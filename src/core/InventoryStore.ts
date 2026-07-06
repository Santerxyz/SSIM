import fsExtra from 'fs-extra';
import type { AccountInventory } from '../types/inventory';
import { logger } from '../utils/logger';
import { writeJsonAtomic } from '../utils/atomicJson';
import { dataDir } from '../utils/paths';

const DEFAULT_STORE_PATH = dataDir('inventories.json');

// Resident-cache safety net: bound how many account records stay in RAM so a very large
// fleet can never grow the inventory cache without limit. LRU by last access (read OR write).
// EVICTION IS DESTRUCTIVE: the dropped record is removed from RAM AND from the persisted file
// (records is the same object flush() writes), and there is NO refetch-on-miss — the account
// reverts to never-refreshed ("—", its last-known wallet gone) until the operator manually
// refreshes it. Generous default (2000 per store) → INERT at typical scale (hundreds of
// accounts, so no eviction ever happens and behaviour is unchanged). A lowered cap takes
// effect from the first write (the constructor never evicts, so shrinking the cap can't
// destroy disk records before the operator sees a log). Set SSIM_INV_CACHE_MAX=0 to disable,
// or lower it to cap RAM harder.
const MAX_RECORDS: number = (() => {
  const raw = Number(process.env.SSIM_INV_CACHE_MAX);
  if (raw === 0) return Infinity;                                  // explicit opt-out
  return Number.isFinite(raw) && raw >= 100 ? raw : 2000;          // default 2000 / floor 100
})();

/** A SYNCHRONOUS sleep for the boot-time read retries (the event loop isn't serving during
 *  the constructor). Atomics.wait blocks the thread without a busy-wait; mirrors singleInstance.ts. */
function sleepSync(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* SAB blocked → skip the wait */ }
}

interface InventoryFile {
  version: number;
  /** keyed by lowercase username */
  records: Record<string, AccountInventory>;
}

/**
 * Disk-backed inventory cache (mirrors TokenStore). Lets the dashboard show
 * inventories instantly on page reload – even when stale – instead of refetching
 * from Steam every time.
 */
export class InventoryStore {
  private data: InventoryFile;
  private dirty = false;
  private flushTimer?: NodeJS.Timeout;
  private readonly path: string;
  /**
   * Set when load() booted empty because the on-disk file was present but UNREADABLE
   * (a transient I/O lock, e.g. an AV scanner) rather than malformed. The last good file
   * is intact on disk; the next flush must preserve it as `<path>.bak` before overwriting,
   * so a boot-time lock can't silently destroy the whole fleet cache. Cleared after one save.
   */
  private preserveNextFlush = false;
  /** Access order for the LRU cap (insertion order = oldest→newest; re-add moves to newest). */
  private readonly lru = new Set<string>();

  /** `filePath` lets callers keep per-game caches in separate files. */
  constructor(filePath: string = DEFAULT_STORE_PATH) {
    this.path = filePath;
    this.data = this.load();
    for (const k of Object.keys(this.data.records)) this.lru.add(k); // seed LRU from disk
  }

