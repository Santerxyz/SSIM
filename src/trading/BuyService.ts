import type { TradeService } from './TradeService';
import type { BuyBilling } from './AccountTrader';
import type { InventoryService } from '../core/InventoryService';
import type { GameId, AccountInventory } from '../types/inventory';
import { currencyInfo } from '../pricing/currencies';
import { scaleConcurrency, clampConcurrency } from '../utils/concurrency';
import { logger } from '../utils/logger';

// Give Steam a moment to FILL an instant (matched) buy order before re-checking
// the inventory. A resting order (price below market) simply won't fill yet.
const FILL_SETTLE_MS = 6_000;

// Hard safety ceiling on a single order's TOTAL value (minor units). A fat-finger
// or unit mistake must NEVER commit an unbounded amount of real money. Generous
// for normal use; raise consciously if ever needed.
const MAX_ORDER_TOTAL_MINOR = 500_000; // e.g. 5000.00 in a 2-decimal currency

export interface BuyParams {
  username:          string;
  marketHashName:    string;
  appId:             number;   // 730 (CS2) | 440 (TF2)
  pricePerItemMinor: number;   // account wallet-currency MINOR units, per single item
  quantity:          number;
  billing?:          BuyBilling; // Steam market buy orders require a valid address
  retryAfterConfirm?: boolean;   // opt-in: FarmManager-style re-POST after approve
}

export interface BuyResult {
  username:          string;
  marketHashName:    string;
  appId:             number;
  quantity:          number;
  pricePerItemMinor: number;
  priceTotalMinor:   number;
  currency:          number;
  currencyIso:       string;
  placed:            boolean;
  confirmed:         boolean;
  needsConfirmation: boolean;
  buyOrderId?:       string;
  /** Items actually received (inventory before→after diff) – the source of truth. */
  filled:            number;
  ownedBefore:       number;
  ownedAfter:        number;
  walletBefore?:     number;
  walletAfter?:      number;
  /** True when the post-order verification refresh failed (order WAS placed). */
  verifyFailed:      boolean;
  message:           string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Folder-level "Mass Buy" (Buy across folders) ────────────────────────────────
// Concurrency scales with the batch (scaleConcurrency: 1 worker / 5 accounts, floor 5,
// ceiling 25). Money safety is per-account (in-flight guard, ceiling, post-buy verify,
// never-throw-after-placed) and unaffected by how many DISTINCT accounts buy at once.
const MASS_BUY_ITEM_DELAY_MS       = 1_500; // pause between an account's buys within a worker

/** Parameters for a folder-wide mass-buy. `pricePerItemMajor` is a MAJOR amount
 *  (e.g. 2.05) applied in EACH account's OWN wallet currency – a region-homogeneous
 *  farm shares one currency, and per-account conversion keeps mixed folders correct. */
export interface MassBuyParams {
  usernames:         string[];
  marketHashName:    string;
  appId:             number;   // 730 (CS2) | 440 (TF2)
  pricePerItemMajor: number;
  billing?:          BuyBilling;
  concurrency?:      number;
}

/** Per-account outcome inside a mass-buy run. */
export interface MassBuyAccountResult {
  username:           string;
  currency?:          number;
  currencyIso?:       string;
  walletMinor?:       number;   // fresh balance (minor units) the plan was built on
  pricePerItemMinor?: number;   // price resolved into this account's currency
  plannedQty:         number;   // quantity we attempted (0 = nothing bought)
  filled:             number;   // items actually received (inventory diff)
  placed:             boolean;
  spentMinor?:        number;
  status: 'bought' | 'placed' | 'skipped' | 'failed' | 'refresh-failed';
  message:            string;
}

export interface MassBuyJob {
  running:           boolean;
  /** Operator pressed "End Task" — the run is winding down (no new orders placed). */
  cancelling?:       boolean;
  /** The run ended because it was cancelled (remaining accounts were skipped). */
  cancelled?:        boolean;
  phase:             'refreshing' | 'buying' | 'done';
  marketHashName:    string;
  appId:             number;
  pricePerItemMajor: number;
  total:             number;   // accounts in the run
  refreshed:         number;   // balances refreshed (phase 1)
  processed:         number;   // buy step finished (phase 2)
  placed:            number;   // accounts where an order was placed
  filled:            number;   // total items received across the folder
  skipped:           number;   // couldn't afford ≥1 / unknown wallet
  failed:            number;   // buy step threw
  currentAccount?:   string;
  startedAt?:        string;
  finishedAt?:       string;
  results:           MassBuyAccountResult[];
}

/** Sum of owned quantity for a market_hash_name across the (stacked) inventory. */
function ownedCount(inv: AccountInventory | undefined, marketHashName: string): number {
  if (!inv) return 0;
  return inv.items
    .filter((i) => i.marketHashName === marketHashName)
    .reduce((n, i) => n + (i.quantity || 0), 0);
}

/**
 * Places Steam Community Market BUY ORDERS and VERIFIES the real outcome. Steam's
 * create response — even a "success-ish" one — is NOT proof a buy filled, so after
 * placing we re-fetch the bot's inventory + wallet and report the actual delta.
 * Each bot buys in its OWN native wallet currency through its isolated session.
 *
 * Money-safety invariants:
 *  - ONE in-flight buy per (account,item,appid) — no double-click / retry duplicate.
 *  - Currency must be KNOWN (never guessed) — wrong scale = wrong real-money amount.
 *  - Order total is capped (ceiling + wallet balance) before committing.
 *  - After the order is placed we NEVER throw — a thrown post-order error would
 *    surface as a 5xx and invite a retry that double-spends.
 */
export class BuyService {
  /** Per (account|appid|item) in-flight guard against duplicate real orders. */
  private readonly inFlight = new Set<string>();

