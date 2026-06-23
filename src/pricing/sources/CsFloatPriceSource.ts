import type { PriceSource } from './PriceSource';
import type { CsFloatService } from '../../csfloat/CsFloatService';
import { CsFloatError } from '../../csfloat/CsFloatClient';

const APPID_CS2 = 730;

// ════════════════════════════════════════════════════════════════════════════
//  CsFloatPriceSource — prices CS2 items from CSFloat's LOWEST buy-now ask via the
//  DOCUMENTED listings search (stable). Uses ANY account that has a key (decision
//  Q2), shared through CsFloatService.pricingClient(). CSFloat is CS2-only, so
//  non-730 items return null (PricingService then shows no value for them).
// ════════════════════════════════════════════════════════════════════════════

export class CsFloatPriceSource implements PriceSource {
  readonly id = 'csfloat' as const;

  constructor(private readonly csfloat: CsFloatService) {}

  /** True when at least one account has a CSFloat key (so this source can fetch). */
  available(): boolean { return !!this.csfloat.pricingClient(); }

  async fetchPriceCents(name: string, appid: number): Promise<number | null> {
    if (appid !== APPID_CS2) return null;             // CSFloat covers CS2 only
    const client = this.csfloat.pricingClient();
    if (!client) return null;                          // no key configured anywhere
    try {
      const res = await client.searchListings({ market_hash_name: name, sort_by: 'lowest_price', limit: 1, type: 'buy_now' });
      const first = (res.data || [])[0] as { price?: number } | undefined;
      return first && typeof first.price === 'number' ? first.price : null;
    } catch (e) {
      if ((e as CsFloatError).status === 429) throw new Error('RATE_LIMIT'); // reuse PricingService backoff
      throw e;
    }
  }
}
