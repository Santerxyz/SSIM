import axios from 'axios';
import { PriceCache } from './PriceCache';
import type { AccountInventory } from '../types/inventory';
import { logger } from '../utils/logger';

const PRICE_TTL_MS        = 24 * 60 * 60 * 1000; // re-price a name at most once / 24h
const FETCH_DELAY_MS      = 3_500;               // ~17 req/min – under Steam's per-IP limit
const RATE_LIMIT_PAUSE_MS = 60_000;              // back off on HTTP 429
const RATE_LIMIT_JITTER_MS = 20_000;             // +0..20s jitter so the fleet doesn't retry in lockstep
const MAX_RATE_LIMIT_RETRIES = 6;                // bound per-name 429 retries, then cache a miss (#17)
const STEAM_CURRENCY_USD  = 1;                   // base currency = USD; EUR via exchange rate
const APPID_CS2           = 730;
const APPID_TF2           = 440;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface PricingStatus {
  running:   boolean;
  queued:    number;
  fetched:   number; // names fetched in the current/last run
  cacheSize: number;
}

/**
 * Prices CS2 items via Steam's market priceoverview endpoint. Lookups are served
 * instantly from a 24h cache; cache misses are fetched in a throttled background
 * job so inventory loads never block on the network. Public, session-less, local IP.
 */
export class PricingService {
  private cache = new PriceCache();
  private queue: Array<{ name: string; appid: number }> = [];
  private queued = new Set<string>(); // cache keys queued or in-flight (dedup across loads)
  private readonly rlAttempts = new Map<string, number>(); // per-key 429 retry counter (#17)
  private running = false;
  private stopped = false;            // set on app teardown/SIGINT → the loop exits promptly
  private fetchedThisRun = 0;

  /** Cache key. CS2 stays name-only (backward compatible with the existing cache);
   *  other apps (e.g. TF2/440) are prefixed so identical names never collide and
   *  each is priced against the CORRECT market. */
  private cacheKey(name: string, appid: number): string {
    return appid === APPID_CS2 ? name : `${appid}:${name}`;
  }

  /** Fresh cached price (USD cents | null) or undefined when missing/stale. */
  priceCents(name: string, appid: number = APPID_CS2): number | null | undefined {
    const e = this.cache.get(this.cacheKey(name, appid));
    if (!e) return undefined;
    // Treat an unparseable fetchedAt (corrupt / hand-edited prices.json) as stale
    // rather than fresh: `Date.now() - NaN > TTL` is false, which would otherwise
    // pin a corrupt price forever and never re-fetch it.
    const fetchedMs = new Date(e.fetchedAt).getTime();
    if (!Number.isFinite(fetchedMs) || Date.now() - fetchedMs > PRICE_TTL_MS) return undefined;
    return e.cents;
  }

  /**
   * Enriches an inventory in place: sets item.price from cache and computes
   * inv.totalValueUsd. Returns the unique market_hash_names that are still
   * missing/stale so the caller can queue a background fill.
   */
  enrich(inv: AccountInventory): Array<{ name: string; appid: number }> {
    // Price each item against ITS OWN market (CS2=730, TF2=440) – otherwise TF2
    // names are looked up on the CS2 market and never resolve (no value shown).
    const appid = inv.game === 'tf2' ? APPID_TF2 : APPID_CS2;
    const missing: Array<{ name: string; appid: number }> = [];
    let total = 0;
    for (const item of inv.items) {
      const cents = this.priceCents(item.marketHashName, appid);
      if (cents === undefined) { item.price = undefined; missing.push({ name: item.marketHashName, appid }); }
      else { item.price = cents; if (cents) total += cents * item.quantity; }
    }
    inv.totalValueUsd = total;
    return missing;
  }

  /** Queues unique (name, appid) pairs for background fetching; starts if idle. */
  ensureFilled(items: Array<{ name: string; appid: number }>): void {
    for (const it of items) {
      const key = this.cacheKey(it.name, it.appid);
      if (this.queued.has(key)) continue;
      this.queued.add(key);
      this.queue.push(it);
    }
    if (!this.running && !this.stopped && this.queue.length) void this.run();
  }

  status(): PricingStatus {
    return { running: this.running, queued: this.queue.length, fetched: this.fetchedThisRun, cacheSize: this.cache.size() };
  }

  flush(): void { this.cache.flush(); }

  /** Stops the background loop and flushes the cache. Called on app teardown/SIGINT so
   *  the loop never keeps writing prices.json after shutdown believed it was done. */
  shutdown(): void {
    this.stopped = true;
    this.cache.flush();
  }

