import type { TradeService } from './TradeService';
import type { InventoryService } from '../core/InventoryService';
import type { MarketOrders } from './AccountTrader';
import { MarketPricing, sellerNetFromBuyer, targetBuyerMinor, feesForNet, EUR_CURRENCY, type SellStrategy } from '../pricing/MarketPricing';
import { knownCurrencyInfo, type CurrencyInfo } from '../pricing/currencies';
import type { PricerIdentity } from '../pricing/PricerIdentityPool';
import { scaleConcurrency, clampConcurrency } from '../utils/concurrency';
import { isSellable } from '../core/MarketModel';
import { MoneyOps, assetKey as moneyKey } from './MoneyOps';
import { logger } from '../utils/logger';
import { classifyNetworkError } from '../utils/errorClass';
import type { GameId } from '../types/inventory';

// The two Steam apps SSIM sells on; both use market context id 2. A mass-sell run/group carries the
// appId so pricing, the market/sellitem POST, and already-listed detection all target the SAME game.
const CS2_APPID = 730;
const TF2_APPID = 440;
const gameForApp = (appId: number): GameId => (appId === TF2_APPID ? 'tf2' : 'cs2');

/** A price-read egress context: route through this account's agent (its exit) and cookie (its
 *  authenticated priceoverview budget). Empty ({}) means an anonymous read (avoided for the fill). */
type PriceCtx = { httpsAgent?: unknown; cookieHeader?: string };

/** ms budget for a BOUNDED getTrader in the price path — a login parked in the global login-concurrency
 *  queue must NOT stall a price read (v1.4.5). Longer than a healthy login (~5s), far shorter than the
 *  preview's own 90s budget, so a jammed login queue de-prioritises to the pool/anonymous fast. Read at
 *  call time so tests can shrink it via SSIM_GETTRADER_BUDGET_MS. */
function getTraderBudgetMs(): number { return Number(process.env.SSIM_GETTRADER_BUDGET_MS) || 6_000; }

/** Reject after `ms` if `p` hasn't settled. The awaited work keeps running in the background (a parked
 *  login still completes and caches its session) — we simply stop WAITING on it for this read. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// Listing concurrency scales with the batch (scaleConcurrency: 1 worker / 5 bots, floor 5,
// ceiling 25). Per-bot anti-spam pacing (item/bot delays) still applies inside each worker.
const DEFAULT_ITEM_DELAY  = 1_200; // pause between a bot's individual listings
const MIN_ITEM_DELAY       = 500;  // hard floor: a client can raise the pause, never remove it (B45 anti-storm)
const DEFAULT_BOT_DELAY    = 3_000; // pause between bots per worker

// ── Stability tuning (Rules 1-3) ──────────────────────────────────────────────
const MAX_SELL_RETRIES   = 3;                       // retries per item on transient errors
const SELL_BACKOFF_MS    = [15_000, 25_000, 35_000]; // backoff before each retry
const PREFLIGHT_RETRIES  = 2;                       // connectivity-probe retries before deferring a bot
const PREFLIGHT_BACKOFF_MS = 8_000;
const CONFIRM_RETRIES    = 3;                       // 2FA-confirmation retries (Steam's confirm servers 500 a lot)
const CONFIRM_BACKOFF_MS = 18_000;                  // pause between confirmation retries (5xx / transport)
// A 429 needs the rate-limit WINDOW to elapse, not a transport backoff. Retrying inside the window is
// both futile and harmful (each attempt re-arms it), so: long pause, few attempts. Mirrors the long-pause
// branch InventoryService already applies to `rateLimited` (RETRY_PAUSE_RATELIMIT).
const CONFIRM_RATELIMIT_PAUSE_MS  = 65_000;
const CONFIRM_RATELIMIT_JITTER_MS = 15_000;         // de-sync the fleet's retries
const CONFIRM_RATELIMIT_RETRIES   = 2;              // ≤3 getlist calls total, not 4 inside one window

/** How long a sell waits for the login 'wallet' event before giving up on the currency. */
const WALLET_WAIT_MS = 5_000;

/**
 * Money-safety gate (B11, generalised in v1.4.5). Steam's market/sellitem interprets its
 * `price` field in the SELLER's OWN wallet currency's minor units — so the ONE thing that
 * matters is that the number we send was READ in that same currency. SSIM now prices every
 * listing in the selling bot's native currency (priceoverview `currency=<the bot's code>`),
 * which is why a PLN/RUB/USD wallet is no longer refused: it is quoted, fee'd and listed in
 * PLN/RUB/USD end to end. The old "EUR or nothing" rule listed EUR cents on a foreign wallet
 * (10,00€ read as ~10 RUB — a ~99% underprice that sells instantly), and blocking was the
 * only safe answer while the quote was hardcoded to EUR; it isn't any more.
 *
 * What remains fail-CLOSED is the currency being UNKNOWABLE, in any of three shapes:
 *  - `undefined` — the 'wallet' event hasn't arrived (or never fires this session). Pricing
 *    in a guessed currency is exactly the underprice above, so the caller waits for the event
 *    (WALLET_WAIT_MS) and then blocks. This closes OQ-B1's fail-open hole, where a genuinely
 *    foreign wallet read `undefined` for a moment right after ensureWebSession and got the
 *    EUR path.
 *  - `0` (ECurrencyCode.Invalid) — a never-funded account has no wallet at all, and the
 *    currency a first top-up would mint is unknowable. Named honestly, not as a foreign wallet.
 *  - an unrecognised code — could be a 0-decimal currency, and assuming 2 decimals mis-scales
 *    the listing 100× (S64).
 */
export function sellWalletBlocked(walletCurrency: number | undefined): boolean {
  return knownCurrencyInfo(walletCurrency) == null;
}

/**
 * Classifies a Steam/network error as transient (retry) vs. hard (give up).
 * H-XCT-001: the verdict comes from the ONE shared taxonomy (src/utils/errorClass),
 * so the same broken-pipe/proxy blip retries here, on refresh, and on the money-commit
 * path alike. `transient` folds in the 429/rate-limit tokens (a sell retry treats both
 * the same); the retry-count cap below is unchanged.
 */
function isTransient(err: unknown): boolean {
  return classifyNetworkError(err).transient;
}

/** A "the listing already exists" style rejection → the item IS listed (phantom). Exported for tests. */
export function isAlreadyListed(err: unknown): boolean {
  const m = ((err as Error)?.message ?? '').toLowerCase();
  // S63: require a COMPOUND match — a market/listing NOUN and an "already/exists" QUALIFIER must BOTH be
  // present. The old bare tokens (`already`, `listed`, `aktiv`, `vorhanden`, `bereits`) were far too broad:
  // a single one fires on unrelated localized errors (e.g. "already rate-limited", "listed as untradable"),
  // mis-bucketing an Owned item as Listed. Steam localizes to the bot's display language, so the German
  // listing nouns (Angebot/Inserat) + qualifiers (bereits/vorhanden/aktiv/existiert) are matched on purpose.
  const listingNoun = /listing|listed|angebot|verkaufsangebot|inserat/;
  const alreadyQual = /already|pending|bereits|vorhanden|aktiv|existiert|besteht/;
  return listingNoun.test(m) && alreadyQual.test(m);
}

/**
 * "The item is no longer in your inventory / not allowed to be traded on the Community
 * Market" → the asset is GONE (already moved/sold/listed elsewhere). This is NOT a genuine
 * failure: it means the candidate set was stale, so it is reported as `gone`, not `failed`,
 * and never retried. Steam localizes it, so match the stable English keywords leniently.
 */
function isGone(err: unknown): boolean {
  const m = ((err as Error)?.message ?? '').toLowerCase();
  return /no longer in your inventory|not allowed to be traded|is not in your inventory|nicht mehr in deinem inventar/.test(m);
}

