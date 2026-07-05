import { type SessionManager, refreshWebSession } from '../core/SessionManager';
import type { AccountManager } from '../core/AccountManager';
import type { InventoryService } from '../core/InventoryService';
import { MoneyOpJournal } from '../core/MoneyOpJournal';
import { isAmbiguousCommitFailure } from './commitAmbiguity';
import { isSellable } from '../core/MarketModel';
import { MoneyOps, assetKey as moneyKey } from './MoneyOps';
import { SessionState, type ManagedSession } from '../types/session';
import type { GameId } from '../types/inventory';
import { AccountTrader, type SendTradeParams, type SendTradeResult, type TradeOfferView } from './AccountTrader';
import { logger } from '../utils/logger';
import { parseSteamTradeError } from '../utils/steamTradeError';

// ─── Trade-offer manager (read + batch actions) ───────────────────────────────
// Fetching offers logs each account in (heavy), so reads run through a small fixed
// pool. Mutating actions (accept/decline/cancel) hit Steam's per-account endpoints
// and MUST stay at a low ceiling to avoid Error 15 / rate-limits — exactly the same
// reasoning as mass-send. The batch ceiling is a HARD 2 (an explicit value may lower it).
const OFFERS_READ_CONCURRENCY = 4;   // parallel account reads (login-bound, not Steam-write)
const OFFER_ACTION_CONCURRENCY = 2;  // HARD ceiling for batch accept/decline/cancel
// Batch accept/decline/cancel are per-account Steam WRITES (+ 2FA confirms on accept), so a
// burst trips Error 15 / rate limits exactly like mass-send. Pace every dispatched action
// with a jittered global gap, not just cap parallelism (B44). Shorter than the send floor —
// these are lighter calls — but never zero. Shared across workers via createDispatchThrottle.
const OFFER_ACTION_MIN_DELAY_MS = 600;
const OFFER_ACTION_MAX_DELAY_MS = 1_200;

/**
 * A global dispatch throttle: reserve time slots ≥ a jittered [minGap,maxGap] apart so the gap
 * is between ANY two dispatches across ALL callers/workers, not just two by one worker. Returns
 * an async `pace()` to await BEFORE each dispatch. (Factored out of runMassSend's inline
 * throttle; exported for unit testing the reservation math without real timers.)
 */
export function createDispatchThrottle(
  minGap: number,
  maxGap: number,
  now: () => number = Date.now,
  rand: () => number = Math.random,
): { reserveWaitMs: () => number; pace: () => Promise<void> } {
  const lo = Math.max(0, minGap);
  const hi = Math.max(lo, maxGap);
  let nextSlotAt = 0;
  const reserveWaitMs = (): number => {
    const gap = lo + Math.floor(rand() * (hi - lo + 1));
    const t = now();
    const wait = Math.max(0, nextSlotAt - t);
    nextSlotAt = Math.max(t, nextSlotAt) + gap;
    return wait;
  };
  return {
    reserveWaitMs,
    pace: async (): Promise<void> => { const w = reserveWaitMs(); if (w > 0) await sleep(w); },
  };
}

/** A trade offer action the operator can take on a single offer. */
export type OfferAction = 'accept' | 'decline' | 'cancel';

/** One account's slice of the aggregated Trade-Offers view (or a per-account error). */
export interface AccountOffers {
  username: string;
  sent:     TradeOfferView[];
  received: TradeOfferView[];
  error?:   string;
}

/** One target of a batch offer action. */
export interface OfferActionTarget {
  username: string;
  offerId:  string;
  action:   OfferAction;
}

export interface OfferActionResult {
  username: string;
  offerId:  string;
  action:   OfferAction;
  ok:       boolean;
  error?:   string;
  // 'unconfirmed' = the accept COMMITTED on Steam but the mobile 2FA confirmation failed
  // (ok:true — the offer is no longer actionable, it only awaits manual mobile confirmation).
  status?:  'unconfirmed';
}

// ─── Mass-send orchestration ──────────────────────────────────────────────────
//
// Trades are DELIBERATELY DECOUPLED from the global dynamic concurrency scaler
// (scaleConcurrency, used by inventory refresh / mass buy / mass sell). Bursting many
// trade offers at a SINGLE receiving account trips Steam Error 15 (Access Denied) — Steam's
// per-recipient spam/DDoS protection. So mass-send runs a small FIXED worker pool and paces
// every dispatch by a jittered gap, regardless of batch size, to protect the receiver.

const TRADE_MAX_CONCURRENCY = 1;     // HARD ceiling for trades — fully serial, never scaled (Error 15 guard)
const TRADE_MIN_DELAY_MS    = 1_000; // min gap between two dispatched offers (global, not per-worker)
const TRADE_MAX_DELAY_MS    = 2_000; // max gap (jittered) — lets the receiver process each offer cleanly

// ─── Session-readiness pre-flight (money ops) ─────────────────────────────────
// A cached trader can hold a web session whose `sessionid` cookie Steam has already
// expired (the web session dies well before the CM login). Firing a buy/sell then
// fails with "no sessionid cookie - cannot place order". We refresh the web session
// (same proxy IP) when the cookie is missing OR older than this.
const WEB_SESSION_MAX_AGE_MS = 25 * 60 * 1000;

