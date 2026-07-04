import { PriceCache, type PriceEntry } from './PriceCache';
import type { AccountInventory } from '../types/inventory';
import { logger } from '../utils/logger';
import { AppSettings } from '../core/AppSettings';
import type { PriceSource, PriceSourceId } from './sources/PriceSource';
import { SteamPriceSource } from './sources/SteamPriceSource';
import { CsFloatPriceSource } from './sources/CsFloatPriceSource';
import type { CsFloatService } from '../csfloat/CsFloatService';

const PRICE_TTL_MS         = 24 * 60 * 60 * 1000; // re-price a name at most once / 24h
const ERROR_MISS_TTL_MS    = 10 * 60 * 1000;      // a transient error-miss expires in minutes, not 24h (S2)
const FETCH_DELAY_MS       = 3_500;               // ~17 req/min – under Steam's per-IP limit
const RATE_LIMIT_PAUSE_MS  = 60_000;              // back off on a 429
const RATE_LIMIT_JITTER_MS = 20_000;              // +0..20s jitter so the fleet doesn't retry in lockstep
const MAX_RATE_LIMIT_RETRIES = 6;                 // bound per-name 429 retries, then cache a miss (#17)
const APPID_CS2            = 730;
const APPID_TF2            = 440;

export interface PricingStatus {
  running:   boolean;
  queued:    number;
  fetched:   number; // names fetched in the current/last run
  cacheSize: number;
  source:    PriceSourceId; // the EFFECTIVE active source (Feature 3)
}

/**
 * Prices CS2/TF2 items through a PLUGGABLE price source (Steam priceoverview or
 * CSFloat lowest-ask — Feature 3). Lookups are served instantly from a 24h cache;
 * misses are fetched in a throttled background job so inventory loads never block.
 *
 * The cache is SEGMENTED by source so switching never serves a cross-source price:
 * Steam keeps the legacy name-only key (backward compatible with prices.json) and
 * CSFloat keys are namespaced `csfloat:`. If CSFloat is selected but NO account has
 * a key, the active source transparently falls back to Steam (the UI is never
 * hard-failed). Public, session-less; CSFloat pricing routes through any keyed account.
 */
export class PricingService {
  private cache = new PriceCache();
  private queue: Array<{ name: string; appid: number }> = [];
  private queued = new Set<string>(); // cache keys queued or in-flight (dedup across loads)
  private readonly rlAttempts = new Map<string, number>(); // per-key 429 retry counter (#17)
  private running = false;
  private stopped = false;            // set on app teardown/SIGINT → the loop exits promptly
  private fetchedThisRun = 0;

  private readonly steamSource = new SteamPriceSource();
  private readonly csfloatSource?: CsFloatPriceSource;
  private readonly csfloat?: CsFloatService;

  constructor(csfloat?: CsFloatService) {
    this.csfloat = csfloat;
    this.csfloatSource = csfloat ? new CsFloatPriceSource(csfloat) : undefined;
  }

  /** The EFFECTIVE source: CSFloat only when selected AND a key exists; else Steam (fallback). */
  private activeSource(): PriceSource {
    if (AppSettings.getPriceSource() === 'csfloat' && this.csfloatSource && this.csfloatSource.available()) {
      return this.csfloatSource;
    }
    return this.steamSource;
  }

  /** The effective source id (accounts for the no-key → Steam fallback). */
  getSource(): PriceSourceId { return this.activeSource().id; }

  /** Switches the app-wide source. Clears pending fetches so queued names re-price from the
   *  NEW source; already-cached prices for that source serve instantly (cache is segmented). */
  setSource(source: PriceSourceId): void {
    AppSettings.setPriceSource(source === 'csfloat' ? 'csfloat' : 'steam');
    this.queue = [];
    this.queued.clear();
    this.rlAttempts.clear();
    logger.info(`[pricing] source set to ${source} (effective: ${this.getSource()})`);
  }

  /** Cache key. Steam CS2 stays name-only (legacy/back-compat); TF2 is appid-prefixed; CSFloat
   *  is namespaced so the two sources never collide and a switch never serves a stale price. */
  private cacheKey(name: string, appid: number, source: PriceSourceId): string {
    const base = appid === APPID_CS2 ? name : `${appid}:${name}`;
    return source === 'csfloat' ? `csfloat:${base}` : base;
  }

  /** An entry is fresh for 24h normally, but only ERROR_MISS_TTL_MS if it is a transient error-miss
   *  (soft) — so a network blip is retried in minutes, never served as a 24h "no price" (S2). */
  private isFresh(e: PriceEntry): boolean {
    const m = new Date(e.fetchedAt).getTime();
    if (!Number.isFinite(m)) return false;
    const ttl = e.soft ? ERROR_MISS_TTL_MS : PRICE_TTL_MS;
    return Date.now() - m <= ttl;
  }

