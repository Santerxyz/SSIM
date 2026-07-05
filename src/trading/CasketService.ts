import type { GcActionLayer, GcItem, GcStatus } from './GcActionLayer';
import type { InventoryService } from '../core/InventoryService';
import { logger } from '../utils/logger';

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

  constructor(private readonly gc: GcActionLayer, private readonly inventory: InventoryService) {}

  status(): GcStatus { return this.gc.status(); }
  moveStatus(): CasketMoveJob { return { ...this.job, failures: [...this.job.failures] }; }

  /** True while a storage (casket) move is running — gates a mid-session update swap (S14): a swap
   *  hard-exit mid-move interrupts item moves inside the confirm window. */
  busy(): boolean { return this.job.running; }

  /** Lists the account's storage units (read-only). */
  listCaskets(username: string): Promise<Array<{ id: string; name: string; count: number }>> {
    return this.gc.listCaskets(username);
  }

  /** Reads one storage unit's contents (read-only). */
  contents(username: string, casketId: string): Promise<GcItem[]> {
    return this.gc.getCasketContents(username, casketId);
  }

  /**
   * Starts a deposit/withdraw of `itemIds` for one storage unit. One job at a time. When GC
   * execution is gated off the job ends immediately with a clear `error` (nothing moved).
   */
  startMove(username: string, casketId: string, itemIds: string[], direction: 'deposit' | 'withdraw'): CasketMoveJob {
    if (this.job.running) throw new Error('a storage move is already running');
    if (!casketId) throw new Error('a storage unit must be selected');
    if (!Array.isArray(itemIds) || itemIds.length === 0) throw new Error('no items selected');
    this.job = {
      running: true, cancelling: false, cancelled: false, direction, username, casketId,
      total: itemIds.length, done: 0, moved: 0, unconfirmed: 0, failed: 0, failures: [], startedAt: new Date().toISOString(),
    };
    void this.runMove(username, casketId, [...itemIds], direction);
    return this.moveStatus();
  }

  cancelMove(): CasketMoveJob {
    if (this.job.running) { this.job.cancelRequested = true; this.job.cancelling = true; logger.info('[casket] move cancel requested'); }
    return this.moveStatus();
  }

  private async runMove(username: string, casketId: string, itemIds: string[], direction: 'deposit' | 'withdraw'): Promise<void> {
    // Bind THIS job so a backstop-detached loop (S16: withTimeout can't cancel fn(go)) writes only into
    // its own orphaned object — never into the NEXT job started after `finally` reopened the gate.
    const job = this.job;
    try {
      const res = await this.gc.moveCasketItems(
        username, casketId, itemIds, direction,
        (p) => { if (!job.running) return; job.done = p.done; job.current = p.current; job.moved = p.moved; job.failed = p.failed; },
        () => job.cancelRequested === true,
      );
      job.moved = res.moved.length;
      job.unconfirmed = res.unconfirmed.length;
      job.failed = res.failed.length;
      job.failures = res.failed;
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
      job.running = false;
      job.cancelling = false;
      job.cancelled = job.cancelRequested === true;
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
