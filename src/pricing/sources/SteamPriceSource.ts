import axios from 'axios';
import type { PriceSource } from './PriceSource';
import { parseSteamMoney } from '../currencies';

// Steam Community market priceoverview — USD base; the existing, default source.
const STEAM_CURRENCY_USD = 1;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export class SteamPriceSource implements PriceSource {
  readonly id = 'steam' as const;

  /** Lowest_price (USD cents) from Steam's priceoverview; null if none. */
  async fetchPriceCents(name: string, appid: number): Promise<number | null> {
    const url = `https://steamcommunity.com/market/priceoverview/` +
      `?appid=${appid}&currency=${STEAM_CURRENCY_USD}&market_hash_name=${encodeURIComponent(name)}`;
    const resp = await axios.get(url, {
      timeout: 12_000,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      validateStatus: () => true,
    });
    if (resp.status === 429) throw new Error('RATE_LIMIT');
    // A non-200 (5xx/403/…) or Steam-level failure (missing body / success !== true) is NOT an
    // authoritative "no price" — it's a transient fetch failure. THROW so PricingService caches only
    // a short-lived miss, instead of a 24h "no price" that survives restart. Authoritative "no price"
    // is a 200 + success:true with no lowest/median → the null returned below. (S2)
    if (resp.status !== 200 || !resp.data || resp.data.success !== true) {
      throw new Error(`FETCH_FAILED_${resp.status}`);
    }
    // Take the LOWER of lowest-listing vs median-sale when both exist — a thin market's
    // lowest_price is volatile (one overpriced listing briefly inflates it); the median is
    // stable, so the min resists spikes without under-valuing liquid items.
    // USD is a 2-decimal currency; delegate to the shared, separator-detecting parser so a Steam
    // locale-format flip (comma-decimal "1,23", grouped "2.500,00") parses correctly instead of
    // mis-scaling 100× like the old rigid ','=thousands / '.'=decimal heuristic. (#32)
    const lowest = parseSteamMoney(resp.data.lowest_price, 2);
    const median = parseSteamMoney(resp.data.median_price, 2);
    if (lowest != null && median != null) return Math.min(lowest, median);
    return lowest ?? median;
  }
}
