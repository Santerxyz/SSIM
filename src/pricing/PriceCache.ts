import fsExtra from 'fs-extra';
import { logger } from '../utils/logger';
import { writeJsonAtomic } from '../utils/atomicJson';
import { dataDir } from '../utils/paths';

const CACHE_FILE = dataDir('prices.json');

export interface PriceEntry {
  /** Lowest market price in USD cents; null = no market price found. */
  cents:     number | null;
  fetchedAt: string; // ISO
}

/**
 * Shared price cache keyed by market_hash_name. A single skin name has the same
 * price for every bot, so this dedups thousands of items down to a few hundred
 * unique lookups. Persisted to data/prices.json (gitignored via *.json? no –
 * explicitly, prices are non-sensitive; kept for instant warm starts).
 */
export class PriceCache {
  private map = new Map<string, PriceEntry>();
  private dirty = false;
  private flushTimer?: NodeJS.Timeout;

  constructor() { this.load(); }

  private load(): void {
    try {
      if (fsExtra.existsSync(CACHE_FILE)) {
        const raw = fsExtra.readJsonSync(CACHE_FILE) as Record<string, PriceEntry>;
        for (const [k, v] of Object.entries(raw)) this.map.set(k, v);
        logger.info(`PriceCache loaded (${this.map.size} entries)`);
      }
    } catch (err) {
      logger.warn(`PriceCache load failed: ${(err as Error).message}`);
    }
  }

  get(name: string): PriceEntry | undefined { return this.map.get(name); }
  size(): number { return this.map.size; }

  /** Generous hard cap so the cache (and prices.json) can never grow without
   *  bound. The real key space is the Steam item universe (tens of thousands of
   *  names), so this ceiling is never reached in practice; it only guards against
   *  a pathological runaway. Eviction is insertion-order (oldest first) and only
   *  triggers for a genuinely NEW key, so updating an existing price never drops
   *  anything. */
  private static readonly MAX_ENTRIES = 100_000;

  set(name: string, cents: number | null): void {
    if (!this.map.has(name) && this.map.size >= PriceCache.MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(name, { cents, fetchedAt: new Date().toISOString() });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 2_000);
    this.flushTimer.unref?.();
  }

  flush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    if (!this.dirty) return;
    try {
      const obj: Record<string, PriceEntry> = {};
      for (const [k, v] of this.map) obj[k] = v;
      writeJsonAtomic(CACHE_FILE, obj);
      this.dirty = false;
    } catch (err) {
      logger.warn(`PriceCache flush failed: ${(err as Error).message}`);
    }
  }
}
