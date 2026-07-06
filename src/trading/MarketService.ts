import type { TradeService } from './TradeService';
import type { InventoryService } from '../core/InventoryService';
import type { MarketOrders } from './AccountTrader';
import { MarketPricing, sellerNetFromBuyer, targetBuyerCents, feesForNet, EUR_CURRENCY, type SellStrategy } from '../pricing/MarketPricing';
import { scaleConcurrency, clampConcurrency } from '../utils/concurrency';
import { isSellable } from '../core/MarketModel';
import { MoneyOps, assetKey as moneyKey } from './MoneyOps';
import { logger } from '../utils/logger';

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
const CONFIRM_BACKOFF_MS = 18_000;                  // pause between confirmation retries

/**
 * Money-safety gate (B11): every price SSIM computes is EUR seller-net cents, but
 * Steam's market/sellitem interprets the `price` field in the SELLER's OWN wallet
 * currency's minor units. Listing an EUR-cents number on a non-EUR wallet lists the
 * item ~99% underpriced (10.00€ → ~10 RUB) and it sells instantly = silent real-money
 * loss. So a sell is only safe when the wallet is EUR. We fail CLOSED for a KNOWN
 * non-EUR wallet (never convert-and-guess); an UNKNOWN wallet keeps the EUR common
 * path (a non-EUR wallet is reported by the login 'wallet' event, so the dangerous
 * case is knowable — proceeding-on-unknown never underprices a wallet we've seen).
 */
export function sellWalletBlocked(walletCurrency: number | undefined): boolean {
  return walletCurrency != null && walletCurrency !== EUR_CURRENCY;
}

