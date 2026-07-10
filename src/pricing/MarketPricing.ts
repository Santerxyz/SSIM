import axios from 'axios';
import { logger } from '../utils/logger';
import { parseSteamMoney, knownCurrencyInfo } from './currencies';

const APPID_CS2     = 730;
/** Steam currency code for EUR. ALL market prices SSIM computes are EUR seller-net
 *  cents (this module hardcodes it), so a sell is only money-safe on an EUR wallet —
 *  see MarketService's wallet-currency guard (B11). Exported as the single source. */
export const EUR_CURRENCY  = 3;
const COUNTRY       = 'DE';

const UA_CHROME  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BACKOFF_BASE_MS = 500; // exponential backoff between the two cascade tries (transient-retry only)

export type SellStrategy = 'lowest' | 'undercut' | 'custom';

export interface SellInfo {
  /** Lowest current sell-listing price (buyer-facing EUR cents) or null. MAY be
   *  median-derived when no live lowest ask existed — see `basis` for provenance. */
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
  /** Provenance of `lowestCents`: `'lowest'` = a real live lowest ask; `'median'` =
   *  the median was substituted because no lowest ask existed; `null` = no price. */
  basis:         'lowest' | 'median' | null;
}

/** A per-account HTTPS agent (proxy / local-IP bound) used to route a price
 *  request through a bot's residential IP instead of the shared server IP. */