/** One bot's slice of a mass-sell: its selected assets + their market names. */
export interface MassSellGroup {
  username: string;
  /** Steam app of THIS group's items — 730 (CS2) or 440 (TF2). Missing ⇒ 730 (backward-compat;
   *  a pre-TF2 client only ever sold CS2). One group = one game (the API stamps a single appId). */
  appId?:   number;
  items:    Array<{ assetId: string; marketHashName: string }>;
}

export interface MassSellJob {
  running:     boolean;
  /** Operator pressed "End Task" — the run is winding down (no new listings created). */
  cancelling?: boolean;
  /** The run ended because it was cancelled (remaining items were skipped). */
  cancelled?:  boolean;
  strategy:    SellStrategy;
  total:       number;   // total assets to list
  done:        number;   // assets processed (terminal state reached)
  listed:      number;   // listings created (incl. recovered phantoms)
  confirmed:   number;   // listings confirmed via 2FA
  recovered:   number;   // phantom listings recovered after a timeout
  retried:     number;   // total retry attempts performed
  skippedNoPrice: number;
  /** Genuine, non-recoverable failures. */
  failed:      Array<{ username: string; assetId: string; error: string }>;
  /** Connection/pre-flight issues – NOT attempted or aborted; safe to retry later. */
  deferred:    Array<{ username: string; assetId: string; error: string }>;
  /** Asset was no longer in the inventory (already moved/sold/listed) – stale candidate,
   *  not a real failure and not retryable. */
  gone:        Array<{ username: string; assetId: string; error: string }>;
  /** Asset is trade-locked or non-tradable per the cached inventory – refused by the
   *  pre-list guard so a locked item can never become an active sell listing (INV-B2/D1). */
  blocked:     Array<{ username: string; assetId: string; error: string }>;
  /** Live progress for the UI so the operator isn't staring at a blank bar. */
  currentBot?: string;
  /** Every bot currently inside processBot (H-TRD-020) — lets the UI list the workers
   *  actually in flight instead of the single last-touched `currentBot` flapping past. */
  activeBots?: string[];
  phase?:      'preflight' | 'listing' | 'confirming' | 'done';
  startedAt?:  string;
  finishedAt?: string;
}

/**
 * Sell-modal price preview. Every amount is MINOR units of `currency` — the wallet the
 * preview was quoted for — so the client formats with that currency's own symbol and
 * decimals instead of a hardcoded €. ADVISORY ONLY: the committed price is re-read per
 * bot, in that bot's own currency, at list time (see resolveNet).
 */
export interface SellPreview {
  /** Steam ECurrencyCode every amount below is denominated in. */
  currency:    number;
  currencyIso: string;
  decimals:    number;
  /** True when `currency` came from an actual known wallet; false when nothing was
   *  resolvable and the quote fell back to EUR, which the client should say out loud. */
  resolved:    boolean;
  prices:      Record<string, { netMinor: number | null; buyerMinor: number | null }>;
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

/**
 * Orchestrates mass-selling selected items on the Steam Community Market — the
 * sell-side counterpart to TradeService.startMassSend. Each bot lists its own assets
 * through its isolated session, priced by MarketPricing in THAT BOT'S OWN wallet
 * currency (the only denomination market/sellitem will read the price as), and every
 * listing is auto-confirmed via 2FA in one batch per bot. Paced via a small worker
 * pool so we never burst-spam Steam.
 */
export class MarketService {
  private readonly pricing = new MarketPricing();
  private job: MassSellJob = {
    running: false, strategy: 'lowest', total: 0, done: 0, listed: 0,
    confirmed: 0, recovered: 0, retried: 0, skippedNoPrice: 0, failed: [], deferred: [], gone: [], blocked: [],
  };
  // Tuning knobs (overridable per run; defaults from the consts above).
  private retryBackoffs = SELL_BACKOFF_MS;
  private preflightBackoff = PREFLIGHT_BACKOFF_MS;
  private confirmBackoff = CONFIRM_BACKOFF_MS;
  private confirmRateLimitPause = CONFIRM_RATELIMIT_PAUSE_MS;
  /** Co-operative cancel flag for the live mass-sell (set by cancelSell()). */
  private cancelRequested = false;
  /** H-TRD-020: bots currently executing processBot, mirrored into job.activeBots for the UI.
   *  Lazily created on first use (see trackBotActive). */
  private activeBotSet?: Set<string>;

  constructor(
    private readonly trades: TradeService,
    /** Lets a completed sell move the just-listed assets Owned→Listed in the cache
     *  immediately (optimistic), instead of relying on a clean follow-up refresh. */
    private readonly inventory?: InventoryService,
    /** Live authenticated PRICER IDENTITIES — the same pool the background price fill uses
     *  (sessions.pricerIdentities). Preview + buy-autofill borrow one when the acting account isn't
     *  web-ready, so an EUR price READ stays authenticated instead of falling to an anonymous host-IP
     *  call that 429s → "no price". NEVER used to COMMIT a sell (that re-prices via the bot's own cookie). */
    private readonly pricerIdentities?: () => PricerIdentity[],
  ) {}

  status(): MassSellJob {
    return { ...this.job, failed: [...this.job.failed], deferred: [...this.job.deferred], gone: [...this.job.gone], blocked: [...this.job.blocked] };
  }

  /** True while a mass-sell is running — gates a mid-session update swap (S14): a swap hard-exits the
   *  process and would interrupt unconfirmed 2FA listings. */
  busy(): boolean { return this.job.running; }

  /**
   * Pre-list guard (INV-B2 / INV-D1 / C3): the set of asset ids in the cached inventory
   * that must never reach `sellOnMarket` — trade-locked or non-tradable stacks, so a
   * locked item never surfaces as an active sell order. Built ONCE per bot (H-TRD-021)
   * from a single `getCached` snapshot (which deep-clones the whole record, INV-B12), not
   * once per item, so a mass-sell of K items costs one clone + one scan instead of K.
   * `undefined` when the account has no cached inventory: with no record we defer to Steam
   * (every asset treated as sellable), since the pre-flight already proved connectivity and
   * `gone` handling covers staleness. An asset absent from the returned set is likewise
   * sellable — the cache simply has no record of it (same defer-to-Steam semantics).
   * A malformed disk-cached record (non-array `items`) throws here exactly as the old
   * per-item `inv.items.find(...)` did — H-TRD-024 contains that throw as one `failed` row.
   */
  private buildUnsellableIndex(username: string, game: GameId = 'cs2'): Set<string> | undefined {
    const inv = this.inventory?.getCached(username, game);
    if (!inv) return undefined;
    const unsellable = new Set<string>();
    inv.items.forEach(stack => {
      if (isSellable(stack)) return;
      for (const id of stack.assetIds ?? []) unsellable.add(String(id));
    });
    return unsellable;
  }

  /** Lowest market ask (minor units of `currency`) for the buy modal's live-price
   *  button. Delegates to the pricing engine; null when no price is found. Routed through
   *  the buying account so the read is AUTHENTICATED (its own priceoverview budget) — an
   *  anonymous read 429s cold on the shared pool. (2026-07-10) */
  async lowestAsk(name: string, appid: number, currency: number, username?: string): Promise<number | null> {
    const ctx = await this.priceCtxFor(username);
    return this.pricing.getLowestAsk(name, appid, currency, ctx);
  }

  // ── Active Orders: fetch + cancel (sell listings & buy orders) ──────────────

  /** All open market orders (both sides, all games) for one account – the data
   *  behind the "Active Orders" dashboard tab. Routed through the bot's session. */
  async getOrders(username: string): Promise<MarketOrders> {
    const trader = await this.trades.getTrader(username);
    return trader.getMarketOrders();
  }