  /** Single live folder mass-buy job (polled by the UI). */
  private massJob: MassBuyJob = {
    running: false, phase: 'done', marketHashName: '', appId: 730, pricePerItemMajor: 0,
    total: 0, refreshed: 0, processed: 0, placed: 0, filled: 0, skipped: 0, failed: 0, results: [],
  };
  /** Co-operative cancel flag for the live folder mass-buy (set by cancelMassBuy()). */
  private massCancel = false;

  constructor(
    private readonly trades: TradeService,
    private readonly inventory: InventoryService,
  ) {}

  async buy(p: BuyParams, opts?: { releaseSession?: boolean }): Promise<BuyResult> {
    // A DIRECT buy (POST /api/market/buy) releases the session it creates so it never leaves the
    // account resident; a mass-buy passes releaseSession:false because its batch releases all at once.
    const release = opts?.releaseSession !== false;
    const game: GameId = p.appId === 440 ? 'tf2' : 'cs2';
    const qty = Math.max(1, Math.floor(p.quantity));
    const perItem = Math.round(p.pricePerItemMinor);

    const guardKey = `${p.username.toLowerCase()}|${p.appId}|${p.marketHashName}`;
    if (this.inFlight.has(guardKey)) {
      throw new Error('A buy for this item on this account is already running');
    }
    // Snapshot live-ness BEFORE we touch the account so we only release a session WE create.
    const wasLiveBefore = this.trades.snapshotLive([p.username]);
    this.inFlight.add(guardKey);
    try {
      // SESSION PRE-FLIGHT: guarantee a live web session with a valid sessionid cookie BEFORE
      // committing money — otherwise the order POST fails with "no sessionid cookie". Refreshes
      // (or re-logs-in) the account if its cached cookies are missing/stale.
      const trader = await this.trades.ensureWebSession(p.username);

      // Baseline: a FRESH (non-coalesced) inventory + wallet BEFORE buying.
      const before = await this.inventory.forceRefresh(p.username, game);
      const ownedBefore = ownedCount(before, p.marketHashName);
      const walletBefore = before.wallet?.balance;
      // C11 symmetry (B15): if the BASELINE read was page-cap TRUNCATED, ownedBefore is
      // under-counted, so the later `ownedAfter - ownedBefore` fill diff is unreliable
      // (it would over-report the fill). The AFTER read already guards this; the BEFORE
      // read must too. Remember it so the post-order verification reports "unverified"
      // instead of a wrong fill count — the order still proceeds (money unaffected).
      const baselinePartial = !!before.partial;
      if (baselinePartial) {
        logger.warn(`[${p.username}] pre-buy baseline inventory was PARTIAL (page-capped) – fill count will be reported as unverified`);
      }

      // Currency MUST be known — never guess. A wrong currency/scale spends real
      // money at the wrong amount, so fail closed if the wallet hasn't been seen.
      const currency = trader.walletCurrency ?? before.wallet?.currency;
      if (currency == null) {
        throw new Error(`wallet currency unknown for ${p.username} – refresh the account (await wallet event) and retry`);
      }
      const info = currencyInfo(currency);
      const iso = info.iso;
      const priceTotalMinor = perItem * qty;

      // Safety ceilings BEFORE committing real money.
      if (priceTotalMinor > MAX_ORDER_TOTAL_MINOR) {
        throw new Error(`order total ${priceTotalMinor} exceeds the safety ceiling ${MAX_ORDER_TOTAL_MINOR} (minor units)`);
      }
      const walletMinorBefore = walletBefore != null
        ? Math.round(walletBefore * Math.pow(10, info.decimals))
        : null;
      if (walletMinorBefore != null && priceTotalMinor > walletMinorBefore) {
        throw new Error(`order total ${priceTotalMinor} exceeds wallet balance ${walletMinorBefore} (${iso} minor units)`);
      }

      const order = await trader.createBuyOrder({
        marketHashName: p.marketHashName,
        appId:          p.appId,
        currency,
        pricePerItemMinor: perItem,
        quantity:          qty,
        billing:           p.billing,
        retryAfterConfirm: p.retryAfterConfirm,
      });

      // ── From here the order IS placed on Steam. NEVER throw out of buy() now —
      //    a thrown post-order error would become a 5xx and invite a duplicate retry.
      await sleep(FILL_SETTLE_MS);
      let ownedAfter = ownedBefore;
      let walletAfter = walletBefore;
      // A truncated BASELINE already makes the fill diff unreliable (B15), independent of
      // the AFTER read below.
      let verifyFailed = baselinePartial;
      try {
        const after = await this.inventory.forceRefresh(p.username, game);
        if (after.partial) {
          // The verification read was TRUNCATED (page cap) → ownedAfter would reflect an
          // incomplete inventory, so the fill diff is unreliable. Don't report a possibly
          // wrong fill; mark unverified instead. (C11 / INV-D3.)
          verifyFailed = true;
          logger.warn(`[${p.username}] post-buy verification read was PARTIAL (page-capped) – fill count unreliable; order WAS placed, check manually`);
        } else {
          ownedAfter = ownedCount(after, p.marketHashName);
          walletAfter = after.wallet?.balance;
        }
      } catch (e) {
        verifyFailed = true;
        logger.warn(`[${p.username}] post-buy verification refresh failed: ${(e as Error).message} – order WAS placed, NOT retrying`);
      }
      const filled = Math.max(0, ownedAfter - ownedBefore);
      const spent = walletBefore != null && walletAfter != null && walletAfter < walletBefore;

      let message: string;
      if (verifyFailed) {
        message = `Buy order placed (buyOrderId=${order.buyOrderId ?? '—'}), but inventory verification failed – do NOT retry; check inventory/orders manually`;
      } else if (filled > 0) {
        message = `${filled}/${qty} bought & in inventory (stock ${ownedBefore}→${ownedAfter})`;
      } else if (spent) {
        message = 'Wallet was charged, but no inventory increase detected – please check manually';
      } else if (order.needsConfirmation) {
        message = 'Buy order created – mobile confirmation still pending; please check';
      } else {
        message = 'Buy order placed & confirmed – resting until a seller matches the price (not yet filled)';
      }

      logger.info(
        `[${p.username}] BUY ${p.marketHashName} x${qty} @ ${perItem} ${iso}(minor) → ` +
        `placed=${order.placed} confirmed=${order.confirmed} filled=${filled} verifyFailed=${verifyFailed}`,
      );

      return {
        username:          p.username,
        marketHashName:    p.marketHashName,
        appId:             p.appId,
        quantity:          qty,
        pricePerItemMinor: perItem,
        priceTotalMinor,
        currency,
        currencyIso:       iso,
        placed:            order.placed,
        confirmed:         order.confirmed,
        needsConfirmation: order.needsConfirmation,
        buyOrderId:        order.buyOrderId,
        filled,
        ownedBefore,
        ownedAfter,
        walletBefore,
        walletAfter,
        verifyFailed,
        message,
      };
    } finally {
      this.inFlight.delete(guardKey);
      // Release the session this direct buy created (mass-buy opts out — its batch releases once).
      if (release) await this.trades.releaseCreatedSessions([p.username], wasLiveBefore);
    }
  }

