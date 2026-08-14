import fsExtra from 'fs-extra';
import { dataDir } from '../utils/paths';
import { writeJsonAtomic } from '../utils/atomicJson';
import { logger } from '../utils/logger';

const DEFAULT_PATH = dataDir('csfloat_delivered.json');
// Bound the file so a long-running farm can't grow it without limit. FIFO-prune the
// oldest ids; a pruned id can in theory re-deliver, but only for a trade that has been
// pending for >MAX_IDS deliveries, which never happens in practice.
const MAX_IDS = 5000;

/**
 * Durable dedup of delivered CSFloat trade ids. The auto-accept worker used an
 * in-process Set, so a restart between "delivered" and "CSFloat drops the trade from
 * pending" re-sent a second real Steam offer for the same sale. This
 * persists every delivered id and is consulted on the first pass after boot.
 */
export class CsFloatDeliveredStore {
  private ids: string[] = [];
  private readonly set = new Set<string>();
  /** True when the file EXISTS but could not be read/parsed → the delivered-id memory is LOST.
   *  Auto-delivery MUST not proceed in this state or every currently-pending sale would be
   *  re-delivered (a second real Steam offer per sale). A MISSING file (fresh install) is not
   *  degraded — nothing has been delivered yet. */
  private degraded = false;
  /** Consecutive persist failures. The load-side degraded gate only covers a file that was corrupt AT
   *  BOOT; a RUNTIME write failure (disk full / EACCES / AV lock) leaves the just-delivered id in memory
   *  only, so a crash + restart re-delivers that sale (a second real Steam offer). After N consecutive
   * failures we latch degraded → auto-delivery pauses, bounding how many sales can be exposed. */
  private persistFailures = 0;
  private static readonly PERSIST_FAIL_LIMIT = 3;
  /** Sidecar written when the runtime-persist latch trips, so the degraded state SURVIVES a restart.
   *  The in-memory latch alone is lost on the crash it defends against — the last-good file lacks the
   *  buffered ids, so a fresh boot would resume delivery and re-send them. Present at boot → stay
   *  degraded until an operator clears the fault and removes this file. (S39 residue / INV-F1.) */
  private readonly MARKER_PATH: string;

  constructor(private readonly path: string = DEFAULT_PATH) {
    this.MARKER_PATH = `${this.path}.persist_failed`;
    this.load();
  }

  private load(): void {
    try {
      if (fsExtra.existsSync(this.MARKER_PATH)) {
        this.degraded = true; // a prior run could not persist delivered ids → stay paused across the restart
        logger.error(`${this.MARKER_PATH} present – a prior run could not persist delivered ids; CSFloat auto-delivery stays DISABLED until the disk/permission fault is cleared, ${this.MARKER_PATH} is removed, and the app is restarted.`);
      }
      if (!fsExtra.existsSync(this.path)) return; // fresh install → empty is correct, not degraded
      const parsed = fsExtra.readJsonSync(this.path) as { version?: unknown; ids?: unknown } | null;
      if (parsed && Array.isArray(parsed.ids)) {
        if (parsed.version !== undefined && parsed.version !== 1) {
          this.degraded = true; // unknown/newer on-disk format → do not misread it as v1
          logger.error(`${this.path} is version ${String(parsed.version)} (a newer/unknown format) – CSFloat auto-delivery DISABLED to avoid misreading it as v1 and re-delivering already-sent sales. Fix or remove the file, then restart.`);
        } else {
          this.ids = parsed.ids.map(String);
          for (const id of this.ids) this.set.add(id);
        }
      } else {
        this.degraded = true; // present but wrong shape → dedup memory is untrustworthy
        logger.error(`${this.path} is present but malformed – CSFloat auto-delivery DISABLED to avoid re-delivering already-sent sales. Fix or remove the file, then restart.`);
      }
    } catch (err) {
      this.degraded = true; // present but unreadable/corrupt → we lost the dedup memory
      logger.error(`${this.path} unreadable – CSFloat auto-delivery DISABLED to avoid re-delivering already-sent sales. Fix or remove the file, then restart. (${(err as Error).message})`);
    }
  }

  /** True when the dedup memory could not be loaded → callers must not auto-deliver. */
  isDegraded(): boolean { return this.degraded; }

  has(id: string): boolean {
    return this.set.has(id);
  }

  /** Records an id as delivered and persists immediately (atomic). Idempotent.
   *  Returns TRUE when the id is durably persisted; FALSE when the write threw (the id is
   *  in memory only → not crash-safe) or the store is already degraded. The caller uses the
   * FALSE signal to stop launching new deliveries on the first non-durable record,
   *  tightening the crash-re-delivery exposure to one sale instead of PERSIST_FAIL_LIMIT. */
  add(id: string): boolean {
    if (!id || this.set.has(id)) return true; // already durably recorded / nothing to persist
    this.set.add(id);
    this.ids.push(id);
    if (this.ids.length > MAX_IDS) {
      const drop = this.ids.splice(0, this.ids.length - MAX_IDS);
      for (const d of drop) this.set.delete(d);
    }
    try {
      writeJsonAtomic(this.path, { version: 1, ids: this.ids }, { spaces: 0 });
      this.persistFailures = 0; // a successful write re-persists the full id list → a prior blip self-heals
      // The full id list is now durable again, so a marker from a self-healed blip must not strand the
      // operator on the next boot. Best-effort clear (a failed unlink just leaves a false marker → safe).
      try { if (fsExtra.existsSync(this.MARKER_PATH)) fsExtra.unlinkSync(this.MARKER_PATH); }
      catch (err) { logger.error(`could not clear ${this.MARKER_PATH} after a successful persist: ${(err as Error).message}`); }
      return !this.degraded; // durable — but if a prior boot latched degraded, the caller must still not deliver
    } catch (err) {
      this.persistFailures++;
      logger.error(`failed to persist ${this.path} (${this.persistFailures}/${CsFloatDeliveredStore.PERSIST_FAIL_LIMIT}): ${(err as Error).message}`);
      if (this.persistFailures >= CsFloatDeliveredStore.PERSIST_FAIL_LIMIT && !this.degraded) {
        // The dedup memory can no longer be made durable — pause auto-delivery so a subsequent crash
        // can't re-deliver a growing set of sales whose delivered-ids were never saved.
        this.degraded = true;
        logger.error(`${this.path}: ${this.persistFailures} consecutive persist failures – CSFloat auto-delivery DISABLED to avoid re-delivering sales whose dedup cannot be saved. Fix the disk/permissions and restart.`);
        // Latch the degraded state to disk so a crash inside this unpersistable window can't resume
        // delivery on the next boot (the in-memory latch alone is lost on that crash). Best-effort:
        // the marker shares the disk that just failed — if it also fails, the in-memory latch is the
        // only protection for this run, which is the pre-existing behavior.
        try { fsExtra.writeFileSync(this.MARKER_PATH, `${new Date().toISOString()} persist_failures=${this.persistFailures}\n`); }
        catch (markerErr) { logger.error(`could not write ${this.MARKER_PATH}: ${(markerErr as Error).message}`); }
      }
      return false; // the id is in memory only — not crash-safe
    }
  }
}
