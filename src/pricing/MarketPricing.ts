import axios from 'axios';
import { logger } from '../utils/logger';
import { parseSteamMoney, knownCurrencyInfo, priceTextForeignCurrency, DEFAULT_FEE_MINIMUM, type CurrencyInfo } from './currencies';
import { STEAM_BROWSER_UA, STEAM_XHR_HEADERS } from '../network/steamHeaders';

const APPID_CS2     = 730;
/** Steam currency code for EUR — the DEFAULT when a caller names no currency (dev reads,
 *  the dashboard's EUR-denominated summaries). It is no longer the only sellable currency:
 *  getSellInfo reads in whatever `PriceFetchOpts.currency` asks for, and MarketService
 *  passes each selling bot's OWN wallet currency so the number it hands market/sellitem
 *  is already in the minor units Steam will interpret it as. */
export const EUR_CURRENCY  = 3;
/** priceoverview `country` param. Verified live 2026-08-03: `currency` is authoritative
 *  regardless of country (DE + currency=6 returns "157,03 zł"), so this stays on the
 *  proven value rather than guessing a country per wallet. */
const COUNTRY       = 'DE';

const UA_CHROME  = STEAM_BROWSER_UA;

const BACKOFF_BASE_MS = 500; // exponential backoff between the two cascade tries (transient-retry only)

export type SellStrategy = 'lowest' | 'undercut' | 'custom';