  // ── Folder-level "Mass Buy": refresh every balance, then max out each account ──

  /** Live status of the single folder mass-buy job (UI polls this). */
  massBuyStatus(): MassBuyJob {
    return { ...this.massJob, results: this.massJob.results.map((r) => ({ ...r })) };
  }

  /**
   * Starts a folder-wide mass-buy: every account is balance-refreshed FIRST, then
   * each maxes out its purchase of `marketHashName` at `pricePerItemMajor` (applied
   * in the account's own currency). Returns the initial job status; poll
   * massBuyStatus(). One run at a time (the money path is deliberately serialized).
   */
  startMassBuy(p: MassBuyParams): MassBuyJob {
    if (this.massJob.running) throw new Error('A folder mass-buy is already running');
    const usernames = [...new Set(p.usernames.map((u) => u.trim()).filter(Boolean))];
    if (usernames.length === 0) throw new Error('no accounts to buy on');
    if (!(p.pricePerItemMajor > 0)) throw new Error('price per item must be greater than 0');
    if (p.appId !== 730 && p.appId !== 440) throw new Error('appId must be 730 (CS2) or 440 (TF2)');

    this.massCancel = false; // fresh run — clear any prior cancel request
    this.massJob = {
      running: true, cancelling: false, cancelled: false, phase: 'refreshing',
      marketHashName: p.marketHashName, appId: p.appId, pricePerItemMajor: p.pricePerItemMajor,
      total: usernames.length, refreshed: 0, processed: 0, placed: 0, filled: 0, skipped: 0, failed: 0,
      startedAt: new Date().toISOString(), results: [],
    };
    void this.runMassBuy({ ...p, usernames });
    return this.massBuyStatus();
  }

