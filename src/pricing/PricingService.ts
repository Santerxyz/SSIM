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
// ── Lane pacing: the budget is PER EXIT IP (2026-08-25) ─────────────────────────────────────────
// Steam meters this endpoint per EXIT IP, so the only quantity that must stay bounded is how fast a
// single IP is driven. The fill's speed then scales with how many DISTINCT exits the live sessions
// actually expose — never by leaning harder on the exits it already has.
//
// The pre-2026-08-25 fill ran 3 lanes at one request per 3.5s. Whether those 3 lanes landed on 1 IP
// or 3 was accidental, so the worst case it ever shipped — and the pace known to be safe — is all 3
// on ONE IP: 3 / 3.5s ≈ 0.86 req/s per exit. That is the budget preserved here, exactly.
//
//   LANES_PER_EXIT        how many lanes may point at one IP (the safety bound)
//   EXIT_BUDGET_MS        one exit's request budget: LANES_PER_EXIT requests per this window
//   per-lane delay        EXIT_BUDGET_MS × (lanes on THIS exit ÷ LANES_PER_EXIT)
//
// so an exit always issues ~LANES_PER_EXIT requests per EXIT_BUDGET_MS regardless of how many lanes
// it got. One exit with 3 lanes → 3.5s each; one exit with a single available account → ~1.17s, the
// same 0.86 req/s. Throughput is therefore (distinct exits × ~51 names/min): a single-exit setup —
// proxyless, one static proxy, or ONE ROTATING PROXY, all of which present as one egressKey — is
// bit-for-bit the old behaviour, and a 12-exit fleet reaches ~600 names/min.
//
// An earlier draft of this change got it wrong in a way worth naming: it raised the lane cap to 16
// and paced per LANE rather than per EXIT, so a single-exit fleet quietly went from 0.86 to 4.57
// req/s on one IP — 5.3× the pressure, on the exact endpoint behind the July 2026 rolling lockout.
// LANES_PER_EXIT is what makes raising MAX_PRICE_LANES safe; the two must move together.
//
// The 429 → soft-miss → retire-the-lane valve below is untouched and remains the backstop: an
// over-driven exit retires after two consecutive 429s and its names return as 10-minute soft misses.
const FETCH_DELAY_MS    = 3_500;   // the proven single-lane pace; also the per-lane ceiling
const EXIT_BUDGET_MS    = 3_500;   // window in which one exit may issue LANES_PER_EXIT requests
const LANES_PER_EXIT    = 3;       // max lanes on ONE exit IP — the per-IP safety bound
const MIN_FETCH_DELAY_MS = 1_000;  // floor, so an arithmetic edge can never produce a hot loop
const MAX_PRICE_LANES   = 36;      // global cap ≈ 12 exits × LANES_PER_EXIT (the ~600 names/min target)

/** Per-lane pace for an identity, derived from how many lanes share its exit. Keeps every exit at
 *  ~LANES_PER_EXIT requests per EXIT_BUDGET_MS however the lanes fell. */
function laneDelayFor(exitLanes: number): number {
  const share = Math.max(1, Math.min(exitLanes, LANES_PER_EXIT));
  return Math.max(MIN_FETCH_DELAY_MS, Math.round(EXIT_BUDGET_MS * (share / LANES_PER_EXIT)));
}
const CSFLOAT_LANES        = 1;                   // CsFloatClient's per-key limiter is single-flight → 1 lane suffices
// The 2026-07-10 failure model: a 429 is "this identity's budget is spent", not "sleep and retry the same
// request" (the old 6×60-80s per-name stall turned a degraded endpoint into a ~day-long zombie grind that
// re-armed Steam's rolling lockout). Two consecutive 429s retire the lane; when every lane retires the fill
// aborts and the names are cached as SHORT soft-misses (re-tried in ~10min, not hammered).
const LANE_RETIRE_AFTER_429 = 2;
// P1 (2026-07-10, after the header fix): with a full browser fingerprint on every price call, an
// ANONYMOUS priceoverview is viable again — so the fill no longer has to be stranded when no account
// is logged in (e.g. a dashboard showing cached inventories with all sessions idle-reaped). We still
// PREFER authenticated identity lanes when they exist (they spread volume across the accounts' proxies
// and are the most robust), so the fill first DEFERS for a short grace to let a login arrive; only if
// none does within the grace does it fall back to one anonymous lane. A login during the grace cancels
// the fallback (kick → the preferred authenticated fill runs instead).
const ANON_FALLBACK_GRACE_MS = 25_000;
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

