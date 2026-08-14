import type { TradeService } from './TradeService';
import type { InventoryService } from '../core/InventoryService';
import type { MarketOrders, ActiveSellOrder, ActiveBuyOrder } from './AccountTrader';
import { MarketPricing, sellerNetFromBuyer, targetBuyerMinor, feesForNet, EUR_CURRENCY, type SellStrategy } from '../pricing/MarketPricing';
import { knownCurrencyInfo, feeMinimumOf, type CurrencyInfo } from '../pricing/currencies';
import type { PricerIdentity } from '../pricing/PricerIdentityPool';
import { scaleConcurrency, clampConcurrency } from '../utils/concurrency';
import { isSellable } from '../core/MarketModel';
import { MoneyOps, assetKey as moneyKey } from './MoneyOps';
import { logger } from '../utils/logger';
import { classifyNetworkError } from '../utils/errorClass';
import type { GameId } from '../types/inventory';

// The two Steam apps SSIM sells on; both use market context id 2. A mass-sell run/group carries the
// appId so pricing, the market/sellitem POST, and already-listed detection all target the same game.
const CS2_APPID = 730;
const TF2_APPID = 440;
const gameForApp = (appId: number): GameId => (appId === TF2_APPID ? 'tf2' : 'cs2');

/** A price-read egress context: route through this account's agent (its exit) and cookie (its
 *  authenticated priceoverview budget). Empty ({}) means an anonymous read (avoided for the fill). */
type PriceCtx = { httpsAgent?: unknown; cookieHeader?: string };

/** ms budget for a BOUNDED getTrader in the price path — a login parked in the global login-concurrency
 *  queue must not stall a price read (v1.4.5). Longer than a healthy login (~5s), far shorter than the
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
// `itemDelay` is the minimum gap between two sellitem DISPATCHES for one bot — the account's
// request cadence, now enforced across the bot's lanes rather than by sleeping after each item.
// It used to double as "wait out the round-trip too", so a bot idled ~0.5-1s per listing on top
// of the pause; the lanes overlap that latency, which is where the speed-up comes from. The
// default is lower than the old 1_200 because it is no longer padded by the round-trip.
const DEFAULT_ITEM_DELAY  = 700;   // min gap between a bot's individual listing dispatches
const MIN_ITEM_DELAY       = 500;  // hard floor: a client can raise the pause, never remove it (B45 anti-storm)
const DEFAULT_BOT_DELAY    = 3_000; // pause between bots per worker
/**
 * Listing lanes per bot. Concurrency here hides Steam's round-trip; it does not raise the
 * request rate (every dispatch still passes the shared `itemDelay` gate), so the anti-spam
 * cadence is unchanged and only dead time is removed. Capped low on purpose: more lanes than
 * this buy nothing once the pacing gate is the bottleneck, and each one is another concurrent
 * money-op on a single account.
 */
const DEFAULT_ITEM_CONCURRENCY = 3;
const MAX_ITEM_CONCURRENCY     = 5;
/**
 * Confirm a bot's listings every this many, instead of once at the end. Steam caps how many
 * listings may await 2FA (a 263-item field run hit the wall at ~254); draining in batches keeps
 * the backlog an order of magnitude below any such cap, and it also means a crash mid-run leaves
 * at most this many listings unconfirmed. Kept well above 1 because each drain spends the
 * account's scarce mobileconf budget (~5 ops/min) — one pass per 50 listings, not per listing.
 */
const CONFIRM_BATCH = 50;

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
 * `price` field in the SELLER's own wallet currency's minor units — so the one thing that
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
 * the listing 100×.
 */
export function sellWalletBlocked(walletCurrency: number | undefined): boolean {
  return knownCurrencyInfo(walletCurrency) == null;
}

/**
 * Classifies a Steam/network error as transient (retry) vs. hard (give up).
 * The verdict comes from the one shared taxonomy (src/utils/errorClass),
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
  // Require a COMPOUND match — a market/listing NOUN and an "already/exists" QUALIFIER must both be
  // present. The old bare tokens (`already`, `listed`, `aktiv`, `vorhanden`, `bereits`) were far too broad:
  // a single one fires on unrelated localized errors (e.g. "already rate-limited", "listed as untradable"),
  // mis-bucketing an Owned item as Listed. Steam localizes to the bot's display language, so the German
  // listing nouns (Angebot/Inserat) + qualifiers (bereits/vorhanden/aktiv/existiert) are matched on purpose.
  const listingNoun = /listing|listed|angebot|verkaufsangebot|inserat/;
  const alreadyQual = /already|pending|bereits|vorhanden|aktiv|existiert|besteht/;
  return listingNoun.test(m) && alreadyQual.test(m);
}

/**
 * "You have too many listings pending confirmation. Please confirm or cancel some before
 * attempting to list more." — Steam's BACKPRESSURE signal, not a failure and not a rate limit.
 *
 * It is entirely self-inflicted: it means WE have parked too many unconfirmed listings, and the
 * one action that clears it is confirming them. Classifying it by message alone sent it down the
 * rate-limit path (it contains "too many"), so every item burned 3 retries × 15-35 s waiting for a
 * window that would never open — the whole tail of a big sell died against a wall we built and
 * could have cleared in one 2FA pass. Checked before isAlreadyListed, which also matches this
 * text ("listings" + "pending") and would otherwise bank the item as a phantom listing.
 */
