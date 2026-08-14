// ════════════════════════════════════════════════════════════════════════════
//  redact.ts – the one canonical secret redactor for every log / crash / API sink.
//
//  Two proxy-credential shapes can carry a user:pass into a sink:
//    • URL userinfo   scheme://user:pass@host:port   (a failed proxied request puts
//                     the whole URL, creds included, into Error.message/stack).
//    • legacy formats host:port:user:pass, user:pass@host:port, etc. — a value stored
//                     by a pre-normalizeProxy version, or a bare proxy value logged raw.
//  `redactSecrets` masks both so the proxy path is fully covered wherever it is applied.
//
//  SCOPE — what this does not do: it does not scrub non-proxy secret VALUES
//  (identity_secret / shared_secret / revocation_code / refresh_token / access_token /
//  account password / license key). Those must never be passed to a log/crash sink in
//  the first place — that "no secret value at a sink" rule is enforced by
//  test/logSecrecyGuard.test.ts as a build invariant, not by scrubbing here.
//
//  Dependency-free ON PURPOSE: logger.ts and crashlog.ts import this, and logger.ts is
//  a boot-critical leaf that AgentFactory (the home of parseProxy) itself imports.
//  Pulling AgentFactory in here would form a logger→redact→AgentFactory→logger cycle,
//  so the small parseProxy is inlined below rather than imported.
// ════════════════════════════════════════════════════════════════════════════

/** True for a valid 1–65535 TCP port. The port is what disambiguates the legacy formats. */
function isPort(x: string): boolean { return /^\d{1,5}$/.test(x) && +x >= 1 && +x <= 65535; }

interface ParsedProxy { scheme: string; host: string; port: string; username?: string; password?: string; }

/**
 * Parses a whole string that is a bare proxy value (any accepted format) into its parts,
 * or null if the whole string doesn't look like a proxy. Mirrors AgentFactory.parseProxy;
 * kept local to keep this module dependency-free (see header). Because it only matches a
 * whole bare value — never a proxy-shaped substring inside a longer log line — it is safe
 * to run over arbitrary log text: a real sentence returns null and is left untouched.
 */
function parseProxy(raw: string): ParsedProxy | null {
  let s = (raw ?? '').trim();
  if (!s) return null;

  let scheme = 'http';
  const m = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (m) { scheme = m[1].toLowerCase(); s = s.slice(m[0].length); }

  let host: string | undefined, port: string | undefined;
  let username: string | undefined, password: string | undefined;

  if (s.includes('@')) {
    const at = s.lastIndexOf('@');
    const lp = s.slice(0, at).split(':');
    const rp = s.slice(at + 1).split(':');
    if (rp.length === 2 && isPort(rp[1])) {
      [host, port] = rp;                        // user:pass@host:port  (format 4)
      username = lp[0]; password = lp.slice(1).join(':');
    } else if (lp.length === 2 && isPort(lp[1])) {
      [host, port] = lp;                        // host:port@user:pass  (format 2)
      username = rp[0]; password = rp.slice(1).join(':');
    } else {
      return null;
    }
  } else {
    const p = s.split(':');
    if (p.length === 2 && isPort(p[1])) {
      [host, port] = p;                         // host:port (no credentials)
    } else if (p.length === 4 && isPort(p[1])) {
      [host, port, username, password] = p;     // host:port:user:pass  (format 1)
    } else if (p.length === 4 && isPort(p[3])) {
      [username, password, host, port] = p;     // user:pass:host:port  (format 3)
    } else {
      return null;
    }
  }

  if (!host || !port || !isPort(port)) return null;
  return { scheme, host, port, username: username || undefined, password };
}

/**
 * Strips proxy credentials from a string before it is logged, written to a crash file,
 * or returned over the API. First masks any URL-userinfo token embedded anywhere in the
 * text; then, if the whole string is a bare legacy-form proxy value that carries creds,
 * masks that too. Non-proxy text is returned unchanged.
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  // W3_31: mask Steam wallet-code shapes (a bearer secret) anywhere in the text — XXXXX-XXXXX-XXXXX.
  let s = input.replace(/[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}/gi, '«wallet-code»');
  // W4_40: mask paysafecard PINs (a 16-digit bearer secret) — as one run "1234567890123456" or in the
  // common 4×4 grouped forms "1234 5678 9012 3456" / "1234-5678-9012-3456". Runs before the URL/proxy
  // masks so a PIN pasted anywhere near a proxy string is still scrubbed. (\D-anchored so it never eats a
  // digit off a longer number.)
  s = s.replace(/(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g, '«paysafe-pin»');
  const urlMasked = s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***:***@');
  if (urlMasked !== s) return urlMasked;       // embedded URL creds → masked
  const p = parseProxy(s);                      // whole-string legacy proxy → mask if it carries creds
  if (p && p.username) return `${p.scheme}://***:***@${p.host}:${p.port}`;
  return s;
}
