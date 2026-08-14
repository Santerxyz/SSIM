import { logger } from '../utils/logger';
import { parseProxy } from './AgentFactory';

// ════════════════════════════════════════════════════════════════════════════
//  ProxyHealth — per-proxy circuit breaker (the "tank").
//
//  WHY: SSIM has no per-proxy failure state. When a proxy provider RST-storms
//  (veritasproxy et al.), every account behind it keeps firing fresh 5×-retried
//  TLS handshakes into the storm — the software AMPLIFIES the outage. Hundreds of
//  concurrent half-open TLS handshakes being torn down at once is the churn that
//  feeds the native 0xC0000409 fast-fail during a full-fleet refresh. This breaker
//  makes the fleet ABSORB a flaky provider instead: a proxy that reset-storms trips
//  OPEN, and BULK logins/refreshes on it stop dialing until a half-open probe shows
//  it recovered — so a bad proxy degrades ITS accounts gracefully (surfaced as
//  "deferred", retryable) instead of destabilising the whole process.
//
//  SCOPE (money-safety, non-negotiable): consult this ONLY on BULK/background paths
//  (fleet refresh, bulk login). A user-initiated single-account money action (trade,
//  sell, buy, confirm, single refresh) MUST bypass it — a deferral must never be
//  mistaken by a money path for "empty inventory" / "balance 0" / "no offers". The
//  breaker never mutates cache/state; it only says "don't dial this proxy right now".
//
//  Provider-agnostic: keyed by proxy host:port, so any provider's exit endpoint gets
//  the same protection. Local-IP (proxyless) accounts are not tracked here — they run
//  through LocalIpThrottle and share the host IP, a different failure domain.
// ════════════════════════════════════════════════════════════════════════════

/** A single dial outcome fed to the breaker. */
export type ProxyOutcome = 'ok' | 'reset' | 'fail';

export enum BreakerState {
  CLOSED = 'closed',      // healthy — dial freely
  OPEN = 'open',          // storming — bulk dials deferred until cooldown elapses
  HALF_OPEN = 'half_open' // cooldown elapsed — allow exactly one probe dial
}

/** Reset-class error signatures: a proxy tearing the connection down mid-handshake.
 *  These are the exact strings/codes the field storm produces (see ssim.log). */
const RESET_SIGNATURES = [
  'econnreset',
  'socket disconnected before secure tls',   // "Client network socket disconnected before secure TLS connection was established"
  'socket hang up',
  'client network socket disconnected',
  'proxy connection timed out',
  'tunneling socket could not be established',
  'etimedout',
  'econnrefused',
  'connect etimedout',
  'esockettimedout',
];

/** Classify an arbitrary error as a reset-class proxy failure vs. an ordinary failure.
 *  Reset-class failures (the ones the storm produces) are what trip the breaker; a plain
 *  auth error or a 429 is not reset-class and must not open a proxy's breaker. */
export function isResetClass(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: unknown }).code;
  const msg = `${(err as { message?: unknown }).message ?? err} ${typeof code === 'string' ? code : ''}`.toLowerCase();
  return RESET_SIGNATURES.some(sig => msg.includes(sig));
}

/** Derive the breaker key (host:port) from a proxy string; null for a proxyless / unparseable value. */
export function proxyKey(proxy: string | undefined | null): string | null {
  if (!proxy) return null;
  const p = parseProxy(proxy);
  return p ? `${p.host}:${p.port}` : null;
}

interface Entry {
  state: BreakerState;
  consecutiveResets: number;
  openedAt: number;        // epoch ms the breaker last tripped OPEN
  cooldownMs: number;      // current cooldown (grows on repeated trips, capped)
  probeInFlight: boolean;  // a HALF_OPEN probe has been handed out and not yet resolved
  lastLogAt: number;       // rate-limit the surfaced warn
}

export interface ProxyHealthOptions {
  /** Consecutive reset-class failures on one proxy before it trips OPEN. */
  resetThreshold?: number;
  /** Base cooldown once OPEN (ms) before a half-open probe is allowed. */
  baseCooldownMs?: number;
  /** Cap on the (exponentially-growing) cooldown (ms). */
  maxCooldownMs?: number;
}

export class ProxyHealth {
  private readonly entries = new Map<string, Entry>();
  private readonly resetThreshold: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;

  constructor(opts: ProxyHealthOptions = {}) {
    this.resetThreshold = Math.max(1, opts.resetThreshold ?? 5);
    this.baseCooldownMs = Math.max(1_000, opts.baseCooldownMs ?? 30_000);
    this.maxCooldownMs = Math.max(this.baseCooldownMs, opts.maxCooldownMs ?? 5 * 60_000);
  }

