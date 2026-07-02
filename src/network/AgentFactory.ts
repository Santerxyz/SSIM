import https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { NetworkConfig } from '../types/account';
import { logger } from '../utils/logger';

// ─── Public Types ─────────────────────────────────────────────────────────────

export type HttpAgent = https.Agent | HttpsProxyAgent | SocksProxyAgent;

export interface AgentBundle {
  /** Drop-in agent for axios / node https requests */
  httpsAgent: HttpAgent;
  /** Options forwarded directly to the SteamUser constructor */
  steamUserOptions: SteamUserNetworkOptions;
}

export interface SteamUserNetworkOptions {
  /** Binds the Steam CM TCP socket to this local IP */
  localAddress?: string;
  /**
   * HTTP proxy used by steam-user for its own HTTP requests AND for tunneling
   * the CM TCP connection via HTTP CONNECT (requires a proxy that supports CONNECT).
   */
  httpProxy?: string;
  /**
   * SOCKS proxy for steam-user's CM/GC connection. steam-user routes the CM
   * through it (forcing the WebSocket transport, since SOCKS can't tunnel its raw
   * TCP path). Mutually exclusive with httpProxy. Without it a SOCKS-proxied
   * account would connect to the CM/GC DIRECTLY from the host IP → IP leak.
   */
  socksProxy?: string;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export interface CreateOptions {
  /**
   * Pool (reuse) the local-IP keepAlive agent across accounts. Default true.
   *
   * All proxyless accounts share ONE host IP and are serialized by LocalIpThrottle,
   * so a single shared keepAlive agent lets consecutive refreshes reuse a warm TLS
   * socket instead of re-handshaking per account. Pass `false` for a throwaway,
   * destroyable agent (e.g. the proxy/IP health-check, which `.destroy()`s it after
   * each poll and must NOT tear down the shared pool that live sessions depend on).
   *
   * Ignored for proxy agents — those are never pooled (per-account creds / exit IP).
   */
  pooled?: boolean;
}

/**
 * Minimal structural view of a Node http(s) Agent for teardown purposes. Native
 * `https.Agent` fills `sockets` (in-use) and `requests` (queued); the agent-base@6
 * proxy agents (https-proxy-agent@5 / socks-proxy-agent@6) keep both permanently
 * empty because they never pool (every request is forced `Connection: close` and
 * `freeSocket()` destroys the socket) — and their `destroy()` is a NO-OP.
 */
interface DestroyableAgent {
  destroy?: () => void;
  sockets?: Record<string, unknown[]>;
  requests?: Record<string, unknown[]>;
}

/** In-flight work an agent still owns: in-use sockets + queued requests. */
function agentBusyCount(agent: DestroyableAgent): number {
  const sum = (m?: Record<string, unknown[]>): number => {
    if (!m || typeof m !== 'object') return 0;
    let n = 0;
    for (const arr of Object.values(m)) if (Array.isArray(arr)) n += arr.length;
    return n;
  };
  return sum(agent.sockets) + sum(agent.requests);
}

/** How often the retire reaper re-checks a still-busy agent. */
const RETIRE_POLL_MS = 1_000;
/**
 * Hard deadline after which a still-busy retired agent is destroyed anyway. Every
 * consumer of a session agent runs with a request timeout (≤15s), so a healthy
 * agent quiesces long before this; hitting it means a request leaked its socket,
 * and an unbounded leak is then the greater evil.
 */
export const RETIRE_FORCE_AFTER_MS = 120_000;

export class AgentFactory {
  /**
   * Process-lifetime cache of local-IP keepAlive agents, keyed by bound localAddress
   * (all proxyless accounts resolve to the same fallback, so they share one entry).
   * Never `.destroy()`ed — a single agent backs every live local-IP session at once.
   */
  private static readonly localIpPool = new Map<string, https.Agent>();

  /** Agents retired while still owning in-flight work: agent → retiredAt (epoch ms). */
  private static readonly retiring = new Map<DestroyableAgent, number>();
  private static retireTimer: NodeJS.Timeout | undefined;
  private static readonly stats = { retired: 0, destroyedIdle: 0, destroyedForced: 0 };

  static create(network: NetworkConfig, opts?: CreateOptions): AgentBundle {
    return network.type === 'localip'
      ? AgentFactory.fromLocalIp(network.value, opts?.pooled ?? true)
      : AgentFactory.fromProxy(network.value);
  }

