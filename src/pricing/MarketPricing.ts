import axios from 'axios';
import { logger } from '../utils/logger';
import { parseSteamMoney } from './currencies';

const APPID_CS2     = 730;
/** Steam currency code for EUR. ALL market prices SSIM computes are EUR seller-net
 *  cents (this module hardcodes it), so a sell is only money-safe on an EUR wallet —
 *  see MarketService's wallet-currency guard (B11). Exported as the single source. */
export const EUR_CURRENCY  = 3;
const COUNTRY       = 'DE';

// Distinct User-Agents per cascade step – varying the UA (plus a fresh proxy IP
// per request) is what actually beats Steam's per-fingerprint rate limit.
const UA_CHROME  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UA_FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0';
const UA_MOBILE  = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

const BACKOFF_BASE_MS = 500; // exponential backoff between cascade tries (500 → 1000)

export type SellStrategy = 'lowest' | 'undercut' | 'custom';

export interface SellInfo {
  /** Lowest current sell-listing price (buyer-facing EUR cents) or null. */
  lowestCents:   number | null;
  /** Median sell price (buyer-facing EUR cents) or null. */
  medianCents:   number | null;
  volume:        number | null;
  /** True iff at least one cascade try got a HTTP 200 with `success === true` — i.e.
   *  Steam actually answered. A null `lowestCents` with `authoritative:true` is a
   *  genuine "no listings"; with `authoritative:false` the price was NEVER read
   *  (all tries threw: 429 storm, proxy reset, 5xx, or a throttled `success:false`)
   *  and must NOT be cached as "no price" for the run (S2 class). */
  authoritative: boolean;
}

/** A per-account HTTPS agent (proxy / local-IP bound) used to route a price
 *  request through a bot's residential IP instead of the shared server IP. */