  private load(): InventoryFile {
    if (!fsExtra.existsSync(this.path)) return { version: 1, records: {} };
    // Discriminate the failure class so a transient I/O lock is not mistaken for corruption:
    //   • parse/shape failure  → the content is genuinely bad; start fresh (refetchable).
    //   • I/O failure (EBUSY/EPERM/EACCES/EIO — e.g. an AV scanner holding the multi-MB file
    //     this app rewrites during fills) → the content is FINE, just unreadable right now.
    //     Boot-only, so a few short synchronous retries are safe (AV locks are sub-second). If
    //     it stays locked, boot empty but flag the intact file to be preserved as .bak on the
    //     first write, instead of overwriting the whole fleet cache with a near-empty file.
    const sleeps = [100, 400, 1000]; // up to 3 retries after the initial attempt
    for (let attempt = 0; ; attempt++) {
      try {
        // Validate the on-disk shape before trusting it: a truncated / older /
        // hand-edited file (e.g. `{}`, `null`, an array) would leave `records`
        // undefined and crash every get/set/all at runtime. Mirror
        // ValueHistoryService's guard and start fresh on any malformed shape
        // (this cache is fully refetchable from Steam, so discarding it is safe).
        const parsed = fsExtra.readJsonSync(this.path) as Partial<InventoryFile> | null;
        if (parsed && typeof parsed.records === 'object' && parsed.records && !Array.isArray(parsed.records)) {
          return { version: 1, records: parsed.records };
        }
        logger.warn(`${this.path} has an unexpected shape – starting fresh`);
        return { version: 1, records: {} };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (typeof code !== 'string') {                // parse failure (SyntaxError, no code) → content is bad
          logger.warn(`${this.path} unreadable, starting fresh: ${(err as Error).message}`);
          return { version: 1, records: {} };
        }
        if (attempt < sleeps.length) {                 // I/O failure → retry a locked-but-intact file
          sleepSync(sleeps[attempt]);
          continue;
        }
        logger.error(`${this.path} unreadable after retries (${code}: ${(err as Error).message}) – `
          + `booting empty; previous cache will be preserved as .bak on next write`);
        this.preserveNextFlush = true;
        return { version: 1, records: {} };
      }
    }
  }

  /**
   * Debounced persistence: during a refresh-all over hundreds of accounts,
   * completions land well under the old 2s window, so each set() rewrote the
   * whole multi-MB JSON (~40× larger than prices.json) once per 2s for the
   * entire pass. Coalesce with a 30s max-delay window plus a burst cap (500)
   * so a single fleet pass persists roughly once — same shape S43 gave
   * PriceCache. Reads are served from memory and the cache is refetchable, so
   * a hard crash mid-pass loses up to 30s of refreshed accounts (refetchable);
   * shutdown and the bulk-pass completion both flush() directly.
   */
  private static readonly FLUSH_MAX_DELAY_MS = 30_000;
  private static readonly FLUSH_EVERY_N      = 500;
  private dirtyCount = 0;

  private scheduleFlush(): void {
    this.dirty = true;
    if (++this.dirtyCount >= InventoryStore.FLUSH_EVERY_N) { this.flush(); return; } // burst cap → persist now
    if (this.flushTimer) return;                                                     // else coalesce into one write
    this.flushTimer = setTimeout(() => this.flush(), InventoryStore.FLUSH_MAX_DELAY_MS);
    this.flushTimer.unref?.();
  }

