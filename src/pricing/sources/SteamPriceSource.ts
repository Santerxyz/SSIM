import axios from 'axios';
import type { PriceSource, PriceRoute } from './PriceSource';
import { parseSteamMoney } from '../currencies';
import { STEAM_BROWSER_UA, STEAM_XHR_HEADERS } from '../../network/steamHeaders';

// Steam Community market priceoverview — USD base; the default source.
const STEAM_CURRENCY_USD = 1;

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
    // Full Chromium fingerprint (Client Hints + Sec-Fetch + Accept-Language/Encoding) so Steam's
    // bot-detection doesn't 429 the request for looking like a bare HTTP client. Spread first;
    // the JSON Accept + optional Cookie below are the money-relevant values and win on collision.
    const headers: Record<string, string> = { ...STEAM_XHR_HEADERS, 'User-Agent': STEAM_BROWSER_UA, Accept: 'application/json' };
    if (route?.cookieHeader) headers.Cookie = route.cookieHeader;
    const resp = await axios.get(url, {
      timeout: 12_000,
      headers,
      validateStatus: () => true,
      // proxy:false ALWAYS — never let an ambient HTTP(S)_PROXY env var silently re-route the call. With a
      // route we pin the account's own agent; without one (the anonymous fallback) we egress the host IP
      // directly, as the P1 design intends — NOT the shared env-proxy pool the fingerprint fix escapes.
      proxy: false as const,
      ...(route?.agent ? { httpsAgent: route.agent } : {}),
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