  /**
   * Retires a disposable per-account agent — destroying it only once QUIESCENT.
   *
   * THE TEARDOWN-QUIESCENCE INVARIANT (native-crash class): an agent is NEVER
   * `.destroy()`ed while it still owns in-use sockets or queued requests. Destroying
   * live sockets yanks native TLS/TCP handles out from under in-flight writes — the
   * exact use-after-teardown churn implicated in the 0xC0000409 fast-fail class.
   * Instead the agent is parked in a reaper that destroys it the moment its socket
   * and request maps drain (all consumers run ≤15s request timeouts), with a hard
   * 120s force-destroy so a leaked socket can't pin agents forever.
   *
   * Reality note (verified against node_modules): the agent-base@6 proxy agents pool
   * NOTHING (`Connection: close` per request) and their `destroy()` is a no-op, so
   * for them this whole path is belt-and-suspenders. It matters for any native
   * `https.Agent` (non-pooled local-IP) and future-proofs a proxy-agent upgrade to
   * versions whose destroy() is real. The SHARED local-IP pool agents back every
   * live proxyless session at once and are never torn down here.
   */
  static destroyIfDisposable(agent: unknown): void {
    if (!agent) return;
    for (const pooled of AgentFactory.localIpPool.values()) {
      if (pooled === agent) return; // shared local-IP agent → never tear down
    }
    AgentFactory.retire(agent as DestroyableAgent);
  }

  private static retire(agent: DestroyableAgent): void {
    AgentFactory.stats.retired++;
    if (agentBusyCount(agent) === 0) {
      try { agent.destroy?.(); } catch { /* best-effort */ }
      AgentFactory.stats.destroyedIdle++;
      return;
    }
    if (!AgentFactory.retiring.has(agent)) AgentFactory.retiring.set(agent, Date.now());
    AgentFactory.ensureReaper();
  }

  private static ensureReaper(): void {
    if (AgentFactory.retireTimer) return;
    AgentFactory.retireTimer = setInterval(() => AgentFactory.sweepRetiring(), RETIRE_POLL_MS);
    AgentFactory.retireTimer.unref?.();
  }

  /** One reaper pass (exposed for tests — `now` is injectable). */
  static sweepRetiring(now: number = Date.now()): void {
    for (const [agent, since] of AgentFactory.retiring) {
      const busy = agentBusyCount(agent);
      if (busy === 0) {
        try { agent.destroy?.(); } catch { /* best-effort */ }
        AgentFactory.stats.destroyedIdle++;
        AgentFactory.retiring.delete(agent);
      } else if (now - since >= RETIRE_FORCE_AFTER_MS) {
        logger.warn(`[network] retired agent still busy (${busy} socket(s)/request(s)) after ${Math.round(RETIRE_FORCE_AFTER_MS / 1000)}s – forcing destroy (a request leaked its socket)`);
        try { agent.destroy?.(); } catch { /* best-effort */ }
        AgentFactory.stats.destroyedForced++;
        AgentFactory.retiring.delete(agent);
      }
    }
    if (AgentFactory.retiring.size === 0 && AgentFactory.retireTimer) {
      clearInterval(AgentFactory.retireTimer);
      AgentFactory.retireTimer = undefined;
    }
  }

  /** Teardown instrumentation: proves "no agent destroyed with work in flight" in soaks/tests. */
  static teardownStats(): { retired: number; destroyedIdle: number; destroyedForced: number; pendingRetire: number } {
    return { ...AgentFactory.stats, pendingRetire: AgentFactory.retiring.size };
  }

  // ── Local-IP binding ───────────────────────────────────────────────────────

  private static fromLocalIp(localIp: string, pooled: boolean): AgentBundle {
    return {
      httpsAgent:       pooled
        ? AgentFactory.pooledLocalIpAgent(localIp)
        : new https.Agent({ localAddress: localIp, keepAlive: true }),
      steamUserOptions: { localAddress: localIp },
    };
  }

  /** Returns the shared keepAlive agent for `localIp`, creating it once. */
  private static pooledLocalIpAgent(localIp: string): https.Agent {
    let agent = AgentFactory.localIpPool.get(localIp);
    if (!agent) {
      agent = new https.Agent({ localAddress: localIp, keepAlive: true });
      AgentFactory.localIpPool.set(localIp, agent);
    }
    return agent;
  }

  // ── Proxy (HTTP/HTTPS or SOCKS4/5) ─────────────────────────────────────────

