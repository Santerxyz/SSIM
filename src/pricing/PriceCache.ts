import fsExtra from 'fs-extra';
import { logger } from '../utils/logger';
import { writeJsonAtomic } from '../utils/atomicJson';
import { dataDir } from '../utils/paths';

const CACHE_FILE = dataDir('prices.json');

export interface PriceEntry {
  /** Lowest market price in USD cents; null = no market price found. */
  cents:     number | null;
  fetchedAt: string; // ISO
  /** True when this null is a TRANSIENT fetch error (proxy/DNS/5xx/429-exhaustion), NOT an
   *  authoritative "no market price". The reader gives soft misses a short TTL so a network blip
   *  is retried in minutes instead of being cached as a 24h "no price" that survives restart (S2). */
  soft?:     boolean;
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
  private readonly path: string;

  /** `filePath` overridable for tests. */
  constructor(filePath: string = CACHE_FILE) { this.path = filePath; this.load(); }

  private load(): void {
    try {
      if (fsExtra.existsSync(this.path)) {
        const raw = fsExtra.readJsonSync(this.path) as Record<string, PriceEntry>;
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

  set(name: string, cents: number | null, opts?: { soft?: boolean }): void {
    // Unit guard (INV-E2 / E-1): every cached price is USD cents — a finite, non-negative
    // value, or null. A NaN / negative / non-finite value signals a parse or unit error at
    // the source (e.g. a non-USD price source); store it as a MISS rather than poisoning
    // every totalValueUsd that sums this entry. Normalize to integer cents.
    let v: number | null = cents;
    if (v != null && (!Number.isFinite(v) || v < 0)) {
      logger.warn(`PriceCache: rejected non-cents price for "${name}" (${cents}) – storing as miss`);
      v = null;
    } else if (v != null) {
      v = Math.round(v);
    }
    if (!this.map.has(name) && this.map.size >= PriceCache.MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    const entry: PriceEntry = { cents: v, fetchedAt: new Date().toISOString() };
    // A soft flag only applies to a null miss; a real price is always authoritative (and overwrites
    // any prior soft miss for the key, so a recovered fetch clears the short-TTL marking). (S2)
    if (v == null && opts?.soft) entry.soft = true;
    this.map.set(name, entry);
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
      writeJsonAtomic(this.path, obj);
      this.dirty = false;
    } catch (err) {
      logger.warn(`PriceCache flush failed: ${(err as Error).message}`);
    }
  }
}
