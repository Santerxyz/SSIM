import type { TradeService } from './TradeService';
import type { MarketOrders } from './AccountTrader';
import { MarketPricing, sellerNetFromBuyer, targetBuyerCents, feesForNet, type SellStrategy } from '../pricing/MarketPricing';
import { scaleConcurrency, clampConcurrency } from '../utils/concurrency';
import { logger } from '../utils/logger';

// Listing concurrency scales with the batch (scaleConcurrency: 1 worker / 5 bots, floor 5,
// ceiling 25). Per-bot anti-spam pacing (item/bot delays) still applies inside each worker.
const DEFAULT_ITEM_DELAY  = 1_200; // pause between a bot's individual listings
const DEFAULT_BOT_DELAY    = 3_000; // pause between bots per worker

// ── Stability tuning (Rules 1-3) ──────────────────────────────────────────────
const MAX_SELL_RETRIES   = 3;                       // retries per item on transient errors
const SELL_BACKOFF_MS    = [15_000, 25_000, 35_000]; // backoff before each retry
const PREFLIGHT_RETRIES  = 2;                       // connectivity-probe retries before deferring a bot
const PREFLIGHT_BACKOFF_MS = 8_000;
const CONFIRM_RETRIES    = 3;                       // 2FA-confirmation retries (Steam's confirm servers 500 a lot)
const CONFIRM_BACKOFF_MS = 18_000;                  // pause between confirmation retries

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
    confirmed: 0, recovered: 0, retried: 0, skippedNoPrice: 0, failed: [], deferred: [],
  };
  // Tuning knobs (overridable per run; defaults from the consts above).
  private retryBackoffs = SELL_BACKOFF_MS;
  private preflightBackoff = PREFLIGHT_BACKOFF_MS;
  private confirmBackoff = CONFIRM_BACKOFF_MS;
  /** Co-operative cancel flag for the live mass-sell (set by cancelSell()). */
  private cancelRequested = false;

  constructor(private readonly trades: TradeService) {}

  status(): MassSellJob {
    return { ...this.job, failed: [...this.job.failed], deferred: [...this.job.deferred] };
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
      recovered: 0, retried: 0, skippedNoPrice: 0, failed: [], deferred: [],
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
    const itemDelay   = opts?.itemDelayMs ?? DEFAULT_ITEM_DELAY;
    const customNet   = strategy === 'custom' ? Math.max(1, Math.round(opts?.customCents ?? 0)) : null;
    const netCache = new Map<string, number | null>(); // marketHashName → seller net cents
    const queue = [...groups];

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

    this.job.running = false;
    this.job.cancelling = false;
    this.job.cancelled = this.cancelRequested;
    this.job.phase = 'done';
    this.job.currentBot = undefined;
    this.job.finishedAt = new Date().toISOString();
    logger.info(
      `[mass-sell] ═══ ${this.cancelRequested ? 'CANCELLED' : 'COMPLETE'}: ${this.job.listed} listed / ${this.job.confirmed} confirmed / ` +
      `${this.job.recovered} recovered / ${this.job.retried} retries / ` +
      `${this.job.failed.length} failed / ${this.job.deferred.length} deferred ═══`,
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

      const net = await resolveNet(item.marketHashName, { httpsAgent: trader.httpsAgent, cookies: trader.cookies });
      if (net == null) {
        this.job.skippedNoPrice++;
        this.job.failed.push({ username: user, assetId: item.assetId, error: 'no market price (skipped)' });
        this.job.done++;
        logger.warn(`[mass-sell] ${user} ${pos}: ${item.marketHashName} – no price, skipped`);
        continue;
      }

      const outcome = await this.listWithRetry(trader, item.assetId, net, listedSet);
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
   *   { error }  – a genuine, non-recoverable failure
   */
  private async listWithRetry(
    trader: { sellOnMarket(a: string, n: number): Promise<unknown>; getListedAssetIds(): Promise<Set<string>>; ready: boolean; sessionState: string; username: string },
    assetId: string,
    net: number,
    listedSet: Set<string>,
  ): Promise<'listed' | 'phantom' | 'deferred' | { error: string }> {
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
