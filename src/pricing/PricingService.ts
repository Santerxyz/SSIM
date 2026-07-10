import { PriceCache, type PriceEntry } from './PriceCache';
import type { AccountInventory } from '../types/inventory';
import { logger } from '../utils/logger';
import { AppSettings } from '../core/AppSettings';
import type { PriceSource, PriceSourceId, PriceRoute } from './sources/PriceSource';
import { SteamPriceSource } from './sources/SteamPriceSource';
import { CsFloatPriceSource } from './sources/CsFloatPriceSource';
import type { CsFloatService } from '../csfloat/CsFloatService';
import type { PricerIdentity } from './PricerIdentityPool';

const PRICE_TTL_MS         = 24 * 60 * 60 * 1000; // re-price a name at most once / 24h
const PRICE_TTL_JITTER_MS  = 4  * 60 * 60 * 1000; // spread a cohort's 24h expiry over 4h (no boot thundering-fill)
const ERROR_MISS_TTL_MS    = 10 * 60 * 1000;      // a transient error-miss expires in minutes, not 24h (S2)
const FETCH_DELAY_MS       = 3_500;               // ~17 req/min PER lane — gentle, well inside a logged-in budget
const MAX_PRICE_LANES      = 8;                   // hard cap on parallel identity lanes
const CSFLOAT_LANES        = 1;                   // CsFloatClient's per-key limiter is single-flight → 1 lane suffices
// The 2026-07-10 failure model: a 429 is "this identity's budget is spent", NOT "sleep and retry the same
// request" (the old 6×60-80s per-name stall turned a degraded endpoint into a ~day-long zombie grind that
// re-armed Steam's rolling lockout). Two consecutive 429s retire the lane; when every lane retires the fill
// aborts and the names are cached as SHORT soft-misses (re-tried in ~10min, not hammered).
const LANE_RETIRE_AFTER_429 = 2;
const APPID_CS2            = 730;
const APPID_TF2            = 440;

export interface PricingStatus {
  running:   boolean;
  queued:    number;
  fetched:   number; // names SUCCESSFULLY priced in the current/last run
  processed: number; // names RESOLVED (success OR error/429) — the true liveness signal (S19)
  cacheSize: number;
  source:    PriceSourceId;   // the EFFECTIVE active source (Feature 3)
  sourceSelected: PriceSourceId; // what the operator SELECTED (may differ from effective — see degradedReason)
  degradedReason?: string;    // set when selected ≠ effective (e.g. CSFloat chosen but no key) — surface it, never silent
}

/** One background fill job, pinned to its ENQUEUE-time cache key + source (S13). */
interface Job { name: string; appid: number; key: string; sourceId: PriceSourceId; }
/** Per-lane instrumentation — printed once per lane so a fill's egress + status mix is greppable. */
interface LaneStat { label: string; requests: number; ok: number; rl: number; err: number; consecutive429: number; }

/**
 * Prices CS2/TF2 items through a PLUGGABLE price source (Steam priceoverview or
 * CSFloat lowest-ask — Feature 3). Lookups are served instantly from a 24h cache;
 * misses are fetched in a throttled background job so inventory loads never block.
 *
 * IDENTITY-BUDGETED EGRESS (2026-07-10 root-cause fix). Steam's ANONYMOUS priceoverview
 * budget is per-IP and, on the fleet's shared rotating residential pool, routinely
 * PRE-EXHAUSTED by other tenants — so a cold request 429s while authenticated traffic on
 * the same proxies sails through. The fill therefore rides real LOGGED-IN identities: each
 * Steam lane sends an account's `steamLoginSecure` cookie over that account's own egress
 * agent, drawing that account's per-session budget. With no identity web-ready yet (boot,
 * pre-login) the fill DEFERS rather than issue an anonymous call, and `kick()` restarts it
 * when a session comes up. CSFloat (keyed) prices off Steam entirely and needs no identity.
 *
 * The cache is SEGMENTED by source so switching never serves a cross-source price: Steam
 * keeps the legacy name-only key (CS2) / appid-prefixed key (TF2); CSFloat keys are
 * namespaced `csfloat:`. CSFloat is CS2-only, so a TF2 name ALWAYS prices via Steam even
 * when CSFloat is the selected source (per-appid routing). If CSFloat is selected but NO
 * account has a key, the effective source falls back to Steam and status() reports the
 * degradation explicitly (never a silent swap).
 */
