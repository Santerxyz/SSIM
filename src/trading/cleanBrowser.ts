import { spawn, execFileSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { parseProxy } from '../network/AgentFactory';
import { logger } from '../utils/logger';

// ════════════════════════════════════════════════════════════════════════════
//  cleanBrowser — "Open in clean browser": open ONE selected account in a fully
//  isolated, ephemeral Steam web session.
//
//  ISOLATION MECHANISM (chosen, and why): the stack is a Node backend + Tauri/Edge
//  shell — NOT Electron — so there is no in-process BrowserWindow to partition.
//  We launch the SYSTEM Chromium (Edge, else Chrome) with:
//    • --user-data-dir=<fresh temp dir>  → a brand-new, isolated profile (zero
//      cookies/state from any other account or a prior session). Ephemeral: the dir
//      is deleted when the browser exits, so closing discards the session.
//    • --proxy-server=<this account's proxy>  → SAME egress IP the account normally
//      uses (a different IP can trip a Steam lock). Authenticated HTTP proxies are
//      chained through a tiny local relay that injects Proxy-Authorization (Chromium
//      can't take proxy creds on the command line).
//    • CDP Network.setCookie → inject ONLY this account's steamLoginSecure + sessionid
//      (the stored web session — never a password), then navigate to steamcommunity.com.
//
//  The SECURITY-CRITICAL part — which cookies, which proxy — is the PURE
//  `buildIsolatedSession` below and is unit-tested. The launch consumes that spec, so
//  no other account's cookie and no other IP can ever enter the context.
// ════════════════════════════════════════════════════════════════════════════

/** Only these auth cookies are carried into the isolated context. */
export const STEAM_AUTH_COOKIES = ['steamLoginSecure', 'sessionid'] as const;
// Steam's session cookies are DOMAIN-SCOPED. The login only ever sets them for
// steamcommunity.com, so a clean browser that injects them on that domain ALONE shows the
// account LOGGED OUT the moment you leave it — the store (store.steampowered.com, e.g. the
// CS2/Prime shop), help, checkout, login, and the Account-details pages all live on the
// steampowered.com tree and were never authenticated. But steamLoginSecure is a JWT access
// token whose audience is "web" — the SAME token value is accepted by EVERY Steam web
// domain; the cookie merely has to be SET on each. So we establish the session on the
// community host AND across the whole *.steampowered.com tree via one '.steampowered.com'
// domain cookie (covers store/help/checkout/login/account). (Bug 2 fix.)
export const STEAM_COOKIE_DOMAINS = ['steamcommunity.com', '.steampowered.com'] as const;
const STEAM_URL = 'https://steamcommunity.com';

export interface IsolatedCookie {
  name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean;
}

export interface IsolatedSessionSpec {
  username:    string;
  /** ONLY this account's auth cookies (steamLoginSecure + sessionid), established on EVERY
   *  Steam web domain — community + the steampowered tree — so the store / account / help
   *  pages stay logged in too (Bug 2). One entry per (cookie × domain). */
  cookies:     IsolatedCookie[];
  /** Chromium `--proxy-server` value (credentials stripped), or null for local IP. */
  proxyServer: string | null;
  /** Upstream proxy credentials when authenticated (used by the local relay), else null. */
  proxyAuth:   { host: string; port: number; username: string; password: string; scheme: string } | null;
  warnings:    string[];
}

/** Parse a web session's `name=value` cookie strings into a flat map (first `=` splits). */
export function parseCookieStrings(cookieStrings: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of cookieStrings ?? []) {
    const head = String(raw).split(';')[0];                 // drop attributes
    const eq = head.indexOf('=');
    if (eq <= 0) continue;
    const name = head.slice(0, eq).trim();
    const value = head.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

/**
 * PURE: build the isolated-session spec for ONE account. Carries ONLY this account's
 * steamLoginSecure + sessionid, and ONLY this account's proxy. No proxy → a warning
 * (never a silent fall-through to the host IP that could differ from the account's egress).
 */
export function buildIsolatedSession(input: {
  username: string;
  cookieStrings: string[];                       // session.webSession.cookies (THIS account only)
  network?: { type: string; value: string } | null;
}): IsolatedSessionSpec {
  const warnings: string[] = [];

  // Cookies: extract ONLY the two auth cookies from THIS account's session. Nothing else
  // (other site cookies, and certainly no other account's cookie) can enter the context.
  const jar = parseCookieStrings(input.cookieStrings);
  const cookies: IsolatedCookie[] = [];
  for (const name of STEAM_AUTH_COOKIES) {
    if (!jar[name]) continue;
    // Set the SAME value on every Steam web domain (community host + the steampowered tree)
    // so the session survives navigating off steamcommunity.com — a community-only cookie did
    // not, which is why the store/account pages showed "logged out". (Bug 2.)
    for (const domain of STEAM_COOKIE_DOMAINS) {
      cookies.push({ name, value: jar[name], domain, path: '/', secure: true, httpOnly: name === 'steamLoginSecure' });
    }
  }
  if (!cookies.some((c) => c.name === 'steamLoginSecure')) {
    warnings.push('no steamLoginSecure cookie for this account — the browser will open NOT logged in; refresh/log the account in first');
  }

  // Proxy: ONLY this account's resolved proxy, parsed by the SAME canonical parser the
  // login flow uses (AgentFactory.parseProxy) — so the host/port/user/pass are extracted
  // IDENTICALLY for EVERY accepted format (URL, host:port:user:pass, user:pass@host:port,
  // …). One source of truth, no re-shaping. localip / none / unparseable → warn (never leak).
  let proxyServer: string | null = null;
  let proxyAuth: IsolatedSessionSpec['proxyAuth'] = null;
  if (input.network && input.network.type === 'proxy' && input.network.value) {
    const p = parseProxy(input.network.value);
    if (!p) {
      warnings.push("could not parse this account's proxy — refusing to open without it");
    } else {
      const scheme = p.scheme || 'http';
      proxyServer = `${scheme}://${p.host}:${p.port}`;
      if (p.username) {
        // Authenticated proxy. Chromium can't take proxy creds on --proxy-server, so an
        // authed HTTP proxy is chained through a local relay that injects Proxy-Authorization.
        if (!p.password) {
          warnings.push("this account's proxy requires authentication but its password is empty — refusing to open on a failing proxy");
          proxyServer = null; // force the caller's guard to refuse rather than open credential-less
        } else if (/^socks/i.test(scheme)) {
          warnings.push('this account uses an AUTHENTICATED SOCKS proxy — the clean browser cannot apply SOCKS auth; refusing rather than opening on a failing proxy');
          proxyServer = null;
        } else {
          proxyAuth = { host: p.host, port: Number(p.port), username: p.username, password: p.password ?? '', scheme };
        }
      }
    }
  } else {
    warnings.push('this account has NO proxy (runs on the host IP) — opening on the local IP may differ from its normal egress and risk a Steam lock');
  }

  return { username: input.username, cookies, proxyServer, proxyAuth, warnings };
}

// ── Launch (side-effect; smoke-level — needs a real Chromium + proxy + Steam) ───

function findChromium(): string | null {
  const c = [
    process.env.SSIM_BROWSER_EXE,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean) as string[];
  for (const p of c) { try { if (fs.existsSync(p)) return p; } catch { /* ignore */ } }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

/**
 * Local relay so Chromium (which takes NO proxy creds on the CLI / in --proxy-server) can
 * still use an AUTHENTICATED HTTP proxy: Chromium → 127.0.0.1:relay → upstream, with the
 * relay injecting `Proxy-Authorization: Basic …` on every hop. Same upstream host/port/creds
 * the login flow uses (passed in via the spec). Handles both:
 *   • CONNECT  → the HTTPS tunnel Steam actually uses (authenticate, verify 200, splice).
 *   • absolute-form GET/POST → plain-HTTP subresources (replay to the upstream with auth),
 *     so nothing 405s and silently looks like a proxy failure.
 * Returns the relay's loopback port + a close().
 */
export function startProxyRelay(
  auth: NonNullable<IsolatedSessionSpec['proxyAuth']>,
  label = 'clean-browser',
  opts?: { maxConns?: number; firstByteTimeoutMs?: number },
): Promise<{ port: number; close: () => void }> {
  const credHeader = `Proxy-Authorization: Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;

  // S65: this relay carries the account's PROXY credentials and, being a loopback proxy, is technically an
  // open proxy any local process could use while the window is open. A true client-auth close isn't possible
  // here — Chromium presents no proxy credentials (the whole reason the relay exists), and Edge/Chrome hand
  // off to a DETACHED browser process whose PID we don't hold, so there's nothing to PID-pin. What we CAN do
  // safely (without risking the just-field-fixed tunnel path) is BOUND the exposure: cap concurrent tunnels,
  // and drop any connector that opens a socket but doesn't send a request promptly (an idle probe/scanner).
  // Chromium always sends its CONNECT/request immediately, so neither ever affects a legitimate tunnel.
  const MAX_RELAY_CONNS = opts?.maxConns ?? 64;
  const FIRST_BYTE_TIMEOUT_MS = opts?.firstByteTimeoutMs ?? 5_000;
  let activeConns = 0;

  const server = net.createServer((client) => {
    if (activeConns >= MAX_RELAY_CONNS) { client.destroy(); return; } // bound concurrent tunnels (S65)
    activeConns++;
    const firstByteTimer = setTimeout(() => { client.destroy(); }, FIRST_BYTE_TIMEOUT_MS); // drop idle connectors (S65)
    firstByteTimer.unref?.();
    client.once('data', () => clearTimeout(firstByteTimer));
    client.on('close', () => { activeConns--; clearTimeout(firstByteTimer); });
    client.on('error', () => client.destroy());
    let buf = Buffer.alloc(0);

    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');               // wait for the full request header block
      if (end === -1) { if (buf.length > 65536) client.destroy(); return; }
      client.removeListener('data', onData);

      const headerBlock = buf.slice(0, end).toString('latin1');
      const rest = buf.slice(end + 4);                    // any bytes already past the headers
      const firstLine = headerBlock.split('\r\n')[0];
      const connect = /^CONNECT\s+(\S+)\s+HTTP\/1\.[01]/i.exec(firstLine);

      const upstream = net.connect(auth.port, auth.host);
      upstream.on('error', (e) => {
        logger.warn(`[${label}] proxy relay: cannot reach upstream proxy ${auth.host}:${auth.port} — ${(e as Error).message}`);
        try { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch { /* ignore */ }
      });
      client.on('error', () => upstream.destroy());

      upstream.once('connect', () => {
        if (connect) {
          // HTTPS tunnel: authenticate to the upstream, confirm 200, then splice raw streams.
          const target = connect[1];
          upstream.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${credHeader}\r\nProxy-Connection: Keep-Alive\r\n\r\n`);
          let upBuf = Buffer.alloc(0);
          const onUp = (uc: Buffer): void => {
            upBuf = Buffer.concat([upBuf, uc]);
            const he = upBuf.indexOf('\r\n\r\n');
            if (he === -1) return;
            upstream.removeListener('data', onUp);
            const statusLine = upBuf.slice(0, upBuf.indexOf('\r\n')).toString('latin1');
            const ok = /^HTTP\/1\.[01]\s+200\b/.test(statusLine);
            if (!ok) {
              logger.warn(`[${label}] proxy relay: upstream ${auth.host}:${auth.port} refused CONNECT (${statusLine}) — proxy credentials likely wrong`);
              try { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch { /* ignore */ } upstream.end(); return;
            }
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            const leftover = upBuf.slice(he + 4);
            if (leftover.length) client.write(leftover);   // tunneled bytes that rode in with the 200
            if (rest.length) upstream.write(rest);          // early client bytes (rare for CONNECT)
            upstream.pipe(client); client.pipe(upstream);
          };
          upstream.on('data', onUp);
        } else {
          // Plain-HTTP (absolute-form) request: inject auth after the request line, replay, splice.
          const lines = headerBlock.split('\r\n');
          lines.splice(1, 0, credHeader);
          upstream.write(lines.join('\r\n') + '\r\n\r\n');
          if (rest.length) upstream.write(rest);
          upstream.pipe(client); client.pipe(upstream);
        }
      });
    };
    client.on('data', onData);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => { try { server.close(); } catch { /* ignore */ } } }));
  });
}