export interface PriceFetchOpts {
  /** Route the request through this agent (the selling bot's proxy) so the price read egresses on the
   *  same exit the account's cookie was issued to. */
  httpsAgent?: unknown;
  /** steamcommunity Cookie header ("steamLoginSecure=…") of the acting account (2026-07-10). An
   *  AUTHENTICATED priceoverview draws that account's per-session budget; the anonymous per-IP budget on
   *  the shared rotating pool is routinely exhausted and 429s cold. Absent → an anonymous call (dev/no
   *  session), which the sell path only reaches when no account context is available. */
  cookieHeader?: string;
  /** Wall-clock budget (ms) for the WHOLE getSellInfo cascade. When set, the loop
   *  stops before a try it can't finish inside the budget, caps each try's axios
   *  timeout to the remaining time, and skips a backoff that would cross the
   *  deadline — so an interactive caller (sell-preview) can RESPOND before its own
   *  120s client abort under a throttle storm (H-PRC-002). Unset = unbounded (the
   *  background mass-sell path is unchanged). */
  budgetMs?: number;
  /** Steam app the item belongs to — 730 (CS2, default) or 440 (TF2). Selects which market the
   *  sell price is read from so a TF2 item is NEVER priced off the CS2 market. Steam serves both
   *  games' prices in EUR at currency=3, so the EUR-wallet guard stays valid for both. */
  appid?: number;
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
 * getSellInfo hardens priceoverview — the only Steam endpoint that reliably returns a sell price
 * (listings/render is HTML-walled even when authenticated — verified live). The 2026-07-10 fix: the LEVER
 * that beats Steam's throttle is the AUTHENTICATED session cookie (`opts.cookieHeader`), not User-Agent
 * rotation — the anonymous per-IP budget on the shared rotating pool is routinely exhausted and 429s cold,
 * while the same account's authenticated reads sail through. So the old 3× UA-rotation "beat the
 * fingerprint" cascade is gone; two tries remain, and the second exists only to retry a TRANSIENT failure:
 *   Try 1  authenticated · lowest price only  (fast happy path)
 *   Try 2  authenticated · lowest OR median   (accept the median when there is no live lowest ask)
 * Exponential backoff between tries; every step is logged verbosely.
 */
export class MarketPricing {
  async getSellInfo(name: string, opts?: PriceFetchOpts): Promise<SellInfo> {
    const short = name.length > 44 ? name.slice(0, 42) + '…' : name;
    const methods: Array<{ label: string; ua: string; stepTimeout: number; allowMedian: boolean }> = [
      { label: 'priceoverview (lowest)',        ua: UA_CHROME, stepTimeout: 12_000, allowMedian: false },
      { label: 'priceoverview (lowest/median)', ua: UA_CHROME, stepTimeout: 15_000, allowMedian: true  },
    ];

    const t0 = Date.now();
    // H-PRC-002: an optional wall-clock budget lets an interactive caller (sell-preview)
    // bound the cascade so it RESPONDS before the 120s client abort under a throttle storm.
    // deadline is Infinity when no budget is set → every gate below is a no-op (background
    // mass-sell path unchanged).
    const deadline = opts?.budgetMs != null ? t0 + opts.budgetMs : Infinity;
    // A try that RETURNS (doesn't throw) got a 200 + success===true — Steam answered
    // (viaPriceOverview throws on any non-200 or success!==true). Track it so an
    // exhausted-with-no-price result is still authoritative if any try was answered.
    let sawAuthoritative = false;
    // H-PRC-003: name the egress route honestly. The lever is the account's cookie (authenticated
    // → its own per-session budget); the agent is that account's exit. An agentless / cookieless call
    // egresses anonymously from the shared IP and is what 429s — the log must not hide that.
    const route = opts?.cookieHeader
      ? (opts?.httpsAgent ? 'authenticated (account cookie + its exit)' : 'authenticated (account cookie, shared IP)')
      : (opts?.httpsAgent ? 'ANONYMOUS via proxy (no cookie)' : 'ANONYMOUS via shared IP (no cookie)');
    for (let i = 0; i < methods.length; i++) {
      const n = i + 1;
      const m = methods[i];
      // (a) Don't start a try we can't finish inside the budget (a full round-trip needs
      // headroom); stop the cascade and return what we have (authoritative iff a prior try answered).
      if (Date.now() + 2000 > deadline) {
        plog(`[Try ${n}/${methods.length}] budget exhausted for "${short}" – stopping cascade (total ${Date.now() - t0}ms)`, 'warn');
        break;
      }
      // (b) Cap this try's axios timeout to the time left in the budget.
      const timeout = Math.min(m.stepTimeout, deadline - Date.now());
      const ts = Date.now();
      plog(`[Try ${n}/${methods.length}] "${short}" → trying ${m.label} [${opts?.httpsAgent ? 'proxy' : 'shared IP'}]…`);
      try {
        const info = await this.viaPriceOverview(name, opts, m.ua, timeout, m.allowMedian);
        sawAuthoritative = true;
        if (info.lowestCents != null) {
          plog(`[Try ${n}/${methods.length}] ✓ hit via ${m.label}: ${(info.lowestCents / 100).toFixed(2)}€ ` +
               `(basis ${info.basis}, method ${Date.now() - ts}ms, total ${Date.now() - t0}ms)`);
          return info;
        }
        // H-PRC-004: an allowMedian try that authoritatively returns NEITHER a lowest ask
        // NOR a median cannot be read any more permissively by a later try — return the
        // all-null (authoritative) result now instead of burning try 3 + its backoff.
        if (m.allowMedian && info.medianCents == null) {
          plog(`[Try ${n}/${methods.length}] authoritative empty — no listings and no median; stopping cascade (total ${Date.now() - t0}ms)`, 'warn');
          return info;
        }
        plog(`[Try ${n}/${methods.length}] ✗ ${m.label}: no price in response (${Date.now() - ts}ms)`, 'warn');
      } catch (err) {
        plog(`[Try ${n}/${methods.length}] ✗ ${m.label} failed: ${describeErr(err)} (${Date.now() - ts}ms)`, 'warn');
      }
      if (i < methods.length - 1) {
        const backoff = BACKOFF_BASE_MS * 2 ** i;
        // (c) Skip the inter-try backoff (and the next try) when it would cross the deadline.
        if (Date.now() + backoff >= deadline) {
          plog(`[Try ${n}/${methods.length}] budget exhausted for "${short}" – skipping backoff (total ${Date.now() - t0}ms)`, 'warn');
          break;
        }
        plog(`[Try ${n}/${methods.length}] → Backoff ${backoff}ms (${route}), then fallback ${n + 1}…`, 'warn');
        await sleep(backoff);
      }
    }
    plog(`✗ All methods exhausted for "${short}" – no price (total ${Date.now() - t0}ms)`, 'warn');
    return { lowestCents: null, medianCents: null, volume: null, authoritative: sawAuthoritative, basis: null };
  }

