import axios from 'axios';
import type { PriceSource, PriceRoute } from './PriceSource';
import { parseSteamMoney } from '../currencies';

// Steam Community market priceoverview — USD base; the default source.
const STEAM_CURRENCY_USD = 1;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export class SteamPriceSource implements PriceSource {
  readonly id = 'steam' as const;

  /** Steam's priceoverview is reachable in principle; PricingService supplies the identity. */
  available(): boolean { return true; }

  /**
   * Lowest_price (USD cents) from Steam's priceoverview; null if none.
   *
   * The 2026-07-10 fix: when `route.cookieHeader` is present the request is AUTHENTICATED as a
   * logged-in account (drawing that account's per-session budget instead of the anonymous per-IP
   * budget the shared rotating pool leaves exhausted), and egresses through `route.agent` — the
   * exit that cookie was issued to. `proxy:false` stops axios double-routing via env proxies.
   * An anonymous call (no cookieHeader) is still possible for the money-path/dev paths, but the
   * background fill no longer issues one — it defers until an identity is web-ready.
   */
  async fetchPriceCents(name: string, appid: number, route?: PriceRoute): Promise<number | null> {
    const url = `https://steamcommunity.com/market/priceoverview/` +
      `?appid=${appid}&currency=${STEAM_CURRENCY_USD}&market_hash_name=${encodeURIComponent(name)}`;
    const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'application/json' };
    if (route?.cookieHeader) headers.Cookie = route.cookieHeader;
    const resp = await axios.get(url, {
      timeout: 12_000,
      headers,
      validateStatus: () => true,
      ...(route?.agent ? { httpsAgent: route.agent, proxy: false as const } : {}),
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