  /**
   * Requests a co-operative stop of the live folder mass-buy. Any order already
   * committed to Steam completes its money-safe post-verify (never interrupted);
   * workers just stop pulling new accounts, so the rest are skipped. No-op when idle.
   */
  cancelMassBuy(): MassBuyJob {
    if (this.massJob.running) {
      this.massCancel = true;
      this.massJob.cancelling = true;
      logger.info('[mass-buy] cancel requested – remaining accounts will be skipped');
    }
    return this.massBuyStatus();
  }

  private async runMassBuy(p: MassBuyParams): Promise<void> {
    const game: GameId = p.appId === 440 ? 'tf2' : 'cs2';
    // Dynamic scaling across DISTINCT accounts (5→25). An explicit p.concurrency is honoured
    // but CLAMPED to the 25 ceiling so no caller can exceed the intentional proxy/socket cap.
    const concurrency = clampConcurrency(p.concurrency, scaleConcurrency(p.usernames.length));
    // Snapshot which accounts were ALREADY live so we release ONLY the sessions this mass-buy
    // creates (phase 1 logs every account in to read its live balance) — so a folder-wide buy
    // doesn't leave the whole folder resident afterwards.
    const wasLiveBefore = this.trades.snapshotLive(p.usernames);

    // ── PHASE 1 (CRITICAL SAFETY): refresh EVERY account's balance live BEFORE any
    //    plan or spend. The budget math must run on real-time funds, never a stale
    //    cache, so a doomed (insufficient-funds) order is never even attempted.
    const wallets = new Map<string, { currency: number; walletMinor: number } | null>();
    {
      const queue = [...p.usernames];
      const worker = async (): Promise<void> => {
        while (queue.length) {
          if (this.massCancel) break; // "End Task" during balance refresh → stop refreshing the rest
          const u = queue.shift()!;
          try {
            const inv = await this.inventory.forceRefresh(u, game);
            const currency = inv.wallet?.currency;
            const balance  = inv.wallet?.balance;
            if (currency == null || balance == null) {
              wallets.set(u, null);
              logger.warn(`[mass-buy] ${u}: wallet still unknown after refresh – skipped`);
            } else {
              const decimals = currencyInfo(currency).decimals;
              wallets.set(u, { currency, walletMinor: Math.round(balance * Math.pow(10, decimals)) });
            }
          } catch (err) {
            wallets.set(u, null);
            logger.warn(`[mass-buy] ${u}: balance refresh failed (${(err as Error).message}) – skipped`);
          } finally {
            this.massJob.refreshed++;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, p.usernames.length) }, () => worker()));
    }