export interface SellInfo {
  /** Lowest current sell-listing price, buyer-facing, in MINOR units of `currency`
   *  (euro-cents for EUR, whole yen for JPY), or null. MAY be median-derived when no
   *  live lowest ask existed — see `basis` for provenance. */
  lowestMinor:   number | null;
  /** Median sale price, buyer-facing, in MINOR units of `currency`, or null. */
  medianMinor:   number | null;
  volume:        number | null;
  /** True iff at least one cascade try got a HTTP 200 with `success === true` — i.e.
   *  Steam actually answered. A null `lowestMinor` with `authoritative:true` is a
   *  genuine "no listings"; with `authoritative:false` the price was NEVER read
   *  (all tries threw: 429 storm, proxy reset, 5xx, or a throttled `success:false`)
   *  and must NOT be cached as "no price" for the run (S2 class). */
  authoritative: boolean;
  /** Provenance of `lowestMinor`: `'lowest'` = a real live lowest ask; `'median'` =
   *  the median was substituted because no lowest ask existed; `null` = no price. */
  basis:         'lowest' | 'median' | null;
  /** Steam ECurrencyCode the two amounts above are denominated in — the currency that
   *  was REQUESTED and (per the mismatch guard) confirmed in Steam's own price text. A
   *  caller handing these minor units to market/sellitem must be listing on a wallet of
   *  exactly this currency. */
  currency:      number;
  /** Minor-unit digits of `currency` (2 for €/$/£, 0 for ¥/₩/Rp) — the scale that turns
   *  the amounts above into major units for display. */
  decimals:      number;
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
   *  sell price is read from so a TF2 item is NEVER priced off the CS2 market. */
  appid?: number;
  /** Steam ECurrencyCode the price must be READ in — for a sell, the LISTING account's own
   *  wallet currency, because market/sellitem interprets its `price` field in exactly that
   *  currency's minor units. Default EUR (3). An unrecognised code is REFUSED rather than
   *  guessed: assuming 2 decimals for a 0-decimal currency mis-scales the price 100× (S64). */
  currency?: number;
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
 * Live Steam Community Market price reader, in ANY Steam wallet currency (`opts.currency`,
 * default EUR/3).
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
    // The currency is resolved ONCE, here, and every parse + log below is scaled by it. An
    // unrecognised code never reaches a request: we cannot know its minor-unit scale, and a
    // wrong scale is a 100× mis-price on a real-money path (S64). `authoritative:false` marks
    // it as "never read" so a mass-sell DEFERS the item instead of failing it as "no price".
    const currency = opts?.currency ?? EUR_CURRENCY;
    const cInfo = knownCurrencyInfo(currency);
    if (!cInfo) {
      plog(`refusing to price "${short}" in unrecognised currency code ${currency} – minor-unit scale unknowable (add it to STEAM_CURRENCIES)`, 'warn');
      return { lowestMinor: null, medianMinor: null, volume: null, authoritative: false, basis: null, currency, decimals: 2 };
    }
    const empty = (authoritative: boolean): SellInfo =>
      ({ lowestMinor: null, medianMinor: null, volume: null, authoritative, basis: null, currency, decimals: cInfo.decimals });
    /** minor units → "12,34 PLN" for the log lines (never a hardcoded €). */
    const money = (minor: number): string => `${(minor / Math.pow(10, cInfo.decimals)).toFixed(cInfo.decimals)} ${cInfo.iso}`;
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
      plog(`[Try ${n}/${methods.length}] "${short}" → trying ${m.label} in ${cInfo.iso} [${opts?.httpsAgent ? 'proxy' : 'shared IP'}]…`);
      try {
        const info = await this.viaPriceOverview(name, opts, m.ua, timeout, m.allowMedian, cInfo);
        sawAuthoritative = true;
        if (info.lowestMinor != null) {
          plog(`[Try ${n}/${methods.length}] ✓ hit via ${m.label}: ${money(info.lowestMinor)} ` +
               `(basis ${info.basis}, method ${Date.now() - ts}ms, total ${Date.now() - t0}ms)`);
          return info;
        }
        // H-PRC-004: an allowMedian try that authoritatively returns NEITHER a lowest ask
        // NOR a median cannot be read any more permissively by a later try — return the
        // all-null (authoritative) result now instead of burning try 3 + its backoff.
        if (m.allowMedian && info.medianMinor == null) {
          plog(`[Try ${n}/${methods.length}] authoritative empty — no listings and no median; stopping cascade ` +
               `(${route}, total ${Date.now() - t0}ms)`, 'warn');
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
    // The EGRESS ROUTE is the single most diagnostic fact about a "no price" (authenticated reads sail
    // through; anonymous ones 429 on the shared pool), yet it was only ever logged on the inter-try
    // BACKOFF line — which never runs on the last try. So the one outcome the operator actually reports
    // ("sell shows no price / 0.00") produced no record of whether the read was even authenticated.
    // Name it on the terminal line too. (v1.4.4 — owner issue 3 diagnostics.)
    plog(`✗ All methods exhausted for "${short}" in ${cInfo.iso} – no price (${route}, authoritative=${sawAuthoritative}, total ${Date.now() - t0}ms)`, 'warn');
    return empty(sawAuthoritative);
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
    cInfo: CurrencyInfo,
  ): Promise<SellInfo> {
    // appid selects the market (730 CS2 default / 440 TF2 via opts.appid); currency selects the
    // DENOMINATION, and Steam honours it for both games — so a PLN bot reads PLN prices and lists
    // PLN minor units, which is precisely what market/sellitem's `price` field means.
    const url = `https://steamcommunity.com/market/priceoverview/` +
      `?country=${COUNTRY}&currency=${cInfo.code}&appid=${opts?.appid ?? APPID_CS2}&market_hash_name=${encodeURIComponent(name)}`;
    // Chromium fingerprint (Client Hints + Sec-Fetch) so Steam's bot-check doesn't 429. Spread first;
    // the de-DE Accept-Language (kept — Steam formats EUR prices by locale, the parser depends on it),
    // JSON Accept and optional Cookie win on collision.
    const headers: Record<string, string> = { ...STEAM_XHR_HEADERS, 'User-Agent': ua, Accept: 'application/json', 'Accept-Language': 'de-DE,de;q=0.9', Connection: 'close' };
    if (opts?.cookieHeader) headers.Cookie = opts.cookieHeader;
    const r = await axios.get(url, {
      timeout,
      validateStatus: () => true,
      ...(opts?.httpsAgent ? { httpsAgent: opts.httpsAgent, proxy: false as const } : {}),
      headers,
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    if (!r.data || r.data.success !== true) throw new Error(`success=${r.data?.success}`);
    const lowestText = r.data.lowest_price;
    const medianText = r.data.median_price;
    // MONEY SAFETY: priceoverview never echoes the currency it answered in, so a response that
    // came back in a DIFFERENT currency than requested is invisible in the number alone — and
    // parsing it against the wallet we're about to list on would mis-price by the whole FX rate
    // (a PLN wallet quoted EUR numbers is B11's ~99% underprice, silently). Steam's own localized
    // symbol is the one witness available; a contradiction FAILS this try (→ cascade → "no price"
    // → item skipped) rather than being priced on a guess.
    for (const text of [lowestText, medianText]) {
      const foreign = priceTextForeignCurrency(text, cInfo.iso);
      if (foreign) {
        throw new Error(`currency mismatch: asked for ${cInfo.iso} (code ${cInfo.code}) but Steam answered in ${foreign} ("${String(text).slice(0, 24)}")`);
      }
    }
    const lowest = parseSteamMoney(lowestText, cInfo.decimals);
    const median = parseSteamMoney(medianText, cInfo.decimals);
    const lowestMinor = lowest ?? (allowMedian ? median : null);
    return {
      lowestMinor,
      medianMinor:   median,
      volume:        parseVolume(r.data.volume),
      authoritative: true, // reached only on a 200 + success===true response
      // H-PRC-004: provenance of lowestMinor — a real lowest ask, or the median
      // substituted for it (line above) when no lowest ask existed, else no price.
      basis:         lowest != null ? 'lowest' : (lowestMinor != null ? 'median' : null),
      currency:      cInfo.code,
      decimals:      cInfo.decimals,
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
    const headers: Record<string, string> = { ...STEAM_XHR_HEADERS, 'User-Agent': UA_CHROME, Accept: 'application/json', 'Accept-Language': 'de-DE,de;q=0.9', Connection: 'close' };
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
    // Same wrong-currency witness as the sell path: this number is auto-filled straight into a
    // real buy order, so a response denominated in something other than the account's wallet
    // currency must be an honest error, never a silently mis-scaled bid.
    for (const text of [r.data.lowest_price, r.data.median_price]) {
      const foreign = priceTextForeignCurrency(text, cInfo.iso);
      if (foreign) throw new Error(`CURRENCY_MISMATCH: asked for ${cInfo.iso} (code ${cInfo.code}) but Steam answered in ${foreign}`);
    }
    return parseSteamMoney(r.data.lowest_price, cInfo.decimals) ?? parseSteamMoney(r.data.median_price, cInfo.decimals);
  }
}

/** Steam volume strings ("1,234") → integer, or null. */
function parseVolume(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const n = parseInt(v.replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

// ─── Steam market fee (reverse calculation) ───────────────────────────────────

/**
 * Steam fee on a sale: the seller RECEIVES `net`, the buyer PAYS
 *   net + steamFee + publisherFee,  steamFee = max(feeMin, floor(net·0.05)),
 *   publisherFee(CS2) = max(feeMin, floor(net·0.10)).
 * The market/sellitem `price` parameter is the seller's `net`, so given a target
 * BUYER price we solve for the largest net whose buyer-facing total ≤ target.
 *
 * Every amount here is MINOR units of ONE currency (euro-cents, grosz, whole yen, …) and
 * callers must never mix denominations across a single call. The PERCENTAGES are the same
 * everywhere, but the FLOOR is not: it is Steam's per-currency `wallet_fee_minimum`
 * (`CurrencyInfo.feeMinimum`), 1 in EUR/USD but 4 in PLN. On a cheap item the floor is the
 * whole fee, so passing the wrong one mis-states the buyer price — which is precisely the
 * v1.4.6 bug this parameter exists to close (a 0,38 zł net previewed as 0,42 gross, listed
 * live at 0,46). `feeMinimum` defaults to 1 so a caller in a currency we have no proven
 * value for behaves exactly as before.
 */
export function feesForNet(net: number, feeMinimum: number = DEFAULT_FEE_MINIMUM): number {
  const min = normalizeFeeMinimum(feeMinimum);
  const steam = Math.max(min, Math.floor(net * 0.05));
  const pub   = Math.max(min, Math.floor(net * 0.10));
  return steam + pub;
}

export function sellerNetFromBuyer(buyerCents: number, feeMinimum: number = DEFAULT_FEE_MINIMUM): number {
  const min = normalizeFeeMinimum(feeMinimum);
  // At or below "one minor unit of net + both fee floors" nothing bigger fits, so the seller
  // gets the single minor unit. (EUR: 3 = 1+1+1, as before. PLN: 9 = 1+4+4.)
  if (buyerCents <= 1 + 2 * min) return 1;
  let net = Math.floor(buyerCents / 1.15);
  // Walk down until the buyer-facing total fits, then up to the largest that fits.
  while (net > 1 && net + feesForNet(net, min) > buyerCents) net--;
  while (net + 1 + feesForNet(net + 1, min) <= buyerCents) net++;
  return Math.max(1, net);
}

/** A fee floor is at least one minor unit; a junk value must never widen a fee. */
function normalizeFeeMinimum(feeMinimum: number): number {
  const m = Math.floor(feeMinimum);
  return Number.isFinite(m) && m >= 1 ? m : DEFAULT_FEE_MINIMUM;
}

/**
 * Resolves the buyer-facing target price for a market-derived strategy, in MINOR units
 * of `info.currency`, or null. 'undercut' shaves ONE minor unit off the lowest ask —
 * a cent in EUR/USD, a whole yen in JPY — which is the smallest step Steam accepts in
 * each currency. ('custom' is NOT handled here — its price is a fixed seller-net amount
 * supplied by the operator, scaled into each bot's currency in MarketService.)
 */
export function targetBuyerMinor(info: SellInfo, strategy: SellStrategy): number | null {
  switch (strategy) {
    case 'lowest':   return info.lowestMinor;
    case 'undercut': return info.lowestMinor != null ? Math.max(1, info.lowestMinor - 1) : null;
    default:         return null;
  }
}
