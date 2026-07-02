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
 * pending" re-sent a second real Steam offer for the same sale (C6 / INV-F1). This
 * persists every delivered id and is consulted on the first pass after boot.
 */
export class CsFloatDeliveredStore {
  private ids: string[] = [];
  private readonly set = new Set<string>();
  /** True when the file EXISTS but could not be read/parsed → the delivered-id memory is LOST.
   *  Auto-delivery MUST NOT proceed in this state or every currently-pending sale would be
   *  re-delivered (a second real Steam offer per sale). A MISSING file (fresh install) is NOT
   *  degraded — nothing has been delivered yet. */
  private degraded = false;

  constructor(private readonly path: string = DEFAULT_PATH) {
    this.load();
  }

  private load(): void {
    try {
      if (!fsExtra.existsSync(this.path)) return; // fresh install → empty is correct, not degraded
      const parsed = fsExtra.readJsonSync(this.path) as { ids?: unknown } | null;
      if (parsed && Array.isArray(parsed.ids)) {
        this.ids = parsed.ids.map(String);
        for (const id of this.ids) this.set.add(id);
      } else {
        this.degraded = true; // present but wrong shape → dedup memory is untrustworthy
        logger.error(`${this.path} is present but malformed – CSFloat auto-delivery DISABLED to avoid re-delivering already-sent sales. Fix or remove the file, then restart.`);
      }
    } catch (err) {
      this.degraded = true; // present but unreadable/corrupt → we lost the dedup memory
      logger.error(`${this.path} unreadable – CSFloat auto-delivery DISABLED to avoid re-delivering already-sent sales. Fix or remove the file, then restart. (${(err as Error).message})`);
    }
  }

  /** True when the dedup memory could not be loaded → callers must NOT auto-deliver. */
  isDegraded(): boolean { return this.degraded; }

  has(id: string): boolean {
    return this.set.has(id);
  }

  /** Records an id as delivered and persists immediately (atomic). Idempotent. */
  add(id: string): void {
    if (!id || this.set.has(id)) return;
    this.set.add(id);
    this.ids.push(id);
    if (this.ids.length > MAX_IDS) {
      const drop = this.ids.splice(0, this.ids.length - MAX_IDS);
      for (const d of drop) this.set.delete(d);
    }
    try {
      writeJsonAtomic(this.path, { version: 1, ids: this.ids }, { spaces: 0 });
    } catch (err) {
      logger.error(`failed to persist ${this.path}: ${(err as Error).message}`);
    }
  }
}