export class PricingService {
  private cache = new PriceCache();
  // S13: each job carries its ENQUEUE-time cache key + source, so a mid-fill effective-source flip (a
  // CSFloat key added/removed at runtime) cannot leave a stale key in `queued` forever.
  private queue: Job[] = [];
  private queued = new Set<string>(); // cache keys queued or in-flight (dedup across loads)
  private running = false;
  private stopped = false;            // set on app teardown/SIGINT → the loop exits promptly
  private fetchedThisRun = 0;
  private processedThisRun = 0;       // S19: every name that reaches a terminal outcome (success OR error)

  private readonly steamSource = new SteamPriceSource();
  private readonly csfloatSource?: CsFloatPriceSource;
  private readonly csfloat?: CsFloatService;
  /** Live authenticated identities for the Steam fill lanes. Injected as a provider so every run()
   *  reads the CURRENT set of web-ready sessions (see PricerIdentityPool). Undefined in dev/tests
   *  with no fleet → the Steam fill simply defers (never prices anonymously). */
  private readonly identityProvider?: () => PricerIdentity[];

  constructor(csfloat?: CsFloatService, identityProvider?: () => PricerIdentity[]) {
    this.csfloat = csfloat;
    this.csfloatSource = csfloat ? new CsFloatPriceSource(csfloat) : undefined;
    this.identityProvider = identityProvider;
  }

  /** The EFFECTIVE source: CSFloat only when selected AND a key exists; else Steam (fallback). */
  private activeSource(): PriceSource {
    if (AppSettings.getPriceSource() === 'csfloat' && this.csfloatSource && this.csfloatSource.available()) {
      return this.csfloatSource;
    }
    return this.steamSource;
  }

  /** The effective source id for a given appid. CSFloat is CS2-only, so a TF2 (440) name ALWAYS
   *  prices via Steam even under a CSFloat selection — this kills the old authoritative-null-for-TF2
   *  hole. A CS2 name follows the effective source (CSFloat when keyed, else Steam). */
  private sourceIdForAppid(appid: number): PriceSourceId {
    return appid === APPID_CS2 ? this.activeSource().id : 'steam';
  }

  /** The effective source id (accounts for the no-key → Steam fallback). */
  getSource(): PriceSourceId { return this.activeSource().id; }

  /** Switches the app-wide source. Clears pending fetches so queued names re-price from the
   *  NEW source; already-cached prices for that source serve instantly (cache is segmented). */
  setSource(source: PriceSourceId): void {
    AppSettings.setPriceSource(source === 'csfloat' ? 'csfloat' : 'steam');
    this.queue = [];
    this.queued.clear();
    logger.info(`[pricing] source set to ${source} (effective: ${this.getSource()})`);
  }

  /** Cache key. Steam CS2 stays name-only (legacy/back-compat); TF2 is appid-prefixed; CSFloat
   *  is namespaced so the two sources never collide and a switch never serves a stale price. */
  private cacheKey(name: string, appid: number, source: PriceSourceId): string {
    const base = appid === APPID_CS2 ? name : `${appid}:${name}`;
    return source === 'csfloat' ? `csfloat:${base}` : base;
  }