/** One background fill job, pinned to its ENQUEUE-time cache key + source. */
interface Job { name: string; appid: number; key: string; sourceId: PriceSourceId; }
/** Per-lane instrumentation — printed once per lane so a fill's egress + status mix is greppable. */
interface LaneStat { label: string; requests: number; ok: number; rl: number; err: number; consecutive429: number; delayMs: number; }

/**
 * Prices CS2/TF2 items through a PLUGGABLE price source (Steam priceoverview or
 * CSFloat lowest-ask — Feature 3). Lookups are served instantly from a 24h cache;
 * misses are fetched in a throttled background job so inventory loads never block.
 *
 * EGRESS MODEL (2026-07-10). The load-bearing fix for the community 429s was the browser
 * fingerprint on every request (see network/steamHeaders.ts) — Steam's bot-check was flagging
 * bare HTTP headers. On top of that, the fill PREFERS authenticated identity lanes: each Steam
 * lane sends a logged-in account's `steamLoginSecure` cookie over that account's own egress agent
 * (spreads volume across the accounts' proxies — the most robust path). With no identity web-ready
 * (boot, or a logged-out dashboard on cached inventories) the fill DEFERS for a short grace and
 * `kick()` starts it the moment a session logs in; only if none arrives within the grace does it
 * fall back to one ANONYMOUS lane (P1) — now safe because that call, too, carries the fingerprint,
 * so valuations are never stranded. CSFloat (keyed) prices off Steam entirely and needs no identity.
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
  // Each job carries its ENQUEUE-time cache key + source, so a mid-fill effective-source flip (a
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
   *  with no fleet → the Steam fill defers, then falls back to one anonymous lane after the grace. */
  private readonly identityProvider?: () => PricerIdentity[];
  /** Grace before the anonymous fallback fires (injectable for tests). */
  private readonly anonFallbackGraceMs: number;
  /** Pending one-shot for the anonymous fallback; armed on deferral, cancelled by kick()/shutdown(). */
  private fallbackTimer?: ReturnType<typeof setTimeout>;

  constructor(
    csfloat?: CsFloatService,
    identityProvider?: () => PricerIdentity[],
    opts?: { anonFallbackGraceMs?: number },
  ) {
    this.csfloat = csfloat;
    this.csfloatSource = csfloat ? new CsFloatPriceSource(csfloat) : undefined;
    this.identityProvider = identityProvider;
    this.anonFallbackGraceMs = opts?.anonFallbackGraceMs ?? ANON_FALLBACK_GRACE_MS;
  }

  /** The EFFECTIVE source: CSFloat only when selected and a key exists; else Steam (fallback). */
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
   *  new source; already-cached prices for that source serve instantly (cache is segmented). */
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
   * minutes, never served as a 24h "no price". */
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
   * null — S2) so the total silently undercounts them.
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
   *  DEFERRED for lack of an authenticated identity starts the moment the first session is web-ready.
   *  A login also CANCELS any pending anonymous-fallback timer — the authenticated fill is preferred. */
  kick(): void {
    if (this.fallbackTimer) { clearTimeout(this.fallbackTimer); this.fallbackTimer = undefined; }
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
  shutdown(): void {
    this.stopped = true;
    if (this.fallbackTimer) { clearTimeout(this.fallbackTimer); this.fallbackTimer = undefined; }
    this.cache.flush();
  }

  /**
   * The run splits by SOURCE. CSFloat jobs (keyed, off-Steam) drain through one lane on the shared
   * per-key limiter. Steam jobs ride up to MAX_PRICE_LANES authenticated identity lanes. If NO identity
   * is web-ready yet, the run DEFERS and arms a short grace timer (preferring an imminent login); only
   * when invoked as the fallback (`opts.allowAnonymous`, from the grace timer) does it run one anonymous
   * lane instead — safe post header-fix, since every price call carries the browser fingerprint.
   */
  private async run(opts?: { allowAnonymous?: boolean }): Promise<void> {
    this.running = true;
    this.fetchedThisRun = 0;
    this.processedThisRun = 0;
    try {
      const steamPending   = this.queue.some((j) => j.sourceId === 'steam');
      // CSFloat (keyed, off-Steam) warms the whole CS2 catalog in one request, then only stragglers need a
      // per-name lane. This is the highest-certainty unblock: it never touches Steam's exhausted anonymous budget.
      if (this.queue.some((j) => j.sourceId === 'csfloat') && this.csfloatSource) await this.csfloatBulkWarm();
      const csfloatPending = this.queue.some((j) => j.sourceId === 'csfloat'); // recompute: bulk warm pruned the fresh ones

      let identities: PricerIdentity[] = [];
      if (steamPending) {
        try { identities = this.identityProvider ? [...this.identityProvider()].slice(0, MAX_PRICE_LANES) : []; }
        catch (e) { logger.warn(`[pricing] identity provider failed (${(e as Error).message})`); }
      }

      // This run prices Steam names anonymously only when it IS the fallback (opts.allowAnonymous) and no
      // identity turned up in the meantime (a login during the grace would have won via kick()).
      const anonymous = steamPending && identities.length === 0 && !!opts?.allowAnonymous;

      // Steam names with NO authenticated identity (and this isn't already the anonymous run): they'll be
      // priced by the anonymous fallback after the grace. ARM it now — REGARDLESS of csfloat work, so a
      // mixed queue (CS2→csfloat + TF2→steam, logged out) doesn't leave the steam names with no lane and no
      // timer. kick() (a login) cancels the timer and prefers the authenticated fill. When there is NOTHING
      // else to do this run (no csfloat lane), DEFER — the timer is the only thing that will run.
      if (steamPending && identities.length === 0 && !anonymous) {
        this.armAnonymousFallback();
        if (!csfloatPending) {
          logger.info(`[pricing] fill deferred — no authenticated pricer identity web-ready yet (${this.queue.length} queued); ` +
            `starts on login, else an anonymous fallback fill in ~${Math.round(this.anonFallbackGraceMs / 1000)}s`);
          return;
        }
        // else: fall through to run the csfloat lane now; the steam names wait for the armed fallback.
      }

      const lanes: Array<Promise<void>> = [];
      // Authenticated identity lanes when we have them (preferred — spreads volume across the accounts'
      // proxies); otherwise one anonymous lane when this is the fallback run.
      const steamLaneCount = identities.length > 0 ? identities.length : (anonymous ? 1 : 0);
      // Report the EGRESS SPREAD, not just the lane count: "6 lanes" over one proxy and "6 lanes" over
      // six proxies are wildly different fills, and the difference is the single most useful number when
      // the operator asks why a fill is slow.
      const exits = new Set(identities.map((i) => i.egressKey)).size;
      const perMin = exits > 0 ? Math.round(exits * LANES_PER_EXIT * 60_000 / EXIT_BUDGET_MS) : 0;
      const steamLaneDesc = identities.length > 0
        ? `${identities.length} steam identity lane(s) over ${exits} distinct exit(s) → ~${perMin} names/min ` +
          `(each exit capped at ${LANES_PER_EXIT} lane(s))`
        : anonymous ? '1 anonymous steam lane (fallback)' : '0 steam lanes';
      logger.info(`[pricing] background fill started (${this.queue.length} queued, source=${this.getSource()}, ` +
        `${steamLaneDesc}${csfloatPending ? ` + ${CSFLOAT_LANES} csfloat lane` : ''})`);

      const steamStats: LaneStat[] = [];
      if (identities.length > 0) {
        for (const id of identities) {
          // Pace against the EXIT, not the lane: this lane gets its exit's budget divided by however
          // many lanes share that exit (see the pacing note at the top). The pool stamps exitLanes
          // from the final per-exit counts for THIS selection.
          const delayMs = laneDelayFor(id.exitLanes);
          const stat: LaneStat = { label: `steam:${id.username}${id.exitLanes > 1 ? `(1/${id.exitLanes} on its exit)` : ''}`, requests: 0, ok: 0, rl: 0, err: 0, consecutive429: 0, delayMs };
          steamStats.push(stat);
          const route: PriceRoute = { agent: id.agent, cookieHeader: id.cookieHeader };
          lanes.push(this.laneWorker('steam', (name, appid) => this.steamSource.fetchPriceCents(name, appid, route), stat));
        }
      } else if (anonymous) {
        // Fallback: NO route → egresses the host IP with the browser fingerprint (header fix). one lane only
        // (single IP — don't fan a large fill across the host IP). Same 429 → retire → soft-miss semantics.
        const stat: LaneStat = { label: 'steam:anonymous', requests: 0, ok: 0, rl: 0, err: 0, consecutive429: 0, delayMs: FETCH_DELAY_MS };
        steamStats.push(stat);
        lanes.push(this.laneWorker('steam', (name, appid) => this.steamSource.fetchPriceCents(name, appid), stat));
      }

      let csfloatStat: LaneStat | undefined;
      if (csfloatPending && this.csfloatSource) {
        // CSFloat is metered by CsFloatClient's own per-key RateLimiter, not by us — this lane must
        // not add a second, redundant 3.5s pause on top of it.
        csfloatStat = { label: 'csfloat', requests: 0, ok: 0, rl: 0, err: 0, consecutive429: 0, delayMs: 0 };
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
          logger.warn(`[pricing] Steam fill ABORTED — all ${steamLaneCount} lane(s) rate-limited; ` +
            `${abandoned} name(s) deferred as soft-miss (retry ~${Math.round(ERROR_MISS_TTL_MS / 60000)}min). ` +
            `Lanes: ${steamStats.map((s) => `${s.label}[${s.ok}✓/${s.rl}×429/${s.requests}req]`).join(' ')}`);
        }
      }
      for (const s of steamStats) if (s.requests > 0) logger.info(`[pricing] lane ${s.label}: ${s.ok} priced / ${s.rl} rate-limited / ${s.err} error / ${s.requests} req`);
      if (csfloatStat && csfloatStat.requests > 0) logger.info(`[pricing] lane ${csfloatStat.label}: ${csfloatStat.ok} priced / ${csfloatStat.rl} rate-limited / ${csfloatStat.err} error / ${csfloatStat.requests} req`);
    } finally {
      this.cache.flush();
      this.running = false;
      // Safety net: if this run left Steam names still queued with no identity (e.g. a csfloat-only run that
      // couldn't price them, or a kick() that landed mid-run and couldn't start), ensure the anonymous
      // fallback is armed so they are never stranded. Idempotent (armAnonymousFallback no-ops if already
      // armed); harmless after an authenticated/anonymous fill (those dequeue every steam job first).
      if (!this.stopped && this.queue.some((j) => j.sourceId === 'steam')) this.armAnonymousFallback();
      logger.info(`[pricing] background fill ${this.stopped ? 'STOPPED' : 'done'} (fetched=${this.fetchedThisRun}, cache=${this.cache.size()})`);
    }
  }

  /** Arm the anonymous-fallback grace timer if not already armed (idempotent). A login (kick) or teardown
   *  (shutdown) cancels it; the callback prices the deferred Steam names with one anonymous lane. */
  private armAnonymousFallback(): void {
    if (this.fallbackTimer || this.stopped) return;
    this.fallbackTimer = setTimeout(() => { this.fallbackTimer = undefined; this.runAnonymousFallback(); }, this.anonFallbackGraceMs);
    this.fallbackTimer.unref?.();
  }

  /** Grace-timer callback: with still no authenticated identity, run one anonymous fallback lane so a
   *  logged-out dashboard isn't left without valuations. If a fill is already in progress (a login-driven
   *  authenticated fill, OR an overlapping csfloat run), RE-ARM and retry after the grace instead of dropping
   *  the fallback — otherwise the deferred Steam names would be stranded. No-op when nothing steam-side
   *  remains. Safe post header-fix; run() re-checks identities and still prefers authenticated lanes. */
  private runAnonymousFallback(): void {
    if (this.stopped) return;
    if (!this.queue.some((j) => j.sourceId === 'steam')) return; // no steam work left to do
    if (this.running) { this.armAnonymousFallback(); return; }   // a fill is in flight — retry after the grace
    void this.run({ allowAnonymous: true });
  }

  /**
   * Hydrate the csfloat-namespaced cache from one bulk price-list request, then PRUNE every queued CSFloat
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
   * • other (transport/5xx/…) → cache a SHORT soft-miss, reset the streak (not a rate-limit signal).
   * Every terminal outcome bumps `processed` and clears the `queued` dedup entry.
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
          // surfaced as FETCH_FAILED) is not authoritative — cache a SHORT miss so it retries in minutes
          // and never survives restart as a fake "no price".
          stat.err++;
          stat.consecutive429 = 0;
          logger.warn(`[pricing] ${job.key}: ${(err as Error).message}`);
          this.cache.set(job.key, null, { soft: true });
        }
      }
      // Per-lane pace (see the pacing note at the top): a dedicated proxy exit runs faster than a
      // shared one, and CSFloat runs at 0 because CsFloatClient's own per-key limiter already paces it.
      if (!this.stopped && stat.delayMs > 0) await sleep(stat.delayMs);
    }
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => { setTimeout(r, ms); }); }
