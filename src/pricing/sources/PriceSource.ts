export type PriceSourceId = 'steam' | 'csfloat';

// ════════════════════════════════════════════════════════════════════════════
//  PriceSource — pluggable price provider for PricingService (Feature 3).
//  fetchPriceCents returns USD cents, or null when the item is unpriced. Throw
//  Error('RATE_LIMIT') on a 429 so PricingService's existing backoff kicks in.
// ════════════════════════════════════════════════════════════════════════════

export interface PriceSource {
  readonly id: PriceSourceId;
  fetchPriceCents(name: string, appid: number): Promise<number | null>;
}
