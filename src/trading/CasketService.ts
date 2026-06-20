import type { GcActionLayer, GcItem, GcStatus } from './GcActionLayer';
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
  failures:    Array<{ itemId: string; error: string }>;
  startedAt?:  string;
  finishedAt?: string;
  /** Set when GC execution is gated off / unavailable — nothing was moved. */
  error?:      string;
}

export class CasketService {
  private job: CasketMoveJob = { running: false, direction: 'deposit', username: '', casketId: '', total: 0, done: 0, moved: 0, unconfirmed: 0, failed: 0, failures: [] };
  private cancel = false;

  constructor(private readonly gc: GcActionLayer) {}

  status(): GcStatus { return this.gc.status(); }
  moveStatus(): CasketMoveJob { return { ...this.job, failures: [...this.job.failures] }; }

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
    this.cancel = false;
    this.job = {
      running: true, cancelling: false, cancelled: false, direction, username, casketId,
      total: itemIds.length, done: 0, moved: 0, unconfirmed: 0, failed: 0, failures: [], startedAt: new Date().toISOString(),
    };
    void this.runMove(username, casketId, [...itemIds], direction);
    return this.moveStatus();
  }

  cancelMove(): CasketMoveJob {
    if (this.job.running) { this.cancel = true; this.job.cancelling = true; logger.info('[casket] move cancel requested'); }
    return this.moveStatus();
  }

  private async runMove(username: string, casketId: string, itemIds: string[], direction: 'deposit' | 'withdraw'): Promise<void> {
    try {
      const res = await this.gc.moveCasketItems(
        username, casketId, itemIds, direction,
        (p) => { this.job.done = p.done; this.job.current = p.current; this.job.moved = p.moved; this.job.failed = p.failed; },
        () => this.cancel,
      );
      this.job.moved = res.moved.length;
      this.job.unconfirmed = res.unconfirmed.length;
      this.job.failed = res.failed.length;
      this.job.failures = res.failed;
    } catch (e) {
      // A pre-flight failure (gated off, library missing, not logged in, cap exceeded) — nothing moved.
      this.job.error = (e as Error).message;
      logger.warn(`[casket] ${username} ${direction} aborted: ${(e as Error).message}`);
    } finally {
      this.job.running = false;
      this.job.cancelling = false;
      this.job.cancelled = this.cancel;
      this.job.current = undefined;
      this.job.finishedAt = new Date().toISOString();
      this.cancel = false;
    }
  }
}