  private ensure(key: string): Entry {
    let e = this.entries.get(key);
    if (!e) {
      e = { state: BreakerState.CLOSED, consecutiveResets: 0, openedAt: 0, cooldownMs: this.baseCooldownMs, probeInFlight: false, lastLogAt: 0 };
      this.entries.set(key, e);
    }
    return e;
  }

  /**
   * May a BULK dial go out through this proxy right now? CLOSED → yes. OPEN → no until the
   * cooldown elapses, then exactly one probe is allowed (transitioning to HALF_OPEN). While a
   * probe is in flight, further bulk dials are refused. Pass `now` for deterministic tests.
   * (Money ops must not call this — see the file header scope note.)
   */
  shouldAllow(key: string | null | undefined, now: number = Date.now()): boolean {
    if (!key) return true; // proxyless / unparseable → not our failure domain, never block
    const e = this.entries.get(key);
    if (!e || e.state === BreakerState.CLOSED) return true;
    if (e.state === BreakerState.HALF_OPEN) return false; // a probe is outstanding; hold the rest back
    // OPEN: allow a single probe once the cooldown has elapsed.
    if (now - e.openedAt >= e.cooldownMs && !e.probeInFlight) {
      e.state = BreakerState.HALF_OPEN;
      e.probeInFlight = true;
      logger.info(`[proxy-health] ${key} cooldown elapsed — probing recovery`);
      return true;
    }
    return false;
  }

  /** Record a dial outcome. `ok` closes/heals; a reset-class `reset` counts toward tripping;
   *  a non-reset `fail` (auth, 429, app error) does not trip the breaker (not the storm class). */
  record(key: string | null | undefined, outcome: ProxyOutcome, now: number = Date.now()): void {
    if (!key) return;
    const e = this.ensure(key);

    if (outcome === 'ok') {
      if (e.state !== BreakerState.CLOSED) {
        logger.info(`[proxy-health] ${key} recovered — closing breaker (was ${e.state})`);
      }
      e.state = BreakerState.CLOSED;
      e.consecutiveResets = 0;
      e.cooldownMs = this.baseCooldownMs;
      e.probeInFlight = false;
      return;
    }

    if (outcome === 'fail') {
      // Non-reset failure: heals a HALF_OPEN probe slot (so it isn't stuck) but does not trip.
      if (e.state === BreakerState.HALF_OPEN) { e.state = BreakerState.OPEN; e.openedAt = now; e.probeInFlight = false; }
      return;
    }

    // reset-class failure
    e.consecutiveResets++;
    if (e.state === BreakerState.HALF_OPEN) {
      // probe failed → reopen with a longer cooldown (capped)
      e.state = BreakerState.OPEN;
      e.openedAt = now;
      e.probeInFlight = false;
      e.cooldownMs = Math.min(this.maxCooldownMs, e.cooldownMs * 2);
      return;
    }
    if (e.state === BreakerState.CLOSED && e.consecutiveResets >= this.resetThreshold) {
      e.state = BreakerState.OPEN;
      e.openedAt = now;
      e.cooldownMs = this.baseCooldownMs;
      if (now - e.lastLogAt > 5_000) {
        logger.warn(`[proxy-health] ${key} is reset-storming (${e.consecutiveResets} consecutive resets) — deferring bulk dials for ${Math.round(e.cooldownMs / 1000)}s. A different/healthier proxy will not be affected.`);
        e.lastLogAt = now;
      }
    }
  }

  /** Is this proxy currently tripped (OPEN/HALF_OPEN)? For surfacing a "deferred" reason. */
  isOpen(key: string | null | undefined): boolean {
    if (!key) return false;
    const e = this.entries.get(key);
    return !!e && e.state !== BreakerState.CLOSED;
  }

  /** Snapshot for diagnostics/telemetry (never logs secrets — keys are host:port only). */
  snapshot(): Array<{ key: string; state: BreakerState; consecutiveResets: number }> {
    return [...this.entries.entries()].map(([key, e]) => ({ key, state: e.state, consecutiveResets: e.consecutiveResets }));
  }

  /** Count of currently-tripped proxies — drives storm-adaptive concurrency. */
  openCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.state !== BreakerState.CLOSED) n++;
    return n;
  }

  /** Test-only reset. */
  _clear(): void { this.entries.clear(); }
}

/** Process-wide singleton (one failure-domain view shared by the login + refresh paths). */
export const proxyHealth = new ProxyHealth();