    // ── PHASE 2: per-account max-affordable plan + execute. buy() re-verifies funds
    //    against its OWN fresh refresh and is money-safe (ceiling, in-flight guard,
    //    never-throw-after-placed), so this is a second safety layer over the plan.
    this.massJob.phase = 'buying';
    {
      const queue = [...p.usernames];
      const worker = async (): Promise<void> => {
        while (queue.length) {
          if (this.massCancel) break; // "End Task": stop committing money on the remaining accounts
          const u = queue.shift()!;
          this.massJob.currentAccount = u;
          await this.massBuyOne(u, p, wallets.get(u) ?? null);
          this.massJob.processed++;
          if (queue.length && !this.massCancel) await sleep(MASS_BUY_ITEM_DELAY_MS);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, p.usernames.length) }, () => worker()));
    }

    // Release the sessions this mass-buy created (orders + verification are done) so the folder
    // returns to its pre-op session baseline instead of staying resident.
    await this.trades.releaseCreatedSessions(p.usernames, wasLiveBefore);

    this.massJob.running = false;
    this.massJob.cancelling = false;
    this.massJob.cancelled = this.massCancel;
    this.massJob.phase = 'done';
    this.massJob.currentAccount = undefined;
    this.massJob.finishedAt = new Date().toISOString();
    logger.info(
      `[mass-buy] ═══ ${this.massCancel ? 'CANCELLED' : 'COMPLETE'}: ${this.massJob.marketHashName} – ${this.massJob.placed} order(s) placed / ` +
      `${this.massJob.filled} item(s) filled / ${this.massJob.skipped} skipped / ${this.massJob.failed} failed ═══`,
    );
    this.massCancel = false;
  }

  /** Plans + executes ONE account's slice of a folder mass-buy from its fresh wallet. */
  private async massBuyOne(
    username: string,
    p: MassBuyParams,
    wallet: { currency: number; walletMinor: number } | null,
  ): Promise<void> {
    const push = (r: MassBuyAccountResult): void => { this.massJob.results.push(r); };

    if (!wallet) {
      this.massJob.skipped++;
      push({ username, plannedQty: 0, filled: 0, placed: false, status: 'refresh-failed',
        message: 'balance unavailable (refresh failed) – skipped for safety' });
      return;
    }

    const info = currencyInfo(wallet.currency);
    const perItem = Math.round(p.pricePerItemMajor * Math.pow(10, info.decimals));
    const base = {
      username, currency: wallet.currency, currencyIso: info.iso,
      walletMinor: wallet.walletMinor, pricePerItemMinor: perItem,
    };
    if (!Number.isFinite(perItem) || perItem < 1) {
      this.massJob.skipped++;
      push({ ...base, plannedQty: 0, filled: 0, placed: false, status: 'skipped', message: 'resolved price < 1 minor unit' });
      return;
    }

    // Max out, bounded by BOTH the live balance AND the per-order safety ceiling.
    const byBalance = Math.floor(wallet.walletMinor / perItem);
    const byCeiling = Math.floor(MAX_ORDER_TOTAL_MINOR / perItem);
    const qty = Math.max(0, Math.min(byBalance, byCeiling));
    if (qty < 1) {
      this.massJob.skipped++;
      push({ ...base, plannedQty: 0, filled: 0, placed: false, status: 'skipped',
        message: `insufficient balance – can't afford one at ${(perItem / Math.pow(10, info.decimals)).toFixed(info.decimals)} ${info.iso}` });
      return;
    }

    try {
      const r = await this.buy({
        username, marketHashName: p.marketHashName, appId: p.appId,
        pricePerItemMinor: perItem, quantity: qty, billing: p.billing, retryAfterConfirm: true,
      }, { releaseSession: false }); // the mass-buy batch releases all created sessions at the end
      if (r.placed) this.massJob.placed++;
      this.massJob.filled += r.filled;
      const spentMinor = (r.walletBefore != null && r.walletAfter != null)
        ? Math.max(0, Math.round((r.walletBefore - r.walletAfter) * Math.pow(10, info.decimals)))
        : undefined;
      push({ ...base, plannedQty: qty, filled: r.filled, placed: r.placed, spentMinor,
        status: r.filled > 0 ? 'bought' : 'placed', message: r.message });
    } catch (err) {
      this.massJob.failed++;
      push({ ...base, plannedQty: qty, filled: 0, placed: false, status: 'failed', message: (err as Error).message });
    }
  }
}