  private static fromProxy(rawProxy: string): AgentBundle {
    const proxyUrl = normalizeProxy(rawProxy);
    const isSocks = /^socks[45h]?:\/\//i.test(proxyUrl);

    if (isSocks) {
      /**
       * SOCKS: route BOTH layers through the proxy so the host IP never leaks.
       *   • web HTTPS calls (inventory, market, confirmations) → SocksProxyAgent
       *   • steam-user's CM/GC socket                          → socksProxy
       * steam-user (≥5.x) tunnels the CM via `socksProxy`, forcing the WebSocket
       * transport (SOCKS can't carry its raw TCP path). WITHOUT socksProxy the
       * CM/GC connection would go DIRECTLY from the host IP – the classic leak.
       * (httpProxy + socksProxy are mutually exclusive in steam-user; we set one.)
       */
      logger.warn('[network] SOCKS proxy → CM/GC tunneled over WebSocket via socksProxy (host IP not exposed). HTTP/HTTPS proxies remain the primary, best-tested CM-tunneling path.');
      return {
        httpsAgent:       new SocksProxyAgent(proxyUrl),
        steamUserOptions: { socksProxy: proxyUrl },
      };
    }

    // HTTP / HTTPS proxy – steam-user tunnels the CM TCP connection via HTTP CONNECT.
    return {
      httpsAgent:       new HttpsProxyAgent(proxyUrl),
      steamUserOptions: { httpProxy: proxyUrl },
    };
  }
}

// ─── Proxy parsing + normalization ──────────────────────────────────────────

export interface ParsedProxy {
  scheme: string;            // http (default) / https / socks4 / socks5 …
  host: string;
  port: string;
  username?: string;
  password?: string;
}

/** True for a valid 1–65535 TCP port. The port is what disambiguates the formats. */
function isPort(x: string): boolean { return /^\d{1,5}$/.test(x) && +x >= 1 && +x <= 65535; }

/**
 * Parses a proxy string in ANY format we accept (single-bot AND environment) into
 * its parts, or null if it doesn't look like a proxy. Accepted forms:
 *   scheme://user:pass@host:port   (already a URL – any scheme)
 *   user:pass@host:port            (format 4)
 *   host:port@user:pass            (format 2)
 *   host:port:user:pass            (format 1)
 *   user:pass:host:port            (format 3)
 *   host:port                      (no credentials)
 * The numeric 1–65535 segment is the PORT, which tells host-first from creds-first.
 */
export function parseProxy(raw: string): ParsedProxy | null {
  let s = (raw ?? '').trim();
  if (!s) return null;

  let scheme = 'http';
  const m = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (m) { scheme = m[1].toLowerCase(); s = s.slice(m[0].length); }

  let host: string | undefined, port: string | undefined;
  let username: string | undefined, password: string | undefined;

  if (s.includes('@')) {
    // Split on the LAST '@' so an '@' inside a creds-last password doesn't misparse.
    const at = s.lastIndexOf('@');
    const lp = s.slice(0, at).split(':');
    const rp = s.slice(at + 1).split(':');
    if (rp.length === 2 && isPort(rp[1])) {
      // user:pass@host:port  (format 4)
      [host, port] = rp;
      username = lp[0]; password = lp.slice(1).join(':');
    } else if (lp.length === 2 && isPort(lp[1])) {
      // host:port@user:pass  (format 2)
      [host, port] = lp;
      username = rp[0]; password = rp.slice(1).join(':');
    } else {
      return null;
    }
  } else {
    const p = s.split(':');
    if (p.length === 2 && isPort(p[1])) {
      [host, port] = p;                       // host:port (no credentials)
    } else if (p.length === 4 && isPort(p[1])) {
      [host, port, username, password] = p;   // host:port:user:pass  (format 1)
    } else if (p.length === 4 && isPort(p[3])) {
      [username, password, host, port] = p;   // user:pass:host:port  (format 3)
    } else {
      return null;
    }
  }

  if (!host || !port || !isPort(port)) return null;
  return { scheme, host, port, username: username || undefined, password };
}

/**
 * Normalizes any accepted proxy format (see parseProxy) into a valid URL the proxy
 * agents understand: "scheme://user:pass@host:port" (credentials URL-encoded). If
 * the input can't be parsed as a proxy, falls back to the legacy behavior (prepend
 * http:// when there is no scheme) so nothing that worked before regresses.
 */
export function normalizeProxy(value: string): string {
  const p = parseProxy(value);
  if (p) {
    const auth = p.username
      ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password ?? '')}@`
      : '';
    return `${p.scheme}://${auth}${p.host}:${p.port}`;
  }
  const trimmed = (value ?? '').trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}