  /**
   * priceoverview fetch. When `opts.cookieHeader` is present the request is AUTHENTICATED as the acting
   * account (drawing its per-session budget — the lever that beats Steam's throttle), egressing through
   * that account's `opts.httpsAgent`. `allowMedian` lets the fallback try accept the median sale price
   * when no live `lowest_price` is present (a degraded/throttled response) — a different DATA
   * interpretation, not a blind repeat.
   */
  private async viaPriceOverview(
    name: string, opts: PriceFetchOpts | undefined, ua: string, timeout: number, allowMedian: boolean,
  ): Promise<SellInfo> {
    // appid selects the market: 730 CS2 (default) or 440 TF2 (via opts.appid). currency stays EUR(3)
    // for BOTH — Steam serves TF2 prices in EUR at currency=3, keeping the EUR-wallet guard valid.
    const url = `https://steamcommunity.com/market/priceoverview/` +
      `?country=${COUNTRY}&currency=${EUR_CURRENCY}&appid=${opts?.appid ?? APPID_CS2}&market_hash_name=${encodeURIComponent(name)}`;
    const headers: Record<string, string> = { 'User-Agent': ua, Accept: 'application/json', 'Accept-Language': 'de-DE,de;q=0.9', Connection: 'close' };
    if (opts?.cookieHeader) headers.Cookie = opts.cookieHeader;
    const r = await axios.get(url, {
      timeout,
      validateStatus: () => true,
      ...(opts?.httpsAgent ? { httpsAgent: opts.httpsAgent, proxy: false as const } : {}),
      headers,
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    if (!r.data || r.data.success !== true) throw new Error(`success=${r.data?.success}`);
    const lowest = parseEurCents(r.data.lowest_price);
    const median = parseEurCents(r.data.median_price);
    const lowestCents = lowest ?? (allowMedian ? median : null);
    return {
      lowestCents,
      medianCents:   median,
      volume:        parseVolume(r.data.volume),
      authoritative: true, // reached only on a 200 + success===true response
      // H-PRC-004: provenance of lowestCents — a real lowest ask, or the median
      // substituted for it (line above) when no lowest ask existed, else no price.
      basis:         lowest != null ? 'lowest' : (lowestCents != null ? 'median' : null),
    };
  }

  /**
   * Lowest current ASK for ANY appid + currency, in MINOR units of that currency.
   * Powers the buy modal's live-price auto-fill (CS2 730 / TF2 440, native wallet
   * currency). One direct priceoverview call; null when Steam returns no price.
   */
  async getLowestAsk(
    name: string, appid: number, currency: number, opts?: PriceFetchOpts,
  ): Promise<number | null> {
    // Derive the minor-unit scale from `currency` INSIDE the module (fail closed) — never
    // trust a caller-supplied `decimals` sourced from the DISPLAY-grade currencyInfo fallback,
    // which guesses 2 for an unknown code and would mis-scale a real 0-decimal ask 100× (S64/B18).
    const cInfo = knownCurrencyInfo(currency);
    if (!cInfo) return null;
    const url = `https://steamcommunity.com/market/priceoverview/` +
      `?country=${COUNTRY}&currency=${currency}&appid=${appid}&market_hash_name=${encodeURIComponent(name)}`;
    const headers: Record<string, string> = { 'User-Agent': UA_CHROME, Accept: 'application/json', 'Accept-Language': 'de-DE,de;q=0.9', Connection: 'close' };
    if (opts?.cookieHeader) headers.Cookie = opts.cookieHeader; // authenticated → the account's own budget
    const r = await axios.get(url, {
      timeout: 12_000,
      validateStatus: () => true,
      ...(opts?.httpsAgent ? { httpsAgent: opts.httpsAgent, proxy: false as const } : {}),
      headers,
    });
    // A non-200 (5xx/403/429/login-wall) or Steam-level failure (missing body / success !== true) is
    // NOT an authoritative "no price" — it's a transient fetch failure (`success:false` is served under
    // throttle). THROW so the buy-modal autofill surfaces an honest, retryable error instead of a silent
    // empty field; the route's asyncHandler converts it to a 500 → the FE error toast. `null` then means
    // ONLY an authoritative 200 + success:true with no parseable lowest/median. (S2 parity, matches
    // SteamPriceSource.fetchPriceCents.)
    if (r.status !== 200 || !r.data || r.data.success !== true) throw new Error(`FETCH_FAILED_${r.status}`);
    return parseSteamMoney(r.data.lowest_price, cInfo.decimals) ?? parseSteamMoney(r.data.median_price, cInfo.decimals);
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
