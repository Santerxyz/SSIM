import type { TradeService } from './TradeService';
import type { BuyBilling } from './AccountTrader';
import type { InventoryService } from '../core/InventoryService';
import { MoneyOpJournal } from '../core/MoneyOpJournal';
import { isAmbiguousCommitFailure } from './commitAmbiguity';
import type { GameId, AccountInventory } from '../types/inventory';
import { knownCurrencyInfo } from '../pricing/currencies';
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
const MASS_BUY_ACCOUNT_DELAY_MS    = 1_500; // pause between two consecutive accounts' orders within one worker

/** Parameters for a folder-wide mass-buy. `pricePerItemMajor` is a MAJOR amount
 *  (e.g. 2.05) applied in each account's own wallet currency – a region-homogeneous
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
  /** true = post-buy verification failed: `filled`/`spentMinor` are UNKNOWN, not zero — see BuyResult.verifyFailed */
  verifyFailed?:      boolean;
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
 * create response — even a "success-ish" one — is not proof a buy filled, so after
 * placing we re-fetch the bot's inventory + wallet and report the actual delta.
 * Each bot buys in its own native wallet currency through its isolated session.
 *
 * Money-safety invariants:
 *  - one in-flight buy per (account,item,appid) — no double-click / retry duplicate.
 *  - Currency must be KNOWN (never guessed) — wrong scale = wrong real-money amount.
 *  - Order total is capped (ceiling + wallet balance) before committing.
 *  - After the order is placed we NEVER throw — a thrown post-order error would
 *    surface as a 5xx and invite a retry that double-spends.
 */
/**
 * Can this account use the Steam Community Market at all?
 *
 * Steam pushes `ClientIsLimitedAccount` on the CM connection at login, so steam-user already holds
 * the answer on every session — SSIM simply never read it. That omission is expensive: a LIMITED
 * account (one that has never spent the ~$5 Steam requires to lift the restriction) cannot use the
 * Market, and `createbuyorder` does not say so. It answers `success:1`, names no order, holds no
 * funds and fills nothing — so SSIM reported `placed=true confirmed=true` for an order that was
 * never created (owner report 2026-08-20: donaldjohnston02, wallet EUR 3.02, two orders accepted,
 * wallet never moved, nothing ever resting).
 *
 * The arithmetic is what makes that conclusive rather than suspected: Steam HOLDS the funds behind a
 * resting buy order. Two accepted orders of 1.99 + 2.00 against a 3.02 wallet cannot both rest — the
 * second would have been refused for insufficient funds. Both were accepted and the balance never
 * changed, so neither order existed.
 *
 * `null` limitations mean the CM has not sent the message yet — genuinely unknown, so it must NOT
 * block a legitimate buy. Only an explicit flag refuses.
 */
