import { spawn, execFileSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
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
const STEAM_DOMAIN = 'steamcommunity.com';
const STEAM_URL = 'https://steamcommunity.com';

export interface IsolatedCookie {
  name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean;
}

export interface IsolatedSessionSpec {
  username:    string;
  /** ONLY this account's auth cookies, scoped to steamcommunity.com. */
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

/** Split a proxy URL (http://user:pass@host:port | socks5://host:port) into parts. */
export function splitProxy(url: string): { scheme: string; host: string; port: number; user: string; pass: string } | null {
  try {
    const u = new URL(/:\/\//.test(url) ? url : `http://${url}`);
    return {
      scheme: (u.protocol || 'http:').replace(':', ''),
      host:   u.hostname,
      port:   Number(u.port) || (u.protocol === 'socks5:' ? 1080 : 3128),
      user:   decodeURIComponent(u.username || ''),
      pass:   decodeURIComponent(u.password || ''),
    };
  } catch { return null; }
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
    if (jar[name]) cookies.push({ name, value: jar[name], domain: STEAM_DOMAIN, path: '/', secure: true, httpOnly: name === 'steamLoginSecure' });
  }
  if (!cookies.some((c) => c.name === 'steamLoginSecure')) {
    warnings.push('no steamLoginSecure cookie for this account — the browser will open NOT logged in; refresh/log the account in first');
  }

  // Proxy: ONLY this account's resolved proxy. localip / none → warn, never leak.
  let proxyServer: string | null = null;
  let proxyAuth: IsolatedSessionSpec['proxyAuth'] = null;
  if (input.network && input.network.type === 'proxy' && input.network.value) {
    const p = splitProxy(input.network.value);
    if (p) {
      proxyServer = `${p.scheme}://${p.host}:${p.port}`;
      if (p.user) proxyAuth = { host: p.host, port: p.port, username: p.user, password: p.pass, scheme: p.scheme };
    } else {
      warnings.push(`could not parse this account's proxy ("${input.network.value}") — refusing to open without it`);
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
 * Minimal local relay so Chromium (which takes no proxy creds on the CLI) can use an
 * AUTHENTICATED http proxy: Chromium → 127.0.0.1:relay → upstream (with Proxy-Authorization).
 * Handles CONNECT (HTTPS, which Steam is). Returns the relay port.
 */
function startProxyRelay(auth: NonNullable<IsolatedSessionSpec['proxyAuth']>): Promise<{ port: number; close: () => void }> {
  const cred = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
  const server = net.createServer((client) => {
    client.once('data', (chunk) => {
      const line = chunk.toString('latin1').split('\r\n')[0];
      const m = /^CONNECT\s+(\S+)\s+HTTP/i.exec(line);
      if (!m) { client.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n'); return; }
      const up = net.connect(auth.port, auth.host, () => {
        up.write(`CONNECT ${m[1]} HTTP/1.1\r\nHost: ${m[1]}\r\nProxy-Authorization: Basic ${cred}\r\nProxy-Connection: Keep-Alive\r\n\r\n`);
      });
      let established = false;
      up.once('data', (resp) => {
        established = /^HTTP\/1\.[01]\s+200/.test(resp.toString('latin1'));
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (established) { up.pipe(client); client.pipe(up); }
        else { client.end(); up.end(); }
      });
      up.on('error', () => { if (!established) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
      client.on('error', () => up.destroy());
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() }));
    server.on('error', reject);
  });
}

/** One CDP request/response over the page's debugger WebSocket. */
async function cdp(ws: WebSocket, id: number, method: string, params: unknown): Promise<void> {
  ws.send(JSON.stringify({ id, method, params }));
}

/**
 * Launch the isolated browser for `spec` and inject its cookies. Best-effort: any failure
 * logs + cleans up the ephemeral profile and throws. The browser stays open until the
 * operator closes it (closing discards the ephemeral profile).
 */
export async function launchIsolatedBrowser(spec: IsolatedSessionSpec): Promise<{ profileDir: string; proxyUsed: string | null }> {
  const exe = findChromium();
  if (!exe) throw new Error('no Chromium browser (Edge/Chrome) found to open a clean session — set SSIM_BROWSER_EXE');
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-clean-'));
  let relay: { port: number; close: () => void } | null = null;
  let child: ChildProcess | undefined;
  const cleanup = (): void => {
    try { relay?.close(); } catch { /* ignore */ }
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  try {
    // Resolve the --proxy-server Chromium will use (chain authed proxies through the relay).
    let proxyArg = spec.proxyServer;
    if (spec.proxyAuth) { relay = await startProxyRelay(spec.proxyAuth); proxyArg = `http://127.0.0.1:${relay.port}`; }

    const port = await freePort();
    const args = [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run', '--no-default-browser-check', '--no-service-autorun', '--disable-sync',
      ...(proxyArg ? [`--proxy-server=${proxyArg}`] : []),
      'about:blank',
    ];
    child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    child.on('exit', cleanup);   // ephemeral: profile gone when the browser closes
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

    logger.info(`[${spec.username}] clean browser opened (proxy=${spec.proxyServer ?? 'LOCAL IP'}, cookies=${spec.cookies.map((c) => c.name).join('+') || 'none'})`);
    return { profileDir, proxyUsed: spec.proxyServer };
  } catch (err) {
    try { child?.kill(); } catch { /* ignore */ }
    cleanup();
    throw err;
  }
}