  /** Cancels one active SELL listing on the Steam market for `username`. */
  async cancelListing(username: string, listingId: string): Promise<void> {
    const trader = await this.trades.getTrader(username);
    await trader.cancelMarketListing(listingId);
  }

  /** Cancels one active BUY order on the Steam market for `username`. */
  async cancelBuyOrder(username: string, buyOrderId: string): Promise<void> {
    const trader = await this.trades.getTrader(username);
    await trader.cancelBuyOrder(buyOrderId);
  }

  private static readonly EMPTY_CTX: PriceCtx = {};

  /** Resolves a bot's price-fetch context so price checks egress via its IP AND carry its session
   *  cookie (authenticated priceoverview → the account's own budget; anonymous reads 429 cold on the
   *  shared pool — 2026-07-10). Single-context form (buy-modal autofill); returns the FIRST of
   *  priceCtxsFor, so it inherits the pricer-identity fallback below. */
  private async priceCtxFor(username?: string): Promise<PriceCtx> {
    return (await this.priceCtxsFor(username, 1))[0] ?? MarketService.EMPTY_CTX;
  }

  /**
   * Resolves up to `max` AUTHENTICATED price-fetch contexts for a price read.
   *
   * ORDER MATTERS (v1.4.5 fix). A price read must NEVER block on a fresh login: the acting account's
   * getTrader() would call loginAccount(), which parks in the GLOBAL login-concurrency FIFO queue
   * (MAX_CONCURRENT_LOGINS). During a "Refresh all" that queue is full, so the whole sell preview
   * hung there — never reaching getSellInfo — until the client's 120s timeout → every row "no price".
   * So we take identities in this order:
   *   1. The ALREADY-LIVE pricer pool (non-blocking) — includes the acting account if it is web-ready,
   *      plus others, so a multi-name preview spreads across several accounts' budgets + exits.
   *   2. ONLY if the live pool can't fill the lanes, a BOUNDED getTrader(username) — abandoned after
   *      GET_TRADER_BUDGET_MS so a queued login can't stall the read (the login still completes in the
   *      background; we just don't wait). Skipped entirely when the pool already provided enough.
   * The caller (preview) then falls back to ONE anonymous lane if this returns empty — anonymous
   * priceoverview works (the browser fingerprint fix), so a read is never blocked, only de-prioritised.
   *
   * Money-safety: this only decides WHOSE per-session budget + exit a READ draws — NOT the
   * denomination. The currency is an explicit priceoverview parameter, so borrowing a PLN bot's
   * cookie to read a EUR quote (or vice versa) is harmless. The COMMITTED sell price is re-resolved
   * via the SELLING bot's own cookie AND its own wallet currency in resolveNet — never one of these
   * borrowed preview contexts.
   */
  private async priceCtxsFor(username?: string, max = 1): Promise<PriceCtx[]> {
    const out: PriceCtx[] = [];
    const seen = new Set<string>(); // de-dup by cookie so one account never fills two lanes
    // 1) Already-live identities — NON-BLOCKING, never queues behind a fleet refresh's logins.
    if (this.pricerIdentities) {
      for (const id of this.pricerIdentities()) {
        if (out.length >= max) break;
        if (id.cookieHeader && !seen.has(id.cookieHeader)) { out.push({ httpsAgent: id.agent, cookieHeader: id.cookieHeader }); seen.add(id.cookieHeader); }
      }
    }
    // 2) Only if the live pool didn't fill the lanes: a BOUNDED login of the acting account. Bounding it
    //    means a login parked in the concurrency queue can't hang the price read (it finishes later).
    if (out.length < max && username) {
      const budget = getTraderBudgetMs();
      try {
        const trader = await withTimeout(this.trades.getTrader(username), budget);
        if (trader?.cookieHeader && !seen.has(trader.cookieHeader)) { out.push({ httpsAgent: trader.httpsAgent, cookieHeader: trader.cookieHeader }); seen.add(trader.cookieHeader); }
      } catch (err) {
        logger.info(`[market-price] ${username} not web-ready in ${budget}ms (${(err as Error).message}) — pricing via the pool / anonymously`);
      }
    }
    return out;
  }

  /**
   * The currency a PREVIEW is quoted in. Advisory, so unlike the commit path it may fall back:
   * the client's `currency` (it knows the selection's wallets) wins when it is a code we
   * recognise, then the acting account's CACHED wallet — deliberately cache-only, because a
   * preview must never block on a login or a wallet event — and finally EUR, flagged
   * `resolved:false` so the modal can say the quote is an assumption. A real listing never
   * uses this: processBot re-resolves the currency per bot and BLOCKS when it can't.
   */
  private previewCurrency(username?: string, requested?: number, game: GameId = 'cs2'): { info: CurrencyInfo; resolved: boolean } {
    const fromClient = knownCurrencyInfo(requested);
    if (fromClient) return { info: fromClient, resolved: true };
    const cached = username ? knownCurrencyInfo(this.inventory?.getCached(username, game)?.wallet?.currency) : null;
    if (cached) return { info: cached, resolved: true };
    return { info: knownCurrencyInfo(EUR_CURRENCY)!, resolved: false };
  }

