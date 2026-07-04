export type PriceSourceId = 'steam' | 'csfloat';

// ════════════════════════════════════════════════════════════════════════════
//  PriceSource — pluggable price provider for PricingService (Feature 3).
//  fetchPriceCents returns USD cents, or null ONLY for an AUTHORITATIVE "no price"
//  (the source answered successfully and the item has no market price). THROW for a
//  transient fetch failure (transport error / 5xx / non-success) so PricingService
//  caches only a short-lived miss, not a 24h "no price" (S2). Throw Error('RATE_LIMIT')
//  on a 429 so PricingService's existing backoff kicks in.
// ════════════════════════════════════════════════════════════════════════════

export interface PriceSource {
  readonly id: PriceSourceId;
  fetchPriceCents(name: string, appid: number): Promise<number | null>;
}
