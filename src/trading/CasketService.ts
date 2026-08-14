import type { GcActionLayer, GcStatus } from './GcActionLayer';
import type { InventoryService } from '../core/InventoryService';
import type { PricingService } from '../pricing/PricingService';
import { MoneyOps, assetKey } from './MoneyOps';
import { isSellable } from '../core/MarketModel';
import { cs2Schema } from '../core/Cs2SchemaService';
import { cs2Items, type ResolvedItem } from '../core/Cs2ItemResolver';
import { logger } from '../utils/logger';

const CS2_APPID = 730;

/** A storage-unit item, NAMED. The GC sends no market_hash_name (see Cs2ItemResolver), so every
 *  field past `id` is reconstructed here — without it the panel can only show raw asset ids. */
export interface CasketContentItem extends ResolvedItem {
  id: string;
  /** Live market price for one unit, or null when the name has no price (tri-state from
   *  PricingService is collapsed here: `undefined` = still loading is reported as null + priced:false). */
  priceCents: number | null;
  /** True when the price above is authoritative (fetched), so the UI never shows "$0.00" for
   *  an item whose price simply hasn't loaded yet. */
  priced: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
//  CasketService — storage-unit (casket) management on top of the shared GC layer.
//  Read paths (list units, read contents) only need the library present; item
//  MOVES (deposit/withdraw) go through the GcActionLayer's verified gate. One move
//  job at a time, with live progress + cancel-after-current.
// ════════════════════════════════════════════════════════════════════════════

export interface CasketMoveJob {
  running:     boolean;
  cancelling?: boolean;
  cancelled?:  boolean;
  direction:   'deposit' | 'withdraw';
  username:    string;
  casketId:    string;
  total:       number;
  done:        number;
  moved:       number;
  /** Sent to the GC but the SO cache didn't confirm the move within the window — NOT retried
   *  (reversible; the item may well have moved — verify in-game). */
  unconfirmed: number;
  failed:      number;
  current?:    string;
  /** Cancel was requested for THIS job (per-job, so a backstop-detached prior loop can't cross-wire). */
  cancelRequested?: boolean;
  failures:    Array<{ itemId: string; error: string }>;
  startedAt?:  string;
  finishedAt?: string;
  /** Set when the move threw. stoppedReason 'preflight' ⇒ nothing was moved; 'aborted' ⇒ the
   *  counters reflect real partial progress (backstop abort). */
  error?:      string;
  /** How the move ended. 'aborted'/'preflight' are set by the catch (see error above). */
  stoppedReason?: 'completed' | 'budget' | 'cancelled' | 'aborted' | 'preflight';
}

export class CasketService {
  private job: CasketMoveJob = { running: false, direction: 'deposit', username: '', casketId: '', total: 0, done: 0, moved: 0, unconfirmed: 0, failed: 0, failures: [] };

  constructor(
    private readonly gc: GcActionLayer,
    private readonly inventory: InventoryService,
    private readonly pricing?: PricingService,
  ) {}

  status(): GcStatus { return this.gc.status(); }
  moveStatus(): CasketMoveJob { return { ...this.job, failures: [...this.job.failures] }; }

  /** True while a storage (casket) move is running — gates a mid-session update swap (S14): a swap
   *  hard-exit mid-move interrupts item moves inside the confirm window. */
  busy(): boolean { return this.job.running; }

  /** Lists the account's storage units (read-only). */
  listCaskets(username: string): Promise<Array<{ id: string; name: string; count: number }>> {
    return this.gc.listCaskets(username);
  }

  /**
   * Reads one storage unit's contents (read-only), NAMED and PRICED.
   *
   * The GC returns bare econ items, so the raw read alone can only produce asset ids. Each item is
   * put through Cs2ItemResolver (schema-backed) to recover its real market_hash_name, wear, float
   * and icon, then priced from the shared cache so the operator can see what a withdrawal is worth.
   * Schema loads are lazy + failure-tolerant: if either index is unavailable the read still returns
   * every item (labelled honestly as unresolved) rather than failing the whole panel.
   */
  async contents(username: string, casketId: string): Promise<CasketContentItem[]> {
    const [items] = await Promise.all([
      this.gc.getCasketContents(username, casketId),
      cs2Schema.ensureLoaded().catch(() => { /* resolver falls back to the def-index label */ }),
      cs2Items.ensureLoaded(),
    ]);
    const missing: Array<{ name: string; appid: number }> = [];
    const out = items.map((it) => {
      const r = cs2Items.resolve(it as Parameters<typeof cs2Items.resolve>[0]);
      // Tri-state price (INV: 0 and "not loaded" are NOT the same): undefined = never fetched →
      // queue a fill and report priced:false; null = authoritative "no market price"; number = real.
      const p = r.resolved && this.pricing ? this.pricing.priceCents(r.marketHashName, CS2_APPID) : null;
      if (p === undefined) missing.push({ name: r.marketHashName, appid: CS2_APPID });
      return { ...r, id: String(it.id), priceCents: p ?? null, priced: typeof p === 'number' };
    });
    // Storage-unit contents are never in the web inventory, so nothing else ever queues these
    // names — warm them so a re-open shows real values.
    if (missing.length && this.pricing) this.pricing.ensureFilled(missing);
    return out;
  }