export function isTooManyPendingConfirmations(err: unknown): boolean {
  const m = ((err as Error)?.message ?? '').toLowerCase();
  const tooMany = /too many|zu viele|demasiad|trop de|слишком много/.test(m);
  const pendingConfirm = /pending confirmation|confirm or cancel|bestätigung|confirmaci|подтвержд/.test(m);
  return tooMany && pendingConfirm;
}

/**
 * "The item is no longer in your inventory / not allowed to be traded on the Community
 * Market" → the asset is GONE (already moved/sold/listed elsewhere). This is not a genuine
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
  /** Steam app of this group's items — 730 (CS2) or 440 (TF2). Missing ⇒ 730 (backward-compat;
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
  /** Connection/pre-flight issues – not attempted or aborted; safe to retry later. */
  deferred:    Array<{ username: string; assetId: string; error: string }>;
  /** Asset was no longer in the inventory (already moved/sold/listed) – stale candidate,
   *  not a real failure and not retryable. */
  gone:        Array<{ username: string; assetId: string; error: string }>;
  /** Asset is trade-locked or non-tradable per the cached inventory – refused by the
   *  pre-list guard so a locked item can never become an active sell listing (INV-B2/D1). */
  blocked:     Array<{ username: string; assetId: string; error: string }>;
  /** Live progress for the UI so the operator isn't staring at a blank bar. */
  currentBot?: string;
  /** Every bot currently inside processBot — lets the UI list the workers
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

// ── Active Orders across many accounts (folder / multi-select scope) ──────────

/** One account's slice of a multi-account Active-Orders scan. A per-account failure is a
 *  ROW with `error`, never an aborted scan — one dead proxy must not hide 200 healthy bots. */
export interface AccountOrders {
  username:   string;
  sellOrders: ActiveSellOrder[];
  buyOrders:  ActiveBuyOrder[];
  /** This account's snapshot was truncated mid-fetch (see MarketOrders.partial). */
  partial?:   boolean;
  error?:     string;
}

export interface OrdersScanProgress {
  total:  number;  // accounts in the scan
  done:   number;  // accounts finished (ok or errored)
  sell:   number;  // sell rows collected so far (after the appId filter)
  buy:    number;  // buy rows collected so far
  errors: number;  // accounts that failed
}

/** Snapshot of the single live orders scan. `accounts` is APPEND-ONLY while the scan runs, so
 *  the route can serve a client cursor (`since`) and never re-send rows it already delivered. */
export interface OrdersScanStatus {
  running:    boolean;
  startedAt:  number;
  appId:      number;
  usernames:  string[];
  progress:   OrdersScanProgress;
  accounts:   AccountOrders[];
  cancelling?: boolean;
  cancelled?:  boolean;
  error?:     string;
}

/** One order to cancel, tagged with the account that owns it (a multi-account bulk cancel). */
export interface CancelOrderTarget {
  username: string;
  kind:     'sell' | 'buy';
  id:       string;
}
export interface CancelOrderResult extends CancelOrderTarget {
  ok:     boolean;
  error?: string;
}

/** Parallel accounts in a multi-account orders scan. Login-bound, so small + FIXED (mirrors
 *  TradeService's OFFERS_READ_CONCURRENCY): a folder scan reads several bots at once but can
 *  never become the unbounded login fan-out that crashes the process. */
const ORDERS_READ_CONCURRENCY = 4;
/** Parallel ACCOUNTS in a bulk cancel (each account's own cancels stay strictly sequential). */
const ORDERS_CANCEL_CONCURRENCY = 3;
/** Pause between two cancels on the same account — market writes, so pace them (B45 anti-storm). */
const ORDERS_CANCEL_PACE_MS = 600;

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