// ─── Bulk-read session release (anti-accumulation) ────────────────────────────
// Loading the global Trade-Offers view logs EVERY account in (getTrader). If those
// sessions are left live, opening offers across a big environment ends with the whole
// fleet resident (Steam client + proxy sockets + a polling TradeOfferManager each) —
// the same resident-session storm that the bulk REFRESH path already releases against.
// So a read fan-out logs out each account IT logged in, right after reading it; an
// account that was ALREADY live (a trade in progress, or one the user logged in) is
// snapshotted and never torn down. Kill switch: SSIM_RELEASE_READ_SESSIONS=0.
const RELEASE_READ_SESSIONS = process.env.SSIM_RELEASE_READ_SESSIONS !== '0';

/** True when the session has a live, non-empty `sessionid` cookie that isn't stale. */
function hasLiveSessionId(session: ManagedSession): boolean {
  const ws = session.webSession;
  if (!ws?.sessionId) return false;
  const sid = (ws.cookies ?? []).find(c => c.trim().toLowerCase().startsWith('sessionid='));
  const value = sid ? sid.split('=').slice(1).join('=').trim() : '';
  if (!value) return false;
  const ageMs = Date.now() - new Date(ws.obtainedAt).getTime();
  return !Number.isFinite(ageMs) || ageMs < WEB_SESSION_MAX_AGE_MS;
}

/** One sender bot's slice of a mass-send: all its selected assets in one offer. */
export interface MassSendGroup {
  username: string;
  assetIds: string[];
  /** App the assets belong to (730 CS2 / 440 TF2, both context 2). A mass-send is uniform —
   *  it's driven by ONE game tab. Omitted ⇒ CS2 (back-compat). App-agnostic send. */
  appId?:     number;
  contextId?: string;
}

export interface MassTradeJob {
  running:     boolean;
  /** Operator pressed "End Task" — the run is winding down (no new offers dispatched). */
  cancelling?: boolean;
  /** The run ended because it was cancelled (remaining bots were skipped). */
  cancelled?:  boolean;
  /** Set when the run stopped itself (e.g. the shared receiver's inventory filled). */
  stopReason?: string;
  total:       number;   // number of sender bots (= offers)
  done:        number;
  sent:        number;
  confirmed:   number;
  /** Offers that were SENT but whose 2FA confirmation could not be cleared. */
  unconfirmed: number;
  failed:      Array<{ username: string; error: string }>;
  results:     Array<{ username: string; offerId: string; status: 'sent' | 'confirmed' | 'unconfirmed' }>;
  startedAt?:  string;
  finishedAt?: string;
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

/**
 * Orchestrates trading across all managed accounts (mirrors SessionManager's
 * role for sessions). Owns one AccountTrader per account, wires their cookie
 * lifecycle to the SessionManager's 'webSession' event, and enforces the
 * auto-accept guard: incoming offers are only ever auto-accepted when the
 * sender is one of OUR managed accounts (Feature 5).
 */
export class TradeService {
  private readonly traders = new Map<string, AccountTrader>();
  /** Per (account|destination|item-set) in-flight guard against duplicate real sends. */
  private readonly inFlight = new Set<string>();
  private autoAcceptInternal = true;
  /** In-flight count of single/batch offer actions (accept/decline/cancel) — a batch of
   *  accepts clears mobile 2FA confirmations, so busy() must see it to gate an update swap. */
  private offerActionsInFlight = 0;
  private massJob: MassTradeJob = { running: false, total: 0, done: 0, sent: 0, confirmed: 0, unconfirmed: 0, failed: [], results: [] };
  /** Co-operative cancel flag for the live mass-send (set by cancelMass()). */
  private massCancel = false;

  constructor(
    private readonly sessions: SessionManager,
    private readonly accounts: AccountManager,
    /** Optional: lets the send path reject trade-locked / non-tradable assets from
     *  the cached inventory before an offer is created (INV-D1 / C3). */
    private readonly inventory?: InventoryService,
    /** Cross-restart money-op journal (B4). Shared with BuyService so a crash mid-send can't be
     *  double-fired by a user retry after restart. Defaults to a no-op (no disk) so direct construction
     *  in tests never contends on the shared journal file; production wires the real one via createDeps. */
    private readonly journal: MoneyOpJournal = MoneyOpJournal.disabled(),
  ) {
    // Whenever an account (re)gains web cookies, (re)wire its trader.
    this.sessions.on('webSession', (username: string) => {
      void this.attach(username);
    });
    // A destroyed session (logout, re-login, account removal) must take its
    // trader down with it: the trader's TradeOfferManager polls every 5s and
    // would otherwise keep hammering Steam through a dead session forever.
    this.sessions.on('sessionDestroyed', (username: string) => {
      this.detach(username);
    });
  }

  // ── Trader lifecycle ─────────────────────────────────────────────────────