  /** Deterministic non-negative hash of a cache key, for per-name TTL jitter. */
  private static hashKey(key: string): number {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  /** An entry is fresh for 24h (minus a deterministic per-name jitter, to break a cohort's TTL cliff),
   *  but only ERROR_MISS_TTL_MS if it is a transient error-miss (soft) — so a network blip is retried in
   *  minutes, never served as a 24h "no price" (S2). */
  private isFresh(e: PriceEntry, key: string): boolean {
    const m = new Date(e.fetchedAt).getTime();
    if (!Number.isFinite(m)) return false;
    const ttl = e.soft ? ERROR_MISS_TTL_MS : PRICE_TTL_MS - (PricingService.hashKey(key) % PRICE_TTL_JITTER_MS);
    return Date.now() - m <= ttl;
  }

  /** Fresh cached price (USD cents | null) or undefined when missing/stale — for the ACTIVE source. */
  priceCents(name: string, appid: number = APPID_CS2): number | null | undefined {
    const key = this.cacheKey(name, appid, this.sourceIdForAppid(appid));
    const e = this.cache.get(key);
    if (!e || !this.isFresh(e, key)) return undefined;
    return e.cents;
  }

  /**
   * Enriches an inventory in place: sets item.price from cache (active source) and computes
   * inv.totalValueUsd. Returns the unique market_hash_names still missing/stale to queue.
   */
  enrich(inv: AccountInventory): Array<{ name: string; appid: number }> {
    const appid = inv.game === 'tf2' ? APPID_TF2 : APPID_CS2;
    const sid = this.sourceIdForAppid(appid);
    const missing: Array<{ name: string; appid: number }> = [];
    let total = 0;
    for (const item of inv.items) {
      const key = this.cacheKey(item.marketHashName, appid, sid);
      const e = this.cache.get(key);
      const fresh = e && this.isFresh(e, key);
      if (!fresh) { item.price = undefined; missing.push({ name: item.marketHashName, appid }); }
      else {
        // Tri-state (INV-E1, price analogue of DIRECTIVES #2): an AUTHORITATIVE no-price
        // (cents===null && !soft) → null ("—"); a transient error-miss (cents===null && soft)
        // → undefined ("…", still effectively pending); a real price → the number.
        const cents = e!.cents;
        item.price = cents == null ? (e!.soft ? undefined : null) : cents;
        if (cents) total += cents * item.quantity;
      }
    }
    inv.totalValueUsd = total;
    return missing;
  }

  /**
   * READ-ONLY twin of enrich (same walk) that NEVER assigns item.price or inv.totalValueUsd — for
   * aggregation callers that must not mutate the cached record. Returns the priced total plus the
   * honesty signals the snapshot needs: `missing` = names with no fresh cache entry (unpriced/stale,
   * must be queued), `softNull` = names whose fresh cache hit is a transient error-miss (soft, cents
   * null — S2) so the total silently undercounts them. (H-INV-022.)
   */
  totalsOf(inv: AccountInventory): { totalCents: number; missing: Array<{ name: string; appid: number }>; softNull: number } {
    const appid = inv.game === 'tf2' ? APPID_TF2 : APPID_CS2;
    const sid = this.sourceIdForAppid(appid);
    const missing: Array<{ name: string; appid: number }> = [];
    let totalCents = 0;
    let softNull = 0;
    for (const item of inv.items) {
      const key = this.cacheKey(item.marketHashName, appid, sid);
      const e = this.cache.get(key);
      const fresh = e && this.isFresh(e, key);
      if (!fresh) { missing.push({ name: item.marketHashName, appid }); }
      else if (e!.cents == null) { if (e!.soft) softNull++; } // fresh soft error-miss → undercounted, not truly 0
      else { totalCents += e!.cents * item.quantity; }
    }
    return { totalCents, missing, softNull };
  }

  /** Queues unique (name, appid) pairs for background fetching; starts if idle. */
  ensureFilled(items: Array<{ name: string; appid: number }>): void {
    for (const it of items) {
      const sid = this.sourceIdForAppid(it.appid);       // per-appid: TF2 always Steam, even under CSFloat
      const key = this.cacheKey(it.name, it.appid, sid);
      if (this.queued.has(key)) continue;
      this.queued.add(key);
      this.queue.push({ name: it.name, appid: it.appid, key, sourceId: sid }); // S13: pin the enqueue key+source
    }
    if (!this.running && !this.stopped && this.queue.length) void this.run();
  }

  /** Re-arm the fill (idempotent). Wired to the SessionManager 'webSession' event so a Steam fill that
   *  DEFERRED for lack of an authenticated identity starts the moment the first session is web-ready. */
  kick(): void {
    if (!this.running && !this.stopped && this.queue.length) void this.run();
  }

  status(): PricingStatus {
    const selected: PriceSourceId = AppSettings.getPriceSource() === 'csfloat' ? 'csfloat' : 'steam';
    const effective = this.getSource();
    const degradedReason = selected === 'csfloat' && effective === 'steam'
      ? 'CSFloat is selected but no API key is loaded — pricing via authenticated Steam. Add a (free) CSFloat key to price off Steam.'
      : undefined;
    return {
      running: this.running, queued: this.queue.length,
      fetched: this.fetchedThisRun, processed: this.processedThisRun,
      cacheSize: this.cache.size(), source: effective, sourceSelected: selected, degradedReason,
    };
  }

  flush(): void { this.cache.flush(); }

  /** Stops the background loop and flushes the cache (app teardown/SIGINT). */
  shutdown(): void { this.stopped = true; this.cache.flush(); }

  /**
   * The run splits by SOURCE. CSFloat jobs (keyed, off-Steam) drain through one lane on the shared
   * per-key limiter. Steam jobs ride up to MAX_PRICE_LANES authenticated identity lanes — and if NO
   * identity is web-ready yet, they DEFER (never an anonymous call); kick() restarts them later.
   */
  private async run(): Promise<void> {
    this.running = true;
    this.fetchedThisRun = 0;
    this.processedThisRun = 0;
    try {
      const steamPending   = this.queue.some((j) => j.sourceId === 'steam');
      // CSFloat (keyed, off-Steam) warms the WHOLE CS2 catalog in ONE request, then only stragglers need a
      // per-name lane. This is the highest-certainty unblock: it never touches Steam's exhausted anonymous budget.
      if (this.queue.some((j) => j.sourceId === 'csfloat') && this.csfloatSource) await this.csfloatBulkWarm();
      const csfloatPending = this.queue.some((j) => j.sourceId === 'csfloat'); // recompute: bulk warm pruned the fresh ones

      let identities: PricerIdentity[] = [];
      if (steamPending) {
        try { identities = this.identityProvider ? [...this.identityProvider()].slice(0, MAX_PRICE_LANES) : []; }
        catch (e) { logger.warn(`[pricing] identity provider failed (${(e as Error).message})`); }
      }

      // No authenticated identity to price the Steam names, and nothing off-Steam to do → DEFER (leave the
      // queue intact) rather than issue an anonymous call the shared pool will 429. kick() restarts on login.
      if (steamPending && identities.length === 0 && !csfloatPending) {
        logger.info(`[pricing] fill deferred — no authenticated pricer identity web-ready yet (${this.queue.length} queued); starts when a session logs in`);
        return;
      }

      const lanes: Array<Promise<void>> = [];
      const steamLaneCount = identities.length;
      logger.info(`[pricing] background fill started (${this.queue.length} queued, source=${this.getSource()}, ` +
        `${steamLaneCount} steam identity lane(s)${csfloatPending ? ` + ${CSFLOAT_LANES} csfloat lane` : ''})`);

      const steamStats: LaneStat[] = identities.map((id) => ({ label: `steam:${id.username}`, requests: 0, ok: 0, rl: 0, err: 0, consecutive429: 0 }));
      identities.forEach((id, i) => {
        const route: PriceRoute = { agent: id.agent, cookieHeader: id.cookieHeader };
        lanes.push(this.laneWorker('steam', (name, appid) => this.steamSource.fetchPriceCents(name, appid, route), steamStats[i]));
      });

      let csfloatStat: LaneStat | undefined;
      if (csfloatPending && this.csfloatSource) {
        csfloatStat = { label: 'csfloat', requests: 0, ok: 0, rl: 0, err: 0, consecutive429: 0 };
        for (let i = 0; i < CSFLOAT_LANES; i++) {
          lanes.push(this.laneWorker('csfloat', (name, appid) => this.csfloatSource!.fetchPriceCents(name, appid), csfloatStat));
        }
      }

      await Promise.all(lanes);

      // If Steam lanes RAN (identities>0) but retired early, steam jobs may remain — they were abandoned by
      // rate-limited lanes. Cache each as a SHORT soft-miss (re-tried in ~10min, S2) instead of leaving them
      // to be re-fetched immediately, and log an honest abort summary. (When we DEFERRED above, steamLaneCount
      // is 0, so leftover steam jobs are left queued for kick() — not soft-missed here.)
      if (steamLaneCount > 0) {
        let abandoned = 0;
        for (let i = this.queue.length - 1; i >= 0; i--) {
          if (this.queue[i].sourceId !== 'steam') continue;
          const job = this.queue.splice(i, 1)[0];
          this.cache.set(job.key, null, { soft: true });
          this.queued.delete(job.key);
          this.processedThisRun++;
          abandoned++;
        }
        if (abandoned > 0) {
          logger.warn(`[pricing] Steam fill ABORTED — all ${steamLaneCount} identity lane(s) rate-limited; ` +
            `${abandoned} name(s) deferred as soft-miss (retry ~${Math.round(ERROR_MISS_TTL_MS / 60000)}min). ` +
            `Lanes: ${steamStats.map((s) => `${s.label}[${s.ok}✓/${s.rl}×429/${s.requests}req]`).join(' ')}`);
        }
      }
      for (const s of steamStats) if (s.requests > 0) logger.info(`[pricing] lane ${s.label}: ${s.ok} priced / ${s.rl} rate-limited / ${s.err} error / ${s.requests} req`);
      if (csfloatStat && csfloatStat.requests > 0) logger.info(`[pricing] lane ${csfloatStat.label}: ${csfloatStat.ok} priced / ${csfloatStat.rl} rate-limited / ${csfloatStat.err} error / ${csfloatStat.requests} req`);
    } finally {
      this.cache.flush();
      this.running = false;
      logger.info(`[pricing] background fill ${this.stopped ? 'STOPPED' : 'done'} (fetched=${this.fetchedThisRun}, cache=${this.cache.size()})`);
    }
  }

  /**
   * Hydrate the csfloat-namespaced cache from ONE bulk price-list request, then PRUNE every queued CSFloat
   * job the warm just satisfied (so the per-name lane only handles stragglers not in the catalog). Best-
   * effort: a failure logs and leaves the per-name lane to do the work. Only CS2 jobs are csfloat-pinned.
   */
  private async csfloatBulkWarm(): Promise<void> {
    if (!this.csfloatSource) return;
    let rows: Array<{ name: string; cents: number }>;
    try { rows = await this.csfloatSource.bulkPriceList(); }
    catch (e) { logger.warn(`[pricing] CSFloat bulk warm failed (${(e as Error).message}) — falling back to per-name`); return; }
    if (rows.length === 0) return;
    for (const r of rows) this.cache.set(this.cacheKey(r.name, APPID_CS2, 'csfloat'), r.cents);
    let pruned = 0;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const job = this.queue[i];
      if (job.sourceId !== 'csfloat') continue;
      const e = this.cache.get(job.key);
      if (e && this.isFresh(e, job.key)) {
        this.queue.splice(i, 1);
        this.queued.delete(job.key);
        this.fetchedThisRun++;
        this.processedThisRun++;
        pruned++;
      }
    }
    logger.info(`[pricing] CSFloat bulk price-list warmed ${rows.length} name(s) → ${pruned} queued name(s) resolved from the catalog`);
  }