  private async run(): Promise<void> {
    this.running = true;
    this.fetchedThisRun = 0;
    logger.info(`[pricing] background fill started (${this.queue.length} names queued)`);
    // try/finally guarantees running=false + a final flush even if the loop throws —
    // an escaped rejection would otherwise wedge background pricing permanently (#61).
    try {
      while (this.queue.length && !this.stopped) {
        const job = this.queue.shift()!;
        const key = this.cacheKey(job.name, job.appid);
        let requeued = false;
        try {
          const cents = await this.fetchSteam(job.name, job.appid);
          this.cache.set(key, cents);
          this.fetchedThisRun++;
        } catch (err) {
          if ((err as Error).message === 'RATE_LIMIT') {
            // #17: bounded rate-limit retries with jitter — never spin a single name forever,
            // and stagger the pause so the fleet doesn't re-hit Steam in lockstep.
            const attempts = (this.rlAttempts.get(key) ?? 0) + 1;
            if (attempts <= MAX_RATE_LIMIT_RETRIES) {
              this.rlAttempts.set(key, attempts);
              this.queue.unshift(job); // retry this one after the pause — stays deduped (see finally)
              requeued = true;
              const pause = RATE_LIMIT_PAUSE_MS + Math.floor(Math.random() * RATE_LIMIT_JITTER_MS);
              logger.warn(`[pricing] rate-limited – pausing ${Math.round(pause / 1000)}s (retry ${attempts}/${MAX_RATE_LIMIT_RETRIES})`);
              await sleep(pause);
            } else {
              logger.warn(`[pricing] ${key}: still rate-limited after ${MAX_RATE_LIMIT_RETRIES} retries – caching a miss, moving on`);
              this.cache.set(key, null);
            }
          } else {
            logger.warn(`[pricing] ${key}: ${(err as Error).message}`);
            this.cache.set(key, null); // cache the miss so we don't hammer it
          }
        } finally {
          // Release the dedup mark + retry budget ONLY on a TERMINAL outcome (success / give-up
          // / non-rate-limit error). A re-queued job keeps its `queued` mark AND rlAttempts for
          // its whole retry lifetime, so a concurrent ensureFilled can't push a duplicate during
          // the pause, and a later non-RL error never leaves a stale retry count behind. (#17a/#17b)
          if (!requeued) {
            this.queued.delete(key);
            this.rlAttempts.delete(key);
          }
        }
        if (requeued) continue; // we already paused; skip the inter-fetch delay
        await sleep(FETCH_DELAY_MS);
      }
    } finally {
      this.cache.flush();
      this.running = false;
      logger.info(`[pricing] background fill ${this.stopped ? 'STOPPED' : 'done'} (fetched=${this.fetchedThisRun}, cache=${this.cache.size()})`);
    }
  }

  /** Fetches lowest_price (USD cents) from Steam's priceoverview; null if none. */
  private async fetchSteam(name: string, appid: number = APPID_CS2): Promise<number | null> {
    const url = `https://steamcommunity.com/market/priceoverview/` +
      `?appid=${appid}&currency=${STEAM_CURRENCY_USD}&market_hash_name=${encodeURIComponent(name)}`;
    const resp = await axios.get(url, {
      timeout: 12_000,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      validateStatus: () => true,
    });
    if (resp.status === 429) throw new Error('RATE_LIMIT');
    if (resp.status !== 200 || !resp.data || resp.data.success !== true) return null;
    // Take the LOWER of lowest-listing vs median-sale when both exist. A thin/illiquid
    // market gives a VOLATILE lowest_price – a single overpriced listing briefly inflates
    // it 100× (e.g. Sawed-Off | Runoff FT spiked to $8.65 vs a real median of ~$0.06).
    // The median sale price is stable, so the min resists those spikes without
    // under-valuing liquid items (where lowest ≈ median anyway).
    const lowest = parseUsdCents(resp.data.lowest_price);
    const median = parseUsdCents(resp.data.median_price);
    if (lowest != null && median != null) return Math.min(lowest, median);
    return lowest ?? median;
  }
}

/** "$1,234.56" → 123456 cents. USD format: '$' prefix, ',' thousands, '.' decimal. */
function parseUsdCents(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const cleaned = s.replace(/[^0-9.,]/g, '').replace(/,/g, '');
  const val = parseFloat(cleaned);
  return isNaN(val) ? null : Math.round(val * 100);
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
