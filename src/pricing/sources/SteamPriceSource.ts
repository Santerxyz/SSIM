import axios from 'axios';
import type { PriceSource } from './PriceSource';

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
    const lowest = parseUsdCents(resp.data.lowest_price);
    const median = parseUsdCents(resp.data.median_price);
    if (lowest != null && median != null) return Math.min(lowest, median);
    return lowest ?? median;
  }
}

/** "$1,234.56" → 123456 cents. USD format: '$' prefix, ',' thousands, '.' decimal. */
function parseUsdCents(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const cleaned = s.replace(/[^0-9.,]/g, '').replace(/,/g, '');
  const val = parseFloat(cleaned);
  return isNaN(val) ? null : Math.round(val * 100);
}