  /**
   * Starts a deposit/withdraw of `itemIds` for one storage unit. One job at a time. When GC
   * execution is gated off the job ends immediately with a clear `error` (nothing moved).
   */
  startMove(username: string, casketId: string, itemIds: string[], direction: 'deposit' | 'withdraw'): CasketMoveJob {
    if (this.job.running) throw new Error('a storage move is already running');
    if (!casketId) throw new Error('a storage unit must be selected');
    if (!Array.isArray(itemIds) || itemIds.length === 0) throw new Error('no items selected');
    // TRADE-LOCK PRE-FLIGHT for DEPOSITS (2026-07-31 — owner: "I still can't deposit anything to a
    // storage unit"). Steam's own trade-protection notice states the item "cannot be consumed,
    // MODIFIED, or TRANSFERRED until <date>" — and moving an item into a casket is exactly such a
    // transfer, so Valve's GC silently DISCARDS a CasketItemAdd for a held item: no SO update, no
    // error. The old behaviour was to send anyway and then burn the full 15s verify window per item
    // before reporting the useless "unconfirmed" (observed live: "0 moved, 2 unconfirmed, 0 failed"
    // on an account whose every storable stack was locked until 2026-08-02). Refuse up front and say
    // WHEN it will work. Withdraw is unaffected — an item already inside a unit is not the held one.
    if (direction === 'deposit') {
      const locked = this.lockedForDeposit(username, itemIds);
      if (locked.blocked.length === itemIds.length) {
        throw new Error(`every selected item is trade-locked${locked.until ? ` until ${locked.until}` : ''} — Steam does not allow a trade-held item to be moved into a storage unit (it "cannot be transferred" while held)`);
      }
      if (locked.blocked.length) {
        logger.warn(`[casket] ${username}: skipping ${locked.blocked.length} trade-locked item(s) — Steam refuses a casket deposit while an item is trade-held`);
        itemIds = itemIds.filter((id) => !locked.blocked.includes(String(id)));
      }
    }
    // Cross-service asset guard (D2 / INV-D2): a move takes these items out of play for the whole
    // (budget-scaled, S16) move, so claim them all-or-nothing before starting — refuse if any is
    // mid-flight in another money op (being sold/sent). Released in runMove's finally.
    const keys = itemIds.map((id) => assetKey(username, id));
    if (!MoneyOps.claimAll(keys)) {
      throw new Error('item(s) busy in another money operation (sell/send) — retry when it settles');
    }
    this.job = {
      running: true, cancelling: false, cancelled: false, direction, username, casketId,
      total: itemIds.length, done: 0, moved: 0, unconfirmed: 0, failed: 0, failures: [], startedAt: new Date().toISOString(),
    };
    void this.runMove(username, casketId, [...itemIds], direction, keys);
    return this.moveStatus();
  }

