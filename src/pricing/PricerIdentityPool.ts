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
  /** Which EXIT this identity leaves through: `proxy:host:port`, or `local` for the host IP.
   *  Two identities sharing this string share one IP and therefore one per-IP budget. */
  egressKey:    string;
  /** How many SELECTED lanes share this identity's exit (always ≥ 1, ≤ maxPerExit).
   *
   *  This is what the fill paces against. The budget Steam meters is per EXIT IP, not per lane, so
   *  a lane must slow down in proportion to how many siblings share its IP: PricingService divides
   *  one exit's fixed request budget by this number. Reporting the count rather than a boolean is
   *  deliberate — an earlier "dedicated: true/false" version silently let N lanes on ONE exit each
   *  run at the full single-lane rate, multiplying that IP's request rate by N. */
  exitLanes:    number;
}

/** A web-ready session reduced to what an identity needs (keeps this module SessionManager-free). */
export interface PricerCandidate {
  username: string;
  cookies:  string[];   // steam-user 'webSession' cookies ("name=value" strings, community domain)
  agent:    HttpAgent;
  /** The account's resolved exit, as `proxy:host:port` or `local`. Callers compute this from the
   *  account's resolved network (SessionManager does it via proxyKey) so this module stays pure. */
  egressKey: string;
  /**
   * True when this candidate's proxy has been MEASURED to hand out a different exit IP per
   * connection (see network/EgressRotation). Such a session does not share an IP budget with its
   * siblings on the same proxy string, so it is bucketed as its own exit — which is what lets a
   * single rotating proxy scale past one exit's worth of lanes.
   *
   * Passed in as data, never looked up here: this module stays pure/framework-free, and the
   * verdict is a measurement the caller owns. Absent/false ⇒ the safe shared-exit treatment.
   */
  rotatingExit?: boolean;
}

/** The exit key for the host IP. Every proxyless account — and every other process on the machine —
 *  shares it, so it is one exit and is never eligible for the per-session rotation treatment. */
export const LOCAL_EGRESS = 'local';

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
 * Selects up to `limit` distinct authenticated identities, SPREAD ACROSS EXITS, with at most
 * `maxPerExit` of them on any single exit IP.
 *
 * The old selection simply took the first `limit` web-ready sessions in map order. On a proxied
 * fleet that was the wrong pick twice over: the same few accounts were chosen on every fill (map
 * order is insertion order), and nothing stopped all of them sharing ONE proxy — so a fleet with
 * dozens of exits still drove its whole price fill through a single IP, which is exactly the budget
 * the identity model exists to spread. Throughput was capped by the least diverse possible choice.
 *
 * So this is a round-robin over exits: take one candidate from each distinct `egressKey`, then a
 * second from each, and so on, until `limit` is reached, `maxPerExit` rounds are done, or the
 * candidates run out.
 *
 * `maxPerExit` is the load-bearing safety bound, not a tuning knob. Steam meters the budget PER
 * EXIT IP, so "how many lanes may point at one IP" is the only cap that keeps a single-exit setup
 * — a proxyless fleet, one static proxy, or one rotating proxy, all of which present as ONE
 * egressKey — from being driven N times harder than the pace that is known to be safe. Raising
 * `limit` alone buys throughput only when there are more EXITS to spread over; it must never turn
 * into more pressure on the same IP.
 *
 * Candidates without a usable auth cookie are skipped; de-duped by username so one account never
 * fills two lanes. `exitLanes` is stamped afterwards, once the final per-exit counts are known.
 */
export function pickPricerIdentities(candidates: PricerCandidate[], limit: number, maxPerExit = 1): PricerIdentity[] {
  if (limit <= 0 || maxPerExit <= 0) return [];
  // Group the eligible candidates by exit, preserving the caller's order within each group.
  const byEgress = new Map<string, PricerIdentity[]>();
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = c.username.toLowerCase();
    if (seen.has(key)) continue;
    const cookieHeader = buildCookieHeader(c.cookies);
    if (!cookieHeader) continue;
    seen.add(key);
    const egressKey = c.egressKey || LOCAL_EGRESS;
    // A MEASURED rotating proxy gives each connection its own IP, so its sessions do not share a
    // budget. Bucket each one under a synthetic per-session key: the round-robin, the per-exit cap
    // and the exitLanes accounting below then all do the right thing with no special-casing — this
    // session simply IS its own exit. The base key stays in the string so logs remain traceable.
    const bucketKey = c.rotatingExit ? `${egressKey}#${c.username.toLowerCase()}` : egressKey;
    const bucket = byEgress.get(bucketKey);
    const identity: PricerIdentity = { username: c.username, cookieHeader, agent: c.agent, egressKey: bucketKey, exitLanes: 1 };
    if (bucket) bucket.push(identity); else byEgress.set(bucketKey, [identity]);
  }

  // Round-robin: one per exit per pass, so the first `limit` picks are as IP-diverse as possible.
  // Capped at `maxPerExit` rounds — beyond that, extra picks would only pile more lanes onto exits
  // that already have their full share.
  const out: PricerIdentity[] = [];
  const buckets = [...byEgress.values()];
  for (let round = 0; round < maxPerExit && out.length < limit; round++) {
    let progressed = false;
    for (const bucket of buckets) {
      if (out.length >= limit) break;
      if (round >= bucket.length) continue;
      out.push(bucket[round]);
      progressed = true;
    }
    if (!progressed) break;  // every bucket exhausted
  }

  // Stamp how many SELECTED lanes ended up on each exit, so the fill can divide that exit's
  // request budget between them.
  const perEgress = new Map<string, number>();
  for (const id of out) perEgress.set(id.egressKey, (perEgress.get(id.egressKey) ?? 0) + 1);
  for (const id of out) id.exitLanes = perEgress.get(id.egressKey) ?? 1;
  return out;
}
