import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

// ════════════════════════════════════════════════════════════════════════════
//  Boot capability token (B26 / P5) — authenticates the DASHBOARD to the backend
//  so a random LOCAL process cannot drive money/vault operations on the loopback
//  API even by forging the Origin header (which the same-origin guard cannot stop
//  for a native process). A per-run secret is generated at boot and delivered to
//  the dashboard OUT-OF-BAND:
//    • Tauri shell (sidecar): the backend prints SSIM_CAP=<token> on stdout; the
//      shell injects `window.__SSIM_CAP__` into the webview (a curl process can't
//      read the shell↔backend stdout pipe NOR the webview's JS context).
//    • dev / Edge fallback (no shell): the backend injects the token into the
//      served index.html (functional; documented weaker — a local process could
//      scrape it, same residual risk the origin guard already carries there).
//  The dashboard sends it back on every PROTECTED call (X-SSIM-Cap header, or a
//  `cap` query param for EventSource which cannot set headers). The token lives
//  only in memory; it is never written to disk or logs.
// ════════════════════════════════════════════════════════════════════════════

let TOKEN: string | undefined;

/** The per-run token, generated on first use (before the server starts serving). */
export function getCapabilityToken(): string {
  if (!TOKEN) TOKEN = crypto.randomBytes(32).toString('hex');
  return TOKEN;
}

/** Constant-time compare so a caller can't learn the token via timing. */
export function verifyCapability(provided: unknown): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const expected = getCapabilityToken();
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

// Secret-returning GET routes (unredacted proxy creds / live 2FA codes) — these must
// carry the token too, not just mutating methods.
const SECRET_GET = /^\/api\/(?:accounts\/[^/]+\/(?:proxy|otp)|environments\/[^/]+\/proxy)$/i;

/**
 * Is this request one that a random local process must NOT be able to make without the
 * token? Every mutating /api call (money, vault, config) plus the secret-returning GETs.
 * Plain reads (inventories, pricing, health, the SSE log stream) stay open so the UI's
 * initial load and the logs window work without the token.
 */
export function isProtectedRequest(method: string, path: string): boolean {
  if (!path.startsWith('/api/')) return false;
  const m = method.toUpperCase();
  if (m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE') return true;
  if (m === 'GET' && SECRET_GET.test(path)) return true;
  return false;
}

/** Express middleware: 401s a protected request that lacks a valid capability token. */
export function capabilityGuard(req: Request, res: Response, next: NextFunction): void {
  if (!isProtectedRequest(req.method, req.path)) { next(); return; }
  const provided = req.get('x-ssim-cap') ?? (typeof req.query.cap === 'string' ? req.query.cap : undefined);
  if (verifyCapability(provided)) { next(); return; }
  res.status(401).json({
    error: 'Missing or invalid capability token. Reload SSIM from its own window.',
    capabilityRequired: true,
  });
}

/** The <script> that seeds `window.__SSIM_CAP__` for the dev/Edge HTML-injection path. */
export function capabilityBootstrapScript(): string {
  // JSON.stringify keeps the hex token a safe string literal (no injection surface — the
  // token is our own hex, but this is the correct habit).
  return `<script>window.__SSIM_CAP__=${JSON.stringify(getCapabilityToken())};</script>`;
}

/** Injects the bootstrap script into an index.html string just before </head> (or prepended). */
export function injectCapabilityIntoHtml(html: string): string {
  const tag = capabilityBootstrapScript();
  const i = html.toLowerCase().indexOf('</head>');
  return i >= 0 ? html.slice(0, i) + tag + html.slice(i) : tag + html;
}