export interface PriceFetchOpts {
  /** Route the request through this agent (bot proxy) – avoids Steam's per-IP
   *  rate limit on the shared local IP, the #1 cause of "no price". */
  httpsAgent?: unknown;
  /** The bot's web-session cookies – required for the listings/render fallback,
   *  which Steam serves as an HTML login wall to anonymous requests. */
  cookies?: string[];
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Verbose, prefixed price-module log line (timestamp is added by the logger). */
function plog(msg: string, level: 'info' | 'warn' = 'info'): void {
  logger[level](`[price] ${msg}`);
}

/** Human-readable failure reason: HTTP status / network code / message. */
function describeErr(err: unknown): string {
  const e = err as { response?: { status?: number }; code?: string; message?: string };
  if (e?.response?.status) return `HTTP ${e.response.status}`;
  if (e?.code) return `${e.code}${e.message ? ` (${e.message})` : ''}`;
  return e?.message ?? String(err);
}

/**
 * Live Steam Community Market price reader (EUR / currency=3).
 *
 * getSellInfo runs a 3-step CASCADE. A retry is worthless if it just repeats the
 * exact same failing call, so each step changes the levers that actually matter
 * for Steam's throttle: a DIFFERENT User-Agent (fingerprint) and — with a bot
 * httpsAgent + `Connection: close` — a FRESH rotating-proxy exit IP per request.
 * priceoverview is the only Steam endpoint that reliably returns a sell price
 * (listings/render is HTML-walled even when authenticated — verified live), so
 * the cascade hardens THAT call instead of chasing dead endpoints:
 *   Try 1  Chrome UA            · lowest price only      (fast happy path)
 *   Try 2  Firefox UA, fresh IP · lowest OR median       (Fallback 1)
 *   Try 3  Mobile UA, fresh IP  · lowest OR median, 20s   (aggressive last resort)
 * Exponential backoff between tries; every step is logged verbosely.
 */
export class MarketPricing {
  async getSellInfo(name: string, opts?: PriceFetchOpts): Promise<SellInfo> {
    const short = name.length > 44 ? name.slice(0, 42) + '…' : name;
    const methods: Array<{ label: string; run: () => Promise<SellInfo> }> = [
      { label: 'priceoverview (Chrome)',           run: () => this.viaPriceOverview(name, opts, UA_CHROME,  12_000, false) },
      { label: 'priceoverview (Firefox+Median)',   run: () => this.viaPriceOverview(name, opts, UA_FIREFOX, 15_000, true)  },
      { label: 'priceoverview (Mobile, aggressiv)',run: () => this.viaPriceOverview(name, opts, UA_MOBILE,  20_000, true)  },
    ];

    const t0 = Date.now();
    // A try that RETURNS (doesn't throw) got a 200 + success===true — Steam answered
    // (viaPriceOverview throws on any non-200 or success!==true). Track it so an
    // exhausted-with-no-price result is still authoritative if any try was answered.
    let sawAuthoritative = false;
    for (let i = 0; i < methods.length; i++) {
      const n = i + 1;
      const m = methods[i];
      const ts = Date.now();
      plog(`[Try ${n}/3] "${short}" → trying ${m.label}…`);
      try {
        const info = await m.run();
        sawAuthoritative = true;
        if (info.lowestCents != null) {
          plog(`[Try ${n}/3] ✓ hit via ${m.label}: ${(info.lowestCents / 100).toFixed(2)}€ ` +
               `(method ${Date.now() - ts}ms, total ${Date.now() - t0}ms)`);
          return info;
        }
        plog(`[Try ${n}/3] ✗ ${m.label}: no price in response (${Date.now() - ts}ms)`, 'warn');
      } catch (err) {
        plog(`[Try ${n}/3] ✗ ${m.label} failed: ${describeErr(err)} (${Date.now() - ts}ms)`, 'warn');
      }
      if (i < methods.length - 1) {
        const backoff = BACKOFF_BASE_MS * 2 ** i;
        plog(`[Try ${n}/3] → Backoff ${backoff}ms (fresh IP + different UA), then fallback ${n + 1}…`, 'warn');
        await sleep(backoff);
      }
    }
    plog(`✗ All 3 methods exhausted for "${short}" – no price (total ${Date.now() - t0}ms)`, 'warn');
    return { lowestCents: null, medianCents: null, volume: null, authoritative: sawAuthoritative };
  }

