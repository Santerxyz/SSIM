import type { HttpAgent } from '../network/AgentFactory';

// ════════════════════════════════════════════════════════════════════════════
//  PricerIdentityPool — turns live logged-in sessions into "pricer identities" for
//  the background price fill (2026-07-10 root-cause fix).
//
//  WHY: Steam's ANONYMOUS market/priceoverview budget is per-IP, tiny, and — on the
//  fleet's shared rotating residential pool — routinely PRE-EXHAUSTED by other
//  tenants, so a cold request 429s while the same proxies carry authenticated
//  traffic fine. The fix is to stop being anonymous: every price request rides a
//  real logged-in session's cookie (attributing the request to that account's
//  budget) over that account's own egress agent (the IP the cookie was issued to).
//
//  This module is pure + framework-free: SessionManager gathers the web-ready
//  candidates, `pickPricerIdentities` builds the cookie header + validates auth.
// ════════════════════════════════════════════════════════════════════════════

/** One authenticated egress the fill can price through. */
export interface PricerIdentity {
  /** The account this identity belongs to (label / diversity key — never logged as a secret). */
  username:     string;
  /** Full Cookie header for steamcommunity.com, e.g. "sessionid=…; steamLoginSecure=…".
   *  MUST contain steamLoginSecure (else it is not authenticated and buys no budget). */
  cookieHeader: string;
  /** The account's own https agent (proxy/local-IP bound) — the exit the cookie was issued to. */
  agent:        HttpAgent;
}

/** A web-ready session reduced to what an identity needs (keeps this module SessionManager-free). */
export interface PricerCandidate {
  username: string;
  cookies:  string[];   // steam-user 'webSession' cookies ("name=value" strings, community domain)
  agent:    HttpAgent;
}

/**
 * Builds a steamcommunity Cookie header from a session's cookie array, or null when the
 * array carries no `steamLoginSecure` — i.e. it is not actually an authenticated session,
 * so pricing through it would silently fall back to the anonymous per-IP budget we are
 * trying to escape. Returning null makes that candidate ineligible rather than pretending.
 */
export function buildCookieHeader(cookies: string[]): string | null {
  if (!Array.isArray(cookies) || cookies.length === 0) return null;
  const parts = cookies.map((c) => (typeof c === 'string' ? c.trim() : '')).filter(Boolean);
  const hasAuth = parts.some((c) => /^steamLoginSecure=/.test(c) && c.length > 'steamLoginSecure='.length);
  if (!hasAuth) return null;
  return parts.join('; ');
}

/**
 * Selects up to `limit` distinct authenticated identities from the candidate list, in the
 * order given (SessionManager passes them in a stable order → identities are stable within a
 * fill and only churn as sessions cycle). Candidates without a usable auth cookie are skipped.
 * De-dups by username so one account never fills two lanes.
 */
export function pickPricerIdentities(candidates: PricerCandidate[], limit: number): PricerIdentity[] {
  const out: PricerIdentity[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (out.length >= limit) break;
    const key = c.username.toLowerCase();
    if (seen.has(key)) continue;
    const cookieHeader = buildCookieHeader(c.cookies);
    if (!cookieHeader) continue;
    seen.add(key);
    out.push({ username: c.username, cookieHeader, agent: c.agent });
  }
  return out;
}
