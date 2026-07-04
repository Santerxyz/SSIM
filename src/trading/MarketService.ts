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

/** A "the listing already exists" style rejection → the item IS listed (phantom). */
function isAlreadyListed(err: unknown): boolean {
  const m = ((err as Error)?.message ?? '').toLowerCase();
  // Steam localizes this error to the bot account's display language, so the German
  // variants (bereits/vorhanden/aktiv) are matched on purpose — do NOT remove them.
  return /already|pending listing|bereits|vorhanden|aktiv|listed/.test(m);
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
   * Pre-list guard (INV-B2 / INV-D1 / C3): is this asset sellable per the cached
   * inventory? A trade-locked or non-tradable item must never reach `sellOnMarket` —
   * Steam is only a backstop, and a locked item must never surface as an active sell
   * order. When the cache has no record of the asset we defer to Steam (return true),
   * since the pre-flight already proved connectivity and `gone` handling covers staleness.
   */
  private isAssetSellable(username: string, assetId: string): boolean {
    const inv = this.inventory?.getCached(username);
    if (!inv) return true;
    const stack = inv.items.find(s => (s.assetIds ?? []).some(id => String(id) === String(assetId)));
    if (!stack) return true;
    return isSellable(stack);
  }

  /** Lowest market ask (minor units of `currency`) for the buy modal's live-price
   *  button. Delegates to the pricing engine; null when no price is found. */
  lowestAsk(name: string, appid: number, currency: number, decimals: number): Promise<number | null> {
    return this.pricing.getLowestAsk(name, appid, currency, decimals);
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
    opts?: { customCents?: number; username?: string },
  ): Promise<Record<string, { netCents: number | null; buyerCents: number | null }>> {
    const out: Record<string, { netCents: number | null; buyerCents: number | null }> = {};

    if (strategy === 'custom') {
      const net = Math.max(1, Math.round(opts?.customCents ?? 0));
      const buyer = net + feesForNet(net);
      for (const name of [...new Set(names)]) out[name] = { netCents: net, buyerCents: buyer };
      return out;
    }

    const ctx = await this.priceCtxFor(opts?.username);
    for (const name of [...new Set(names)]) {
      // getSellInfo runs its own 3-method cascade internally – one call suffices.
      const info = await this.pricing.getSellInfo(name, ctx);
      const buyer = targetBuyerCents(info, strategy);
      out[name] = { buyerCents: buyer, netCents: buyer != null ? sellerNetFromBuyer(buyer) : null };
    }
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
    void this.runMassSell(groups, strategy, opts);
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
    const resolveNet = async (name: string, ctx: { httpsAgent?: unknown; cookies?: string[] }): Promise<number | null> => {
      if (customNet != null) return customNet;
      if (netCache.has(name)) return netCache.get(name)!;
      const info = await this.pricing.getSellInfo(name, ctx);
      const buyer = targetBuyerCents(info, strategy);
      const net = buyer != null ? sellerNetFromBuyer(buyer) : null;
      netCache.set(name, net);
      return net;
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
        await this.processBot(group, resolveNet, itemDelay);
        if (queue.length > 0 && !this.cancelRequested) await sleep(DEFAULT_BOT_DELAY);
      }
    };

    const workers = Math.max(1, Math.min(concurrency, groups.length || 1));
    await Promise.all(Array.from({ length: workers }, () => worker()));
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
  private async processBot(
    group: MassSellGroup,
    resolveNet: (name: string, ctx: { httpsAgent?: unknown; cookies?: string[] }) => Promise<number | null>,
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
    const failedHere: Array<{ assetId: string; idx: number }> = [];
    let listedForBot = 0;
    let pendingForBot = 0; // listings (incl. phantoms) that still need a 2FA confirm

    for (let i = 0; i < group.items.length; i++) {
      const item = group.items[i];
      const pos = `${i + 1}/${N}`;

      // "End Task" mid-bot: defer this item + the rest (retryable) and stop this bot.
      if (this.cancelRequested) {
        const rest = group.items.slice(i);
        logger.warn(`[mass-sell] ${user} ${pos}: cancelled (End Task) – deferring ${rest.length} remaining item(s)`);
        this.deferAll(group, rest, 'cancelled (End Task) – not attempted');
        break;
      }

      // Already listed (pre-existing or an earlier phantom) → count once, skip.
      if (listedSet.has(item.assetId)) {
        this.job.listed++; this.job.done++;
        logger.info(`[mass-sell] ${user} ${pos}: ${item.marketHashName} already listed → skipped (${listedForBot} new this bot)`);
        continue;
      }

      // Pre-list guard (INV-B2 / INV-D1 / C3): never list a trade-locked or non-tradable
      // asset. A locked item must never become an active sell listing.
      if (!this.isAssetSellable(user, item.assetId)) {
        this.job.blocked.push({ username: user, assetId: item.assetId, error: 'trade-locked or not tradable' });
        this.job.done++;
        logger.warn(`[mass-sell] ${user} ${pos}: ${item.marketHashName} is trade-locked / not tradable → blocked (not listed)`);
        continue;
      }

      const net = await resolveNet(item.marketHashName, { httpsAgent: trader.httpsAgent, cookies: trader.cookies });
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
        failedHere.push({ assetId: item.assetId, idx: this.job.failed.length - 1 });
        logger.error(`[mass-sell] ${user} ${pos}: ✗ failed ${item.marketHashName} – ${outcome.error}`);
      }

      if (i < group.items.length - 1) await sleep(itemDelay);
    }

    // ── Confirm this bot's pending listings in one 2FA batch (Hotfix A: retry) ──
    if (pendingForBot > 0) {
      this.job.phase = 'confirming';
      logger.info(`[mass-sell] ${user}: confirming ${pendingForBot} listing(s) via 2FA…`);
      try {
        const n = await this.confirmWithRetry(trader, user);
        this.job.confirmed += n;
        logger.info(`[mass-sell] ${user}: ✓ ${n} listing(s) confirmed via 2FA`);
      } catch (err) {
        logger.error(`[mass-sell] ${user}: confirmation FAILED after retries (${(err as Error).message}) – listings exist but await manual 2FA`);
      }
    }

    // ── Rule 3 backstop: reconcile phantoms ────────────────────────────────────
    // After confirmation, phantom listings are ACTIVE and WILL show in the
    // listings set. Any item we marked failed that is in fact listed → recover.
    if (failedHere.length > 0) {
      try {
        const finalListed = await trader.getListedAssetIds();
        let recovered = 0;
        for (const f of failedHere) {
          if (finalListed.has(f.assetId)) {
            this.job.failed[f.idx] = { username: user, assetId: f.assetId, error: '__recovered__' };
            recovered++;
          }
        }
        if (recovered > 0) {
          this.job.failed = this.job.failed.filter(f => f.error !== '__recovered__');
          this.job.listed += recovered;
          this.job.recovered += recovered;
          logger.info(`[mass-sell] ${user}: reconciled ${recovered} phantom listing(s) ← were marked failed`);
        }
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
    trader: { confirmMarketListings(): Promise<number>; username: string },
    user: string,
  ): Promise<number> {
    let total = 0;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= CONFIRM_RETRIES; attempt++) {
      try {
        const n = await trader.confirmMarketListings();
        total += n;
        return total;
      } catch (err) {
        lastErr = err;
        // A partial pass may have confirmed some before failing; a retry picks up
        // the rest (idempotent). Only retry on transient/server errors.
        if (isTransient(err) && attempt < CONFIRM_RETRIES) {
          logger.warn(`[mass-sell] ${user}: 2FA confirm attempt ${attempt + 1}/${CONFIRM_RETRIES + 1} failed (${(err as Error).message}) – retry in ${this.confirmBackoff / 1000}s`);
          await sleep(this.confirmBackoff);
          continue;
        }
        throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('confirmation failed');
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
          // The probe itself failed → the connection is very likely dead.
          if (isTransient(probeErr)) return 'deferred';
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
