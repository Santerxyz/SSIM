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

  /** True when at least one account has a CSFloat key (so this source can fetch).
   *  Uses the side-effect-free hasAnyKey() probe, not the client factory pricingClient(). */
  available(): boolean { return this.csfloat.hasAnyKey(); }

  async fetchPriceCents(name: string, appid: number): Promise<number | null> {
    if (appid !== APPID_CS2) return null;             // CSFloat covers CS2 only
    const client = this.csfloat.pricingClient();
    // No client at dequeue is a transient source-availability condition (key cleared mid-fill),
    // NOT an authoritative "no price" — throw so PricingService caches a short soft miss (→ retry
    // in minutes / re-queue under the new active source), never a hard 24h null here (S2/S13).
    if (!client) throw new Error('FETCH_FAILED_NO_CLIENT');
    try {
      const res = await client.searchListings({ market_hash_name: name, sort_by: 'lowest_price', limit: 1, type: 'buy_now' });
      // Validate the 2xx body shape before deriving a price: CsFloatClient casts res.data unchecked
      // (validateStatus:()=>true), so a 200 HTML interstitial / drifted shape must be a transient THROW
      // (→ short soft miss), NOT a hard null cached as an authoritative 24h "no price" (S2).
      if (!res || !Array.isArray(res.data)) throw new Error('FETCH_FAILED_SHAPE');
      if (res.data.length === 0) return null;            // authoritative: no buy-now listing for this name
      const p = (res.data[0] as { price?: unknown }).price;
      if (typeof p !== 'number' || !Number.isFinite(p) || p < 0) throw new Error('FETCH_FAILED_PRICE');
      return p;
    } catch (e) {
      if ((e as CsFloatError).status === 429) throw new Error('RATE_LIMIT'); // reuse PricingService backoff
      throw e;
    }
  }
}
