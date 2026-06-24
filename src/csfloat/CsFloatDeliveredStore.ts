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

  constructor(private readonly path: string = DEFAULT_PATH) {
    this.load();
  }

  private load(): void {
    try {
      if (fsExtra.existsSync(this.path)) {
        const parsed = fsExtra.readJsonSync(this.path) as { ids?: unknown } | null;
        if (parsed && Array.isArray(parsed.ids)) {
          this.ids = parsed.ids.map(String);
          for (const id of this.ids) this.set.add(id);
        }
      }
    } catch (err) {
      logger.warn(`${this.path} unreadable, starting fresh: ${(err as Error).message}`);
    }
  }

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
