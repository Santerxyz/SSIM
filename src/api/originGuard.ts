import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

// ════════════════════════════════════════════════════════════════════════════
//  originGuard.ts — same-origin / anti-CSRF guard for the localhost money API.
//
//  THREAT: the dashboard API runs on http://127.0.0.1:<port> with no auth. While the
//  operator is browsing the web, a malicious page could fire cross-origin requests at
//  it (CSRF) — e.g. POST /api/trade/send — to move real items, OR use DNS-rebinding to
//  pose as same-origin. Browsers can't READ the response (CORS), but a state-changing
//  request still EXECUTES, which is all an attacker needs for a trading tool.
//
//  DEFENCE (OWASP same-origin verification — no UI changes, the browser already sends
//  Origin on every fetch/XHR/cross-origin form POST):
//   1. DNS-rebind guard: only ever answer a localhost Host header (default bind). An
//      attacker who rebinds evil.com → 127.0.0.1 sends Host: evil.com → refused.
//   2. Reads (GET/HEAD/OPTIONS) pass — they don't change state and CORS blocks reading
//      the response cross-origin anyway (covers the dashboard, static, ping, SSE).
//   3. State-changing methods MUST carry an Origin (or Referer) that matches our own
//      origin → a foreign web page is refused; our own UI (same origin) sails through.
//  Blocked attempts are logged loudly (and show up in the Live Logs window).
// ════════════════════════════════════════════════════════════════════════════

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i;

// When SSIM binds the default localhost, we additionally enforce a localhost Host header
// (DNS-rebind guard). If the operator explicitly opted into LAN exposure (HOST=0.0.0.0 or a
// specific IP — see the security warning in index.ts), that strict check is relaxed, but the
// same-origin CSRF check below still applies.
const BIND_HOST = process.env.HOST ?? '127.0.0.1';
const ENFORCE_LOCALHOST_HOST = BIND_HOST === '127.0.0.1' || BIND_HOST === 'localhost' || BIND_HOST === '::1';

function deny(res: Response, code: string, msg: string): void {
  res.status(403).json({ error: msg, code });
}

export function sameOriginGuard(req: Request, res: Response, next: NextFunction): void {
  const host = String(req.headers.host ?? '').toLowerCase();

  // 1) DNS-rebinding guard (default localhost bind only).
  if (ENFORCE_LOCALHOST_HOST && !LOCAL_HOST_RE.test(host)) {
    logger.warn(`[security] refused request with non-localhost Host "${host}" (${req.method} ${req.path})`);
    return deny(res, 'BAD_HOST', 'SSIM only serves localhost.');
  }

  // 2) Reads are safe (no state change; CORS blocks cross-origin response reads).
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') { next(); return; }

  // 3) State-changing requests must be same-origin.
  const origin = req.headers.origin;
  if (origin) {
    const o = String(origin).toLowerCase();
    if (o === `http://${host}` || o === `https://${host}`) { next(); return; }
    logger.warn(`[security] blocked cross-origin ${method} ${req.path} from origin ${origin}`);
    return deny(res, 'BAD_ORIGIN', 'Cross-origin request blocked.');
  }

  // No Origin header → fall back to Referer (same-origin requests carry one).
  const referer = req.headers.referer;
  if (referer) {
    try { if (new URL(referer).host.toLowerCase() === host) { next(); return; } } catch { /* malformed referer */ }
    logger.warn(`[security] blocked ${method} ${req.path} with foreign referer`);
    return deny(res, 'BAD_REFERER', 'Cross-origin request blocked.');
  }

  // Neither header: the dashboard's fetch ALWAYS sends Origin, so absence means a non-browser
  // caller (curl / another local process). Refuse state-changing calls.
  logger.warn(`[security] blocked ${method} ${req.path} with no Origin/Referer`);
  return deny(res, 'NO_ORIGIN', 'Missing Origin header.');
}
