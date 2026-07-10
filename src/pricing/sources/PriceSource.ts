export type PriceSourceId = 'steam' | 'csfloat';

// ════════════════════════════════════════════════════════════════════════════
//  PriceSource — pluggable price provider for PricingService (Feature 3).
//  fetchPriceCents returns USD cents, or null ONLY for an AUTHORITATIVE "no price"
//  (the source answered successfully and the item has no market price). THROW for a
//  transient fetch failure (transport error / 5xx / non-success) so PricingService
//  caches only a short-lived miss, not a 24h "no price" (S2). Throw Error('RATE_LIMIT')
//  on a 429 so PricingService's failure model (soft-miss + lane retire) kicks in.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Egress + identity for one price request. The 2026-07-10 root-cause fix: a Steam price
 * request must ride a LOGGED-IN identity (its `cookieHeader`) over that account's OWN
 * `agent`, so it draws that account's per-session budget instead of the anonymous per-IP
 * budget that the shared rotating pool leaves perpetually exhausted. Sources with their own
 * egress + auth (CSFloat, keyed) ignore this.
 */
export interface PriceRoute {
  /** Pre-built https agent (the identity's account proxy/local-IP) — the exit the cookie belongs to. */
  agent?:        unknown;
  /** steamcommunity Cookie header ("steamLoginSecure=…; sessionid=…"). When present, the request is
   *  authenticated as that account; when absent, a Steam source would fall back to an ANONYMOUS call
   *  (which PricingService no longer does for the fill — it defers until an identity is available). */
  cookieHeader?: string;
}

export interface PriceSource {
  readonly id: PriceSourceId;
  /** True when this source can currently serve a fetch (credential present, dependencies
   *  reachable); always-available sources return a constant true. */
  available(): boolean;
  /** `route` (optional): the identity/egress for this request (see {@link PriceRoute}). Steam routes
   *  the raw HTTP call through `route.agent` and sends `route.cookieHeader`; CSFloat ignores it. */
  fetchPriceCents(name: string, appid: number, route?: PriceRoute): Promise<number | null>;
}
