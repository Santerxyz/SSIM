import { type SessionManager, refreshWebSession } from '../core/SessionManager';
import type { AccountManager } from '../core/AccountManager';
import type { InventoryService } from '../core/InventoryService';
import { isSellable } from '../core/MarketModel';
import { SessionState, type ManagedSession } from '../types/session';
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
}

export interface MassTradeJob {
  running:     boolean;
  /** Operator pressed "End Task" — the run is winding down (no new offers dispatched). */
  cancelling?: boolean;
  /** The run ended because it was cancelled (remaining bots were skipped). */
  cancelled?:  boolean;
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
  private massJob: MassTradeJob = { running: false, total: 0, done: 0, sent: 0, confirmed: 0, unconfirmed: 0, failed: [], results: [] };
  /** Co-operative cancel flag for the live mass-send (set by cancelMass()). */
  private massCancel = false;

  constructor(
    private readonly sessions: SessionManager,
    private readonly accounts: AccountManager,
    /** Optional: lets the send path reject trade-locked / non-tradable assets from
     *  the cached inventory before an offer is created (INV-D1 / C3). */
    private readonly inventory?: InventoryService,
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

  /** Performs ONE offer action (accept / decline / cancel) for `username`. */
  async offerAction(username: string, offerId: string, action: OfferAction): Promise<void> {
    const trader = await this.getTrader(username);
    if (action === 'accept') return trader.acceptTradeOffer(offerId);
    // 'cancel' (our sent offer) and 'decline' (an incoming offer) share one Steam call;
    // the library routes it by the offer's isOurOffer flag.
    return trader.cancelOrDeclineOffer(offerId);
  }

  /**
   * Runs a batch of offer actions through a HARD concurrency-2 pool (Error-15 / rate-limit
   * guard — never scaled). Every target is attempted; failures are reported per-item and
   * never abort the batch. Returns a result row for each input target.
   */
  async batchOfferAction(
    targets: OfferActionTarget[],
    opts?: { concurrency?: number },
  ): Promise<OfferActionResult[]> {
    const concurrency = Math.min(OFFER_ACTION_CONCURRENCY, Math.max(1, opts?.concurrency ?? OFFER_ACTION_CONCURRENCY));
    const results: OfferActionResult[] = [];
    const queue = [...targets];

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const t = queue.shift()!;
        try {
          await this.offerAction(t.username, t.offerId, t.action);
          results.push({ ...t, ok: true });
        } catch (err) {
          results.push({ ...t, ok: false, error: (err as Error).message });
          logger.error(`[offers] ${t.username} ${t.action} ${t.offerId} failed: ${(err as Error).message}`);
        }
      }
    };

    const workers = Math.max(1, Math.min(concurrency, targets.length || 1));
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return results;
  }

  // ── Bulk-op session release helpers (anti-accumulation) ───────────────────
  // Shared by every fleet-wide login fan-out (offers read + mass send/sell/buy) so none of
  // them can leave the whole fleet resident — the resident-session storm that, unbounded, lets
  // the process be externally killed. Mirrors InventoryService.runRefresh's release.

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
    const inv = this.inventory.getCached(username);
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
    try {
      const trader = await this.getTrader(fromUsername);
      try {
        return await trader.sendTrade(params);
      } catch (err) {
        // Bubble Steam's ACTUAL reason up cleanly (eresult / cause / full-inventory text),
        // reading only what Steam returned — never a follow-up inventory fetch. The parsed
        // flags are attached so callers that want structure (not just the string) have them.
        const parsed = parseSteamTradeError(err);
        const clean = new Error(parsed.message) as Error & { eresult?: number; cause?: string; inventoryFull?: boolean };
        if (parsed.eresult != null) clean.eresult = parsed.eresult;
        if (parsed.cause) clean.cause = parsed.cause;
        clean.inventoryFull = parsed.inventoryFull;
        throw clean;
      }
    } finally {
      this.inFlight.delete(guardKey);
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
    void this.runMassSend(groups, tradeUrl, opts);
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
            myItems: group.assetIds.map(id => ({ assetId: id })),
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
    try {
      await receiver.acceptOffer(offer);
      logger.info(`[${receiver.username}] offer ${offerId} accepted`);
    } catch (err) {
      logger.error(`[${receiver.username}] auto-accept failed for ${offerId}: ${(err as Error).message}`);
    }
  }

  // ── Managed-identity helpers ─────────────────────────────────────────────

  /** True when the SteamID64 belongs to one of our managed accounts. */
  isManagedSteamId(steamId: string): boolean {
    return this.sessions.getAllSessions().some(s => s.steamId === steamId);
  }

  managedSteamIds(): string[] {
    return this.sessions.getAllSessions()
      .map(s => s.steamId)
      .filter((id): id is string => !!id);
  }

  setAutoAccept(on: boolean): void { this.autoAcceptInternal = on; }
  isAutoAccept(): boolean          { return this.autoAcceptInternal; }

  /** Number of live AccountTrader instances (each owns a polling TradeOfferManager).
   *  Surfaced for the memory heartbeat so RSS can be correlated with fleet size. */
  get traderCount(): number { return this.traders.size; }

  shutdown(): void {
    for (const trader of this.traders.values()) trader.shutdown();
    this.traders.clear();
  }
}