/** One CDP request/response over the page's debugger WebSocket. */
async function cdp(ws: WebSocket, id: number, method: string, params: unknown): Promise<void> {
  ws.send(JSON.stringify({ id, method, params }));
}

// ── Ephemeral-session lifetime ──────────────────────────────────────────────
// Teardown (close relay + delete profile) MUST follow the BROWSER, not the process we spawn.
// Edge/Chrome hand off to a separate browser process and the launcher we spawned exits almost
// immediately — so the original `child.on('exit')` tore the relay down WHILE the window was
// still open, and the window then hit a dead 127.0.0.1:<relayPort> → ERR_PROXY_CONNECTION_FAILED.
// We instead watch the browser's own debug port (which survives the hand-off) and tear down when
// IT disappears, with a process-shutdown backstop so nothing leaks if SSIM exits first.
const liveTeardowns = new Set<() => void>();
let shutdownHooked = false;
function hookShutdownOnce(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const all = (): void => { for (const t of [...liveTeardowns]) { try { t(); } catch { /* ignore */ } } };
  // Teardown rides the 'exit' hook because every JS-capable termination path in index.ts funnels
  // through process.exit; paths that run no JS (SIGKILL, native fast-fail) are covered by the
  // stale-profile sweep (H-TRD-062), not by handlers — so we must NOT install signal handlers here
  // (they truncated index.ts's graceful shutdown mid-logoutAll and forced exit code 0).
  process.once('exit', all);
}