  /** Creates (if needed) and refreshes the trader for a ready session. */
  private async attach(username: string): Promise<void> {
    const session = this.sessions.getSession(username);
    if (!session || !session.webSession) return;

    const key = username.toLowerCase();
    let trader = this.traders.get(key);

    // SESSION ISOLATION: a re-login produces a NEW ManagedSession. A trader
    // still bound to the old one would trade through stale cookies and the OLD
    // network agent (wrong proxy/IP after a change) – rebuild it instead.
    if (trader && !trader.isBoundTo(session)) {
      logger.info(`[${username}] session was replaced – rebuilding trader on the new session`);
      trader.shutdown();
      this.traders.delete(key);
      trader = undefined;
    }

    if (!trader) {
      trader = new AccountTrader(session, (t, offer) => void this.handleNewOffer(t, offer));
      this.traders.set(key, trader);
      logger.info(`[${username}] AccountTrader attached`);
    }

    try {
      await trader.setCookies(session.webSession.cookies);
    } catch (err) {
      logger.error(`[${username}] failed to set trade cookies: ${(err as Error).message}`);
    }
  }

  /** Shuts down and removes an account's trader (no-op when none exists). */
  private detach(username: string): void {
    const key = username.toLowerCase();
    const trader = this.traders.get(key);
    if (!trader) return;
    trader.shutdown();
    this.traders.delete(key);
    logger.info(`[${username}] AccountTrader detached (session destroyed)`);
  }

  /** Returns a ready trader, logging the account in / attaching as needed. */
  async getTrader(username: string): Promise<AccountTrader> {
    const key = username.toLowerCase();
    this.sessions.markUsed(username); // genuine use → keep out of the idle reaper (B40)
    const existing = this.traders.get(key);
    if (existing?.ready) return existing;

    const account = this.accounts.get(username);
    if (!account) throw new Error(`Account "${username}" not found`);

    let session = this.sessions.getSession(username);
    if (!session || session.state !== SessionState.LOGGED_IN || !session.webSession) {
      session = await this.sessions.loginAccount(account);
    }
    await this.attach(username);

    const trader = this.traders.get(key);
    if (!trader) throw new Error(`Could not initialize trader for ${username}`);
    return trader;
  }

  /**
   * Session-readiness PRE-FLIGHT for money ops (buy / sell). Unlike getTrader, this does NOT
   * trust a cached "ready" trader: it verifies the account has a LIVE web session with a valid
   * `sessionid` cookie and, if it's missing or stale, refreshes the web session in place (same
   * proxy IP) — or re-logs-in if the CM session itself died — BEFORE returning the trader.
   * This is the fix for "no sessionid cookie - cannot place order" during mass buy / sell.
   */
  async ensureWebSession(username: string): Promise<AccountTrader> {
    const account = this.accounts.get(username);
    if (!account) throw new Error(`Account "${username}" not found`);
    this.sessions.markUsed(username); // genuine money-op use → keep out of the idle reaper (B40)

    let session = this.sessions.getSession(username);
    // No live login at all → full login (also establishes a fresh web session).
    if (!session || session.state !== SessionState.LOGGED_IN) {
      session = await this.sessions.loginAccount(account);
    }
    // Logged in but the sessionid cookie is missing / empty / stale → refresh cookies WITHOUT a
    // full re-login (keeps the same proxy exit IP, avoids Steam's IP-change security filter).
    if (!hasLiveSessionId(session)) {
      logger.info(`[${username}] pre-flight: web session not ready (no/stale sessionid) – refreshing`);
      try {
        await refreshWebSession(session);
      } catch (err) {
        logger.warn(`[${username}] web-session refresh failed (${(err as Error).message}) – re-logging in`);
        session = await this.sessions.loginAccount(account);
      }
    }
    await this.attach(username); // (re)wire the trader onto the now-ready cookies
    const trader = this.traders.get(username.toLowerCase());
    if (!trader) throw new Error(`Could not initialize trader for ${username}`);
    return trader;
  }

  // ── New feature: global Trade-Offers manager ─────────────────────────────

  /**
   * Aggregates sent + received trade offers across `usernames` (typically every bot
   * in an environment). Each account is read through its own isolated session via a
   * small fixed worker pool — a read logs the account in, which is the heavy part, so
   * we never fan out to the whole fleet at once. A single account's failure (offline,
   * dead proxy, no API access) is captured as a per-account `error` and NEVER aborts
   * the others, so the manager always renders what it can.
   */
  async getOffersForAccounts(
    usernames: string[],
    opts?: { historyLimit?: number },
  ): Promise<AccountOffers[]> {
    const unique = [...new Set(usernames.map(u => u.trim()).filter(Boolean))];
    const results: AccountOffers[] = [];
    const queue = [...unique];

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const username = queue.shift()!;
        // Snapshot live-ness BEFORE we touch the account so we only release sessions WE create —
        // never one the user already had live (e.g. mid-trade) or logged in concurrently.
        const wasLiveBefore = this.sessions.isLive(username);
        try {
          const trader = await this.getTrader(username);
          const offers = await trader.getTradeOffers({ historyLimit: opts?.historyLimit });
          results.push({ username, sent: offers.sent, received: offers.received });
        } catch (err) {
          logger.warn(`[offers] ${username}: ${(err as Error).message}`);
          results.push({ username, sent: [], received: [], error: (err as Error).message });
        } finally {
          // Release the session this read created (inventory/offers already in hand), so loading
          // offers across a big environment never leaves the whole fleet resident. Best-effort.
          if (RELEASE_READ_SESSIONS && !wasLiveBefore && this.sessions.isLive(username)) {
            await this.sessions.logoutAccount(username).catch(() => undefined);
          }
        }
      }
    };