export function marketEligibility(
  lim: { limited?: boolean; communityBanned?: boolean; locked?: boolean } | null | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (!lim) return { ok: true };   // not known yet — never guess a refusal onto a real buy
  if (lim.locked) return { ok: false, reason: 'this Steam account is LOCKED, so it cannot use the Community Market' };
  if (lim.communityBanned) return { ok: false, reason: 'this Steam account is COMMUNITY BANNED, so it cannot use the Community Market' };
  if (lim.limited) {
    return { ok: false, reason: 'this is a LIMITED Steam account. Steam does not let limited accounts use the Community Market, and it does not say so — createbuyorder answers success:1, then holds no funds and never fills. Spend the ~$5 Steam requires (a game or wallet top-up SPENT, not just added) to lift the limitation, then re-run' };
  }
  return { ok: true };
}

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
    /** Cross-restart money-op journal, shared with TradeService — see MoneyOpJournal. Defaults to a
     *  no-op so direct construction in tests doesn't touch the shared journal file; createDeps wires the real one. */
    private readonly journal: MoneyOpJournal = MoneyOpJournal.disabled(),
    /** Reads the item's current lowest ask. Injected rather than taking MarketService directly:
     *  MarketService already depends on TradeService, so a hard reference here would close a cycle.
     *  Optional — absent (tests, direct construction) simply means no ask hint. */
    private readonly readAsk?: (name: string, appId: number, currency: number, username: string)
      => Promise<{ minor: number; source: 'lowest' | 'median' } | null>,
  ) {}

  async buy(p: BuyParams, opts?: { releaseSession?: boolean }): Promise<BuyResult> {
    // A DIRECT buy (POST /api/market/buy) releases the session it creates so it never leaves the
    // account resident; a mass-buy passes releaseSession:false because its batch releases all at once.
    const release = opts?.releaseSession !== false;
    const game: GameId = p.appId === 440 ? 'tf2' : 'cs2';
    const qty = Math.floor(Number(p.quantity));            // replaces the Math.max(1, …) up-coercion
    const perItem = Math.round(p.pricePerItemMinor);
    // Fail CLOSED on non-finite/non-positive caller input before any guard/journal state is
    // touched (this throw predates wasLiveBefore/inFlight.add below). Without it a NaN perItem makes
    // priceTotalMinor NaN and both pre-commit ceilings compare false (NaN comparisons) → the caps fail
    // OPEN; the old Math.max(1, …) also up-coerced a quantity-0 request into a real 1-item buy. "invalid"
    // in both messages keys the /api/market/buy classifier to 400 (bad request), not a retryable 502.
    if (!Number.isInteger(perItem) || perItem < 1) throw new Error(`invalid pricePerItemMinor ${p.pricePerItemMinor} – must resolve to an integer ≥ 1 (wallet minor units)`);
    if (!Number.isInteger(qty) || qty < 1) throw new Error(`invalid quantity ${p.quantity} – must resolve to an integer ≥ 1`);

    const guardKey = `${p.username.toLowerCase()}|${p.appId}|${p.marketHashName}`;
    if (this.inFlight.has(guardKey)) {
      throw new Error('A buy for this item on this account is already running');
    }
    // Snapshot live-ness before we touch the account so we only release a session WE create.
    const wasLiveBefore = this.trades.snapshotLive([p.username]);
    this.inFlight.add(guardKey);
    // Set when the commit fails TRANSPORT-AMBIGUOUSLY (the order may already be on Steam). The finally
    // then SKIPS journal.resolve so a retry hits the refuse-once gate instead of double-spending.
    let commitMayHaveLanded = false;
    // Set when this call was REFUSED (a lingering entry). The finally must not resolve the entry it
    // just kept, or a double-click's 2nd click would find nothing and fire the possibly-duplicate op.
    let refused = false;
    try {
      // Cross-restart dedup. A LINGERING journal entry means an identical buy died mid-flight
      // last run (Steam-side outcome unknown). consultRefusal REFUSES it (KEEPING the entry, so a rapid
      // double-click is refused too) until a deliberate-pause min-age elapses, then ALLOWS + consumes it.
      // A cleanly-completed buy leaves no entry, so legitimate repeats are unaffected.
      const priorBuy = this.journal.consultRefusal(guardKey);
      if (priorBuy) {
        refused = true;
        // A machine-readable marker so the money endpoint answers 409 (a honest
        // duplicate-precondition), not a retryable 502 an HTTP client would blindly re-fire.
        const e = new Error(`A matching buy was interrupted before it finished (${new Date(priorBuy.at).toISOString()}) and may already be placed on Steam — check this account's buy orders / inventory, then retry in a few seconds to proceed.`) as Error & { moneyOpRefused?: true };
        e.moneyOpRefused = true;
        throw e;
      }
      this.journal.begin(guardKey, 'buy');
      // SESSION PRE-FLIGHT: guarantee a live web session with a valid sessionid cookie before
      // committing money — otherwise the order POST fails with "no sessionid cookie". Refreshes
      // (or re-logs-in) the account if its cached cookies are missing/stale.
      const trader = await this.trades.ensureWebSession(p.username);

      // MARKET ELIGIBILITY. Checked here, after the session is live (the flags ride the CM login) and
      // BEFORE the journal commits anything or a single euro is risked. A limited account silently
      // swallows buy orders, so without this SSIM reports a placed, confirmed order that does not
      // exist — the worst kind of wrong, because it looks like success.
      const eligible = marketEligibility(trader.limitations);
      if (!eligible.ok) {
        refused = true;
        const e = new Error(`Cannot buy on ${p.username}: ${eligible.reason}. Nothing was ordered.`) as Error & { moneyOpRefused?: true };
        e.moneyOpRefused = true;   // a precondition, not a retryable fault — the route answers 409
        logger.warn(`[${p.username}] buy REFUSED before ordering — ${eligible.reason}`);
        throw e;
      }

      // Baseline: a FRESH (non-coalesced) inventory + wallet before buying.
      const before = await this.inventory.forceRefresh(p.username, game);
      const ownedBefore = ownedCount(before, p.marketHashName);
      const walletBefore = before.wallet?.balance;
      // C11 symmetry: if the BASELINE read was page-cap TRUNCATED, ownedBefore is
      // under-counted, so the later `ownedAfter - ownedBefore` fill diff is unreliable
      // (it would over-report the fill). The after read already guards this; the before
      // read must too. Remember it so the post-order verification reports "unverified"
      // instead of a wrong fill count — the order still proceeds (money unaffected).
      // A stale-fallback baseline (B31 suspect-read substitution) is a failed fresh read,
      // so it mis-anchors ownedBefore the same way a page-capped one does → also unverified.
      const baselinePartial = !!before.partial || !!before.staleReadFallback;
      if (baselinePartial) {
        logger.warn(`[${p.username}] pre-buy baseline inventory was PARTIAL (page-capped) or stale-fallback – fill count will be reported as unverified`);
      }

      // Currency MUST be known — never guess. A wrong currency/scale spends real
      // money at the wrong amount, so fail closed if the wallet hasn't been seen.
      const currency = trader.walletCurrency ?? before.wallet?.currency;
      if (currency == null) {
        throw new Error(`wallet currency unknown for ${p.username} – refresh the account (await wallet event) and retry`);
      }
      // A code we don't recognise could be a 0-decimal currency; scaling with the 2-decimal fallback
      // would mis-price the order 100×. Fail closed before placement — never guess the scale on a money path.
      const info = knownCurrencyInfo(currency);
      if (!info) {
        throw new Error(`unrecognised wallet currency code ${currency} for ${p.username} – refusing to price the order (would risk a 100× mis-scale); update STEAM_CURRENCIES`);
      }
      const iso = info.iso;
      const priceTotalMinor = perItem * qty;

      // Safety ceilings before committing real money.
      if (priceTotalMinor > MAX_ORDER_TOTAL_MINOR) {
        throw new Error(`order total ${priceTotalMinor} exceeds the safety ceiling ${MAX_ORDER_TOTAL_MINOR} (minor units)`);
      }
      const walletMinorBefore = walletBefore != null
        ? Math.round(walletBefore * Math.pow(10, info.decimals))
        : null;
      if (walletMinorBefore != null && priceTotalMinor > walletMinorBefore) {
        throw new Error(`order total ${priceTotalMinor} exceeds wallet balance ${walletMinorBefore} (${iso} minor units)`);
      }

      // WHAT IS THIS ACTUALLY GOING FOR? Read here, where the wallet currency is finally known, and
      // NEVER as a gate — an operator may deliberately want a resting order under the market. Its
      // only job is to make the difference visible between "my bid is under the ask" and "the buy
      // path is broken", which from the outside look identical: both end at placed=true, filled=0.
      // Best-effort by construction; a throttled price read must never block a real buy.
      let askHint = '';
      try {
        const ask = this.readAsk ? await this.readAsk(p.marketHashName, p.appId, currency, p.username) : null;
        if (ask && ask.source === 'lowest' && perItem < ask.minor) {
          askHint = `Your bid of ${perItem} is BELOW the lowest ask of ${ask.minor} (${iso} minor units), so it rests until a seller comes down to it.`;
          logger.warn(`[${p.username}] bid ${perItem} is BELOW the lowest ask ${ask.minor} ${iso}(minor) — this order will REST, not fill`);
        } else if (ask && ask.source === 'median') {
          askHint = 'Steam reported no live lowest ask for this item, only a historical median, so a bid taken from it may never fill.';
          logger.warn(`[${p.username}] no live ask for ${p.marketHashName} — only a median`);
        }
      } catch (e) { logger.info(`[${p.username}] pre-buy ask check unavailable (${(e as Error).message}) – continuing`); }

      const order = await trader.createBuyOrder({
        marketHashName: p.marketHashName,
        appId:          p.appId,
        currency,
        pricePerItemMinor: perItem,
        quantity:          qty,
        billing:           p.billing,
        retryAfterConfirm: p.retryAfterConfirm,
      }).catch((err: unknown) => {
        // A transport-ambiguous commit failure (ECONNRESET/timeout on the response leg, or the
        // explicit verifyBeforeRetry from the resting-order probe) means the order MAY already exist.
        // Flag it so the finally keeps the journal entry → a retry is refused once, not double-spent.
        if (isAmbiguousCommitFailure(err)) commitMayHaveLanded = true;
        throw err;
      });
      if (order.placed) this.journal.record(guardKey, 'buy', 'placed'); // survives a post-commit crash (record never throws)

      // ── From here the order IS placed on Steam. NEVER throw out of buy() now —
      //    a thrown post-order error would become a 5xx and invite a duplicate retry.
      await sleep(FILL_SETTLE_MS);
      let ownedAfter = ownedBefore;
      let walletAfter = walletBefore;
      // A truncated BASELINE already makes the fill diff unreliable, independent of
      // the after read below.
      let verifyFailed = baselinePartial;
      try {
        const after = await this.inventory.forceRefresh(p.username, game);
        if (after.partial || after.staleReadFallback) {
          // The verification read was TRUNCATED (page cap) or a B31 stale-fallback substitution
          // (H-TRD-041: a suspect after-read hands back the pre-buy snapshot) → ownedAfter would
          // reflect an incomplete / stale inventory, so the fill diff is unreliable. Don't report a
          // possibly wrong fill; mark unverified instead.
          verifyFailed = true;
          logger.warn(`[${p.username}] post-buy verification read was ${after.partial ? 'PARTIAL (page-capped)' : 'a stale-fallback substitution'} – fill count unreliable; order WAS placed, check manually`);
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
        // An order that rests is USUALLY a bid under the ask, and `askHint` says so when it is. When
        // it is NOT — the bid is at or above the ask and Steam still will not match it — nothing SSIM
        // controls explains it, so ask STEAM. The probe runs exactly here, at the only moment the
        // answer matters, and never on a healthy buy. Read-only, one request, best-effort.
        let why = askHint;
        if (!why) {
          try {
            const probe = await trader.probeMarketAccess();
            const eligibility = probe.tradeEligibility;
            if (!probe.settled) {
              // Steam bounced the read instead of answering it. That is a finding, not a blank —
              // reporting "no notice" here would read as an all-clear the probe never established.
              why = `Steam would not serve this account's own market page (bounced ${probe.redirects.length}× without landing), so its market standing could NOT be read.`;
            } else if (probe.marketAllowed === false) {
              why = 'Steam reports this account may NOT use the Community Market (g_bMarketAllowed=false), which is why the order rests and never matches.';
            } else if (eligibility && eligibility.allowed === 0) {
              const days = eligibility.steamguard_required_days;
              const cooldown = eligibility.new_device_cooldown_days;
              why = `Steam reports this account is not yet eligible to trade/market${days ? ` (Steam Guard required for ${String(days)} more day(s))` : ''}${cooldown ? ` (new-device cooldown: ${String(cooldown)} day(s))` : ''} — the order rests and cannot match until that clears.`;
            } else if (probe.walletCurrency != null && probe.walletCurrency !== currency) {
              // A bid priced in a currency the wallet is not in cannot be funded, and Steam does not
              // say so on the create — it just never matches.
              why = `Steam reports this account's wallet is currency ${probe.walletCurrency}, but the order was priced in ${currency} (${iso}). A bid Steam cannot fund from the wallet never matches.`;
            } else if (probe.walletBalanceMinor != null && probe.walletBalanceMinor < priceTotalMinor) {
              // Steam HOLDS the funds behind a resting buy order, so a wallet that cannot cover the
              // total cannot hold one. SSIM's own balance comes from the CM 'wallet' event and can be
              // older than this read, which is exactly why the number is re-read here rather than reused.
              why = `Steam reports this account's spendable wallet is ${probe.walletBalanceMinor} ${iso}(minor) — less than the ${priceTotalMinor} this order needs`
                + (probe.walletDelayedBalanceMinor ? `, with a further ${probe.walletDelayedBalanceMinor} still on hold` : '')
                + '. Steam cannot hold the funds for the order, so it never rests and never matches.';
            } else if (probe.notice) {
              why = `Steam's market page says: "${probe.notice.slice(0, 200)}"`;
            }
          } catch (e) { logger.info(`[${p.username}] market access probe unavailable (${(e as Error).message})`); }
        }
        message = `Buy order placed & confirmed${order.buyOrderId ? ` (#${order.buyOrderId})` : ''} – resting until a seller matches the price (not yet filled)`
          + (why ? ` ${why}` : '');
      }

      // buyOrderId is the one handle that ties this run to a row on Steam's own market page. It was
      // captured and then dropped, so a resting order could not be checked against Steam without
      // guessing which one it was — exactly what an unfilled buy leaves you needing (owner 2026-08-20).
      logger.info(
        `[${p.username}] BUY ${p.marketHashName} x${qty} @ ${perItem} ${iso}(minor) → ` +
        `placed=${order.placed} confirmed=${order.confirmed} filled=${filled} verifyFailed=${verifyFailed} ` +
        `buyOrderId=${order.buyOrderId ?? 'NONE-RETURNED'}`,
      );
      // success=1 with no buy_orderid means Steam accepted the POST without naming an order. That is
      // not a normal create, and it is indistinguishable downstream from a healthy one — say so.
      if (order.placed && !order.buyOrderId) {
        logger.warn(`[${p.username}] Steam reported the buy order placed but returned NO buy_orderid – there may be no resting order to find`);
      }

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
      // Release the session this direct buy created (mass-buy opts out — its batch releases once). This
      // runs before journal.resolve so the refuse-once memory survives a crash inside the release await
      //: the outcome has not reached the operator until Express writes the response after this
      // finally, so consuming the entry any earlier would let a post-restart re-fire double-spend a buy the
      // operator never saw complete. releaseCreatedSessions is best-effort (never throws), so resolve is
      // always reached when the process lives; if release ever hangs the entry lingers and the next
      // identical buy is refused once — safe friction consistent with the S15 contract.
      if (release) await this.trades.releaseCreatedSessions([p.username], wasLiveBefore);
      // Consume the entry on a clean resolution (success OR a definite/pre-commit failure), but
      // KEEP it when the commit failed transport-ambiguously or when this call was a refusal.
      if (!commitMayHaveLanded && !refused) this.journal.resolve(guardKey);
    }
  }

  // ── Folder-level "Mass Buy": refresh every balance, then max out each account ──

  /** Live status of the single folder mass-buy job (UI polls this). */
  massBuyStatus(): MassBuyJob {
    return { ...this.massJob, results: this.massJob.results.map((r) => ({ ...r })) };
  }

  /** True while a buy is in flight or a mass-buy job is running — the update scheduler checks this
   *  so a mid-session update never hard-exits into a swap while real orders are being placed. */
  busy(): boolean { return this.inFlight.size > 0 || this.massJob.running; }

  /**
   * Starts a folder-wide mass-buy: every account is balance-refreshed first, then
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
    // Finalize a fire-and-forget orchestrator on rejection — reset running + log — so it never
    // escapes `void` as an unhandledRejection (breaker tick) nor latches the job type until restart.
    void this.runMassBuy({ ...p, usernames }).catch((err) => {
      this.massJob.running = false;
      logger.error(`[mass-buy] orchestrator crashed – job released: ${(err as Error).message}`);
    });
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
    // Snapshot which accounts were already live so we release ONLY the sessions this mass-buy
    // creates (phase 1 logs every account in to read its live balance) — so a folder-wide buy
    // doesn't leave the whole folder resident afterwards.
    const wasLiveBefore = this.trades.snapshotLive(p.usernames);

    // ── PHASE 1 (CRITICAL SAFETY): refresh every account's balance live before any
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
            const cInfo = currency != null ? knownCurrencyInfo(currency) : null;
            if (currency == null || balance == null) {
              wallets.set(u, null);
              logger.warn(`[mass-buy] ${u}: wallet still unknown after refresh – skipped`);
            } else if (!cInfo) {
              // Unrecognised currency code → could be 0-decimal; skip rather than risk a 100× mis-scale.
              wallets.set(u, null);
              logger.warn(`[mass-buy] ${u}: unrecognised wallet currency code ${currency} – skipped for safety (S64)`);
            } else {
              wallets.set(u, { currency, walletMinor: Math.round(balance * Math.pow(10, cInfo.decimals)) });
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
    //    against its own fresh refresh and is money-safe (ceiling, in-flight guard,
    //    never-throw-after-placed), so this is a second safety layer over the plan.
    this.massJob.phase = 'buying';
    {
      const queue = [...p.usernames];
      const worker = async (): Promise<void> => {
        while (queue.length) {
          if (this.massCancel) break; // "End Task": stop committing money on the remaining accounts
          const u = queue.shift()!;
          await this.massBuyOne(u, p, wallets.get(u) ?? null);
          this.massJob.processed++;
          if (queue.length && !this.massCancel) await sleep(MASS_BUY_ACCOUNT_DELAY_MS);
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
    this.massJob.finishedAt = new Date().toISOString();
    logger.info(
      `[mass-buy] ═══ ${this.massCancel ? 'CANCELLED' : 'COMPLETE'}: ${this.massJob.marketHashName} – ${this.massJob.placed} order(s) placed / ` +
      `${this.massJob.filled} item(s) filled / ${this.massJob.skipped} skipped / ${this.massJob.failed} failed ═══`,
    );
    this.massCancel = false;
  }

  /** Plans + executes one account's slice of a folder mass-buy from its fresh wallet. */
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

    // Defence-in-depth — the wallet-setup above already nulls unrecognised codes, but never scale a
    // real per-item price on a fallback guess. Skip if the code isn't known (a 0-decimal currency would 100×).
    const info = knownCurrencyInfo(wallet.currency);
    if (!info) {
      this.massJob.skipped++;
      push({ username, plannedQty: 0, filled: 0, placed: false, status: 'skipped',
        message: `unrecognised wallet currency code ${wallet.currency} – skipped for safety (cannot scale price reliably)` });
      return;
    }
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

    // Max out, bounded by both the live balance and the per-order safety ceiling.
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
      const spentMinor = (!r.verifyFailed && r.walletBefore != null && r.walletAfter != null)
        ? Math.max(0, Math.round((r.walletBefore - r.walletAfter) * Math.pow(10, info.decimals)))
        : undefined;
      push({ ...base, plannedQty: qty, filled: r.filled, placed: r.placed, spentMinor,
        verifyFailed: r.verifyFailed,
        status: r.filled > 0 ? 'bought' : 'placed', message: r.message });
    } catch (err) {
      this.massJob.failed++;
      push({ ...base, plannedQty: qty, filled: 0, placed: false, status: 'failed', message: (err as Error).message });
    }
  }
}
