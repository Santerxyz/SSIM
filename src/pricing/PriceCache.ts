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
        const raw = fsExtra.readJsonSync(this.path) as Record<string, unknown>;
        let dropped = 0;
        for (const [k, v] of Object.entries(raw)) {
          const e = PriceCache.sanitizeEntry(v);
          if (e) this.map.set(k, e); else dropped++;
        }
        logger.info(`PriceCache loaded (${this.map.size} entries)`);
        // A persisted file can predate the set() unit guard, or be hand-edited / written by an old
        // mis-scaled source (S64). Whatever the file holds is trusted verbatim on READ otherwise, so a
        // bad cents (negative, non-finite, a string) would poison totalValueUsd. Enforce INV-E2 on load
        // too — one aggregate warn, not one per key (this is a warm-start hot path over up to MAX_ENTRIES).
        if (dropped) logger.warn(`PriceCache: dropped ${dropped} invalid persisted entr${dropped === 1 ? 'y' : 'ies'} on load`);
      }
    } catch (err) {
      logger.warn(`PriceCache load failed: ${(err as Error).message}`);
    }
  }

  /** The INV-E2 cents rule, shared by set() (runtime write) and sanitizeEntry() (load). A price is USD
   *  cents — a finite, non-negative integer, or null. Anything else (NaN/Infinity/negative, or a
   *  non-number leaked from a persisted file) becomes a null miss rather than poisoning totalValueUsd. */
  private static normalizeCents(c: unknown): number | null {
    if (typeof c !== 'number') return null;
    if (!Number.isFinite(c) || c < 0) return null;
    return Math.round(c);
  }

  /** Validate a persisted record before it is trusted as a cache entry. Used ONLY by load() — set()
   *  supplies its own fresh fetchedAt and cannot be routed through a path that requires a persisted one.
   *  Returns null (skip the key) when the record isn't a plain object or lacks a string fetchedAt. */
  private static sanitizeEntry(v: unknown): PriceEntry | null {
    if (typeof v !== 'object' || v === null) return null;
    const rec = v as { cents?: unknown; fetchedAt?: unknown; soft?: unknown };
    if (typeof rec.fetchedAt !== 'string') return null;
    const cents = PriceCache.normalizeCents(rec.cents);
    const entry: PriceEntry = { cents, fetchedAt: rec.fetchedAt };
    if (cents == null && rec.soft === true) entry.soft = true;
    return entry;
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
    const v = PriceCache.normalizeCents(cents);
    if (v == null && cents != null) {
      logger.warn(`PriceCache: rejected non-cents price for "${name}" (${cents}) – storing as miss`);
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

  // S43: during a background fill a new price arrives about every 3.5s (PricingService.FETCH_DELAY_MS) —
  // LONGER than the old 2s window — so each set() landed after its own window elapsed and rewrote the
  // WHOLE prices.json (up to MAX_ENTRIES) once per fetch, for the whole fill. Coalesce with a longer
  // max-delay window, plus a burst cap so a fast bulk warm-up still persists promptly. Prices are
  // non-sensitive and re-fetchable, so a few tens of seconds at risk on a hard crash is acceptable.
  private static readonly FLUSH_MAX_DELAY_MS = 30_000;
  private static readonly FLUSH_EVERY_N      = 250;
  private dirtyCount = 0;

  private scheduleFlush(): void {
    this.dirty = true;
    if (++this.dirtyCount >= PriceCache.FLUSH_EVERY_N) { this.flush(); return; } // burst cap → persist now
    if (this.flushTimer) return;                                                 // else coalesce into one write
    this.flushTimer = setTimeout(() => this.flush(), PriceCache.FLUSH_MAX_DELAY_MS);
    this.flushTimer.unref?.();
  }

  flush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    if (!this.dirty) return;
    this.dirtyCount = 0; // reset on every flush ATTEMPT (a failing disk must not re-trigger every set)
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