/**
 * Orchestrates mass-selling selected items on the Steam Community Market — the
 * sell-side counterpart to TradeService.startMassSend. Each bot lists its own assets
 * through its isolated session, priced by MarketPricing in THAT BOT'S own wallet
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
  /** Single live multi-account Active-Orders scan (polled by the UI with a row cursor). Its
   *  `accounts` array is append-only and retained until the next start, so a poll landing after
   *  completion still receives every row. */
  private ordersJob: OrdersScanStatus = {
    running: false, startedAt: 0, appId: CS2_APPID, usernames: [],
    progress: { total: 0, done: 0, sell: 0, buy: 0, errors: 0 }, accounts: [],
  };
  /** Co-operative cancel flag for the orders scan (set by cancelOrdersScan()). */
  private ordersScanCancel = false;
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

  /** True while a mass-sell is running — gates a mid-session update swap: a swap hard-exits the
   *  process and would interrupt unconfirmed 2FA listings. */
  busy(): boolean { return this.job.running; }

  /**
   * Pre-list guard: the set of asset ids in the cached inventory
   * that must never reach `sellOnMarket` — trade-locked or non-tradable stacks, so a
   * locked item never surfaces as an active sell order. Built once per bot
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

  // ── Active Orders across many accounts (folder / multi-select scope) ─────────

  /**
   * Starts the multi-account Active-Orders scan as a DETACHED job and returns immediately.
   *
   * Detached for the same reason the ban check is: a folder of a few hundred bots is
   * login-bound and runs far past the client's 120s request budget, so awaiting one POST would time
   * the view out while the backend kept working. The client polls `ordersScanStatus()` with a cursor
   * and renders accounts AS THEY LAND. Single-flight — a second start while one runs throws (409).
   */
  startOrdersScan(usernames: string[], appId: number): { total: number } {
    if (this.ordersJob.running) throw new Error('An Active Orders scan is already running');
    const unique = [...new Set(usernames.map((u) => u.trim()).filter(Boolean))];
    this.ordersScanCancel = false;
    this.ordersJob = {
      running: true, startedAt: Date.now(), appId, usernames: unique,
      progress: { total: unique.length, done: 0, sell: 0, buy: 0, errors: 0 },
      accounts: [],
    };
    const job = this.ordersJob;
    void this.runOrdersScan(unique, appId, job)
      .catch((err) => {
        job.error = (err as Error).message;
        logger.error(`[orders] scan crashed – ${job.error}`);
      })
      .finally(() => {
        job.running = false;
        job.cancelling = false;
        logger.info(`[orders] scan finished: ${job.progress.done}/${job.progress.total} account(s), ` +
          `${job.progress.sell} sell / ${job.progress.buy} buy, ${job.progress.errors} failed${job.cancelled ? ' (cancelled)' : ''}`);
      });
    return { total: unique.length };
  }

  /** Live snapshot of the orders scan. Retained until the next `startOrdersScan`, so a poll that
   *  lands after completion still receives every row (the client reads from its own cursor). */
  ordersScanStatus(): OrdersScanStatus {
    const j = this.ordersJob;
    return {
      running: j.running, startedAt: j.startedAt, appId: j.appId, usernames: j.usernames,
      progress: { ...j.progress }, accounts: j.accounts,
      cancelling: j.cancelling, cancelled: j.cancelled, error: j.error,
    };
  }

  /** Co-operative stop: workers finish the account in hand and take no new ones. Accounts already
   *  scanned keep their rows — a cancelled scan is a SHORT scan, not a discarded one. */
  cancelOrdersScan(): { cancelling: boolean } {
    if (!this.ordersJob.running) return { cancelling: false };
    this.ordersScanCancel = true;
    this.ordersJob.cancelling = true;
    logger.info('[orders] scan cancel requested — no new accounts will be started');
    return { cancelling: true };
  }

  /**
   * Reads open orders for every account in `usernames` (bounded worker pool), filtered to `appId`.
   * Per-account failures land as `error` rows and never abort the others. Each worker releases the
   * session IT created straight after that account's read, so a 200-bot folder scan never leaves the
   * whole fleet resident (the resident-session storm that lets the process be externally killed).
   */
  private async runOrdersScan(usernames: string[], appId: number, job: OrdersScanStatus): Promise<void> {
    const queue = [...usernames];
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        if (this.ordersScanCancel) { job.cancelled = true; return; }
        const username = queue.shift()!;
        // Snapshot live-ness before we touch the account so we only release sessions WE create —
        // never one the user already had live (e.g. mid-trade) or logged in concurrently.
        const wasLive = this.trades.snapshotLive([username]);
        try {
          const orders = await this.getOrders(username);
          const sellOrders = orders.sellOrders.filter((o) => o.appId === appId);
          const buyOrders  = orders.buyOrders.filter((o) => o.appId === appId);
          job.progress.sell += sellOrders.length;
          job.progress.buy  += buyOrders.length;
          job.accounts.push({ username, sellOrders, buyOrders, partial: orders.partial });
        } catch (err) {
          const error = (err as Error).message;
          logger.warn(`[orders] ${username}: ${error}`);
          job.progress.errors++;
          job.accounts.push({ username, sellOrders: [], buyOrders: [], error });
        } finally {
          job.progress.done++;
          await this.trades.releaseCreatedSessions([username], wasLive).catch(() => undefined);
        }
      }
    };
    const workers = Math.max(1, Math.min(ORDERS_READ_CONCURRENCY, usernames.length || 1));
    await Promise.all(Array.from({ length: workers }, () => worker()));
  }

  /**
   * Cancels a set of orders that may span many accounts (the multi-scope "Cancel selected/all").
   *
   * Grouped by account so one bot's cancels run strictly sequentially through its own session —
   * paced (ORDERS_CANCEL_PACE_MS) because these are market WRITES — while a few accounts are worked
   * in parallel. Per-item failures are results, never throws, so one dead order can't strand the rest.
   * Sessions this op creates are released per account (same anti-accumulation rule as the scan).
   */
  async cancelOrdersBatch(targets: CancelOrderTarget[]): Promise<CancelOrderResult[]> {
    const groups = new Map<string, CancelOrderTarget[]>();
    for (const t of targets) {
      const key = t.username.toLowerCase();
      const list = groups.get(key) ?? [];
      list.push(t);
      groups.set(key, list);
    }
    const results: CancelOrderResult[] = [];
    const queue = [...groups.values()];
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const group = queue.shift()!;
        const username = group[0].username;
        const wasLive = this.trades.snapshotLive([username]);
        try {
          for (let i = 0; i < group.length; i++) {
            const t = group[i];
            if (i > 0) await sleep(ORDERS_CANCEL_PACE_MS);
            try {
              if (t.kind === 'buy') await this.cancelBuyOrder(t.username, t.id);
              else                  await this.cancelListing(t.username, t.id);
              results.push({ ...t, ok: true });
            } catch (err) {
              const error = (err as Error).message;
              logger.error(`[orders] ${t.username} cancel ${t.kind} ${t.id} failed: ${error}`);
              results.push({ ...t, ok: false, error });
            }
          }
        } finally {
          await this.trades.releaseCreatedSessions([username], wasLive).catch(() => undefined);
        }
      }
    };
    const workers = Math.max(1, Math.min(ORDERS_CANCEL_CONCURRENCY, groups.size || 1));
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return results;
  }

  private static readonly EMPTY_CTX: PriceCtx = {};

  /** Resolves a bot's price-fetch context so price checks egress via its IP and carry its session
   *  cookie (authenticated priceoverview → the account's own budget; anonymous reads 429 cold on the
   *  shared pool — 2026-07-10). Single-context form (buy-modal autofill); returns the first of
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
   * The caller (preview) then falls back to one anonymous lane if this returns empty — anonymous
   * priceoverview works (the browser fingerprint fix), so a read is never blocked, only de-prioritised.
   *
   * Money-safety: this only decides WHOSE per-session budget + exit a READ draws — not the
   * denomination. The currency is an explicit priceoverview parameter, so borrowing a PLN bot's
   * cookie to read a EUR quote (or vice versa) is harmless. The COMMITTED sell price is re-resolved
   * via the SELLING bot's own cookie and its own wallet currency in resolveNet — never one of these
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
      // Fee floor of this wallet's currency — a PLN net of 38 costs the buyer 46, not 42.
      const buyer = net + feesForNet(net, feeMinimumOf(cur));
      for (const name of [...new Set(names)]) out[name] = { netMinor: net, buyerMinor: buyer };
      return done();
    }

    // Resolve up to WORKERS authenticated egress contexts (acting account first when web-ready, else
    // pricer identities). Each worker gets its own context so a several-hundred-name preview spreads
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
    // Bound the cascade to a live viewer. The sequential loop kept issuing
    // Steam requests for a client that had already aborted (S32, client aborts at 120s);
    // `shouldStop` (the route flips it on 'close') stops fetching and returns the partial
    // map. A small 3-worker pool over the deduped names caps concurrency well below the
    // mass-sell's own 25 (see runMassSell) while making preview proportional to the batch.
    // Additionally give each per-name cascade a 10s budget and stop dispatching
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
        out[name] = { buyerMinor: buyer, netMinor: buyer != null ? sellerNetFromBuyer(buyer, feeMinimumOf(cur)) : null };
      }
    };
    // ALWAYS run up to WORKERS concurrent workers (throughput must not drop when only one identity is
    // available — that was the v1.4.3 regression that starved the 90s budget on a big batch). Round-robin
    // the resolved contexts across the workers: 1 identity ⇒ all workers share it (3× concurrency, as
    // before); ≥3 ⇒ each worker pins a distinct identity so the batch spreads across accounts + exits.
    const workerCount = Math.min(WORKERS, unique.length);
    await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(ctxs[i % ctxs.length])));
    // On a 90s budget stop (not a client disconnect, where nobody is listening), any name
    // never dispatched gets an explicit null-price row so the modal shows the per-name retry
    // affordance instead of omitting it silently.
    if (budgetTripped) for (const name of unique) if (!(name in out)) out[name] = { buyerMinor: null, netMinor: null };
    return done();
  }

  startMassSell(
    groups:   MassSellGroup[],
    strategy: SellStrategy,
    opts?: { concurrency?: number; itemDelayMs?: number; itemConcurrency?: number; customPriceMajor?: number; retryBackoffMs?: number; preflightBackoffMs?: number; confirmBackoffMs?: number; confirmRateLimitPauseMs?: number },
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
    // A fire-and-forget orchestrator that ever REJECTS would (a) escape `void` as an
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
    opts?: { concurrency?: number; itemDelayMs?: number; itemConcurrency?: number; customPriceMajor?: number },
  ): Promise<void> {
    // Dynamic scaling: 1 worker / 5 bots, floor 5, ceiling 25. An explicit override (e.g. the
    // /api/market/sell body) is honoured but CLAMPED to the 25 ceiling — proxy/socket stability
    // is non-negotiable, so a client value can never raise it above the intentional cap.
    const concurrency = clampConcurrency(opts?.concurrency, scaleConcurrency(groups.length));
    // Floor the per-listing pause: a client itemDelayMs:0 (careless user or a
    // forged-origin local request) would remove all inter-listing pacing for every bot
    // — a per-account request storm (Steam rate-limit / ban risk). The caller may RAISE
    // the delay, never drop it below the floor. `?? default` then `Math.max`, because
    // 0 ?? 1200 === 0 would otherwise keep the zero.
    const itemDelay   = Math.max(MIN_ITEM_DELAY, opts?.itemDelayMs ?? DEFAULT_ITEM_DELAY);
    // Lanes per bot. Clamped like every other client-supplied concurrency: a forged body must not
    // be able to point an unbounded number of concurrent money-ops at one account. Raising lanes
    // never raises the request RATE (itemDelay still gates every dispatch) — it only hides latency.
    const itemConcurrency = Math.max(1, Math.min(MAX_ITEM_CONCURRENCY,
      Number.isFinite(opts?.itemConcurrency) ? Math.floor(Number(opts?.itemConcurrency)) : DEFAULT_ITEM_CONCURRENCY));
    // A custom price is a MAJOR amount (e.g. 2.05) applied in each bot's own wallet currency —
    // the same contract as a folder mass-buy's pricePerItemMajor. It cannot be pre-scaled here:
    // 2.05 is 205 minor units on a 2-decimal wallet and 2 on a 0-decimal one, so the scaling
    // happens per bot inside resolveNet, once its currency is known.
    const customMajor = strategy === 'custom' ? Math.max(0, Number(opts?.customPriceMajor ?? 0)) : null;
    const netCache = new Map<string, number | null>(); // appId:currency:name → seller net (minor units)
    // In-flight lookups, so the bot's parallel listing lanes ASK STEAM once for a name they all
    // want. Without it the value cache only fills when the first lookup RETURNS, and K lanes
    // starting together on K copies of the same item would each fire their own priceoverview —
    // K× the account's scarce price budget for one answer (H-TRD-023's dedupe, restored for lanes).
    const netInflight = new Map<string, Promise<{ net: number | null; transport: boolean }>>();
    const queue = [...groups];
    // Snapshot which bots were already live so we release ONLY the sessions this sell creates.
    const wasLiveBefore = this.trades.snapshotLive(groups.map((g) => g.username));

    // Fixed custom price → no lookups; otherwise getSellInfo's internal cascade (via the bot
    // proxy, in the bot's own currency) resolves the price. Cached per (game, currency, name).
    // S2 (in-run): a null net is cached (and short-circuits every same-name item) ONLY
    // when Steam actually answered (`info.authoritative`). A transport-failure null
    // (all cascade tries threw) is not cached and surfaces as `transport:true` so the
    // caller defers the item instead of failing it and poisoning the rest of the run.
    const resolveNet = async (name: string, ctx: { httpsAgent?: unknown; cookieHeader?: string }, appId: number, cur: CurrencyInfo): Promise<{ net: number | null; transport: boolean }> => {
      if (customMajor != null) return { net: Math.max(1, Math.round(customMajor * Math.pow(10, cur.decimals))), transport: false };
      // Cache key includes appId and currency: a same-named item can exist in both games at
      // DIFFERENT prices (so a CS2 price must never be reused for a TF2 item), and the same
      // item's price in PLN is a completely different NUMBER than in EUR — reusing one across
      // wallets is exactly the mis-denomination this whole path exists to prevent.
      const key = `${appId}:${cur.code}:${name}`;
      if (netCache.has(key)) return { net: netCache.get(key)!, transport: false };
      const pending = netInflight.get(key);
      if (pending) return pending;          // another lane is already asking Steam for this name
      const lookup = (async () => {
        const info = await this.pricing.getSellInfo(name, { ...ctx, appid: appId, currency: cur.code });
        const buyer = targetBuyerMinor(info, strategy);
        // The net we COMMIT is solved with this bot's own currency fee floor: with the wrong
        // floor the listing goes live ABOVE the buyer price it was aiming at, so an 'undercut'
        // silently fails to undercut (v1.4.6, PLN).
        const net = buyer != null ? sellerNetFromBuyer(buyer, feeMinimumOf(cur)) : null;
        if (net != null || info.authoritative) netCache.set(key, net);
        return { net, transport: net == null && !info.authoritative };
      })();
      netInflight.set(key, lookup);
      // Cleared on both paths: a rejected lookup must not leave a poisoned promise that every
      // later item for this name re-awaits (they would all inherit one dead request's failure).
      try { return await lookup; } finally { netInflight.delete(key); }
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
        // Bot containment: processBot's own item/preflight guards already account for
        // everything it reached, so a rejection escaping it is unexpected. Swallow it here so this
        // worker keeps pulling the next bot instead of dying and rejecting Promise.allSettled's
        // sibling — counters are not touched (processBot already recorded what it did; the visible
        // done < total gap plus this log is the honest record).
        try {
          await this.processBot(group, resolveNet, itemDelay, itemConcurrency);
        } catch (err) {
          logger.error(`[mass-sell] ${group.username}: bot aborted (${(err as Error)?.message ?? String(err)})`);
        }
        if (queue.length > 0 && !this.cancelRequested) await sleep(DEFAULT_BOT_DELAY);
      }
    };

    const workers = Math.max(1, Math.min(concurrency, groups.length || 1));
    // Run containment: allSettled — never allow a future worker-reject path to skip the
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
   * Remove this bot's failed rows that are in fact listed (phantoms), by IDENTITY (username +
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
   * The currency this bot's listings must be priced and posted in — its own Steam wallet's —
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
    itemConcurrency: number = DEFAULT_ITEM_CONCURRENCY,
  ): Promise<void> {
    const user = group.username;
    const N = group.items.length;
    // The game for this bot's items — all of one group share it. Threaded into pricing, the
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

    // MONEY SAFETY: establish the currency this bot prices and lists in — its own
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
    const failedHere = new Set<string>(); // S28: identity (assetId), not a positional index into the shared failed[]
    let listedForBot = 0;
    let pendingForBot = 0; // listings (incl. phantoms) that still need a 2FA confirm
    let skippedAlreadyListed = 0; // pre-existing listings we skipped (for the operator-facing count)
    let skippedAwaitingConfirm = 0; // …of which are still unconfirmed → the confirm phase must run
    let transportPriceMisses = 0; // S2: consecutive price lookups that failed at the transport layer (not "no price")

    // Pre-list guard, snapshotted once per bot: the trade-locked / non-tradable
    // asset ids per the cached inventory. `undefined` (no cache) or an id absent from the set
    // ⇒ sellable (defer to Steam). Built lazily on the first item so a malformed disk-cached
    // record throws INSIDE the item try/catch below (H-TRD-024 contains it as one `failed`
    // row, not a fleet abort). The snapshot is at bot-start rather than at-item-time — the
    // window is this bot's runtime, Steam stays the backstop (`gone` + INV-B2's authoritative
    // refresh), and the cache could only change mid-bot via a concurrent refresh anyway.
    let unsellable: Set<string> | undefined;
    let unsellableBuilt = false;

    // ── List the bot's items over PARALLEL LANES, confirming as we go ─────────
    //
    // Two things were wrong with the old strictly-sequential "list everything, then confirm
    // once at the end" shape, and they compound on a big batch:
    //
    //  1. the WALL. Steam caps how many listings may sit awaiting 2FA. Confirming only at the
    //     end meant the backlog grew unbounded until Steam refused every further listing with
    //     "too many listings pending confirmation" — at which point the run was dead in the
    //     water (field report, 2026-08-04: a 263-item sell died at 254). Worse, the message
    //     contains "too many", so it classified as a rate limit and each remaining item burned
    //     3 retries × 15-35 s against a window that could never open, because the only thing
    //     that clears it is confirming. Now the confirm pass is INTERLEAVED: every
    //     CONFIRM_BATCH successful listings we drain the backlog, so it never approaches the
    //     cap — and if Steam says the wall anyway (a pre-existing backlog, a smaller cap on
    //     this account), that is a 'needs-confirm' outcome: drain, then re-list the item.
    //
    //  2. DEAD TIME. One item at a time meant the bot sat idle for the whole round-trip of
    //     every listing (~0.5-1 s) on top of the deliberate anti-spam pause. Lanes overlap
    //     those round-trips without raising the request rate: `pace()` still admits at most
    // one sellitem per `itemDelay` for this bot, so the pacing floor is intact and
    //     the only thing removed is waiting. Latency is hidden, cadence is unchanged.
    let cursor = 0;                       // next unclaimed item (lanes share it)
    let stopReason: string | null = null; // set once → every UNCLAIMED item is deferred below
    let nextDispatchAt = 0;               // wall-clock gate for the shared pacing
    let confirmPass: Promise<void> | null = null; // in-flight interleaved confirm (lanes await it)

    /** Claims the next item, or null when the bot is done/stopping. */
    const claimNext = (): { item: MassSellGroup['items'][number]; pos: string } | null => {
      if (stopReason || this.cancelRequested || cursor >= group.items.length) return null;
      const i = cursor++;
      return { item: group.items[i], pos: `${i + 1}/${N}` };
    };
    /** Stops this bot's remaining (unclaimed) work; in-flight lanes finish their own item. */
    const stopBot = (reason: string): void => { if (!stopReason) stopReason = reason; };
    /** Admits one listing dispatch per `itemDelay` for this bot, across all lanes. */
    const pace = async (): Promise<void> => {
      const now = Date.now();
      const at = Math.max(now, nextDispatchAt);
      nextDispatchAt = at + itemDelay;
      if (at > now) await sleep(at - now);
    };
    /**
     * Drains the 2FA backlog mid-run. Single-flight: a second lane hitting the threshold (or the
     * wall) at the same moment awaits the pass already running instead of starting a second one —
     * two concurrent getlist/confirm rounds on one account would spend its mobileconf budget twice
     * over for the same work. Never throws: a failed drain leaves the listings awaiting manual 2FA
     * exactly as the end-of-bot pass does, and the run continues.
     */
    const drainConfirmations = async (why: string): Promise<void> => {
      if (confirmPass) { await confirmPass; return; }
      const pending = pendingForBot;
      pendingForBot = 0;                  // reset up front: these are now this pass's responsibility
      this.job.phase = 'confirming';
      logger.info(`[mass-sell] ${user}: confirming ${pending} pending listing(s) mid-run (${why})…`);
      confirmPass = (async () => {
        try {
          const n = await this.confirmWithRetry(trader, user);
          this.job.confirmed += n;
          logger.info(`[mass-sell] ${user}: ✓ ${n} listing(s) confirmed via 2FA (mid-run)`);
        } catch (err) {
          this.job.confirmed += (err as { confirmedSoFar?: number }).confirmedSoFar ?? 0;
          logger.error(`[mass-sell] ${user}: mid-run confirmation FAILED (${(err as Error).message}) – those listings await manual 2FA; continuing`);
        } finally {
          this.job.phase = 'listing';
        }
      })();
      try { await confirmPass; } finally { confirmPass = null; }
    };

    /** Processes one claimed item to a terminal outcome. `retryAfterConfirm` allows exactly one
     *  re-list after a backlog drain, so the wall costs an item a confirm pass — not its life. */
    const processItem = async (item: MassSellGroup['items'][number], pos: string, retryAfterConfirm = true): Promise<void> => {
      // Already listed (pre-existing or an earlier phantom) → count once, skip.
      // A pre-existing listing may still be awaiting its 2FA confirm (crash-rerun after
      // listings were created but before the confirm phase). Steam tells us WHICH ones (pending_listings
      // → confirmed:false), so only those arm the confirm gate below. Arming it for already-ACTIVE
      // listings bought nothing and spent a mobileconf/getlist against the account's per-IP budget.
      if (listedSet.has(item.assetId)) {
        this.job.listed++; this.job.done++; skippedAlreadyListed++;
        if (unconfirmedSet.has(item.assetId)) skippedAwaitingConfirm++;
        logger.info(`[mass-sell] ${user} ${pos}: ${item.marketHashName} already listed → skipped (${listedForBot} new this bot)`);
        return;
      }

      // Pre-list guard: never list a trade-locked or non-tradable
      // asset. A locked item must never become an active sell listing. The index is built
      // once on the first item that reaches this guard.
      if (!unsellableBuilt) { unsellable = this.buildUnsellableIndex(user, game); unsellableBuilt = true; }
      if (unsellable?.has(String(item.assetId))) {
        this.job.blocked.push({ username: user, assetId: item.assetId, error: 'trade-locked or not tradable' });
        this.job.done++;
        logger.warn(`[mass-sell] ${user} ${pos}: ${item.marketHashName} is trade-locked / not tradable → blocked (not listed)`);
        return;
      }

      const { net, transport } = await resolveNet(item.marketHashName, { httpsAgent: trader.httpsAgent, cookieHeader: trader.cookieHeader }, appId, currency);
      if (net == null && transport) {
        // S2 (in-run): the price lookup failed at the transport layer (429 storm, proxy
        // reset, 5xx) — Steam never answered, so this is not "no price". Defer the item
        // (retryable), never fail it, so one blip doesn't mass-fail every same-name item.
        this.job.deferred.push({ username: user, assetId: item.assetId, error: 'price lookup failed (connection) – not attempted' });
        this.job.done++;
        transportPriceMisses++;
        logger.warn(`[mass-sell] ${user} ${pos}: ${item.marketHashName} – price lookup failed (connection), deferred`);
        // Two connection-class price misses in a row → the bot's egress is down; stop instead of
        // burning a lookup per item (same philosophy as the 'deferred' outcome).
        if (transportPriceMisses >= 2) {
          logger.warn(`[mass-sell] ${user} ${pos}: price lookups failing (connection) – deferring the remaining item(s)`);
          stopBot('price lookup failed (connection) – not attempted');
        }
        return;
      }
      transportPriceMisses = 0; // Steam answered (a real net or an authoritative no-price) → streak broken.
      if (net == null) {
        this.job.skippedNoPrice++;
        this.job.failed.push({ username: user, assetId: item.assetId, error: 'no market price (skipped)' });
        this.job.done++;
        logger.warn(`[mass-sell] ${user} ${pos}: ${item.marketHashName} – no price, skipped`);
        return;
      }

      // Cross-service guard (D2 / INV-D2): don't list an asset that is mid-flight in
      // another money op (e.g. a trade-send of the same asset). Held only for the list
      // call, so legitimate sequential ops are unaffected.
      const mk = moneyKey(user, item.assetId);
      if (!MoneyOps.claim(mk)) {
        this.job.blocked.push({ username: user, assetId: item.assetId, error: 'busy in another money operation' });
        this.job.done++;
        logger.warn(`[mass-sell] ${user} ${pos}: ${item.marketHashName} busy in another money op → skipped`);
        return;
      }
      // Wait out any in-flight confirm drain, then take this lane's pacing slot.
      if (confirmPass) await confirmPass;
      await pace();
      const outcome = await this.listWithRetry(trader, item.assetId, net, listedSet, appId)
        .finally(() => MoneyOps.release(mk));

      // Steam refused because OUR unconfirmed backlog is full. Drain it, then re-list this item
      // once. The item is not counted here — processItem is re-entered and reaches a terminal
      // outcome there (or is failed below if the wall survives the drain).
      if (outcome === 'needs-confirm') {
        logger.warn(`[mass-sell] ${user} ${pos}: Steam's pending-confirmation backlog is full – confirming now, then re-listing`);
        await drainConfirmations('Steam refused further listings');
        if (retryAfterConfirm) return processItem(item, pos, false);
        this.job.failed.push({ username: user, assetId: item.assetId, error: 'still too many listings pending confirmation after a 2FA pass' });
        this.job.done++;
        failedHere.add(item.assetId);
        logger.error(`[mass-sell] ${user} ${pos}: ✗ ${item.marketHashName} – backlog still full after confirming`);
        return;
      }

      this.job.done++;
      if (outcome === 'listed')      { this.job.listed++; listedForBot++; pendingForBot++;
        logger.info(`[mass-sell] ${user} ${pos}: ✓ listed ${item.marketHashName} @ ${money(net)} net (${listedForBot} listed / ${N})`);
      }
      else if (outcome === 'phantom'){ this.job.listed++; this.job.recovered++; pendingForBot++;
        logger.info(`[mass-sell] ${user} ${pos}: ✓ recovered (phantom) ${item.marketHashName} (${listedForBot + this.job.recovered} listed)`);
      }
      else if (outcome === 'deferred') {
        // Connection died on this item → defer it and the remaining items.
        this.job.deferred.push({ username: user, assetId: item.assetId, error: 'connection lost during listing' });
        logger.warn(`[mass-sell] ${user} ${pos}: connection lost – deferring the remaining item(s)`);
        stopBot('connection lost – not attempted');
        return;
      }
      else if (outcome === 'gone') {
        // Stale candidate: the asset already left the inventory (sold/moved/listed elsewhere).
        // Reported as `gone`, not a failure, and not retried.
        this.job.gone.push({ username: user, assetId: item.assetId, error: 'no longer in inventory' });
        logger.info(`[mass-sell] ${user} ${pos}: ${item.marketHashName} no longer in inventory → skipped (gone)`);
        return;
      } else {
        this.job.failed.push({ username: user, assetId: item.assetId, error: outcome.error });
        failedHere.add(item.assetId);
        logger.error(`[mass-sell] ${user} ${pos}: ✗ failed ${item.marketHashName} – ${outcome.error}`);
        return;
      }

      // Drain the backlog well before Steam's cap rather than discovering it at the wall.
      if (pendingForBot >= CONFIRM_BATCH) await drainConfirmations(`${pendingForBot} awaiting 2FA`);
    };

    const lane = async (): Promise<void> => {
      for (;;) {
        const next = claimNext();
        if (!next) return;
        // Item containment: an UNEXPECTED throw inside one item's processing (e.g.
        // isAssetSellable hitting a malformed disk-cached stack) must cost exactly one `failed`
        // row, never abort the bot — a bare throw here escapes to worker()/Promise.all and would
        // strand the rest of the fleet's workers as zombies against the next run.
        try {
          await processItem(next.item, next.pos);
        } catch (err) {
          const msg = (err as Error)?.message ?? String(err);
          this.job.failed.push({ username: user, assetId: next.item.assetId, error: 'internal error: ' + msg });
          this.job.done++;
          failedHere.add(next.item.assetId);
          logger.error(`[mass-sell] ${user} ${next.pos}: ✗ internal error ${next.item.marketHashName} – ${msg}`);
        }
      }
    };

    const lanes = Math.max(1, Math.min(itemConcurrency, group.items.length));
    if (lanes > 1) logger.info(`[mass-sell] ${user}: listing over ${lanes} lane(s), one dispatch per ${itemDelay}ms, confirming every ${CONFIRM_BATCH}`);
    await Promise.all(Array.from({ length: lanes }, () => lane()));

    // Whatever no lane claimed (End Task, dead connection, dead egress) is deferred as one
    // retryable block — the sequential loop's `slice(i)` in pooled form.
    if (stopReason || this.cancelRequested) {
      const rest = group.items.slice(cursor);
      if (rest.length) {
        logger.warn(`[mass-sell] ${user}: deferring ${rest.length} unattempted item(s) – ${stopReason ?? 'cancelled (End Task) – not attempted'}`);
        this.deferAll(group, rest, stopReason ?? 'cancelled (End Task) – not attempted');
      }
    }

    // ── Final 2FA pass: whatever the mid-run drains left (Hotfix A: retry) ──────
    // Usually a partial batch (< CONFIRM_BATCH) plus anything a drain could not confirm; on a
    // small sell it is still the only pass. H-TRD-026: also arm it when the only pending work is
    // pre-existing listings from an
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
        // up; count those so `confirmed` reflects the truth.
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
   * not abort the run. Retries up to CONFIRM_RETRIES with a 15-20s backoff.
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
      // A 429 is not a 500. errorClass classifies it as {transient:true, rateLimited:true} and its own
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
   *  retries so a brief hiccup doesn't defer a whole bot. Returns the already-listed asset ids and the
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
   *   'needs-confirm' – Steam refused because OUR unconfirmed backlog is full → caller
   *                     confirms, then re-lists this item (see isTooManyPendingConfirmations)
   *   { error }  – a genuine, non-recoverable failure
   */
  private async listWithRetry(
    trader: { sellOnMarket(a: string, n: number, appId: number, contextId?: string): Promise<unknown>; getListedAssetIds(appId: number): Promise<Set<string>>; ready: boolean; sessionState: string; username: string },
    assetId: string,
    net: number,
    listedSet: Set<string>,
    appId: number,
  ): Promise<'listed' | 'phantom' | 'deferred' | 'gone' | 'needs-confirm' | { error: string }> {
    let lastErr = '';
    for (let attempt = 0; attempt <= MAX_SELL_RETRIES; attempt++) {
      try {
        await trader.sellOnMarket(assetId, net, appId);
        listedSet.add(assetId);
        return 'listed';
      } catch (err) {
        lastErr = (err as Error).message;

        // Steam's pending-confirmation wall: OUR unconfirmed backlog, not a Steam fault. Hand it
        // back so the caller runs a 2FA pass and re-lists — retrying here just waits out a window
        // that never opens (this check MUST precede isAlreadyListed, which matches the same text).
        if (isTooManyPendingConfirmations(err)) return 'needs-confirm';

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
          // connection errors). any probe failure → defer: the honest, retryable bucket.
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