  /** Fresh cached price (USD cents | null) or undefined when missing/stale — for the ACTIVE source. */
  priceCents(name: string, appid: number = APPID_CS2): number | null | undefined {
    const e = this.cache.get(this.cacheKey(name, appid, this.activeSource().id));
    if (!e || !this.isFresh(e)) return undefined;
    return e.cents;
  }

  /**
   * Enriches an inventory in place: sets item.price from cache (active source) and computes
   * inv.totalValueUsd. Returns the unique market_hash_names still missing/stale to queue.
   */
  enrich(inv: AccountInventory): Array<{ name: string; appid: number }> {
    const appid = inv.game === 'tf2' ? APPID_TF2 : APPID_CS2;
    const sid = this.activeSource().id;
    const missing: Array<{ name: string; appid: number }> = [];
    let total = 0;
    for (const item of inv.items) {
      const e = this.cache.get(this.cacheKey(item.marketHashName, appid, sid));
      const fresh = e && this.isFresh(e);
      if (!fresh) { item.price = undefined; missing.push({ name: item.marketHashName, appid }); }
      else { item.price = e!.cents ?? undefined; if (e!.cents) total += e!.cents * item.quantity; }
    }
    inv.totalValueUsd = total;
    return missing;
  }

  /** Queues unique (name, appid) pairs for background fetching; starts if idle. */
  ensureFilled(items: Array<{ name: string; appid: number }>): void {
    const sid = this.activeSource().id;
    for (const it of items) {
      const key = this.cacheKey(it.name, it.appid, sid);
      if (this.queued.has(key)) continue;
      this.queued.add(key);
      this.queue.push(it);
    }
    if (!this.running && !this.stopped && this.queue.length) void this.run();
  }

  status(): PricingStatus {
    return { running: this.running, queued: this.queue.length, fetched: this.fetchedThisRun, cacheSize: this.cache.size(), source: this.getSource() };
  }

  flush(): void { this.cache.flush(); }

  /** Stops the background loop and flushes the cache (app teardown/SIGINT). */
  shutdown(): void { this.stopped = true; this.cache.flush(); }

  private async run(): Promise<void> {
    this.running = true;
    this.fetchedThisRun = 0;
    logger.info(`[pricing] background fill started (${this.queue.length} names queued, source=${this.getSource()})`);
    try {
      while (this.queue.length && !this.stopped) {
        const job = this.queue.shift()!;
        const src = this.activeSource();
        const key = this.cacheKey(job.name, job.appid, src.id);
        let requeued = false;
        try {
          const cents = await src.fetchPriceCents(job.name, job.appid);
          this.cache.set(key, cents);
          this.fetchedThisRun++;
        } catch (err) {
          if ((err as Error).message === 'RATE_LIMIT') {
            const attempts = (this.rlAttempts.get(key) ?? 0) + 1;
            if (attempts <= MAX_RATE_LIMIT_RETRIES) {
              this.rlAttempts.set(key, attempts);
              this.queue.unshift(job); // retry after the pause — stays deduped (see finally)
              requeued = true;
              const pause = RATE_LIMIT_PAUSE_MS + Math.floor(Math.random() * RATE_LIMIT_JITTER_MS);
              logger.warn(`[pricing] rate-limited – pausing ${Math.round(pause / 1000)}s (retry ${attempts}/${MAX_RATE_LIMIT_RETRIES})`);
              await sleep(pause);
            } else {
              logger.warn(`[pricing] ${key}: still rate-limited after ${MAX_RATE_LIMIT_RETRIES} retries – caching a SHORT miss, moving on`);
              this.cache.set(key, null, { soft: true }); // error-miss: short TTL, not a 24h "no price" (S2)
            }
          } else {
            // A thrown fetch failure (transport ECONNRESET/timeout/DNS, or a Steam 5xx/403/non-success
            // now surfaced as FETCH_FAILED) is NOT authoritative — cache a SHORT miss so it retries in
            // minutes and never survives restart as a fake "no price". (S2)
            logger.warn(`[pricing] ${key}: ${(err as Error).message}`);
            this.cache.set(key, null, { soft: true });
          }
        } finally {
          if (!requeued) { this.queued.delete(key); this.rlAttempts.delete(key); }
        }
        if (requeued) continue; // already paused; skip the inter-fetch delay
        await sleep(FETCH_DELAY_MS);
      }
    } finally {
      this.cache.flush();
      this.running = false;
      logger.info(`[pricing] background fill ${this.stopped ? 'STOPPED' : 'done'} (fetched=${this.fetchedThisRun}, cache=${this.cache.size()})`);
    }
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => { setTimeout(r, ms); }); }