  /**
   * priceoverview fetch. `ua` varies the fingerprint and (with a proxy agent +
   * Connection:close) each call lands on a fresh exit IP. `allowMedian` lets the
   * fallback tries accept the median sale price when no live `lowest_price` is
   * present (a degraded/throttled response) – a different DATA interpretation,
   * not a blind repeat.
   */
  private async viaPriceOverview(
    name: string, opts: PriceFetchOpts | undefined, ua: string, timeout: number, allowMedian: boolean,
  ): Promise<SellInfo> {
    const url = `https://steamcommunity.com/market/priceoverview/` +
      `?country=${COUNTRY}&currency=${EUR_CURRENCY}&appid=${APPID_CS2}&market_hash_name=${encodeURIComponent(name)}`;
    const r = await axios.get(url, {
      timeout,
      validateStatus: () => true,
      ...(opts?.httpsAgent ? { httpsAgent: opts.httpsAgent, proxy: false as const } : {}),
      headers: { 'User-Agent': ua, Accept: 'application/json', 'Accept-Language': 'de-DE,de;q=0.9', Connection: 'close' },
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    if (!r.data || r.data.success !== true) throw new Error(`success=${r.data?.success}`);
    const lowest = parseEurCents(r.data.lowest_price);
    const median = parseEurCents(r.data.median_price);
    return {
      lowestCents:   lowest ?? (allowMedian ? median : null),
      medianCents:   median,
      volume:        parseVolume(r.data.volume),
      authoritative: true, // reached only on a 200 + success===true response
    };
  }

  /**
   * Lowest current ASK for ANY appid + currency, in MINOR units of that currency.
   * Powers the buy modal's live-price auto-fill (CS2 730 / TF2 440, native wallet
   * currency). One direct priceoverview call; null when Steam returns no price.
   */
  async getLowestAsk(
    name: string, appid: number, currency: number, decimals: number, opts?: PriceFetchOpts,
  ): Promise<number | null> {
    const url = `https://steamcommunity.com/market/priceoverview/` +
      `?country=${COUNTRY}&currency=${currency}&appid=${appid}&market_hash_name=${encodeURIComponent(name)}`;
    const r = await axios.get(url, {
      timeout: 12_000,
      validateStatus: () => true,
      ...(opts?.httpsAgent ? { httpsAgent: opts.httpsAgent, proxy: false as const } : {}),
      headers: { 'User-Agent': UA_CHROME, Accept: 'application/json', 'Accept-Language': 'de-DE,de;q=0.9', Connection: 'close' },
    });
    // A non-200 (5xx/403/429/login-wall) or Steam-level failure (missing body / success !== true) is
    // NOT an authoritative "no price" — it's a transient fetch failure (`success:false` is served under
    // throttle). THROW so the buy-modal autofill surfaces an honest, retryable error instead of a silent
    // empty field; the route's asyncHandler converts it to a 500 → the FE error toast. `null` then means
    // ONLY an authoritative 200 + success:true with no parseable lowest/median. (S2 parity, matches
    // SteamPriceSource.fetchPriceCents.)
    if (r.status !== 200 || !r.data || r.data.success !== true) throw new Error(`FETCH_FAILED_${r.status}`);
    return parseSteamMoney(r.data.lowest_price, decimals) ?? parseSteamMoney(r.data.median_price, decimals);
  }
}

/** Steam volume strings ("1,234") → integer, or null. */
function parseVolume(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const n = parseInt(v.replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

/** "1,23€" → 123 · "1.234,56€" → 123456 (EUR format: '.' thousands, ',' decimal). */
export function parseEurCents(s: unknown): number | null {
  // Delegate to the robust, separator-detecting parser (#32) instead of a rigid
  // '.'=thousands / ','=decimal assumption that mis-scales a format deviation by 100×.
  // EUR is a 2-decimal currency.
  return parseSteamMoney(s, 2);
}

// ─── Steam market fee (reverse calculation) ───────────────────────────────────

/**
 * Steam fee on a sale: the seller RECEIVES `net`, the buyer PAYS
 *   net + steamFee + publisherFee,  steamFee = max(1, floor(net·0.05)),
 *   publisherFee(CS2) = max(1, floor(net·0.10)).
 * The market/sellitem `price` parameter is the seller's `net`, so given a target
 * BUYER price we solve for the largest net whose buyer-facing total ≤ target.
 */
export function feesForNet(net: number): number {
  const steam = Math.max(1, Math.floor(net * 0.05));
  const pub   = Math.max(1, Math.floor(net * 0.10));
  return steam + pub;
}

export function sellerNetFromBuyer(buyerCents: number): number {
  if (buyerCents <= 3) return 1; // below the minimum fee floor → seller gets 1 cent
  let net = Math.floor(buyerCents / 1.15);
  // Walk down until the buyer-facing total fits, then up to the largest that fits.
  while (net > 1 && net + feesForNet(net) > buyerCents) net--;
  while (net + 1 + feesForNet(net + 1) <= buyerCents) net++;
  return Math.max(1, net);
}

/**
 * Resolves the buyer-facing target price (EUR cents) for a market-derived
 * strategy, or null. ('custom' is NOT handled here — its price is a fixed
 * seller-net amount supplied by the operator, applied directly in MarketService.)
 */
export function targetBuyerCents(info: SellInfo, strategy: SellStrategy): number | null {
  switch (strategy) {
    case 'lowest':   return info.lowestCents;
    case 'undercut': return info.lowestCents != null ? Math.max(1, info.lowestCents - 1) : null;
    default:         return null;
  }
}