    const workers = Math.max(1, Math.min(OFFERS_READ_CONCURRENCY, unique.length || 1));
    await Promise.all(Array.from({ length: workers }, () => worker()));
    // Stable order: present accounts in the order they were requested.
    const order = new Map(unique.map((u, i) => [u.toLowerCase(), i]));
    results.sort((a, b) => (order.get(a.username.toLowerCase()) ?? 0) - (order.get(b.username.toLowerCase()) ?? 0));
    return results;
  }

  /** Performs ONE offer action (accept / decline / cancel) for `username`.
   *  Wraps the whole body in the busy() counter (covers the single-action route AND every
   *  batch worker with one site). The `return await`s are load-bearing: returning the bare
   *  promise would run the finally (decrement) the moment the promise is created, making the
   *  gate false during the very accept+2FA window it exists to cover. */
  async offerAction(username: string, offerId: string, action: OfferAction): Promise<'done' | 'unconfirmed'> {
    this.offerActionsInFlight++;
    try {
      const trader = await this.getTrader(username);
      // A two-sided accept COMMITS on Steam even when its 2FA confirmation later fails; the trader
      // reports that as 'unconfirmed' (never rethrown) so the offer is not shown as "failed" — it
      // is done on Steam and only awaits a manual mobile confirmation (mirrors the send path). The
      // `await` is load-bearing (see the doc above): the finally decrement must not fire before the
      // accept+2FA window closes.
      if (action === 'accept') {
        const status = await trader.acceptTradeOffer(offerId);
        return status === 'unconfirmed' ? 'unconfirmed' : 'done';
      }
      // 'cancel' (our sent offer) and 'decline' (an incoming offer) share one Steam call;
      // the library routes it by the offer's isOurOffer flag.
      await trader.cancelOrDeclineOffer(offerId);
      return 'done';
    } finally {
      this.offerActionsInFlight--;
    }
  }

  /**
   * Runs a batch of offer actions through a HARD concurrency-2 pool (Error-15 / rate-limit
   * guard — never scaled). Every target is attempted; failures are reported per-item and
   * never abort the batch. Returns a result row for each input target.
   *
   * Like every other fleet-wide login fan-out, this releases the sessions it CREATES: targets
   * are grouped by account and each worker takes one account's group, snapshots its live-ness
   * BEFORE the first action, runs that account's actions sequentially, and logs the session out
   * in a `finally` iff we created it (same guard as the offers read at 323-325). Without this a
   * "decline/cancel all" across a big environment logs in one session per account and keeps them
   * all resident until the reaper — the one bulk path that used to leave the fleet accumulating.
   */
  async batchOfferAction(
    targets: OfferActionTarget[],
    opts?: { concurrency?: number },
  ): Promise<OfferActionResult[]> {
    const concurrency = Math.min(OFFER_ACTION_CONCURRENCY, Math.max(1, opts?.concurrency ?? OFFER_ACTION_CONCURRENCY));
    const results: OfferActionResult[] = [];
    // Group targets by account, preserving first-seen order, so a worker owns ALL of one
    // account's actions — same-account writes serialize (strictly safer for Error 15) and the
    // session is released exactly once, only if this batch created it. ≤2 accounts in flight ⇒
    // ≤2 actions in flight, so OFFER_ACTION_CONCURRENCY (2) still hard-caps action parallelism.
    const groups = new Map<string, OfferActionTarget[]>();
    for (const t of targets) {
      const key = t.username.toLowerCase();
      const g = groups.get(key);
      if (g) g.push(t);
      else groups.set(key, [t]);
    }
    const queue = [...groups.values()];
    // Global dispatch pacing (B44): a jittered gap between ANY two actions across both
    // workers, so a large batch of accepts/declines/cancels never bursts a single
    // account's Steam write endpoints (Error-15 / rate-limit guard) — the same reasoning
    // as mass-send, which this previously lacked entirely.
    const throttle = createDispatchThrottle(OFFER_ACTION_MIN_DELAY_MS, OFFER_ACTION_MAX_DELAY_MS);

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const group = queue.shift()!;
        const username = group[0].username;
        // Snapshot live-ness BEFORE we touch the account so we only release sessions WE create —
        // never one the user already had live (e.g. mid-trade) or logged in concurrently.
        const wasLiveBefore = this.sessions.isLive(username);
        try {
          for (const t of group) {
            await throttle.pace(); // space this action from every other in-flight one
            try {
              const status = await this.offerAction(t.username, t.offerId, t.action);
              // An 'unconfirmed' accept committed on Steam (ok:true) — it awaits a manual mobile
              // confirmation, not a re-run; carry that distinction onto the row so the UI can
              // report it separately instead of counting it as a failure.
              results.push({ ...t, ok: true, ...(status === 'unconfirmed' ? { status } : {}) });
            } catch (err) {
              results.push({ ...t, ok: false, error: (err as Error).message });
              logger.error(`[offers] ${t.username} ${t.action} ${t.offerId} failed: ${(err as Error).message}`);
            }
          }
        } finally {
          // Release the session this batch created, so a fleet-wide decline/cancel never leaves
          // the whole environment resident. Best-effort; honours SSIM_RELEASE_READ_SESSIONS=0.
          if (RELEASE_READ_SESSIONS && !wasLiveBefore && this.sessions.isLive(username)) {
            await this.sessions.logoutAccount(username).catch(() => undefined);
          }
        }
      }
    };

    const workers = Math.max(1, Math.min(concurrency, groups.size || 1));
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return results;
  }

  // ── Bulk-op session release helpers (anti-accumulation) ───────────────────
  // Shared by every fleet-wide login fan-out (offers read + batch accept/decline/cancel +
  // mass send/sell/buy) so none of them can leave the whole fleet resident — the resident-session
  // storm that, unbounded, lets the process be externally killed. Mirrors InventoryService.runRefresh's
  // release. (batchOfferAction releases inline per-account rather than via snapshotLive/releaseCreatedSessions,
  // mirroring the offers-read fan-out it shares its per-account structure with.)

  /** True when the account currently has a live (or logging-in) session. Lets a bulk op decide
   *  which sessions are ITS OWN to release vs. one the user already had live. */
  isLive(username: string): boolean { return this.sessions.isLive(username); }

  /** Snapshot of which of `usernames` are ALREADY live — captured BEFORE a bulk op so it only
   *  ever releases sessions it itself creates (never one the user had live, e.g. mid-trade). */
  snapshotLive(usernames: string[]): Set<string> {
    const set = new Set<string>();
    for (const u of usernames) if (this.sessions.isLive(u)) set.add(u.toLowerCase());
    return set;
  }

  /**
   * Releases the sessions a bulk op CREATED: logs out each listed account that was NOT already
   * live before the op (per `wasLiveBefore`) and is live now, so a fleet-wide send/sell/buy/offers
   * pass returns to the pre-op session baseline instead of leaving the fleet resident. Sequential
   * + best-effort (a logout never throws here); honours SSIM_RELEASE_READ_SESSIONS=0. Returns count.
   */
  async releaseCreatedSessions(usernames: string[], wasLiveBefore: Set<string>): Promise<number> {
    if (!RELEASE_READ_SESSIONS) return 0;
    let released = 0;
    for (const u of [...new Set(usernames.map((x) => x.toLowerCase()))]) {
      if (wasLiveBefore.has(u)) continue;
      if (this.sessions.isLive(u)) {
        await this.sessions.logoutAccount(u).catch(() => undefined);
        released++;
      }
    }
    if (released) logger.info(`[bulk] released ${released} session(s) created by the op (fleet returned to baseline)`);
    return released;
  }

  // ── Feature 2: trade URL ─────────────────────────────────────────────────

  async getTradeUrl(username: string): Promise<string> {
    const trader = await this.getTrader(username);
    return trader.getTradeUrl();
  }

  // ── Feature 3 / 4: send a trade from a given account ─────────────────────

  /**
   * Strips trade-locked / non-tradable assets (per the cached inventory) from a send.
   * Returns params with `myItems` reduced to the sellable subset; throws if that subset
   * is empty. No cache (or no inventory dep) ⇒ pass through unchanged — Steam stays the
   * backstop. (INV-D1 / C3.)
   */
  private filterSendable(username: string, params: SendTradeParams): SendTradeParams {
    const items = params.myItems ?? [];
    if (!items.length || !this.inventory) return params;
    // A send is uniform in appId (driven by one game tab), so resolve the game from the
    // items' appId — 440 → TF2, else CS2 — and check THAT game's cached inventory for the
    // trade-lock / non-tradable guard. Using the CS2 cache for a TF2 send would find no
    // stack and silently skip the guard. (App-agnostic send: CS2 + TF2.)
    const game: GameId = (items[0]?.appId ?? 730) === 440 ? 'tf2' : 'cs2';
    const inv = this.inventory.getCached(username, game);
    if (!inv) return params;
    const stackOf = (assetId: string) =>
      inv.items.find(s => (s.assetIds ?? []).some(id => String(id) === String(assetId)));
    const blocked: string[] = [];
    const kept = items.filter((it) => {
      const stack = stackOf(it.assetId);
      if (stack && !isSellable(stack)) { blocked.push(it.assetId); return false; }
      return true;
    });
    if (blocked.length) {
      logger.warn(`[trade-send] ${username}: dropped ${blocked.length} trade-locked/non-tradable asset(s) from the offer: ${blocked.join(', ')}`);
    }
    if (!kept.length) {
      throw new Error('All selected items are trade-locked or not tradable – nothing to send');
    }
    return { ...params, myItems: kept };
  }

  async sendTrade(fromUsername: string, params: SendTradeParams): Promise<SendTradeResult> {
    // Guard (INV-D1 / C3): a trade-locked or non-tradable asset can never go into an
    // offer. Drop such assets up front (Steam rejects the whole offer otherwise) and
    // proceed with the sellable remainder; throw only if nothing tradable is left.
    params = this.filterSendable(fromUsername, params);
    // Idempotency guard: an identical (account + destination + item-set) send that is
    // already in flight must NOT fire a second real-asset offer on a double-click or
    // client retry. Mirrors BuyService's per-item in-flight Set. The destination and
    // the sorted asset id list make two genuinely-distinct sends hash differently.
    const assetKey = [...(params.myItems ?? []).map((i) => i.assetId)].sort().join(',');
    const dest = (params.tradeUrl ?? params.partnerSteamId ?? '').trim();
    const guardKey = `${fromUsername.toLowerCase()}|${dest}|${assetKey}`;
    if (this.inFlight.has(guardKey)) {
      throw new Error('An identical trade from this account is already in flight');
    }
    this.inFlight.add(guardKey);
    // Cross-service guard (D2 / INV-D2): refuse if any of these assets is mid-flight in
    // ANOTHER money op (e.g. being listed for sale), then hold them for this op's lifetime.
    const moneyKeys = (params.myItems ?? []).map((i) => moneyKey(fromUsername, i.assetId));
    const collision = moneyKeys.find((k) => MoneyOps.held(k));
    if (collision) {
      this.inFlight.delete(guardKey);
      throw new Error('An asset in this trade is already in another money operation (sell/buy) – try again shortly');
    }
    moneyKeys.forEach((k) => MoneyOps.claim(k));
    // B4/S15: cross-restart dedup. A LINGERING journal entry means an identical send died mid-flight
    // last run (Steam-side outcome unknown). consultRefusal REFUSES it (KEEPING the entry, so a rapid
    // double-click is refused too) until a deliberate-pause min-age elapses, then ALLOWS + consumes it.
    // A cleanly-completed send leaves no entry, so a legitimate sequential repeat is never affected.
    const priorSend = this.journal.consultRefusal(guardKey);
    if (priorSend) {
      this.inFlight.delete(guardKey);
      moneyKeys.forEach((k) => MoneyOps.release(k));
      // S15: do NOT resolve here — consultRefusal KEEPS the entry so a rapid re-fire is refused too.
      // Marker so the send endpoint answers 409 (honest duplicate-precondition), not a retryable 502.
      const e = new Error(`An identical trade was interrupted before it finished (${new Date(priorSend.at).toISOString()}) and may already exist on Steam — check this account's trade offers, then retry in a few seconds to proceed.`) as Error & { moneyOpRefused?: true };
      e.moneyOpRefused = true;
      throw e;
    }
    this.journal.begin(guardKey, 'send');
    // S3: set when offer.send fails TRANSPORT-AMBIGUOUSLY (the offer may already exist on Steam). The
    // finally then SKIPS journal.resolve so a retry hits the refuse-once gate instead of duplicating it.
    let commitMayHaveLanded = false;
    try {
      const trader = await this.getTrader(fromUsername);
      try {
        const result = await trader.sendTrade(params);
        this.journal.record(guardKey, 'send', 'sent'); // the offer now exists on Steam (survives a post-commit crash)
        return result;
      } catch (err) {
        // S3: an ECONNRESET/timeout on offer.send's response leg means the offer MAY have landed — keep
        // the journal entry so a retry is refused once. A definite Steam rejection (eresult) is not
        // ambiguous → the entry resolves normally. Classify the RAW error before it is re-shaped below.
        if (isAmbiguousCommitFailure(err)) commitMayHaveLanded = true;
        // Bubble Steam's ACTUAL reason up cleanly (eresult / cause / full-inventory text),
        // reading only what Steam returned — never a follow-up inventory fetch. The parsed
        // flags are attached so callers that want structure (not just the string) have them.
        const parsed = parseSteamTradeError(err);
        const clean = new Error(parsed.message) as Error & { eresult?: number; cause?: string; code?: string; inventoryFull?: boolean; commitMayHaveLanded?: boolean };
        if (parsed.eresult != null) clean.eresult = parsed.eresult;
        if (parsed.cause) clean.cause = parsed.cause;
        if (parsed.code) clean.code = parsed.code;
        clean.inventoryFull = parsed.inventoryFull;
        // S3/H-FLT-001: carry the transport-ambiguity verdict on the re-thrown error. parseSteamTradeError
        // reshapes the message, so a caller (the CSFloat auto-accept worker) cannot re-classify reliably —
        // it reads this flag to know the offer MAY exist on Steam and must never be auto-resent.
        clean.commitMayHaveLanded = commitMayHaveLanded;
        throw clean;
      }
    } finally {
      this.inFlight.delete(guardKey);
      moneyKeys.forEach((k) => MoneyOps.release(k));
      // S3: consume the entry on a clean resolution (success OR a definite failure), but KEEP it when the
      // commit failed transport-ambiguously — so the next attempt is refused once, not duplicated.
      if (!commitMayHaveLanded) this.journal.resolve(guardKey);
    }
  }

  // ── v2.1: Mass-send orchestrator (folder → storage) ──────────────────────

  massStatus(): MassTradeJob {
    return { ...this.massJob, failed: [...this.massJob.failed], results: [...this.massJob.results] };
  }

  /**
   * Starts a paced mass-send: each group is ONE bot sending all its selected
   * assets to `tradeUrl` in a single offer, auto-confirmed via 2FA. Runs in the
   * background through a small worker pool so we never burst-spam Steam. Returns
   * the initial job state immediately; poll massStatus() for progress.
   */
  startMassSend(
    groups:   MassSendGroup[],
    tradeUrl: string,
    opts?: { concurrency?: number; delayMs?: number; message?: string },
  ): MassTradeJob {
    if (this.massJob.running) throw new Error('A mass-send is already running');
    this.massCancel = false; // fresh run — clear any prior cancel request
    this.massJob = {
      running: true, cancelling: false, cancelled: false, total: groups.length, done: 0, sent: 0, confirmed: 0, unconfirmed: 0,
      failed: [], results: [], startedAt: new Date().toISOString(),
    };
    // S33: finalize a fire-and-forget orchestrator on rejection — reset running + log — so it never
    // escapes `void` as an unhandledRejection (breaker tick) nor latches the job type until restart.
    void this.runMassSend(groups, tradeUrl, opts).catch((err) => {
      this.massJob.running = false;
      logger.error(`[mass-send] orchestrator crashed – job released: ${(err as Error).message}`);
    });
    return this.massStatus();
  }

  /**
   * Requests a co-operative stop of the live mass-send. Does NOT abort the offer
   * already in flight — workers simply stop pulling new bots off the queue, so the
   * remaining accounts are skipped cleanly. No-op when nothing is running.
   */
  cancelMass(): MassTradeJob {
    if (this.massJob.running) {
      this.massCancel = true;
      this.massJob.cancelling = true;
      logger.info('[mass] cancel requested – remaining bots will be skipped');
    }
    return this.massStatus();
  }

  private async runMassSend(
    groups:   MassSendGroup[],
    tradeUrl: string,
    opts?: { concurrency?: number; delayMs?: number; message?: string },
  ): Promise<void> {
    // HARDCODED concurrency: trades NEVER use the dynamic scaler (Error 15 guard). The cap is
    // exactly TRADE_MAX_CONCURRENCY (1 — fully serial) no matter how many bots are queued; an
    // explicit opts.concurrency may only LOWER it, never raise it above the hard ceiling.
    const concurrency = Math.min(TRADE_MAX_CONCURRENCY, Math.max(1, opts?.concurrency ?? TRADE_MAX_CONCURRENCY));
    // Global pacing floor: every dispatched offer is at least this far apart in time, jittered up
    // to TRADE_MAX_DELAY_MS so the receiving Steam account isn't hit by a burst. An explicit
    // opts.delayMs may RAISE the floor (slower = safer) but never drop below the 1s minimum.
    const minGap = Math.max(TRADE_MIN_DELAY_MS, opts?.delayMs ?? 0);
    const maxGap = Math.max(TRADE_MAX_DELAY_MS, minGap);
    const queue  = [...groups];
    // Snapshot which senders were ALREADY live so we release ONLY the sessions this send creates.
    const wasLiveBefore = this.snapshotLive(groups.map((g) => g.username));

    // Global dispatch throttle (shared across ALL workers): reserve time slots `gap` apart so the
    // gap is between ANY two offers, not just two sends by the same worker. At the default ceiling
    // of 1 this means offers go out strictly one-at-a-time, each ≥1–2s after the last — the safest
    // possible cadence against Steam Error 15. (If the ceiling is ever raised, the throttle still
    // guarantees the inter-offer gap regardless of worker count.)
    let nextSlotAt = 0;
    const throttle = async (): Promise<void> => {
      const gap = minGap + Math.floor(Math.random() * (maxGap - minGap + 1));
      const now = Date.now();
      const wait = Math.max(0, nextSlotAt - now);
      nextSlotAt = Math.max(now, nextSlotAt) + gap;
      if (wait > 0) await sleep(wait);
    };

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        if (this.massCancel) break; // "End Task": stop pulling new bots; in-flight offer (if any) finishes
        const group = queue.shift()!;
        await throttle(); // pace the dispatch BEFORE sending (anti-spam, per-recipient Error 15 guard)
        if (this.massCancel) break; // re-check after the pacing wait so we don't fire a freshly-paced offer
        try {
          const res = await this.sendTrade(group.username, {
            tradeUrl,
            // Carry each asset's real app/context so a TF2 (440) mass-send builds a TF2 offer,
            // not a CS2 one. group.appId/contextId default to CS2 in toEconItem. (App-agnostic.)
            myItems: group.assetIds.map(id => ({ assetId: id, appId: group.appId, contextId: group.contextId })),
            message: opts?.message,
          });
          this.massJob.sent++;
          if (res.status === 'confirmed')   this.massJob.confirmed++;
          if (res.status === 'unconfirmed') this.massJob.unconfirmed++;
          this.massJob.results.push({ username: group.username, offerId: res.offerId, status: res.status });
          logger.info(`[mass] ${group.username} → offer ${res.offerId} (${res.status})  [${this.massJob.done + 1}/${this.massJob.total}]`);
        } catch (err) {
          this.massJob.failed.push({ username: group.username, error: (err as Error).message });
          logger.error(`[mass] ${group.username} failed: ${(err as Error).message}`);
          // Every group targets the SAME receiver, so a full-inventory rejection dooms every
          // remaining bot (login + pacing gap + a refused offer each). Stop the run at the first
          // one, exactly as an operator "End Task" does — the cooperative-cancel checks (667/670)
          // drain the queue and the epilogue marks cancelled:true. Remedy is free space + re-run.
          if ((err as { inventoryFull?: boolean }).inventoryFull === true && !this.massCancel) {
            this.massCancel = true;
            this.massJob.cancelling = true;
            this.massJob.stopReason = 'Receiver inventory full — remaining bots skipped';
            logger.error(`[mass] receiver inventory is full — stopping the run (${queue.length} bot(s) skipped)`);
          }
        } finally {
          this.massJob.done++;
        }
      }
    };

    const workers = Math.max(1, Math.min(concurrency, groups.length || 1));
    await Promise.all(Array.from({ length: workers }, () => worker()));
    // Release the sessions this send created so a mass-send doesn't leave the whole folder resident.
    await this.releaseCreatedSessions(groups.map((g) => g.username), wasLiveBefore);

    this.massJob.running = false;
    this.massJob.cancelling = false;
    this.massJob.cancelled = this.massCancel;
    this.massJob.finishedAt = new Date().toISOString();
    logger.info(`[mass] ${this.massCancel ? 'CANCELLED' : 'complete'}: ${this.massJob.sent} sent / ${this.massJob.confirmed} confirmed / ${this.massJob.unconfirmed} unconfirmed / ${this.massJob.failed.length} failed`);
    this.massCancel = false;
  }

  // ── Feature 5: auto-accept internal offers ───────────────────────────────

  private async handleNewOffer(receiver: AccountTrader, offer: any): Promise<void> {
    const offerId = offer?.id ?? '?';
    if (offer?.isOurOffer) return;                 // ignore our own outgoing offers
    if (!this.autoAcceptInternal) {
      logger.info(`[${receiver.username}] incoming offer ${offerId} – auto-accept disabled`);
      return;
    }

    const partnerId: string | undefined = offer?.partner?.getSteamID64?.();
    if (!partnerId || !this.isManagedSteamId(partnerId)) {
      logger.warn(`[${receiver.username}] incoming offer ${offerId} from EXTERNAL ${partnerId ?? '?'} – NOT auto-accepted`);
      return;
    }

    logger.info(`[${receiver.username}] internal offer ${offerId} from ${partnerId} – auto-accepting`);
    // Reaper contract (SessionManager.ts:64-65): a session in active use is touched on every op
    // entry so a 30-min-idle receiver can't be reaped mid accept+2FA.
    this.sessions.markUsed(receiver.username);
    // Staleness guard: the bulk-read fan-out releases each session the moment getTradeOffers returns,
    // while an early poll may have ALREADY dispatched this accept. A detached/replaced trader (its
    // session being torn down) must not fire a write — the next attach re-emits the offer as new.
    if (this.traders.get(receiver.username.toLowerCase()) !== receiver) return;
    // busy() visibility: this accept clears a mobile 2FA confirmation, so count it in the same
    // in-flight gauge as offer actions (the return await requirement keeps the finally off the
    // freshly-created promise). Then an update swap (S14) defers between accept and confirmation.
    this.offerActionsInFlight++;
    try {
      // A two-sided auto-accept commits on Steam even when its 2FA confirmation later fails;
      // acceptOffer reports that as 'unconfirmed' (never thrown) so we log it as accepted-but-
      // awaiting-confirmation rather than as a failure of an accept that actually landed.
      const status = await receiver.acceptOffer(offer);
      if (status === 'unconfirmed') {
        logger.warn(`[${receiver.username}] offer ${offerId} auto-accepted but UNCONFIRMED (awaiting mobile confirmation)`);
      } else {
        logger.info(`[${receiver.username}] offer ${offerId} accepted`);
      }
    } catch (err) {
      logger.error(`[${receiver.username}] auto-accept failed for ${offerId}: ${(err as Error).message}`);
    } finally {
      this.offerActionsInFlight--;
    }
  }

  // ── Managed-identity helpers ─────────────────────────────────────────────

  /** True when the SteamID64 belongs to one of our managed accounts. Sessions come and go
   *  (mass-send releases sender sessions immediately, the idle reaper the rest), so we also
   *  consult the persistent SteamID registry (accounts.json, written through on every login) —
   *  otherwise late/unconfirmed internal offers get misclassified EXTERNAL and skipped forever. */
  isManagedSteamId(steamId: string): boolean {
    return this.sessions.getAllSessions().some(s => s.steamId === steamId)
        || this.accounts.getAll().some(a => a.steamId === steamId);
  }

  managedSteamIds(): string[] {
    const ids = this.sessions.getAllSessions().map(s => s.steamId)
      .concat(this.accounts.getAll().map(a => a.steamId))
      .filter((id): id is string => !!id);
    return [...new Set(ids)];
  }

  setAutoAccept(on: boolean): void { this.autoAcceptInternal = on; }
  isAutoAccept(): boolean          { return this.autoAcceptInternal; }

  /** True while a send is in flight, an offer action (single or batch accept/decline/cancel) is
   *  running, or a mass-send job is running — the update scheduler (C5) checks this so a mid-session
   *  update never hard-exits into a swap while real trades or 2FA confirmations are being dispatched. */
  busy(): boolean { return this.inFlight.size > 0 || this.offerActionsInFlight > 0 || this.massJob.running; }

  /** Number of live AccountTrader instances (each owns a polling TradeOfferManager).
   *  Surfaced for the memory heartbeat so RSS can be correlated with fleet size. */
  get traderCount(): number { return this.traders.size; }

  shutdown(): void {
    for (const trader of this.traders.values()) trader.shutdown();
    this.traders.clear();
  }
}