  /**
   * Which of `itemIds` are trade-held (and so cannot be deposited), plus the soonest expiry to quote
   * back. Mirrors TradeService.filterSendable: resolve each asset from the account's CACHED CS2
   * inventory (caskets are CS2-only) and treat a stack that isn't freely tradable as blocked. A cache
   * miss blocks NOTHING — an unknown item is still attempted, so a stale cache can never turn into a
   * refusal to move an item Steam would have accepted.
   */
  private lockedForDeposit(username: string, itemIds: string[]): { blocked: string[]; until: string | null } {
    // Fail OPEN on anything unusable — no inventory service, no getCached, no cache entry. This guard
    // may only ever REFUSE a move we positively know Steam will reject; it must never become a new way
    // for a deposit to fail. (Also keeps the cross-service busy guard below reachable, which is the
    // stronger invariant: H-TRD-099 (c) asserts startMove reports "busy" for a held asset.)
    const inv = typeof this.inventory?.getCached === 'function'
      ? this.inventory.getCached(username, 'cs2')
      : null;
    if (!inv?.items) return { blocked: [], until: null };
    const stackOf = (assetId: string) =>
      inv.items.find((s) => (s.assetIds ?? []).some((id) => String(id) === String(assetId)));
    const blocked: string[] = [];
    let soonest: number | null = null;
    for (const id of itemIds) {
      const stack = stackOf(String(id));
      if (!stack) continue;                       // unknown to the cache → attempt it (never over-block)
      if (isSellable(stack)) continue;            // freely tradable → fine
      blocked.push(String(id));
      const exp = stack.tradeLockExpiry ? Date.parse(String(stack.tradeLockExpiry)) : NaN;
      if (Number.isFinite(exp) && (soonest == null || exp < soonest)) soonest = exp;
    }
    return { blocked, until: soonest != null ? new Date(soonest).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : null };
  }

  cancelMove(): CasketMoveJob {
    if (this.job.running) { this.job.cancelRequested = true; this.job.cancelling = true; logger.info('[casket] move cancel requested'); }
    return this.moveStatus();
  }

  private async runMove(username: string, casketId: string, itemIds: string[], direction: 'deposit' | 'withdraw', claimedKeys: string[]): Promise<void> {
    // Bind THIS job so a backstop-detached loop (S16: withTimeout can't cancel fn(go)) writes only into
    // its own orphaned object — never into the NEXT job started after `finally` reopened the gate.
    const job = this.job;
    try {
      const res = await this.gc.moveCasketItems(
        username, casketId, itemIds, direction,
        (p) => { if (!job.running) return; job.done = p.done; job.current = p.current; job.moved = p.moved; job.unconfirmed = p.unconfirmed; job.failed = p.failed; },
        () => job.cancelRequested === true,
      );
      job.moved = res.moved.length;
      job.unconfirmed = res.unconfirmed.length;
      job.failed = res.failed.length;
      job.failures = res.failed;
      // Label how the move ended (S16 residue): 'completed' = natural exit, 'budget' = cooperative
      // deadline break (the rest were NOT attempted — a re-run continues), 'cancelled' = the user's
      // cancel-after-current break. `cancelled` is a strict function of this discriminator so a cancel
      // clicked during the final item's verify window can't mislabel a fully-completed job.
      job.stoppedReason = res.stopped;
      job.cancelled = res.stopped === 'cancelled';
    } catch (e) {
      // Label the throw by what actually happened. A pre-flight throw (gated off, library missing, not
      // logged in, cap exceeded) fires before any send → 'preflight' (nothing moved). The withTimeout
      // backstop (GcActionLayer) fires MID-move → 'aborted' and the counters (set live by onProgress)
      // reflect real partial progress — keep them, do NOT reset. `done > 0` is a faithful discriminator
      // because onProgress fires only after a real send.
      job.error = String((e as Error)?.message ?? e);
      job.stoppedReason = job.done > 0 ? 'aborted' : 'preflight';
      logger.warn(`[casket] ${username} ${direction} aborted: ${job.error}`);
    } finally {
      // Cross-service asset guard (D2 / INV-D2): these items are no longer busy in this move.
      MoneyOps.releaseAll(claimedKeys);
      job.running = false;
      job.cancelling = false;
      job.current = undefined;
      job.finishedAt = new Date().toISOString();
      // Post-move reconcile (parity with every other mutating service): deposited/withdrawn assets
      // left Steam's web inventory (ctx2), so the cached inventory is now stale. Refresh this one
      // account's FULL pipeline so the modal + master view drop the moved items without a manual
      // refresh. `unconfirmed` is included — an unconfirmed item may well have moved (see line 21-23),
      // the same rule the frontend applies to its contents reload. Failed-only / pre-flight-error jobs
      // skip (nothing changed on Steam); an 'aborted' (mid-move backstop) job with real partial progress
      // is covered here — its live `moved` makes the same `moved>0` condition true. refreshOne
      // in-flight-dedups, so a concurrent fleet refresh coalesces; a rejection only warns (the job state
      // is already finalized above).
      if (job.moved > 0 || job.unconfirmed > 0) {
        void this.inventory.refreshOne(job.username, 'cs2').catch((e) => logger.warn(`[casket] post-move inventory reconcile failed for ${job.username}: ${(e as Error).message}`));
      }
    }
  }
}