  /** Pull the next queued job for `sourceId` (live queue → jobs enqueued mid-fill are still picked up). */
  private nextJob(sourceId: PriceSourceId): Job | undefined {
    const i = this.queue.findIndex((j) => j.sourceId === sourceId);
    return i < 0 ? undefined : this.queue.splice(i, 1)[0];
  }

  /**
   * One fill lane. Pulls jobs of its source and prices them via `fetch`. The 2026-07-10 failure model:
   *  • success/authoritative      → cache the price, reset the lane's 429 streak.
   *  • RATE_LIMIT (429)           → cache a SHORT soft-miss IMMEDIATELY (no per-name stall), bump the streak;
   *                                 two consecutive 429s RETIRE the lane (its identity/key is out of budget).
   *  • other (transport/5xx/…)    → cache a SHORT soft-miss, reset the streak (not a rate-limit signal). (S2)
   * Every terminal outcome bumps `processed` (S19) and clears the `queued` dedup entry.
   */
  private async laneWorker(sourceId: PriceSourceId, fetch: (name: string, appid: number) => Promise<number | null>, stat: LaneStat): Promise<void> {
    while (!this.stopped) {
      const job = this.nextJob(sourceId);
      if (!job) return;
      stat.requests++;
      try {
        const cents = await fetch(job.name, job.appid);
        this.cache.set(job.key, cents);
        this.fetchedThisRun++;
        this.processedThisRun++;
        this.queued.delete(job.key);
        stat.ok++;
        stat.consecutive429 = 0;
      } catch (err) {
        this.queued.delete(job.key);
        this.processedThisRun++;
        if ((err as Error).message === 'RATE_LIMIT') {
          stat.rl++;
          stat.consecutive429++;
          this.cache.set(job.key, null, { soft: true }); // error-miss: short TTL, not a 24h "no price" (S2)
          if (stat.consecutive429 >= LANE_RETIRE_AFTER_429) {
            logger.warn(`[pricing] lane ${stat.label} retired — ${stat.consecutive429} consecutive 429s (out of budget); leaving remaining names for the next fill`);
            return;
          }
        } else {
          // A thrown fetch failure (transport ECONNRESET/timeout/DNS, or a Steam 5xx/403/non-success now
          // surfaced as FETCH_FAILED) is NOT authoritative — cache a SHORT miss so it retries in minutes
          // and never survives restart as a fake "no price". (S2)
          stat.err++;
          stat.consecutive429 = 0;
          logger.warn(`[pricing] ${job.key}: ${(err as Error).message}`);
          this.cache.set(job.key, null, { soft: true });
        }
      }
      if (!this.stopped) await sleep(FETCH_DELAY_MS);
    }
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => { setTimeout(r, ms); }); }