/** Classifies a Steam/network error as transient (retry) vs. hard (give up). */
function isTransient(err: unknown): boolean {
  const m = ((err as Error)?.message ?? '').toLowerCase();
  return /timeout|timed out|econnreset|esockettimedout|socket hang up|econnrefused|enetunreach|ehostunreach|etimedout|network|noconnection|eresult 3|429|too many|rate.?limit|http( error)? 5\d\d|error 50\d|bad gateway|gateway time-?out|service unavailable|temporarily|tunnel|proxy|aborted/.test(m);
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
  phase?:      'preflight' | 'pricing' | 'listing' | 'confirming' | 'done';
  startedAt?:  string;
  finishedAt?: string;
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

/**
 * Orchestrates mass-selling selected items on the Steam Community Market — the
 * sell-side counterpart to TradeService.startMassSend. Each bot lists its own
 * assets through its isolated session, prices come from MarketPricing (EUR), and
 * every listing is auto-confirmed via 2FA in one batch per bot. Paced via a small
 * worker pool so we never burst-spam Steam.
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
  /** Co-operative cancel flag for the live mass-sell (set by cancelSell()). */
  private cancelRequested = false;

  constructor(
    private readonly trades: TradeService,
    /** Lets a completed sell move the just-listed assets Owned→Listed in the cache
     *  immediately (optimistic), instead of relying on a clean follow-up refresh. */
    private readonly inventory?: InventoryService,
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
  private buildUnsellableIndex(username: string): Set<string> | undefined {
    const inv = this.inventory?.getCached(username);
    if (!inv) return undefined;
    const unsellable = new Set<string>();
    inv.items.forEach(stack => {
      if (isSellable(stack)) return;
      for (const id of stack.assetIds ?? []) unsellable.add(String(id));
    });
    return unsellable;
  }

  /** Lowest market ask (minor units of `currency`) for the buy modal's live-price
   *  button. Delegates to the pricing engine; null when no price is found. */
  lowestAsk(name: string, appid: number, currency: number): Promise<number | null> {
    return this.pricing.getLowestAsk(name, appid, currency);
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

  /** Resolves a bot's price-fetch context (proxy agent + session cookies) so
   *  price checks egress via its IP and the render fallback is authenticated. */
  private async priceCtxFor(username?: string): Promise<{ httpsAgent?: unknown; cookies?: string[] }> {
    if (!username) return {};
    try {
      const trader = await this.trades.getTrader(username);
      return { httpsAgent: trader.httpsAgent, cookies: trader.cookies };
    } catch (err) {
      logger.warn(`[market-price] could not resolve price context for ${username}: ${(err as Error).message}`);
      return {};
    }
  }

  /**
   * Price preview for the sell modal: name → { netCents, buyerCents }.
   * `customCents` (when strategy='custom') is the operator's fixed seller-net
   * price applied to every item – no live lookup needed. Otherwise prices are
   * fetched live, routed through `username`'s bot proxy to dodge rate limits.
   */
  async preview(
    names: string[],
    strategy: SellStrategy,
    opts?: { customCents?: number; username?: string; shouldStop?: () => boolean },
  ): Promise<Record<string, { netCents: number | null; buyerCents: number | null }>> {
    const out: Record<string, { netCents: number | null; buyerCents: number | null }> = {};

    if (strategy === 'custom') {
      const net = Math.max(1, Math.round(opts?.customCents ?? 0));
      const buyer = net + feesForNet(net);
      for (const name of [...new Set(names)]) out[name] = { netCents: net, buyerCents: buyer };
      return out;
    }

    const ctx = await this.priceCtxFor(opts?.username);
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
    const worker = async (): Promise<void> => {
      while (idx < unique.length) {
        if (shouldStop?.()) return;
        if (Date.now() - previewStart >= PREVIEW_BUDGET_MS) { budgetTripped = true; return; }
        const name = unique[idx++];
        // getSellInfo runs its own 3-method cascade internally – one call suffices.
        const info = await this.pricing.getSellInfo(name, { ...ctx, budgetMs: PER_NAME_BUDGET_MS });
        const buyer = targetBuyerCents(info, strategy);
        out[name] = { buyerCents: buyer, netCents: buyer != null ? sellerNetFromBuyer(buyer) : null };
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, unique.length) }, () => worker()));
    // On a 90s budget stop (NOT a client disconnect, where nobody is listening), any name
    // never dispatched gets an explicit null-price row so the modal shows the per-name retry
    // affordance instead of omitting it silently.
    if (budgetTripped) for (const name of unique) if (!(name in out)) out[name] = { buyerCents: null, netCents: null };
    return out;
  }

  startMassSell(
    groups:   MassSellGroup[],
    strategy: SellStrategy,
    opts?: { concurrency?: number; itemDelayMs?: number; customCents?: number; retryBackoffMs?: number; preflightBackoffMs?: number; confirmBackoffMs?: number },
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
    opts?: { concurrency?: number; itemDelayMs?: number; customCents?: number },
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
    const customNet   = strategy === 'custom' ? Math.max(1, Math.round(opts?.customCents ?? 0)) : null;
    const netCache = new Map<string, number | null>(); // marketHashName → seller net cents
    const queue = [...groups];
    // Snapshot which bots were ALREADY live so we release ONLY the sessions this sell creates.
    const wasLiveBefore = this.trades.snapshotLive(groups.map((g) => g.username));

    // Fixed custom price → no lookups; otherwise getSellInfo's internal 3-method
    // cascade (via the bot proxy + cookies) resolves the price. Cached per name.
    // S2 (in-run): a null net is cached (and short-circuits every same-name item) ONLY
    // when Steam actually answered (`info.authoritative`). A transport-failure null
    // (all cascade tries threw) is NOT cached and surfaces as `transport:true` so the
    // caller defers the item instead of failing it and poisoning the rest of the run.
    const resolveNet = async (name: string, ctx: { httpsAgent?: unknown; cookies?: string[] }): Promise<{ net: number | null; transport: boolean }> => {
      if (customNet != null) return { net: customNet, transport: false };
      if (netCache.has(name)) return { net: netCache.get(name)!, transport: false };
      const info = await this.pricing.getSellInfo(name, ctx);
      const buyer = targetBuyerCents(info, strategy);
      const net = buyer != null ? sellerNetFromBuyer(buyer) : null;
      if (net != null || info.authoritative) netCache.set(name, net);
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

  private async processBot(
    group: MassSellGroup,
    resolveNet: (name: string, ctx: { httpsAgent?: unknown; cookies?: string[] }) => Promise<{ net: number | null; transport: boolean }>,
    itemDelay: number,
  ): Promise<void> {
    const user = group.username;
    const N = group.items.length;
    this.job.currentBot = user;
    this.job.phase = 'preflight';

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
      return;
    }

    // MONEY SAFETY (B11): refuse to list on a KNOWN non-EUR wallet — the price is EUR
    // cents and Steam would read it as wallet-currency minor units (~99% underprice).
    // These are BLOCKED (operator must fix the wallet/feature), not deferred (retrying
    // wouldn't help). An unknown wallet keeps the EUR path (see sellWalletBlocked).
    if (sellWalletBlocked(trader.walletCurrency)) {
      const wc = trader.walletCurrency;
      logger.error(`[mass-sell] ${user}: wallet currency ${wc} is not EUR (${EUR_CURRENCY}) – prices are EUR-denominated; listing would underprice ~99%. BLOCKING this bot to protect real money.`);
      for (const item of group.items) {
        this.job.blocked.push({ username: user, assetId: item.assetId, error: `wallet currency ${wc} is not EUR – EUR-only pricing; not listed (would underprice ~99%)` });
        this.job.done++;
      }
      return;
    }

    let listedSet: Set<string>;
    try {
      listedSet = await this.preflightProbe(trader);
    } catch (err) {
      logger.warn(`[mass-sell] ${user}: pre-flight connectivity check failed (${(err as Error).message}) – ${N} item(s) deferred`);
      this.deferAll(group, group.items, `No Steam connection (pre-flight): ${(err as Error).message}`);
      return;
    }
    logger.info(`[mass-sell] ${user}: pre-flight OK (${listedSet.size} existing listing(s)) – listing ${N} item(s)…`);

    // ── List each item (Rules 2 + 3) ──────────────────────────────────────────
    this.job.phase = 'listing';
    const failedHere = new Set<string>(); // S28: identity (assetId), NOT a positional index into the shared failed[]
    let listedForBot = 0;
    let pendingForBot = 0; // listings (incl. phantoms) that still need a 2FA confirm
    let skippedAlreadyListed = 0; // H-TRD-026: pre-existing listings (crash-rerun) — may still await a 2FA confirm
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
      // H-TRD-026: a pre-existing listing may still be awaiting its 2FA confirm (crash-rerun
      // after listings were created but before the confirm phase). Count it so the confirm
      // gate below still fires; confirmMarketListings is idempotent when nothing is pending.
      if (listedSet.has(item.assetId)) {
        this.job.listed++; this.job.done++; skippedAlreadyListed++;
        logger.info(`[mass-sell] ${user} ${pos}: ${item.marketHashName} already listed → skipped (${listedForBot} new this bot)`);
        continue;
      }

      // Pre-list guard (INV-B2 / INV-D1 / C3): never list a trade-locked or non-tradable
      // asset. A locked item must never become an active sell listing. The index is built
      // once (H-TRD-021) on the first item that reaches this guard.
      if (!unsellableBuilt) { unsellable = this.buildUnsellableIndex(user); unsellableBuilt = true; }
      if (unsellable?.has(String(item.assetId))) {
        this.job.blocked.push({ username: user, assetId: item.assetId, error: 'trade-locked or not tradable' });
        this.job.done++;
        logger.warn(`[mass-sell] ${user} ${pos}: ${item.marketHashName} is trade-locked / not tradable → blocked (not listed)`);
        continue;
      }

      const { net, transport } = await resolveNet(item.marketHashName, { httpsAgent: trader.httpsAgent, cookies: trader.cookies });
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
      const outcome = await this.listWithRetry(trader, item.assetId, net, listedSet)
        .finally(() => MoneyOps.release(mk));
      this.job.done++;
      if (outcome === 'listed')      { this.job.listed++; listedForBot++; pendingForBot++;
        logger.info(`[mass-sell] ${user} ${pos}: ✓ listed ${item.marketHashName} @ ${(net / 100).toFixed(2)}€ (${listedForBot} listed / ${N})`);
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
    // H-TRD-026: also arm the confirm phase when the only "pending" work is pre-existing
    // listings from an interrupted earlier run (skippedAlreadyListed) — those may still
    // await mobile confirmation. confirmMarketListings is idempotent (getConfirmations
    // returns only still-pending confirmations → resolves 0 when nothing is left).
    if (pendingForBot + skippedAlreadyListed > 0) {
      this.job.phase = 'confirming';
      logger.info(`[mass-sell] ${user}: confirming ${pendingForBot} new + ${skippedAlreadyListed} pre-existing listing(s) via 2FA…`);
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
    }

    // ── Rule 3 backstop: reconcile phantoms ────────────────────────────────────
    // After confirmation, phantom listings are ACTIVE and WILL show in the
    // listings set. Any item we marked failed that is in fact listed → recover.
    if (failedHere.size > 0) {
      try {
        const finalListed = await trader.getListedAssetIds();
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
    if (nowListed.length) this.inventory?.markListed(user, nowListed);
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
      // Only retry on transient/server errors.
      if (isTransient(err) && attempt < CONFIRM_RETRIES) {
        logger.warn(`[mass-sell] ${user}: 2FA confirm attempt ${attempt + 1}/${CONFIRM_RETRIES + 1} failed (${err.message}) – retry in ${this.confirmBackoff / 1000}s`);
        await sleep(this.confirmBackoff);
        continue;
      }
      throw Object.assign(err, { confirmedSoFar: total });
    }
    throw Object.assign(lastErr instanceof Error ? lastErr : new Error('confirmation failed'), { confirmedSoFar: total });
  }

  /** Rule 1: connectivity pre-flight – probes getListedAssetIds with a couple
   *  of retries so a brief hiccup doesn't defer a whole bot. Returns the live
   *  set of already-listed asset ids; throws only when truly unreachable. */
  private async preflightProbe(trader: { getListedAssetIds(): Promise<Set<string>> }): Promise<Set<string>> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= PREFLIGHT_RETRIES; attempt++) {
      try {
        return await trader.getListedAssetIds();
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
    trader: { sellOnMarket(a: string, n: number): Promise<unknown>; getListedAssetIds(): Promise<Set<string>>; ready: boolean; sessionState: string; username: string },
    assetId: string,
    net: number,
    listedSet: Set<string>,
  ): Promise<'listed' | 'phantom' | 'deferred' | 'gone' | { error: string }> {
    let lastErr = '';
    for (let attempt = 0; attempt <= MAX_SELL_RETRIES; attempt++) {
      try {
        await trader.sellOnMarket(assetId, net);
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
          const nowListed = await trader.getListedAssetIds();
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