  /**
   * Price preview for the sell modal: name → { netMinor, buyerMinor }, all in the minor units
   * of the returned `currency` (the wallet the quote was made for — see previewCurrency).
   * `customPriceMajor` (when strategy='custom') is the operator's fixed seller-net price in
   * MAJOR units, scaled here by that currency's decimals — no live lookup needed. Otherwise
   * prices are fetched live, routed through `username`'s bot proxy to dodge rate limits.
   */
  async preview(
    names: string[],
    strategy: SellStrategy,
    opts?: { customPriceMajor?: number; username?: string; shouldStop?: () => boolean; appId?: number; currency?: number },
  ): Promise<SellPreview> {
    const out: SellPreview['prices'] = {};
    const appId = opts?.appId ?? CS2_APPID;
    const { info: cur, resolved } = this.previewCurrency(opts?.username, opts?.currency, gameForApp(appId));
    const done = (): SellPreview => ({ currency: cur.code, currencyIso: cur.iso, decimals: cur.decimals, resolved, prices: out });

    if (strategy === 'custom') {
      const net = Math.max(1, Math.round((opts?.customPriceMajor ?? 0) * Math.pow(10, cur.decimals)));
      const buyer = net + feesForNet(net);
      for (const name of [...new Set(names)]) out[name] = { netMinor: net, buyerMinor: buyer };
      return done();
    }

    // Resolve up to WORKERS authenticated egress contexts (acting account first when web-ready, else
    // pricer identities). Each worker gets its OWN context so a several-hundred-name preview spreads
    // across accounts' budgets + exits instead of hammering one (and never goes anonymous → "no price").
    const WORKERS = 3;
    const ctxs = await this.priceCtxsFor(opts?.username, WORKERS);
    // With no identity available at all (dev / whole fleet logged out) ctxs is empty — price anonymously
    // as the last resort (one context) rather than not at all; the caller's retry affordance covers a 429.
    if (ctxs.length === 0) ctxs.push(MarketService.EMPTY_CTX);
    // Say WHICH lanes this preview got. "no price" on every row is almost always "we ended up on the
    // anonymous lane" (which 429s on the shared pool) rather than a genuinely price-less item — but that
    // was invisible: the preview logged nothing at all. One line per preview makes the next report
    // self-diagnosing. (v1.4.4 — owner issue 3 diagnostics.)
    const authedLanes = ctxs.filter((c) => !!c.cookieHeader).length;
    logger.info(`[market-price] preview for ${opts?.username ?? '(no acting account)'} in ${cur.iso}` +
      `${resolved ? '' : ' (ASSUMED — no wallet currency known for this selection)'} over ${ctxs.length} lane(s) — ` +
      `${authedLanes} authenticated, ${ctxs.length - authedLanes} ANONYMOUS` +
      (authedLanes === 0 ? ' (anonymous priceoverview is the usual cause of "no price" — no account was web-ready to borrow)' : ''));
    // H-TRD-022: bound the cascade to a live viewer. The sequential loop kept issuing
    // Steam requests for a client that had already aborted (S32, client aborts at 120s);
    // `shouldStop` (the route flips it on 'close') stops fetching and returns the partial
    // map. A small 3-worker pool over the deduped names caps concurrency well below the
    // mass-sell's own 25 (see runMassSell) while making preview proportional to the batch.
    // H-PRC-002: additionally give each per-name cascade a 10s budget and stop dispatching
    // new names once 90s total have elapsed, so the modal RESPONDS before the 120s client
    // abort under a throttle storm. Undispatched names are returned as null-price rows so
    // the modal renders the existing per-name retry affordance instead of a dead spinner.
    const unique = [...new Set(names)];
    let idx = 0;
    const shouldStop = opts?.shouldStop;
    const previewStart = Date.now();
    const PREVIEW_BUDGET_MS = 90_000;   // stop dispatching new names after 90s total
    const PER_NAME_BUDGET_MS = 10_000;  // per-name cascade budget (bounds one getSellInfo)
    let budgetTripped = false;          // 90s cap hit → backfill the undispatched names below
    const worker = async (ctx: PriceCtx): Promise<void> => {
      while (idx < unique.length) {
        if (shouldStop?.()) return;
        if (Date.now() - previewStart >= PREVIEW_BUDGET_MS) { budgetTripped = true; return; }
        const name = unique[idx++];
        // getSellInfo runs its own cascade internally – one call suffices.
        // appId selects the market so a TF2 preview is priced off the TF2 market, never CS2;
        // currency selects the denomination so the quote matches the wallet that will list.
        const info = await this.pricing.getSellInfo(name, { ...ctx, budgetMs: PER_NAME_BUDGET_MS, appid: appId, currency: cur.code });
        const buyer = targetBuyerMinor(info, strategy);
        out[name] = { buyerMinor: buyer, netMinor: buyer != null ? sellerNetFromBuyer(buyer) : null };
      }
    };
    // ALWAYS run up to WORKERS concurrent workers (throughput must not drop when only one identity is
    // available — that was the v1.4.3 regression that starved the 90s budget on a big batch). Round-robin
    // the resolved contexts across the workers: 1 identity ⇒ all workers share it (3× concurrency, as
    // before); ≥3 ⇒ each worker pins a distinct identity so the batch spreads across accounts + exits.
    const workerCount = Math.min(WORKERS, unique.length);
    await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(ctxs[i % ctxs.length])));
    // On a 90s budget stop (NOT a client disconnect, where nobody is listening), any name
    // never dispatched gets an explicit null-price row so the modal shows the per-name retry
    // affordance instead of omitting it silently.
    if (budgetTripped) for (const name of unique) if (!(name in out)) out[name] = { buyerMinor: null, netMinor: null };
    return done();
  }

  startMassSell(
    groups:   MassSellGroup[],
    strategy: SellStrategy,
    opts?: { concurrency?: number; itemDelayMs?: number; customPriceMajor?: number; retryBackoffMs?: number; preflightBackoffMs?: number; confirmBackoffMs?: number; confirmRateLimitPauseMs?: number },
  ): MassSellJob {
    if (this.job.running) throw new Error('A mass-sell is already running');
    this.cancelRequested = false; // fresh run — clear any prior cancel request
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    this.job = {
      running: true, cancelling: false, cancelled: false, strategy, total, done: 0, listed: 0, confirmed: 0,
      recovered: 0, retried: 0, skippedNoPrice: 0, failed: [], deferred: [], gone: [], blocked: [],
      startedAt: new Date().toISOString(),
    };
    // Timing overrides (tests/tuning) – otherwise the documented defaults apply.
    this.retryBackoffs   = opts?.retryBackoffMs   != null ? [opts.retryBackoffMs] : SELL_BACKOFF_MS;
    this.preflightBackoff = opts?.preflightBackoffMs != null ? opts.preflightBackoffMs : PREFLIGHT_BACKOFF_MS;
    this.confirmBackoff   = opts?.confirmBackoffMs != null ? opts.confirmBackoffMs : CONFIRM_BACKOFF_MS;
    this.confirmRateLimitPause = opts?.confirmRateLimitPauseMs != null ? opts.confirmRateLimitPauseMs : CONFIRM_RATELIMIT_PAUSE_MS;
    // S33: a fire-and-forget orchestrator that ever REJECTS would (a) escape `void` as an
    // unhandledRejection → a money-breaker tick, and (b) never reach its trailing running=false → the
    // job type latched refused until restart. Finalize on rejection: reset the flag + log (never rethrow).
    void this.runMassSell(groups, strategy, opts).catch((err) => {
      this.job.running = false; this.job.cancelling = false;
      logger.error(`[mass-sell] orchestrator crashed – job released: ${(err as Error).message}`);
    });
    return this.status();
  }

  /**
   * Requests a co-operative stop of the live mass-sell. A listing already mid-flight
   * (and its 2FA confirmation) finishes; workers then stop pulling new bots, and the
   * remaining items of the bot in progress are deferred (retryable). No-op when idle.
   */
  cancelSell(): MassSellJob {
    if (this.job.running) {
      this.cancelRequested = true;
      this.job.cancelling = true;
      logger.info('[mass-sell] cancel requested – remaining items will be skipped');
    }
    return this.status();
  }

  private async runMassSell(
    groups:   MassSellGroup[],
    strategy: SellStrategy,
    opts?: { concurrency?: number; itemDelayMs?: number; customPriceMajor?: number },
  ): Promise<void> {
    // Dynamic scaling: 1 worker / 5 bots, floor 5, ceiling 25. An explicit override (e.g. the
    // /api/market/sell body) is honoured but CLAMPED to the 25 ceiling — proxy/socket stability
    // is non-negotiable, so a client value can never raise it above the intentional cap.
    const concurrency = clampConcurrency(opts?.concurrency, scaleConcurrency(groups.length));
    // Floor the per-listing pause (B45): a client itemDelayMs:0 (careless user or a
    // forged-origin local request) would remove ALL inter-listing pacing for every bot
    // — a per-account request storm (Steam rate-limit / ban risk). The caller may RAISE
    // the delay, never drop it below the floor. `?? default` then `Math.max`, because
    // 0 ?? 1200 === 0 would otherwise keep the zero.
    const itemDelay   = Math.max(MIN_ITEM_DELAY, opts?.itemDelayMs ?? DEFAULT_ITEM_DELAY);
    // A custom price is a MAJOR amount (e.g. 2.05) applied in EACH bot's OWN wallet currency —
    // the same contract as a folder mass-buy's pricePerItemMajor. It cannot be pre-scaled here:
    // 2.05 is 205 minor units on a 2-decimal wallet and 2 on a 0-decimal one, so the scaling
    // happens per bot inside resolveNet, once its currency is known.
    const customMajor = strategy === 'custom' ? Math.max(0, Number(opts?.customPriceMajor ?? 0)) : null;
    const netCache = new Map<string, number | null>(); // appId:currency:name → seller net (minor units)
    const queue = [...groups];
    // Snapshot which bots were ALREADY live so we release ONLY the sessions this sell creates.
    const wasLiveBefore = this.trades.snapshotLive(groups.map((g) => g.username));

    // Fixed custom price → no lookups; otherwise getSellInfo's internal cascade (via the bot
    // proxy, in the bot's own currency) resolves the price. Cached per (game, currency, name).
    // S2 (in-run): a null net is cached (and short-circuits every same-name item) ONLY
    // when Steam actually answered (`info.authoritative`). A transport-failure null
    // (all cascade tries threw) is NOT cached and surfaces as `transport:true` so the
    // caller defers the item instead of failing it and poisoning the rest of the run.
    const resolveNet = async (name: string, ctx: { httpsAgent?: unknown; cookieHeader?: string }, appId: number, cur: CurrencyInfo): Promise<{ net: number | null; transport: boolean }> => {
      if (customMajor != null) return { net: Math.max(1, Math.round(customMajor * Math.pow(10, cur.decimals))), transport: false };
      // Cache key includes appId AND currency: a same-named item can exist in both games at
      // DIFFERENT prices (so a CS2 price must never be reused for a TF2 item), and the same
      // item's price in PLN is a completely different NUMBER than in EUR — reusing one across
      // wallets is exactly the mis-denomination this whole path exists to prevent.
      const key = `${appId}:${cur.code}:${name}`;
      if (netCache.has(key)) return { net: netCache.get(key)!, transport: false };
      const info = await this.pricing.getSellInfo(name, { ...ctx, appid: appId, currency: cur.code });
      const buyer = targetBuyerMinor(info, strategy);
      const net = buyer != null ? sellerNetFromBuyer(buyer) : null;
      if (net != null || info.authoritative) netCache.set(key, net);
      return { net, transport: net == null && !info.authoritative };
    };

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        // "End Task": defer every remaining bot's items (retryable) and stop. Each
        // group keeps its own username so the deferred list stays correctly attributed.
        if (this.cancelRequested) {
          let g: MassSellGroup | undefined;
          while ((g = queue.shift())) this.deferAll(g, g.items, 'cancelled (End Task) – not attempted');
          break;
        }
        const group = queue.shift()!;
        // Bot containment (H-TRD-024): processBot's own item/preflight guards already account for
        // everything it reached, so a rejection escaping it is unexpected. Swallow it here so this
        // worker keeps pulling the next bot instead of dying and rejecting Promise.allSettled's
        // sibling — counters are NOT touched (processBot already recorded what it did; the visible
        // done < total gap plus this log is the honest record).
        try {
          await this.processBot(group, resolveNet, itemDelay);
        } catch (err) {
          logger.error(`[mass-sell] ${group.username}: bot aborted (${(err as Error)?.message ?? String(err)})`);
        }
        if (queue.length > 0 && !this.cancelRequested) await sleep(DEFAULT_BOT_DELAY);
      }
    };

    const workers = Math.max(1, Math.min(concurrency, groups.length || 1));
    // Run containment (H-TRD-024): allSettled — never allow a future worker-reject path to skip the
    // releaseCreatedSessions / finalizer below (which would leak this run's sessions and latch the job).
    // worker() already contains per-bot rejections, so no result here should ever reject; allSettled is
    // the belt-and-braces guarantee the S33 outer .catch was designed to backstop.
    await Promise.allSettled(Array.from({ length: workers }, () => worker()));
    // Release the sessions this sell created so a mass-sell doesn't leave the whole folder resident.
    await this.trades.releaseCreatedSessions(groups.map((g) => g.username), wasLiveBefore);

    this.job.running = false;
    this.job.cancelling = false;
    this.job.cancelled = this.cancelRequested;
    this.job.phase = 'done';
    this.job.currentBot = undefined;
    this.activeBotSet?.clear();
    this.job.activeBots = [];
    this.job.finishedAt = new Date().toISOString();
    logger.info(
      `[mass-sell] ═══ ${this.cancelRequested ? 'CANCELLED' : 'COMPLETE'}: ${this.job.listed} listed / ${this.job.confirmed} confirmed / ` +
      `${this.job.recovered} recovered / ${this.job.retried} retries / ` +
      `${this.job.failed.length} failed / ${this.job.gone.length} gone / ${this.job.deferred.length} deferred ═══`,
    );
    this.cancelRequested = false;
  }

  /** Defers every remaining (unprocessed) item of a bot – connection issue, retryable later. */
  private deferAll(group: MassSellGroup, items: MassSellGroup['items'], error: string): void {
    for (const item of items) {
      this.job.deferred.push({ username: group.username, assetId: item.assetId, error });
      this.job.done++;
    }
  }

  /**
   * Processes one bot's items end-to-end with all three stability rules:
   *   1) PRE-FLIGHT: log in + a live authenticated probe (getListedAssetIds). If
   *      the bot has no working connection, NONE of its items are attempted –
   *      they are DEFERRED (retryable), not blasted as failures.
   *   2) RETRY: each listing is retried up to MAX_SELL_RETRIES on transient
   *      errors (timeout / 5xx / 429 / NoConnection) with a 15-35s backoff.
   *   3) PHANTOM: before counting a failure, we check whether Steam actually
   *      created the listing anyway (its asset id appears in the listings set),
   *      and after confirmation we reconcile once more.
   *   If the connection drops mid-bot, the REMAINING items are deferred instead
   *   of hammering a dead session.
   */
  /**
   * S28: remove THIS bot's failed rows that are in fact listed (phantoms), by IDENTITY (username +
   * assetId) — never by a positional index into the SHARED `this.job.failed`. Up to 25 processBot
   * workers share that array; one bot's reconcile filter reindexes it while another awaits
   * getListedAssetIds(), so a stored index would write/drop the WRONG row and silently vanish another
   * bot's genuine failure. Identity-matching is race-safe (the read-filter-assign below is synchronous —
   * it cannot interleave — and each bot only removes its own user's recovered ids). Returns the count.
   */
  private reconcilePhantoms(user: string, failedAssetIds: Set<string>, finalListed: Set<string>): number {
    const recoveredIds = new Set([...failedAssetIds].filter((id) => finalListed.has(id)));
    if (recoveredIds.size === 0) return 0;
    this.job.failed = this.job.failed.filter((f) => !(f.username === user && recoveredIds.has(f.assetId)));
    this.job.listed += recoveredIds.size;
    this.job.recovered += recoveredIds.size;
    return recoveredIds.size;
  }

  /** H-TRD-020: add/remove a bot from the in-flight set and mirror it into job.activeBots, so the
   *  status UI can name every worker currently listing instead of one flapping last-touched bot. */
  private trackBotActive(user: string, active: boolean): void {
    const set = (this.activeBotSet ??= new Set<string>());
    if (active) set.add(user); else set.delete(user);
    this.job.activeBots = [...set];
  }

  /**
   * The currency THIS bot's listings must be priced and posted in — its own Steam wallet's —
   * or null when that is not knowable, in which case the caller must block rather than guess
   * (see sellWalletBlocked). Three sources, cheapest first:
   *   1. the live session's wallet (already there for a resident account);
   *   2. a BOUNDED wait on the login 'wallet' event — the login promise resolves on 'webSession',
   *      which regularly beats 'wallet', so reading straight after ensureWebSession sees
   *      `undefined` on a perfectly good foreign wallet (OQ-B1 sub-case a);
   *   3. the cached inventory's wallet, which InventoryService attaches on every refresh —
   *      covers an account whose event never fires this session (OQ-B1 sub-case b).
   */
  private async resolveSellCurrency(username: string, trader: { walletCurrency?: number }, game: GameId): Promise<CurrencyInfo | null> {
    let code = trader.walletCurrency;
    if (sellWalletBlocked(code)) {
      const waited = await this.trades.awaitWallet?.(username, WALLET_WAIT_MS).catch(() => undefined);
      if (!sellWalletBlocked(waited?.currency)) code = waited!.currency;
    }
    if (sellWalletBlocked(code)) {
      const cached = this.inventory?.getCached(username, game)?.wallet?.currency;
      if (!sellWalletBlocked(cached)) code = cached;
    }
    return knownCurrencyInfo(code);
  }

  private async processBot(
    group: MassSellGroup,
    resolveNet: (name: string, ctx: { httpsAgent?: unknown; cookieHeader?: string }, appId: number, cur: CurrencyInfo) => Promise<{ net: number | null; transport: boolean }>,
    itemDelay: number,
  ): Promise<void> {
    const user = group.username;
    const N = group.items.length;
    // The game for THIS bot's items — all of one group share it. Threaded into pricing, the
    // market/sellitem POST, already-listed detection, and the trade-lock cache read so a TF2 sell
    // never touches the CS2 market/context (money-safety). Missing appId ⇒ 730 (backward-compat).
    const appId: number = group.appId ?? CS2_APPID;
    const game: GameId = gameForApp(appId);
    this.job.currentBot = user;
    this.job.phase = 'preflight';
    this.trackBotActive(user, true);

    // ── Rule 1: pre-flight ────────────────────────────────────────────────────
    let trader;
    try {
      logger.info(`[mass-sell] ${user}: logging in / connecting…`);
      // SESSION PRE-FLIGHT: a listing needs a live sessionid cookie too — ensure/refresh it
      // before listing rather than failing mid-batch with "no sessionid cookie".
      trader = await this.trades.ensureWebSession(user);
    } catch (err) {
      logger.warn(`[mass-sell] ${user}: login/connection failed (${(err as Error).message}) – ${N} item(s) deferred`);
      this.deferAll(group, group.items, `Login/connection failed: ${(err as Error).message}`);
      this.trackBotActive(user, false);
      return;
    }

    // MONEY SAFETY (B11): establish the currency this bot prices AND lists in — its own
    // wallet's. A foreign wallet is no longer refused; it is quoted in its own currency
    // below, end to end. An UNKNOWABLE one still is refused: market/sellitem reads `price`
    // as wallet minor units, so a guessed denomination mis-prices by the whole FX rate.
    // BLOCKED (the operator must fund/refresh the account), not deferred — a bare retry
    // would not learn the currency.
    const currency = await this.resolveSellCurrency(user, trader, game);
    if (!currency) {
      const wc = trader.walletCurrency;
      // Three distinct causes with three different remedies, so name which one this is:
      // 0 (ECurrencyCode.Invalid) = a fresh, never-funded account has no wallet at all;
      // undefined = the 'wallet' event never arrived; anything else = a code we don't carry.
      const msg = wc === 0
        ? 'no Steam wallet on this account – its currency is unknowable until first funds; blocked to protect pricing (add funds once, then re-run)'
        : wc == null
          ? `wallet currency unknown (the login 'wallet' event did not arrive within ${WALLET_WAIT_MS}ms and no cached balance carries one) – refusing to guess the denomination; refresh this account and re-run`
          : `unrecognised wallet currency code ${wc} – its minor-unit scale is unknowable (assuming 2 decimals for a 0-decimal currency mis-prices 100×); update STEAM_CURRENCIES`;
      logger.error(`[mass-sell] ${user}: ${msg}`);
      for (const item of group.items) {
        this.job.blocked.push({ username: user, assetId: item.assetId, error: msg });
        this.job.done++;
      }
      this.trackBotActive(user, false);
      return;
    }
    /** minor units → "12,34 PLN" for this bot's log lines (never a hardcoded €). */
    const money = (minor: number): string => `${(minor / Math.pow(10, currency.decimals)).toFixed(currency.decimals)} ${currency.iso}`;

    let listedSet: Set<string>;
    let unconfirmedSet: Set<string>;
    try {
      ({ listed: listedSet, unconfirmed: unconfirmedSet } = await this.preflightProbe(trader, appId));
    } catch (err) {
      logger.warn(`[mass-sell] ${user}: pre-flight connectivity check failed (${(err as Error).message}) – ${N} item(s) deferred`);
      this.deferAll(group, group.items, `No Steam connection (pre-flight): ${(err as Error).message}`);
      this.trackBotActive(user, false);
      return;
    }
    logger.info(`[mass-sell] ${user}: pre-flight OK (${listedSet.size} existing listing(s), ${unconfirmedSet.size} awaiting 2FA) – pricing + listing ${N} item(s) in ${currency.iso}…`);

    // ── List each item (Rules 2 + 3) ──────────────────────────────────────────
    this.job.phase = 'listing';
    const failedHere = new Set<string>(); // S28: identity (assetId), NOT a positional index into the shared failed[]
    let listedForBot = 0;
    let pendingForBot = 0; // listings (incl. phantoms) that still need a 2FA confirm
    let skippedAlreadyListed = 0; // pre-existing listings we skipped (for the operator-facing count)
    let skippedAwaitingConfirm = 0; // H-TRD-026: …of which are STILL unconfirmed → the confirm phase must run
    let transportPriceMisses = 0; // S2: consecutive price lookups that failed at the transport layer (not "no price")

    // Pre-list guard, snapshotted ONCE per bot (H-TRD-021): the trade-locked / non-tradable
    // asset ids per the cached inventory. `undefined` (no cache) or an id absent from the set
    // ⇒ sellable (defer to Steam). Built lazily on the first item so a malformed disk-cached
    // record throws INSIDE the item try/catch below (H-TRD-024 contains it as one `failed`
    // row, not a fleet abort). The snapshot is at bot-start rather than at-item-time — the
    // window is this bot's runtime, Steam stays the backstop (`gone` + INV-B2's authoritative
    // refresh), and the cache could only change mid-bot via a concurrent refresh anyway.
    let unsellable: Set<string> | undefined;
    let unsellableBuilt = false;

    for (let i = 0; i < group.items.length; i++) {
      const item = group.items[i];
      const pos = `${i + 1}/${N}`;

      // Item containment (H-TRD-024): an UNEXPECTED throw inside one item's processing (e.g.
      // isAssetSellable hitting a malformed disk-cached stack) must cost exactly one `failed`
      // row, never abort the bot — a bare throw here escapes to worker()/Promise.all and would
      // strand the rest of the fleet's workers as zombies against the next run.
      try {
      // "End Task" mid-bot: defer this item + the rest (retryable) and stop this bot.
      if (this.cancelRequested) {
        const rest = group.items.slice(i);
        logger.warn(`[mass-sell] ${user} ${pos}: cancelled (End Task) – deferring ${rest.length} remaining item(s)`);
        this.deferAll(group, rest, 'cancelled (End Task) – not attempted');
        break;
      }

      // Already listed (pre-existing or an earlier phantom) → count once, skip.
      // H-TRD-026: a pre-existing listing may still be awaiting its 2FA confirm (crash-rerun after
      // listings were created but before the confirm phase). Steam tells us WHICH ones (pending_listings
      // → confirmed:false), so only those arm the confirm gate below. Arming it for already-ACTIVE
      // listings bought nothing and spent a mobileconf/getlist against the account's per-IP budget.
      if (listedSet.has(item.assetId)) {
        this.job.listed++; this.job.done++; skippedAlreadyListed++;
        if (unconfirmedSet.has(item.assetId)) skippedAwaitingConfirm++;
        logger.info(`[mass-sell] ${user} ${pos}: ${item.marketHashName} already listed → skipped (${listedForBot} new this bot)`);
        continue;
      }

      // Pre-list guard (INV-B2 / INV-D1 / C3): never list a trade-locked or non-tradable
      // asset. A locked item must never become an active sell listing. The index is built
      // once (H-TRD-021) on the first item that reaches this guard.
      if (!unsellableBuilt) { unsellable = this.buildUnsellableIndex(user, game); unsellableBuilt = true; }
      if (unsellable?.has(String(item.assetId))) {
        this.job.blocked.push({ username: user, assetId: item.assetId, error: 'trade-locked or not tradable' });
        this.job.done++;
        logger.warn(`[mass-sell] ${user} ${pos}: ${item.marketHashName} is trade-locked / not tradable → blocked (not listed)`);
        continue;
      }

      const { net, transport } = await resolveNet(item.marketHashName, { httpsAgent: trader.httpsAgent, cookieHeader: trader.cookieHeader }, appId, currency);
      if (net == null && transport) {
        // S2 (in-run): the price lookup failed at the transport layer (429 storm, proxy
        // reset, 5xx) — Steam never answered, so this is NOT "no price". Defer the item
        // (retryable), never fail it, so one blip doesn't mass-fail every same-name item.
        this.job.deferred.push({ username: user, assetId: item.assetId, error: 'price lookup failed (connection) – not attempted' });
        this.job.done++;
        transportPriceMisses++;
        logger.warn(`[mass-sell] ${user} ${pos}: ${item.marketHashName} – price lookup failed (connection), deferred`);
        // Two connection-class price misses in a row → the bot's egress is down; defer the
        // rest instead of burning a lookup per item (same philosophy as the 'deferred' outcome).
        if (transportPriceMisses >= 2) {
          const rest = group.items.slice(i + 1);
          logger.warn(`[mass-sell] ${user} ${pos}: price lookups failing (connection) – deferring ${rest.length} remaining item(s)`);
          this.deferAll(group, rest, 'price lookup failed (connection) – not attempted');
          break;
        }
        continue;
      }
      transportPriceMisses = 0; // Steam answered (a real net or an authoritative no-price) → streak broken.
      if (net == null) {
        this.job.skippedNoPrice++;
        this.job.failed.push({ username: user, assetId: item.assetId, error: 'no market price (skipped)' });
        this.job.done++;
        logger.warn(`[mass-sell] ${user} ${pos}: ${item.marketHashName} – no price, skipped`);
        continue;
      }

      // Cross-service guard (D2 / INV-D2): don't list an asset that is mid-flight in
      // another money op (e.g. a trade-send of the same asset). Held only for the list
      // call, so legitimate sequential ops are unaffected.
      const mk = moneyKey(user, item.assetId);
      if (!MoneyOps.claim(mk)) {
        this.job.blocked.push({ username: user, assetId: item.assetId, error: 'busy in another money operation' });
        this.job.done++;
        logger.warn(`[mass-sell] ${user} ${pos}: ${item.marketHashName} busy in another money op → skipped`);
        continue;
      }
      const outcome = await this.listWithRetry(trader, item.assetId, net, listedSet, appId)
        .finally(() => MoneyOps.release(mk));
      this.job.done++;
      if (outcome === 'listed')      { this.job.listed++; listedForBot++; pendingForBot++;
        logger.info(`[mass-sell] ${user} ${pos}: ✓ listed ${item.marketHashName} @ ${money(net)} net (${listedForBot} listed / ${N})`);
      }
      else if (outcome === 'phantom'){ this.job.listed++; this.job.recovered++; pendingForBot++;
        logger.info(`[mass-sell] ${user} ${pos}: ✓ recovered (phantom) ${item.marketHashName} (${listedForBot + this.job.recovered} listed)`);
      }
      else if (outcome === 'deferred') {
        // Connection died on this item → defer it AND the remaining items.
        this.job.deferred.push({ username: user, assetId: item.assetId, error: 'connection lost during listing' });
        const rest = group.items.slice(i + 1);
        logger.warn(`[mass-sell] ${user} ${pos}: connection lost – deferring ${rest.length + 1} remaining item(s)`);
        this.deferAll(group, rest, 'connection lost – not attempted');
        break;
      }
      else if (outcome === 'gone') {
        // Stale candidate: the asset already left the inventory (sold/moved/listed elsewhere).
        // Reported as `gone`, not a failure, and not retried.
        this.job.gone.push({ username: user, assetId: item.assetId, error: 'no longer in inventory' });
        logger.info(`[mass-sell] ${user} ${pos}: ${item.marketHashName} no longer in inventory → skipped (gone)`);
      } else {
        this.job.failed.push({ username: user, assetId: item.assetId, error: outcome.error });
        failedHere.add(item.assetId);
        logger.error(`[mass-sell] ${user} ${pos}: ✗ failed ${item.marketHashName} – ${outcome.error}`);
      }

      if (i < group.items.length - 1) await sleep(itemDelay);
      } catch (err) {
        // An exception no branch above anticipated → one honest `failed` row, then carry on
        // with the next item. This is containment (defined outcome), not a retry wrapper.
        const msg = (err as Error)?.message ?? String(err);
        this.job.failed.push({ username: user, assetId: item.assetId, error: 'internal error: ' + msg });
        this.job.done++;
        failedHere.add(item.assetId);
        logger.error(`[mass-sell] ${user} ${pos}: ✗ internal error ${item.marketHashName} – ${msg}`);
      }
    }

    // ── Confirm this bot's pending listings in one 2FA batch (Hotfix A: retry) ──
    // H-TRD-026: also arm the confirm phase when the only pending work is pre-existing listings from an
    // interrupted earlier run — but ONLY the ones Steam still reports as awaiting confirmation. A re-run
    // over listings that are already active has nothing to confirm, and calling anyway cost a
    // mobileconf/getlist per bot against a per-IP budget the account needs for real money ops.
    if (pendingForBot + skippedAwaitingConfirm > 0) {
      this.job.phase = 'confirming';
      logger.info(`[mass-sell] ${user}: confirming ${pendingForBot} new + ${skippedAwaitingConfirm} pre-existing listing(s) via 2FA…`);
      try {
        const n = await this.confirmWithRetry(trader, user);
        this.job.confirmed += n;
        logger.info(`[mass-sell] ${user}: ✓ ${n} listing(s) confirmed via 2FA`);
      } catch (err) {
        // A failed retry chain may still have confirmed some listings before giving
        // up; count those so `confirmed` reflects the truth (H-TRD-027).
        this.job.confirmed += (err as { confirmedSoFar?: number }).confirmedSoFar ?? 0;
        logger.error(`[mass-sell] ${user}: confirmation FAILED after retries (${(err as Error).message}) – listings exist but await manual 2FA`);
      }
    } else if (skippedAlreadyListed > 0) {
      logger.info(`[mass-sell] ${user}: ${skippedAlreadyListed} pre-existing listing(s) are already confirmed — no 2FA pass needed`);
    }

    // ── Rule 3 backstop: reconcile phantoms ────────────────────────────────────
    // After confirmation, phantom listings are ACTIVE and WILL show in the
    // listings set. Any item we marked failed that is in fact listed → recover.
    if (failedHere.size > 0) {
      try {
        const finalListed = await trader.getListedAssetIds(appId);
        const recovered = this.reconcilePhantoms(user, failedHere, finalListed);
        if (recovered > 0) logger.info(`[mass-sell] ${user}: reconciled ${recovered} phantom listing(s) ← were marked failed`);
      } catch { /* reconciliation is best-effort */ }
    }

    // ── Optimistic cache update ─────────────────────────────────────────────────
    // Move every asset that is now listed for this bot Owned→Listed in the inventory cache
    // RIGHT NOW, so the panel reflects the sale immediately instead of depending on a clean
    // follow-up refresh (which used to leave them stuck under "Owned"). `listedSet` holds
    // the bot's pre-existing listings + everything created this run; markListed is idempotent
    // and best-effort. The next reconciled refresh verifies it against the live listings set.
    const nowListed = group.items.filter(it => listedSet.has(it.assetId)).map(it => it.assetId);
    if (nowListed.length) this.inventory?.markListed(user, nowListed, game);
    this.trackBotActive(user, false);
  }

  /**
   * Hotfix A: confirms a bot's pending market listings with retries. Steam's
   * mobile-confirmation servers throw HTTP 500/502/503 under load – those must
   * NOT abort the run. Retries up to CONFIRM_RETRIES with a 15-20s backoff.
   * confirmMarketListings is idempotent: getConfirmations only ever returns the
   * STILL-pending confirmations, so a retry just finishes whatever is left.
   */
  private async confirmWithRetry(
    trader: { confirmMarketListings(): Promise<{ confirmed: number; error?: Error }>; username: string },
    user: string,
  ): Promise<number> {
    let total = 0;
    let lastErr: unknown;
    let rateLimitRetries = 0;
    for (let attempt = 0; attempt <= CONFIRM_RETRIES; attempt++) {
      let err: Error;
      try {
        const r = await trader.confirmMarketListings();
        // A partial pass confirms some listings before failing; those count.
        // The count accumulates across attempts (getConfirmations only returns the
        // still-pending confirmations, so a retry finishes whatever is left).
        total += r.confirmed;
        if (!r.error) return total;
        err = r.error;                       // mid-pass respond failure — total already banked
      } catch (rejErr) {
        err = rejErr instanceof Error ? rejErr : new Error(String(rejErr)); // getConfirmations threw — nothing counted this pass
      }
      lastErr = err;
      const cls = classifyNetworkError(err);
      // A 429 is NOT a 500. errorClass classifies it as {transient:true, rateLimited:true} and its own
      // doc prescribes a LONG pause; routing it onto the transient path retried Steam's mobileconf
      // endpoint 4× inside its own rate-limit window (18s apart), which cannot succeed and only pushes
      // the account deeper into the window. Give the window time to elapse, and try far fewer times.
      if (cls.rateLimited) {
        if (rateLimitRetries < CONFIRM_RATELIMIT_RETRIES && attempt < CONFIRM_RETRIES) {
          rateLimitRetries++;
          // Jitter de-syncs the fleet's retries; it rides on the base pause, so a 0 pause (tests/tuning)
          // stays a 0 pause rather than sleeping a random 0-15s.
          const pause = this.confirmRateLimitPause > 0
            ? this.confirmRateLimitPause + Math.floor(Math.random() * CONFIRM_RATELIMIT_JITTER_MS)
            : 0;
          logger.warn(`[mass-sell] ${user}: 2FA confirm rate-limited by Steam (${err.message}) – waiting ${Math.round(pause / 1000)}s for the window to clear (${rateLimitRetries}/${CONFIRM_RATELIMIT_RETRIES})`);
          await sleep(pause);
          continue;
        }
        throw Object.assign(err, { confirmedSoFar: total });
      }
      // Only retry on transient/server errors.
      if (cls.transient && attempt < CONFIRM_RETRIES) {
        logger.warn(`[mass-sell] ${user}: 2FA confirm attempt ${attempt + 1}/${CONFIRM_RETRIES + 1} failed (${err.message}) – retry in ${this.confirmBackoff / 1000}s`);
        await sleep(this.confirmBackoff);
        continue;
      }
      throw Object.assign(err, { confirmedSoFar: total });
    }
    throw Object.assign(lastErr instanceof Error ? lastErr : new Error('confirmation failed'), { confirmedSoFar: total });
  }

  /** Rule 1: connectivity pre-flight – probes the account's live market listings with a couple of
   *  retries so a brief hiccup doesn't defer a whole bot. Returns the already-listed asset ids AND the
   *  subset still awaiting a 2FA confirm (one HTTP read, both answers); throws only when truly
   *  unreachable. A trader without `getListedAssets` falls back FAIL-SAFE: every pre-existing listing is
   *  treated as possibly-unconfirmed, i.e. exactly the old behaviour — we never skip a needed confirm. */
  private async preflightProbe(
    trader: { getListedAssetIds(appId: number): Promise<Set<string>>; getListedAssets?(appId: number): Promise<{ listed: Set<string>; unconfirmed: Set<string> }> },
    appId: number,
  ): Promise<{ listed: Set<string>; unconfirmed: Set<string> }> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= PREFLIGHT_RETRIES; attempt++) {
      try {
        if (typeof trader.getListedAssets === 'function') return await trader.getListedAssets(appId);
        const listed = await trader.getListedAssetIds(appId);
        return { listed, unconfirmed: new Set(listed) };
      } catch (err) {
        lastErr = err;
        if (attempt < PREFLIGHT_RETRIES) await sleep(this.preflightBackoff);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('unreachable');
  }

  /**
   * Lists a single asset with retry + phantom detection. Returns:
   *   'listed'   – created this run
   *   'phantom'  – Steam had already created it (recovered, no double-list)
   *   'deferred' – the bot's connection is dead → caller defers the rest
   *   'gone'     – the asset is no longer in the inventory (stale candidate; not a failure)
   *   { error }  – a genuine, non-recoverable failure
   */
  private async listWithRetry(
    trader: { sellOnMarket(a: string, n: number, appId: number, contextId?: string): Promise<unknown>; getListedAssetIds(appId: number): Promise<Set<string>>; ready: boolean; sessionState: string; username: string },
    assetId: string,
    net: number,
    listedSet: Set<string>,
    appId: number,
  ): Promise<'listed' | 'phantom' | 'deferred' | 'gone' | { error: string }> {
    let lastErr = '';
    for (let attempt = 0; attempt <= MAX_SELL_RETRIES; attempt++) {
      try {
        await trader.sellOnMarket(assetId, net, appId);
        listedSet.add(assetId);
        return 'listed';
      } catch (err) {
        lastErr = (err as Error).message;

        // A "listing already exists" rejection means the item IS listed (phantom).
        if (isAlreadyListed(err) && !isTransient(err)) {
          listedSet.add(assetId);
          logger.info(`[mass-sell] ${trader.username} ${assetId}: already listed → counted (recovered)`);
          return 'phantom';
        }

        // The asset is gone from the inventory (already moved/sold) → stale candidate, not a
        // failure and not retryable. Report it as such so the operator sees the real outcome.
        if (isGone(err) && !isTransient(err)) {
          return 'gone';
        }

        // Rule 3: did Steam create the listing despite this error? (phantom probe)
        try {
          const nowListed = await trader.getListedAssetIds(appId);
          if (nowListed.has(assetId)) {
            listedSet.add(assetId);
            logger.info(`[mass-sell] ${trader.username} ${assetId}: phantom-listed despite "${lastErr}" → recovered`);
            return 'phantom';
          }
        } catch (probeErr) {
          // The probe itself failed → we cannot read this bot's own listings, so neither
          // phantom detection nor further listing attempts are trustworthy (a dead web
          // session throws non-transient market/mylistings HTTP 40x too, not just transient
          // connection errors). ANY probe failure → defer: the honest, retryable bucket.
          // The caller defers the bot's remainder, so no request is burned on a dead session.
          const pmsg = (probeErr as Error)?.message ?? String(probeErr);
          logger.warn(`[mass-sell] ${trader.username} ${assetId}: phantom probe failed (${pmsg}) – deferring (phantom status unknown, session suspect)`);
          return 'deferred';
        }

        if (!isTransient(err)) {
          return { error: lastErr };             // genuine hard error – don't retry
        }
        // Transient: if the session is no longer connected, defer (don't burn retries).
        if (!trader.ready || trader.sessionState !== 'LOGGED_IN') return 'deferred';
        if (attempt < MAX_SELL_RETRIES) {
          const wait = this.retryBackoffs[Math.min(attempt, this.retryBackoffs.length - 1)];
          this.job.retried++;
          logger.warn(`[mass-sell] ${trader.username} ${assetId}: attempt ${attempt + 1}/${MAX_SELL_RETRIES + 1} failed (${lastErr}) – retry in ${wait / 1000}s`);
          await sleep(wait);
        }
      }
    }
    return { error: `${lastErr} (after ${MAX_SELL_RETRIES} retries)` };
  }
}