  /** Writes pending changes to disk immediately (atomic). Safe to call anytime. */
  flush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    if (!this.dirty) return;
    this.dirtyCount = 0; // reset on every flush ATTEMPT (a failing disk must not re-trigger every set)
    try {
      // Persist recency: rebuild `records` in LRU order (oldest→newest) so the line-57 seed
      // reconstructs true access order across restarts — otherwise `lru` order dies with the
      // process and the first post-restart evictions target first-EVER-inserted keys (which
      // may be the operator's most-active accounts). Captures read-recency as of this flush.
      const ordered: Record<string, AccountInventory> = {};
      for (const k of this.lru) if (k in this.data.records) ordered[k] = this.data.records[k];
      this.data.records = ordered;
      // If we booted empty over a locked-but-intact file (I/O-degraded load), keep the last
      // good file as `<path>.bak` before this near-empty first write replaces it — one-shot.
      writeJsonAtomic(this.path, this.data, { spaces: 0, backup: this.preserveNextFlush });
      this.dirty = false;
      this.preserveNextFlush = false;
    } catch (err) {
      logger.error(`failed to persist ${this.path}: ${(err as Error).message}`);
    }
  }

  get(username: string): AccountInventory | undefined {
    const key = username.toLowerCase();
    const rec = this.data.records[key];
    if (rec) { this.lru.delete(key); this.lru.add(key); } // mark most-recently-used
    // Return a DEEP COPY. The API read paths overlay manual locks, categories and
    // prices onto the result in place; a live reference would persist those
    // read-time mutations back into the cache on the next debounced flush —
    // corrupting the trade-lock/category state that gates real-asset trade/sell.
    return rec ? cloneInventory(rec) : undefined;
  }

  /**
   * Read-only view for AGGREGATION only (H-INV-023): the live record, NO clone and NO LRU
   * touch — used by the value-history snapshot which sums two numbers per account and would
   * otherwise structuredClone the whole multi-MB record per account, per snapshot. Callers
   * MUST NOT mutate the returned object (INV-B12: read-time enrichment never persists into
   * the cache); the read-only enricher `PricingService.totalsOf` upholds that. Use get()
   * everywhere else.
   */
  peek(username: string): Readonly<AccountInventory> | undefined {
    return this.data.records[username.toLowerCase()];
  }

  set(username: string, inventory: AccountInventory): void {
    const key = username.toLowerCase();
    const existing = this.data.records[key];
    // #13: don't let a slower/older concurrent fetch (e.g. a refresh-all worker) clobber a
    // newer snapshot (e.g. a buy-verification forceRefresh). Both are valid; newest wins.
    // (Falls through to set when either fetchedAt is missing — preserves prior behavior.)
    if (existing?.fetchedAt && inventory.fetchedAt) {
      const existingT = new Date(existing.fetchedAt).getTime();
      // A stored stamp beyond plausible skew is provably from a clock that has since stepped
      // back (NTP correction, resume-from-sleep, manual change). Trusting it would silently
      // refuse every genuine fetch for up to that Δ, returning stale cache as "refreshed".
      // Accept the incoming write in that case; keep the strict-newer refusal otherwise.
      if (existingT > Date.now() + 60_000) {
        logger.warn(`[inv-cache] stored record for ${key} is future-dated by `
          + `${Math.round((existingT - Date.now()) / 1000)}s (clock step?) – accepting fresh snapshot`);
      } else if (existingT > new Date(inventory.fetchedAt).getTime()) {
        return;
      }
    }
    this.data.records[key] = inventory;
    this.lru.delete(key); this.lru.add(key); // most-recently-used
    this.evictIfNeeded();
    this.scheduleFlush();
  }

  delete(username: string): void {
    const key = username.toLowerCase();
    delete this.data.records[key];
    this.lru.delete(key);
    this.scheduleFlush();
  }

  /**
   * Drops the least-recently-used records from RAM when over MAX_RECORDS, so a very large
   * fleet can't grow the cache without bound. Eviction is DESTRUCTIVE: it deletes the record
   * from RAM AND (on the next flush) from the persisted file, with no refetch-on-miss — the
   * account reverts to never-refreshed ("—", wallet gone) until a manual refresh. No-op below
   * the cap, so at typical scale (hundreds of accounts) this never runs and behaviour is unchanged.
   */
  private evictIfNeeded(): void {
    const over = this.lru.size - MAX_RECORDS;
    if (over <= 0) return;
    const it = this.lru.values();
    const drop: string[] = [];
    for (let i = 0; i < over; i++) { const n = it.next(); if (n.done) break; drop.push(n.value); }
    for (const k of drop) { delete this.data.records[k]; this.lru.delete(k); }
    if (drop.length) {
      this.scheduleFlush();
      // info (not debug): eviction permanently deletes refreshed fleet data (wallets included)
      // from disk with no refetch-on-miss — an operator must see it. It is already aggregated
      // once per eviction pass (not per account), so it is not per-account spam.
      logger.info(`[inv-cache] evicted ${drop.length} least-recently-used record(s) (cap ${MAX_RECORDS}) – ${this.path}`);
    }
  }

  /** Deep-copied snapshot of every record (same no-mutate-the-cache guarantee as get). */
  all(): Record<string, AccountInventory> {
    const out: Record<string, AccountInventory> = {};
    for (const [user, inv] of Object.entries(this.data.records)) out[user] = cloneInventory(inv);
    return out;
  }
}

/**
 * Deep copy of an inventory record. `structuredClone` (Node ≥17) preserves the Date
 * fields (`fetchedAt`, per-item `tradeLockExpiry`) that a JSON round-trip would
 * silently degrade to strings.
 */
function cloneInventory(inv: AccountInventory): AccountInventory {
  return structuredClone(inv);
}