/**
 * Launch the isolated browser for `spec` and inject its cookies. Best-effort: any failure
 * logs + cleans up the ephemeral profile and throws. The browser stays open until the
 * operator closes it (closing discards the ephemeral profile).
 */
export async function launchIsolatedBrowser(spec: IsolatedSessionSpec): Promise<{ profileDir: string; proxyUsed: string | null; proxyAuthApplied: boolean }> {
  const exe = findChromium();
  if (!exe) throw new Error('no Chromium browser (Edge/Chrome) found to open a clean session — set SSIM_BROWSER_EXE');
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-clean-'));
  let relay: { port: number; close: () => void } | null = null;
  let child: ChildProcess | undefined;
  let tornDown = false;
  const teardown = (): void => {
    if (tornDown) return;
    tornDown = true;
    liveTeardowns.delete(teardown);
    try { relay?.close(); } catch { /* ignore */ }
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  try {
    // Resolve the --proxy-server Chromium will use. An AUTHENTICATED proxy is NEVER handed to
    // Chromium credential-stripped (that yields ERR_PROXY_CONNECTION_FAILED): it is chained
    // through the local relay, which carries this account's proxy creds. proxyAuth came from
    // the SAME parser the login flow uses, so the relay's egress == the account's login egress.
    let proxyArg = spec.proxyServer;
    let proxyAuthApplied = false;
    if (spec.proxyAuth) {
      relay = await startProxyRelay(spec.proxyAuth, spec.username);
      proxyArg = `http://127.0.0.1:${relay.port}`;
      proxyAuthApplied = true;
    }

    const port = await freePort();
    const args = [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run', '--no-default-browser-check', '--no-service-autorun', '--disable-sync',
      ...(proxyArg ? [`--proxy-server=${proxyArg}`] : []),
      'about:blank',
    ];
    child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    // NOTE: deliberately NOT child.on('exit', teardown) — Edge/Chrome hand off and this spawned
    // process exits immediately while the real window lives on. Teardown is driven by the debug-port
    // watcher below (set up after injection), which tracks the actual browser.
    child.on('error', () => { /* spawn failure surfaces as the debugger-discovery timeout below */ });
    child.unref();

    // Discover the page debugger WS endpoint (poll — Chromium needs a moment).
    let wsUrl = '';
    for (let i = 0; i < 40 && !wsUrl; i++) {
      await sleep(150);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/list`);
        const tabs = (await r.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        wsUrl = tabs.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? '';
      } catch { /* not up yet */ }
    }
    if (!wsUrl) throw new Error('could not reach the browser debugger to inject the session');

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let id = 0;
      const t = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error('debugger handshake timed out')); }, 8000);
      ws.onopen = async () => {
        await cdp(ws, ++id, 'Network.enable', {});
        for (const c of spec.cookies) {
          await cdp(ws, ++id, 'Network.setCookie', { name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly });
        }
        await cdp(ws, ++id, 'Page.navigate', { url: STEAM_URL });
        clearTimeout(t);
        // Give the commands a tick to flush, then detach (the page keeps running).
        setTimeout(() => { try { ws.close(); } catch { /* ignore */ } resolve(); }, 400);
      };
      ws.onerror = () => { clearTimeout(t); reject(new Error('debugger connection failed')); };
    });

    const authNote = proxyAuthApplied ? 'yes (via local relay)' : (spec.proxyServer ? 'no (open proxy)' : 'n/a');
    logger.info(`[${spec.username}] clean browser opened (proxy=${spec.proxyServer ?? 'LOCAL IP'}, proxy auth: ${authNote}, cookies=${spec.cookies.map((c) => c.name).join('+') || 'none'})`);

    // Keep the relay (+ ephemeral profile) alive for EXACTLY as long as the browser is open, by
    // watching its debug port — which follows the real browser process across Edge's hand-off, so
    // the relay no longer dies under a live window. Backstop: tear everything down if SSIM exits.
    hookShutdownOnce();
    liveTeardowns.add(teardown);
    let misses = 0;
    const watch = setInterval(() => {
      fetch(`http://127.0.0.1:${port}/json/version`).then(
        () => { misses = 0; },
        () => { if (++misses >= 6) { clearInterval(watch); teardown(); } }, // ~9s of no debug port ⇒ window closed
      );
    }, 1500);
    watch.unref?.();

    return { profileDir, proxyUsed: spec.proxyServer, proxyAuthApplied };
  } catch (err) {
    try { child?.kill(); } catch { /* ignore */ }
    teardown();
    throw err;
  }
}
