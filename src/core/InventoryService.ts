import { AsyncLocalStorage } from 'async_hooks';
import { InventoryStore } from './InventoryStore';
import { InventoryManager } from './InventoryManager';
import { fetchListedItems } from './MarketListings';
import { bucketOf } from './MarketModel';
import type { SessionManager } from './SessionManager';
import type { AccountManager } from './AccountManager';
import { LocalIpThrottle } from '../network/LocalIpThrottle';
import { proxyHealth, proxyKey } from '../network/ProxyHealth';
import { SessionState, type ManagedSession } from '../types/session';
import type { AccountInventory, CS2Item, GameId } from '../types/inventory';
import { logger } from '../utils/logger';
import { dataDir } from '../utils/paths';
import { scaleConcurrency, clampConcurrency } from '../utils/concurrency';
import { classifyNetworkError } from '../utils/errorClass';

// Refresh concurrency scales DYNAMICALLY with the batch size (scaleConcurrency:
// 1 worker / 5 accounts, floor 5, ceiling 25) so 500 accounts run ~25-wide instead of a
// static 5. CS2's per-account fetch is the full pure-web one (a few sequential requests
// on the account's own IP / the local-IP throttle), so no special low cap is needed.

// ── Local-IP (no-proxy) rate limiting ───────────────────────────────────────────
// Every no-proxy account egresses from the SAME host IP, so a bulk refresh that
// fetches them concurrently hammers Steam from one IP and trips the per-IP rate
// limit (HTTP 429) fast. The LocalIpThrottle serializes
// these accounts and spaces their fetches by a randomized cooldown; proxied accounts
// (own exit IP each) stay fully concurrent. The window is env-tunable.
const LOCALIP_MIN_DELAY_MS = parseDelayEnv(process.env.SSIM_LOCALIP_MIN_MS,  6_000);
const LOCALIP_MAX_DELAY_MS = parseDelayEnv(process.env.SSIM_LOCALIP_MAX_MS, 12_000);

/** Parses a non-negative integer ms delay from env, falling back when unset/invalid. */
function parseDelayEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

// ── Refresh resilience ────────────────────────────────────────────────────────
// A refresh should not fail because of a single transient hiccup. Rate limits
// and network/proxy blips are retried with a pause before the account is
// reported as failed; genuine errors (private inventory, missing maFile, auth)
// fail immediately. 429 gets a LONG pause – Steam's per-IP window must elapse.
const REFRESH_RETRIES        = 2;
const RETRY_PAUSE_RATELIMIT  = 35_000;
const RETRY_PAUSE_TRANSIENT  = 8_000;

// H-XCT-003: ctx2 and ctx16 are read from the SAME Steam per-IP endpoint, so they share ONE
// rate-limit window. A per-account ThrottleState carries the moment ctx2's last 35s rate-limit
// wait ended; if ctx16 hits the identical window ctx2 just waited out, it serves only the
// REMAINDER of that window instead of a fresh full 35s — halving the ~140s worst-case per account.
// It is per-invocation (allocated in doRefreshOneViaGc), NEVER shared across accounts.
interface ThrottleState { lastRateLimitWaitEndedAt?: number; }

// H-XCT-001: both verdicts now come from the ONE shared taxonomy (src/utils/errorClass)
// so a broken-pipe/aborted-connection blip is classified identically on refresh, sell,
// and the money-commit path. The per-bucket ACTION (long 429 pause vs short transient
// pause, retry-vs-fail) below is unchanged.
function isRateLimited(err: unknown): boolean {
  return classifyNetworkError(err).rateLimited;
}

function isTransientRefreshError(err: unknown): boolean {
  return classifyNetworkError(err).transient;
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// ── Bulk-refresh session release (anti-accumulation) ──────────────────────────
// A full-fleet refresh logs every account in to read its inventory. If those sessions
// are LEFT live, a 500+ account refresh ends with 500+ resident Steam clients + proxy
// socket pools + polling trade-managers all at once — the resource load that silently
// kills the process. With release ON (default), the bulk refresh logs out each account
// IT logged in, right after caching that account's inventory, so live sessions stay
// bounded to ~the worker count during the pass and return to the pre-refresh baseline
// after. Accounts that were ALREADY live before the refresh (e.g. one the user is
// trading with) are snapshotted and never touched. The inventory is cached before
// logout, so nothing is lost; any later action re-logs the account in on demand.
// Set SSIM_REFRESH_RELEASE_SESSIONS=0 to keep the old "stay logged in" behaviour.
const REFRESH_RELEASE_SESSIONS = process.env.SSIM_REFRESH_RELEASE_SESSIONS !== '0';

export interface RefreshJob {
  running:     boolean;
  /** Operator pressed "End Task" — the run is winding down (remaining accounts skipped). */
  cancelling?: boolean;
  /** The run ended because it was cancelled. */
  cancelled?:  boolean;
  /** The game TAB the job was started from (labels the run; the bulk refresh now fetches BOTH
   *  games per account on the same login/throttle slot). */
  game?:       GameId;
  total:       number;
  done:        number;
  failed:      Array<{ username: string; error: string }>;
  startedAt?:  string;
  finishedAt?: string;
}

/**
 * Owns the persistent inventory cache and orchestrates (re)fetching with a
 * concurrency cap so we never hammer Steam with hundreds of parallel logins.
 *
 * Trade-lock policy (deliberately simple & trustworthy): an item is marked
 * locked ONLY when Steam's own inventory API says so – i.e. its `tradable` flag
 * is 0 or it carries an explicit hold date (cache_expiration / "Tradable After"),
 * both parsed in InventoryManager. SSIM does NOT guess locks from trade history
 * or snapshot diffs anymore (those produced false positives on freely-tradable
 * items). The only non-API source is the per-account MANUAL `protectedUntil`
 * override the operator sets by hand, applied at read-time in the API layer.
 */
export class InventoryService {
  /** CS2 inventory cache from the WEB endpoint (legacy name kept – primary game). */
  readonly store = new InventoryStore();
  /** TF2 inventory cache – separate file so the CS2 records stay untouched. */
  readonly tf2Store = new InventoryStore(dataDir('inventories_tf2.json'));
  /**
   * CS2 FULL-refresh cache: the COMPLETE pure-web record (context 2 + context 16
   * + market listings, one bucket per asset). Kept in a separate file so the quick
   * ctx2-only record (`store`, written by forceRefresh/buy-verify) and this complete
   * record never overwrite each other; CS2 reads PREFER this record and fall back to
   * `store` otherwise. The `inventories_gc.json` filename and `source: 'gc'` are legacy
   * markers kept for cache/dashboard compatibility – the GC stack is retired (DIRECTIVES.md #3).
   */
  readonly gcStore = new InventoryStore(dataDir('inventories_gc.json'));
  private job: RefreshJob = { running: false, total: 0, done: 0, failed: [] };
  /** Co-operative cancel flag for the live bulk refresh (set by cancelRefresh()). */
  private refreshCancel = false;
  /** H-INV-007: post-trade refresh passes in flight. `refreshAfterTrade` sets no job flag and its
   *  local-IP accounts sit in the LocalIpThrottle queue with NOTHING in `inFlight`, so busy() was
   *  blind to them and the update swap gate (C5) could fire mid-pass. Counted so busy() sees them. */
  private bgRefreshPasses = 0;
  private onCompleteCb?: (reason: string, game?: GameId) => void;
  /** Serializes + spaces out fetches for no-proxy (local IP) accounts (rate-limit guard). */
  private readonly localIpThrottle = new LocalIpThrottle(LOCALIP_MIN_DELAY_MS, LOCALIP_MAX_DELAY_MS);

  constructor(
    private readonly sessions: SessionManager,
    private readonly accounts: AccountManager,
  ) {}

  /** The cache for a given game. */
  storeFor(game: GameId): InventoryStore {
    return game === 'tf2' ? this.tf2Store : this.store;
  }

  /**
   * Registers a callback fired after a refresh pass settles (refresh-all job
   * done / post-trade refetch). Used to take a value-history snapshot –
   * "one point per refresh" for the dashboard's worth/wallet curve.
   */
  onRefreshComplete(cb: (reason: string, game?: GameId) => void): void {
    this.onCompleteCb = cb;
  }

  // ── Cache reads ──────────────────────────────────────────────────────────────

  getCached(username: string, game: GameId = 'cs2'): AccountInventory | undefined {
    // CS2 reads prefer the richer GC record (complete: owned + locked + listed);
    // fall back to the web record. TF2 is unaffected.
    if (game === 'cs2') return this.gcStore.get(username) ?? this.store.get(username);
    return this.storeFor(game).get(username);
  }

  /**
   * Clone-free read for AGGREGATION only (H-INV-023) — mirrors getCached's gc-preferred
   * fallback but via InventoryStore.peek (no structuredClone, no LRU touch). The value-history
   * snapshot only sums two numbers per account, so cloning the whole fleet's records per snapshot
   * is pure event-loop stall. The caller MUST treat the result as read-only (INV-B12).
   */
  peekCached(username: string, game: GameId = 'cs2'): Readonly<AccountInventory> | undefined {
    if (game === 'cs2') return this.gcStore.peek(username) ?? this.store.peek(username);
    return this.storeFor(game).peek(username);
  }

  /**
   * The whole CS2 cache as the dashboard should see it: every account's GC record
   * if present, else its web record. GC overrides web (richer), so no account
   * appears twice and GC-exclusive data (listed items) survives a web refresh-all.
   */
  allCs2(): Record<string, AccountInventory> {
    const merged: Record<string, AccountInventory> = { ...this.store.all() };
    for (const [user, inv] of Object.entries(this.gcStore.all())) merged[user] = inv;
    return merged;
  }

  // ── Single refresh ───────────────────────────────────────────────────────────

  /** In-flight dedup: concurrent refreshes of the SAME account+game (e.g. a
   *  manual refresh while refresh-all is running) would race their logins and
   *  kill each other's session – share one promise per account instead. */
  private readonly inFlight = new Map<string, Promise<AccountInventory>>();

  /** S25: PER-INVOCATION ownership context — did THIS refresh's ensureSession create the live session
   *  (true) or reuse one another op owns (false)? Was a service-level Map keyed by ACCOUNT, which two
   *  concurrent flows on the same account (a fleet refresh + a post-trade refresh) clobbered — one could
   *  log the shared session out mid-fetch, or neither release it (leaked to the reaper). AsyncLocalStorage
   *  scopes ownership to each per-account refresh call instead, so concurrent flows never collide. Each
   *  worker runs its refresh inside `ownershipCtx.run(store, …)` and reads its OWN `store` for release. */
  private readonly ownershipCtx = new AsyncLocalStorage<{ createdByCall?: boolean }>();

  refreshOne(username: string, game: GameId = 'cs2'): Promise<AccountInventory> {
    // CS2 has ONE refresh and it is the COMPLETE one: the full pure-web fetch
    // (context 2 + 16 + market listings, fully categorised). The quick single-context
    // fetch (doRefreshOne) now serves only TF2 and the buy-verification path
    // (forceRefresh), where a context-2 read is exactly what's needed and must stay fast.
    if (game === 'cs2') return this.refreshOneViaGc(username);
    const key = `${game}:${username.toLowerCase()}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const p = this.doRefreshOne(username, game).finally(() => {
      if (this.inFlight.get(key) === p) this.inFlight.delete(key);
    });
    this.inFlight.set(key, p);
    return p;
  }

  /**
   * Like refreshOne, but GUARANTEES a fresh fetch that starts NOW (bypasses the
   * in-flight dedup). The buy-verification before/after diff must not reuse a
   * snapshot whose underlying fetch began before the order was placed, or it would
   * under-count fills. Same-key (quick-path) callers coalesce onto this fresh fetch;
   * the CS2 full refresh uses its own `gc:` key and deliberately never coalesces with
   * a quick ctx2 read (it must not return a ctx2-only result).
   */
  forceRefresh(username: string, game: GameId = 'cs2'): Promise<AccountInventory> {
    const key = `${game}:${username.toLowerCase()}`;
    const p = this.doRefreshOne(username, game).finally(() => {
      if (this.inFlight.get(key) === p) this.inFlight.delete(key);
    });
    this.inFlight.set(key, p);
    return p;
  }

  // ── CS2 full refresh (the single CS2 refresh: context 2 + 16 + market listings) ──

  /**
   * THE CS2 refresh: assembles an account's COMPLETE inventory from PURE WEB requests
   * — context 2 (owned + market-bought holds) + context 16 (trade-received trade-locked
   * + listed) + the market listings — fully categorised (listed / tradelocked / tradable).
   * No Game Coordinator / game-client connection. Stored in its own cache (source='gc', a
   * legacy marker kept so the dashboard's category logic is unchanged). Deduped against a
   * concurrent refresh of the account. (Method name 'refreshOneViaGc' is legacy — there is
   * no GC anymore; it is reached by refreshOne() for every CS2 account.)
   */
  refreshOneViaGc(username: string): Promise<AccountInventory> {
    const key = `gc:${username.toLowerCase()}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const p = this.doRefreshOneViaGc(username).finally(() => {
      if (this.inFlight.get(key) === p) this.inFlight.delete(key);
    });
    this.inFlight.set(key, p);
    return p;
  }

  /**
   * S50 / H-TRD-123: run ONE leg of a refresh under the SAME bounded transient/429 retry the TF2 & quick
   * paths already have (see the fetchInventoryOnly loop below). Without it a single 429/proxy blip on a
   * leg threw straight out and failed the whole account for the pass → inflated `failed` counts at fleet
   * scale. A non-transient error (auth, private inventory) still throws immediately. `label` names the leg
   * in the warn line; retries are sequential inside the account's existing refresh slot (no concurrency raise).
   */
  private async retrying<T>(op: () => Promise<T>, label: string, username: string, throttle?: ThrottleState): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= REFRESH_RETRIES; attempt++) {
      try {
        return await op();
      } catch (err) {
        lastErr = err;
        const rateLimited = isRateLimited(err);
        if (attempt >= REFRESH_RETRIES || (!rateLimited && !isTransientRefreshError(err))) throw err;
        let pause = rateLimited ? RETRY_PAUSE_RATELIMIT : RETRY_PAUSE_TRANSIENT;
        // H-XCT-003: ctx2 and ctx16 share ONE per-IP window. If a sibling context just waited a
        // full RETRY_PAUSE_RATELIMIT moments ago, that window is still fresh, so this context need
        // wait only the time that has ELAPSED since — ≈0 right after the sibling's wait, decaying
        // back to the full window as that credit ages out. Never a duplicate fresh 35s.
        if (rateLimited && throttle?.lastRateLimitWaitEndedAt !== undefined) {
          pause = Math.max(0, Math.min(pause, Date.now() - throttle.lastRateLimitWaitEndedAt));
        } else if (!rateLimited) {
          // TANK: full-jitter the TRANSIENT (reset-class) backoff so a fleet's worth of proxied
          // accounts failing the same storming proxy in the same tick don't retry in lockstep and
          // reconcentrate the TLS create/destroy churn. Decorrelated to [50%,100%]. NOT applied to the
          // RATELIMIT branch — that must never drop below Steam's per-IP 429 window (H-XCT-003 intact).
          pause = Math.round(pause * (0.5 + Math.random() * 0.5));
        }
        logger.warn(
          `[${username}] ${label} attempt ${attempt + 1}/${REFRESH_RETRIES + 1} failed ` +
          `(${(err as Error).message}) – retrying in ${Math.round(pause / 1000)}s`,
        );
        await this.pause(pause);
        if (rateLimited && throttle) throttle.lastRateLimitWaitEndedAt = Date.now();
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** S50: fetch ONE CS2 web-inventory context under the shared retry policy (see `retrying`).
   *  H-XCT-003: `throttle` is shared across an account's ctx2/ctx16 fetches so ctx16 does not
   *  re-serve a per-IP rate-limit window ctx2 already waited out. */
  private fetchRawRetrying(
    session: ManagedSession, ctx: number, username: string, throttle?: ThrottleState,
  ): Promise<Awaited<ReturnType<typeof InventoryManager.fetchRaw>>> {
    return this.retrying(() => InventoryManager.fetchRaw(session, 'cs2', ctx), `cs2 ctx${ctx} fetch`, username, throttle);
  }

  /** The bounded-backoff wait between retry attempts — a seam so tests can exercise the retry path
   *  without waiting real seconds. */
  protected pause(ms: number): Promise<void> { return sleep(ms); }

  private async doRefreshOneViaGc(username: string): Promise<AccountInventory> {
    const session = await this.ensureSession(username);

    const steamId = String(session.steamId ?? '');

    // 1) Market listings FIRST. Their asset ids are excluded below so a listed item is
    //    NEVER also counted as owned/locked (one asset = one bucket). Best-effort —
    //    `listingsOk` tracks whether the fetch SUCCEEDED so a transient hiccup is never
    //    mistaken for "no listings" (which would wipe the listed bucket from the cache).
    let listed: CS2Item[] = [];
    let listedAssetIds = new Set<string>();
    let listingsOk = true;
    let listedTruncated = false;
    try {
      // H-TRD-123: the listings leg gets the SAME bounded transient/429 retry as the ctx2/ctx16
      // fetches (S50) so one proxy/429 blip no longer leaves a stale listed bucket for the pass.
      // Read-only re-reads (≤MAX_PAGES GETs); non-transient errors still fail fast into the catch.
      const fetched = await this.retrying(() => fetchListedItems(session), 'mylistings', username);
      listed = InventoryManager.stack(fetched.items);
      // Canonical dedup superset from the single parser (includes metadata-less and
      // pending listings) — strictly ⊇ the displayed rows, so nothing on the market
      // can leak back into the Owned/locked bucket.
      listedAssetIds = fetched.assetIds;
      listedTruncated = fetched.truncated; // MAX_PAGES cap exhausted → listed bucket INCOMPLETE (C12)
    } catch (err) {
      listingsOk = false;
      logger.warn(`[${username}] market-listings fetch failed (listed bucket unread this pass): ${(err as Error).message}`);
    }

    // 2) The complete inventory from PURE WEB (no Game Coordinator): context 2 holds
    //    owned + market-bought holds; context 16 holds trade-received trade-locked AND
    //    currently-listed items. Names + exact unlock dates come straight from Steam's
    //    own descriptions (owner_descriptions "Tradable/Marketable After …"), so no
    //    schema resolver and no game-client connection are needed.
    // H-XCT-003: ctx2 and ctx16 share ONE per-IP rate-limit window; this per-account marker lets
    // ctx16 serve only the REMAINDER of a window ctx2 already waited out (not a fresh full 35s).
    const throttle: ThrottleState = {};
    let raw2  = await this.fetchRawRetrying(session, 2, username, throttle);  // S50: bounded transient/429 retry
    let raw16 = await this.fetchRawRetrying(session, 16, username, throttle);
    let ctx2  = InventoryManager.parse(raw2,  steamId, 'cs2');
    let ctx16 = InventoryManager.parse(raw16, steamId, 'cs2');

    // H-INV-005: Steam's OWN total is the empty/partial disambiguator. A strict 0 on BOTH
    // contexts means the account is AUTHORITATIVELY empty (converge the cache); an ABSENT
    // field (undefined) keeps full protection. fetchRaw now returns undefined when the field
    // was omitted, so `=== 0` never fires on an unknown read.
    let authoritativeEmpty = raw2.total_inventory_count === 0 && raw16.total_inventory_count === 0;

    // Genuine retry on a suspicious empty read: if BOTH inventory contexts came back
    // with zero assets while the cache holds owned/locked items, Steam very likely served
    // a partial/empty page (total_inventory_count disagreeing with reality). Give it ONE
    // more chance before we trust the empty read — far better than accepting the first bad
    // page and then having the partial-read path kick in. (One re-fetch, bounded.)
    // Skip entirely when Steam already DECLARED the account empty (authoritativeEmpty): there
    // is nothing to re-read, and re-reading would only burn two full-context fetches + 2s.
    if (ctx2.length + ctx16.length === 0 && !authoritativeEmpty) {
      const cached = this.gcStore.get(username);
      const cachedOwned = cached ? cached.items.some(i => i.category !== 'listed') : false;
      if (cachedOwned) {
        logger.warn(`[${username}] inventory contexts returned 0 assets while cache holds items – retrying inventory read once`);
        await sleep(2_000);
        // H-INV-004: the confirmation re-read gets the SAME bounded transient/429 retry as the
        // primary fetches (S50) — a single blip here (likely mid-429-storm) no longer fails the
        // whole account for the pass; a non-transient error still throws immediately.
        raw2  = await this.fetchRawRetrying(session, 2, username);
        raw16 = await this.fetchRawRetrying(session, 16, username);
        ctx2  = InventoryManager.parse(raw2,  steamId, 'cs2');
        ctx16 = InventoryManager.parse(raw16, steamId, 'cs2');
        authoritativeEmpty = raw2.total_inventory_count === 0 && raw16.total_inventory_count === 0;
      }
    }

    // 3) Combine, drop anything that's on the market (dedup by asset id), then stack +
    //    categorise: a future trade-lock → 'tradelocked', otherwise → 'tradable'.
    const now = Date.now();
    const ownedLockedRaw = [...ctx2, ...ctx16].filter(i => !listedAssetIds.has(i.assetId));
    const gcOwnedLockedCount = ownedLockedRaw.length; // owned+locked count, BEFORE listed are merged in
    const partial = !!(raw2.truncated || raw16.truncated || listedTruncated); // page-capped read → INCOMPLETE (C12)
    const inv: AccountInventory = {
      username, steamId, game: 'cs2', source: 'gc',
      items:      InventoryManager.stack(ownedLockedRaw),
      totalItems: gcOwnedLockedCount,
      fetchedAt:  new Date(),
      partial,
    };
    for (const it of inv.items) {
      it.category = bucketOf(it, now);
    }

    // 4) The listed stacks form the 3rd bucket. When the listings fetch FAILED this pass
    //    (listingsOk=false), carry the previously-cached listed bucket forward instead of
    //    writing an empty one — a transient market-endpoint hiccup must never silently drop
    //    listed items (the 31-listed-but-24-shown / Locked↔Tradable instability).
    if (listed.length) {
      inv.items.push(...listed);
      inv.totalItems += listed.reduce((n, i) => n + i.quantity, 0);
    } else if (!listingsOk) {
      const prevListed = this.gcStore.get(username)?.items.filter(i => i.category === 'listed') ?? [];
      if (prevListed.length) {
        inv.items.push(...prevListed);
        inv.totalItems += prevListed.reduce((n, i) => n + (i.quantity || 0), 0);
        logger.warn(`[${username}] market listings unread this pass – kept ${prevListed.length} cached listed stack(s) (no wipe)`);
      }
    }

    // Attach the wallet whenever the 'wallet' event fired — INCLUDING accounts with NO Steam
    // wallet (hasWallet=false → balance 0). A refreshed account is then always shown as a real
    // number (0 when empty); only a NEVER-refreshed account stays "—".
    if (session.wallet) {
      inv.wallet = {
        currency: session.wallet.currency,
        balance:  session.wallet.hasWallet ? session.wallet.balance : 0,
      };
    } else {
      // S41: the 'wallet' event can fire AFTER this refresh commits (a login whose inventory read
      // finishes before the wallet arrives). Writing the new record with no wallet would flip a
      // previously-funded account back to the "—" tri-state on every such pass. Carry the last-known
      // wallet forward instead — a real balance is only ever replaced by a newer real balance.
      const prevWallet = this.getCached(username, 'cs2')?.wallet;
      if (prevWallet) inv.wallet = prevWallet;
    }

    // #10 money-safety: a partial inventory read can return an EMPTY backpack for an account
    // that actually holds items. NEVER let that wipe a known-non-empty cache — the operator
    // gates trade/sell decisions on this cache. BUT the protection must RECONCILE, not FREEZE:
    // the old guard returned the pre-refresh record verbatim, so an account that had just
    // listed/sold items kept showing them as Owned forever (every refresh re-tripped it).
    //
    // The fix turns on telling two zeros apart:
    //   • rawCount === 0  → the inventory contexts returned NOTHING (a true empty/partial
    //     read). Protect the cached owned/locked set, but still reconcile the AUTHORITATIVE
    //     `mylistings` set into it (Owned→Listed) so just-listed items don't freeze as Owned.
    //   • rawCount  >  0  → the read succeeded; owned/locked is 0 only because EVERYTHING the
    //     account holds is now listed/sold. That is the TRUTH and MUST overwrite the cache.
    // (`gcOwnedLockedCount` = ctx2+ctx16 AFTER removing listed; `rawCount` = before removing.)
    //   • authoritativeEmpty (H-INV-005) → Steam ITSELF reported total_inventory_count:0 on BOTH
    //     contexts; the account is genuinely empty (traded/consolidated away). Fall through to the
    //     normal commit so the cache CONVERGES to empty instead of freezing phantom items forever.
    const rawCount = ctx2.length + ctx16.length;
    if (rawCount === 0 && authoritativeEmpty) {
      logger.info(`[${username}] inventory authoritatively empty (total_inventory_count=0 on both contexts) – committing empty`);
    }
    if (rawCount === 0 && !authoritativeEmpty) {
      const prev = this.gcStore.get(username);
      const prevOwnedLocked = prev
        ? prev.items.filter(i => i.category !== 'listed').reduce((n, i) => n + (i.quantity || 0), 0)
        : 0;
      if (prevOwnedLocked > 0) {
        logger.warn(`[${username}] inventory contexts returned 0 assets but cache holds ${prevOwnedLocked} owned/locked – reconciling listings into cache (suspected partial read)`);
        return this.reconcilePartialRead(username, prev!, listed, listedAssetIds, listingsOk, inv.wallet);
      }
    }

    // A TRUNCATED (page-capped) read is PARTIAL, not authoritative. If the cache already
    // holds MORE owned/locked than this partial read returned, do not let the smaller set
    // clobber it — keep the fuller cache and only reconcile listings (same protection as an
    // empty read, but for the "too-big-to-page" case). (C12 / INV-B10.)
    if (partial) {
      const prev = this.gcStore.get(username);
      const prevOwnedLocked = prev
        ? prev.items.filter(i => i.category !== 'listed').reduce((n, i) => n + (i.quantity || 0), 0)
        : 0;
      if (prevOwnedLocked > gcOwnedLockedCount) {
        logger.warn(`[${username}] inventory read TRUNCATED at the page cap and cache holds more (${prevOwnedLocked} > ${gcOwnedLockedCount}) – keeping fuller cache, reconciling listings`);
        return this.reconcilePartialRead(username, prev!, listed, listedAssetIds, listingsOk, inv.wallet);
      }
    }

    this.gcStore.set(username, inv); // separate cache – never clobbers the web record
    const locked = inv.items.filter(i => i.category === 'tradelocked').length;
    const listedN = inv.items.filter(i => i.category === 'listed').length;
    logger.info(`[${username}] full inventory refreshed (${inv.totalItems} items · ${locked} locked stacks · ${listedN} listed stacks) → cache`);
    // Return an independent copy (see InventoryStore.get clone note): the API enriches
    // the result in place and must not write back into the cache it was just stored in.
    return this.gcStore.get(username) ?? inv;
  }

  /**
   * Suspected-partial-read reconciliation (replaces the old "freeze the stale cache").
   * The inventory contexts came back empty while the cache holds items, so we KEEP the
   * cached owned/locked set (data-loss protection) — but we still trust the AUTHORITATIVE
   * `mylistings` read: any cached asset now in `listedAssetIds` is moved Owned→Listed, and
   * the listed bucket is replaced with the freshly-fetched listings. This is what stops a
   * just-listed item from being frozen as Owned across refreshes. If the listings fetch
   * ALSO failed this pass (`listingsOk=false`), the cached listed bucket is kept untouched
   * (we never wipe listed items on a double miss).
   */
  private reconcilePartialRead(
    username: string,
    prev: AccountInventory,
    listed: CS2Item[],
    listedAssetIds: Set<string>,
    listingsOk: boolean,
    wallet: AccountInventory['wallet'] | undefined,
  ): AccountInventory {
    const now = Date.now();

    // Cached owned/locked, minus any asset that authoritative `mylistings` now reports as
    // listed (those leave the Owned bucket). Re-derive each surviving stack's category from
    // its own lock state so classification stays deterministic.
    const ownedLocked = prev.items
      .filter(i => i.category !== 'listed')
      .map((i) => {
        const remaining = i.assetIds.filter(id => !listedAssetIds.has(String(id)));
        return { ...i, assetIds: remaining, quantity: remaining.length };
      })
      .filter(i => i.quantity > 0);
    for (const it of ownedLocked) {
      it.category = bucketOf(it, now);
    }

    // Listed bucket: authoritative fresh listings when the fetch succeeded; otherwise keep
    // whatever the cache already had (don't drop listings on a double miss).
    const listedBucket = listingsOk ? listed : prev.items.filter(i => i.category === 'listed');

    const inv: AccountInventory = {
      ...prev,
      username,
      game:       'cs2',
      source:     'gc',
      fetchedAt:  new Date(),
      items:      [...ownedLocked, ...listedBucket],
      totalItems: ownedLocked.reduce((n, i) => n + i.quantity, 0)
                + listedBucket.reduce((n, i) => n + (i.quantity || 0), 0),
    };
    // H-INV-006: the `{...prev}` spread carried `prev.wallet` forward; when this pass captured a
    // fresher wallet (live 'wallet' event, else S41 carry) commit THAT instead so a protected read
    // no longer persists a stale balance stamped as fresh. No wallet this pass → keep the spread
    // fallback (never fabricate 0). (Directive 2 tri-state.)
    if (wallet) inv.wallet = wallet;
    this.gcStore.set(username, inv);
    const movedToListed = listingsOk
      ? prev.items.filter(i => i.category !== 'listed').reduce((n, i) => n + i.assetIds.filter(id => listedAssetIds.has(String(id))).length, 0)
      : 0;
    logger.info(`[${username}] partial-read reconciled: kept ${inv.totalItems - listedBucket.reduce((n, i) => n + (i.quantity || 0), 0)} owned/locked, ${listedBucket.length} listed stack(s)${movedToListed ? ` (moved ${movedToListed} Owned→Listed)` : ''}`);
    return this.gcStore.get(username) ?? inv;
  }

  /**
   * Optimistic post-mass-sell cache update: moves the given assets Owned→Listed in the CS2
   * cache IMMEDIATELY after their listings are created/confirmed, so the panel reflects the
   * sale at once instead of waiting for (and depending on) a clean follow-up refresh. The
   * next reconciled refresh verifies this against the live `mylistings` set. Idempotent —
   * assets already in the listed bucket (or not found owned) are skipped. Best-effort: any
   * failure is swallowed so it can never break the mass-sell.
   */
  markListed(username: string, assetIds: string[], game: GameId = 'cs2'): void {
    try {
      if (!assetIds.length) return;
      // Write into the SAME cache the game's reads come from: CS2's complete record lives in gcStore,
      // TF2's in tf2Store. Using the wrong store would leave sold TF2 items stuck under "Owned".
      const store = game === 'cs2' ? this.gcStore : this.tf2Store;
      const rec = store.get(username);
      if (!rec) return; // no cache yet → the next refresh will populate it correctly

      const toList = new Set(assetIds.map(String));
      const ownedStacks  = rec.items.filter(i => i.category !== 'listed');
      const listedStacks = rec.items.filter(i => i.category === 'listed');
      const alreadyListed = new Set(listedStacks.flatMap(i => i.assetIds.map(String)));

      const newlyListed: CS2Item[] = [];
      for (const stack of ownedStacks) {
        const moving = stack.assetIds.filter(id => toList.has(String(id)) && !alreadyListed.has(String(id)));
        if (!moving.length) continue;
        stack.assetIds = stack.assetIds.filter(id => !toList.has(String(id)));
        stack.quantity = stack.assetIds.length;
        for (const id of moving) {
          newlyListed.push({ ...stack, category: 'listed', tradable: false, tradeLockExpiry: null, quantity: 1, assetIds: [id] });
        }
      }
      if (!newlyListed.length) return; // nothing actually moved (already reflected)

      const remainingOwned = ownedStacks.filter(s => s.quantity > 0);
      // Re-stack the listed bucket by name. stack() consumes single items, so explode the
      // existing listed stacks back to singles first (passing a quantity>1 stack would
      // mis-count it as a single item).
      const explode = (arr: CS2Item[]): CS2Item[] =>
        arr.flatMap(s => s.assetIds.map(id => ({ ...s, quantity: 1, assetIds: [id] })));
      const mergedListed = InventoryManager.stack([...explode(listedStacks), ...newlyListed]);

      const inv: AccountInventory = {
        ...rec,
        source:     rec.source, // preserve the record's own source (CS2 'gc' / TF2 web) — game-agnostic
        fetchedAt:  new Date(),
        items:      [...remainingOwned, ...mergedListed],
        totalItems: remainingOwned.reduce((n, i) => n + i.quantity, 0)
                  + mergedListed.reduce((n, i) => n + (i.quantity || 0), 0),
      };
      store.set(username, inv);
      logger.info(`[${username}] optimistic cache update: moved ${newlyListed.length} item(s) Owned→Listed after mass-sell`);
    } catch (err) {
      logger.warn(`[${username}] optimistic post-sell cache update failed (next refresh will reconcile): ${(err as Error).message}`);
    }
  }

  private async doRefreshOne(username: string, game: GameId): Promise<AccountInventory> {
    const session = await this.ensureSession(username);

    // Fetch + parse + stack, with a retry layer for TRANSIENT failures (429 /
    // proxy blips) so a momentary hiccup doesn't mark the account as failed.
    // Trade-locks come straight from Steam's inventory flags – no guessing.
    let inv: AccountInventory | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= REFRESH_RETRIES; attempt++) {
      try {
        inv = await InventoryManager.fetchInventoryOnly(session, game);
        break;
      } catch (err) {
        lastErr = err;
        const rateLimited = isRateLimited(err);
        if (attempt >= REFRESH_RETRIES || (!rateLimited && !isTransientRefreshError(err))) throw err;
        const pause = rateLimited ? RETRY_PAUSE_RATELIMIT : RETRY_PAUSE_TRANSIENT;
        logger.warn(
          `[${username}] inventory fetch attempt ${attempt + 1}/${REFRESH_RETRIES + 1} failed ` +
          `(${(err as Error).message}) – retrying in ${Math.round(pause / 1000)}s`,
        );
        await sleep(pause);
      }
    }
    if (!inv) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));

    // Persist the Steam wallet balance (needs a live session, so capture it here).
    // Attach the wallet whenever the 'wallet' event fired — INCLUDING accounts with NO Steam
    // wallet (hasWallet=false → balance 0). A refreshed account is then always shown as a real
    // number (0 when empty); only a NEVER-refreshed account stays "—".
    if (session.wallet) {
      inv.wallet = {
        currency: session.wallet.currency,
        balance:  session.wallet.hasWallet ? session.wallet.balance : 0,
      };
    } else {
      // S41 (parity with the GC path): don't drop a previously-known wallet when the 'wallet' event
      // hasn't fired on this pass — carry the last-known balance forward to avoid the funded→"—" flicker.
      const prevWallet = this.getCached(username, game)?.wallet;
      if (prevWallet) inv.wallet = prevWallet;
    }

    // Empty / partial-read protection (B31 — parity with the CS2 path's #10/C12 guards, which
    // this TF2 + forceRefresh path lacked). A transient bad page can return an EMPTY or page-cap
    // TRUNCATED (smaller) inventory for an account that actually holds items; letting that WIPE a
    // known-non-empty cache is data loss the operator gates send/sell on — and a wiped cache
    // silently disables the send-side trade-lock guard (filterSendable passes an asset through
    // when it has no cached stack). Keep the fuller cache; the next good read overwrites it.
    const prev = this.storeFor(game).get(username);
    const prevCount = prev ? prev.items.reduce((n, i) => n + (i.quantity || 0), 0) : 0;
    // H-INV-005: an EXPLICIT reportedTotal:0 means Steam itself declared the account empty →
    // commit the empty read so a genuinely-emptied account converges (not suspect). An absent
    // reportedTotal (undefined) keeps full protection.
    const suspectEmpty     = inv.totalItems === 0 && prevCount > 0 && inv.reportedTotal !== 0;
    const suspectTruncated = !!inv.partial && prevCount > inv.totalItems;
    if (suspectEmpty || suspectTruncated) {
      logger.warn(`[${username}] ${game} refresh returned ${inv.totalItems} item(s) (${suspectEmpty ? 'empty' : 'page-cap truncated'}) while cache holds ${prevCount} – keeping fuller cache (suspected partial read), NOT wiping`);
      // H-TRD-041: mark the substituted clone so fresh-read-dependent consumers (buy verification)
      // treat it as a FAILED fresh read, not the pre-buy snapshot. `prev` is already an independent
      // deep copy (InventoryStore.get clones), so stamping it never touches the cache.
      const fallbackClone = prev!;
      fallbackClone.staleReadFallback = true;
      // H-INV-006: a protected pass must still commit a fresher wallet (live 'wallet' event, else
      // S41 carry) — otherwise a balance that changed since the last good read stays stale forever
      // (the H-INV-005 freeze compounds this: reconcile every pass → wallet never updates). Show it
      // on the returned record; persist it onto the cached record too WITHOUT re-stamping fetchedAt
      // (item data is old) and WITHOUT the read-only staleReadFallback flag (H-TRD-041 never
      // persists that). `set`'s newest-wins guard passes on the equal timestamp. (Directive 2.)
      if (inv.wallet) {
        fallbackClone.wallet = inv.wallet;
        const stored = this.storeFor(game).get(username);
        if (stored) { stored.wallet = inv.wallet; this.storeFor(game).set(username, stored); }
      }
      return fallbackClone;
    }

    this.storeFor(game).set(username, inv);
    const lockedStacks = inv.items.filter(i => i.tradeLockExpiry).length;
    logger.info(`[${username}] ${game} inventory refreshed (${inv.totalItems} items, ${lockedStacks} locked stacks) → cache`);
    // Return an independent copy: the API enriches the result in place, and the object
    // handed to set() is now the cache's own (see InventoryStore.get clone note).
    return this.storeFor(game).get(username) ?? inv;
  }

  private async ensureSession(username: string): Promise<ManagedSession> {
    const account = this.accounts.get(username);
    if (!account) throw new Error(`Account "${username}" not found`);
    // S25: record ownership into the CALLER'S per-invocation store (undefined outside a refresh worker,
    // e.g. a single-account API refresh that never releases) — never a shared per-account map.
    const store = this.ownershipCtx.getStore();
    const existing = this.sessions.getSession(username);
    if (existing && existing.state === SessionState.LOGGED_IN && existing.webSession) {
      // Reused a live session — not ours to release. STICKY: never downgrade a `true` a PRIOR
      // ensureSession call in THIS same refresh already set. The both-games refresh calls ensureSession
      // twice per account (CS2 creates the session → true; the TF2 leg then reuses it): a plain
      // `= false` here clobbered the CS2 leg's ownership, so the finally never released the session and
      // the whole fleet piled up to the live-session ceiling ("released 0" → mass ceiling refusals).
      if (store && store.createdByCall === undefined) store.createdByCall = false;
      this.sessions.markUsed(username);        // genuine use → keep it out of the idle reaper (B40)
      return existing;
    }
    const { session, createdByCall } = await this.sessions.loginAccountOwned(account);
    // OR-in: this refresh owns the session if EITHER a prior leg created it OR this login did.
    if (store) store.createdByCall = store.createdByCall === true || createdByCall;
    this.sessions.markUsed(username);
    return session;
  }

  // ── Bulk refresh (concurrency-limited, non-blocking job) ─────────────────────

  status(): RefreshJob { return { ...this.job, failed: [...this.job.failed] }; }

  /** True while any inventory refresh (single or a bulk fleet refresh) is in flight — the update
   *  scheduler (C5) checks this so a mid-session update swap never interrupts a running refresh. */
  busy(): boolean { return this.inFlight.size > 0 || this.job.running || this.bgRefreshPasses > 0; }

  /**
   * Starts a background refresh of `usernames` with at most `concurrency`
   * simultaneous logins. Returns the initial job state immediately; poll
   * status() for progress. Throws if a refresh is already running.
   */
  startRefresh(usernames: string[], game: GameId = 'cs2', concurrency?: number): RefreshJob {
    if (this.job.running) throw new Error('A refresh is already running');
    this.refreshCancel = false; // fresh run — clear any prior cancel request
    // Concurrency scales with the batch (5→25); an explicit caller value is honoured but
    // CLAMPED to the 25 ceiling (proxy/socket + per-IP-rate stability is non-negotiable).
    const conc = clampConcurrency(concurrency, scaleConcurrency(usernames.length));
    this.job = {
      running: true, cancelling: false, cancelled: false, game, total: usernames.length, done: 0, failed: [],
      startedAt: new Date().toISOString(),
    };
    void this.runRefresh(usernames, game, conc);
    return this.status();
  }

  /**
   * Requests a co-operative stop of the live bulk refresh. The account currently
   * being fetched finishes; workers then stop pulling new accounts off the queue.
   * No-op when nothing is running.
   */
  cancelRefresh(): RefreshJob {
    if (this.job.running) {
      this.refreshCancel = true;
      this.job.cancelling = true;
      logger.info('Refresh-all: cancel requested – remaining accounts will be skipped');
    }
    return this.status();
  }

  private async runRefresh(usernames: string[], game: GameId, concurrency: number): Promise<void> {
    const queue = [...usernames];
    const workers = Math.max(1, Math.min(concurrency, usernames.length || 1));

    // Memory watch: a fleet refresh holds every account's parsed inventory in the
    // in-RAM cache, so a big batch is the prime OOM suspect. Sample RSS while the
    // pool runs and report the peak in the summary — a peak that approaches the V8
    // heap ceiling is the signal to raise --max-old-space-size or stop caching the
    // whole fleet at once. (A true OOM aborts mid-run; bootflags' diagnostic report
    // captures THAT, while this peak diagnoses a non-fatal climb.)
    const mb = (n: number): number => Math.round(n / 1048576);
    const startRss = process.memoryUsage().rss;
    let peakRss = startRss;
    const memTimer = setInterval(() => {
      const rss = process.memoryUsage().rss;
      if (rss > peakRss) peakRss = rss;
    }, 2_000);
    memTimer.unref(); // never keep the process alive for the sampler

    const localIpCount = usernames.filter(u => this.isLocalIp(u)).length;
    if (localIpCount > 0) {
      logger.info(
        `Refresh-all: ${localIpCount}/${usernames.length} account(s) run on local IP – ` +
        `throttled serially (${Math.round(LOCALIP_MIN_DELAY_MS / 1000)}–${Math.round(LOCALIP_MAX_DELAY_MS / 1000)}s apart) ` +
        `to avoid Steam's per-IP rate limit; proxied accounts stay concurrent.`,
      );
    }

    let released = 0; // sessions this refresh created and then logged back out
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        if (this.refreshCancel) break; // "End Task": stop pulling new accounts; in-flight fetch finishes
        const username = queue.shift()!;
        // TANK (bulk-scoped): if this account's proxy is currently reset-storming, DEFER it instead of
        // firing another handshake into the storm — the churn that feeds the 0xC0000409 native fast-fail.
        // Money-safe by construction: a deferred account is NOT dialed, so its cached inventory/balance is
        // untouched (never coerced to empty/0) and it is surfaced in job.failed as retryable. Only the BULK
        // refresh consults the breaker; user-initiated single-account/ money ops never defer. Proxyless→null.
        const acct = this.accounts.get(username);
        const pkey = acct?.network?.type === 'proxy' ? proxyKey(acct.network.value) : null;
        if (pkey && !proxyHealth.shouldAllow(pkey)) {
          this.job.failed.push({ username, error: `proxy ${pkey} is backing off after a reset storm — refresh deferred (retry shortly)` });
          this.job.done++;
          continue;
        }
        // S25: ownership is scoped to THIS account-refresh via a per-invocation store (isolated from a
        // concurrent post-trade refresh of the same account), set by ensureSession within the run().
        const store: { createdByCall?: boolean } = {};
        try {
          // Both games per account on ONE login/throttle slot (owner request). Safe on the hardened
          // base: the per-proxy breaker already gated this account ABOVE, so a storming proxy is
          // deferred before either leg dials — the TF2 leg only ever rides an already-healthy session.
          await this.ownershipCtx.run(store, () => this.refreshBothMaybeThrottled(username, () => this.refreshCancel));
        } catch (err) {
          // H-INV-008: a ThrottleSkippedError means the account was cancelled BEFORE any fetch started —
          // it's a skip, not a failure. Don't inflate job.failed (the finally still counts it in job.done,
          // matching today's cancelled-run accounting); log at debug.
          if ((err as { skipped?: boolean }).skipped === true) {
            logger.debug(`[${username}] refresh skipped (cancelled before start)`);
          } else {
            this.job.failed.push({ username, error: (err as Error).message });
            logger.warn(`[${username}] refresh failed: ${(err as Error).message}`);
          }
        } finally {
          this.job.done++;
          // Release ONLY a session THIS refresh created (ownership recorded by ensureSession into our own
          // store) so a full-fleet refresh doesn't end with the whole fleet held live (the resource
          // storm), WITHOUT ever tearing down a session another op owns or leaking one we created. The
          // inventory is already cached, so logging out loses nothing; any later action re-logs. (C17 / S25.)
          const createdByUs = store.createdByCall === true;
          if (REFRESH_RELEASE_SESSIONS && createdByUs) {
            try {
              if (this.sessions.isLive(username)) { await this.sessions.logoutAccount(username); released++; }
            } catch (err) {
              logger.warn(`[${username}] post-refresh session release failed: ${(err as Error).message}`);
            }
          }
        }
      }
    };

    await Promise.all(Array.from({ length: workers }, () => worker()));
    clearInterval(memTimer);
    { // final sample, in case the peak landed in the last <2s window
      const endRss = process.memoryUsage().rss;
      if (endRss > peakRss) peakRss = endRss;
      logger.info(`Refresh-all memory: RSS ${mb(startRss)}→${mb(endRss)}MB · peak ${mb(peakRss)}MB over ${usernames.length} account(s)`);
    }

    // Every account fetched BOTH games this pass: CS2 wrote the full-inventory (gc) cache,
    // TF2 wrote its own — persist each batch in one atomic write.
    this.gcStore.flush();
    this.tf2Store.flush();
    this.job.running = false;
    this.job.cancelling = false;
    this.job.cancelled = this.refreshCancel;
    this.job.finishedAt = new Date().toISOString();
    const wasCancelled = this.refreshCancel;
    this.refreshCancel = false;
    // History snapshots track BOTH games (CS2 + a parallel TF2 series), so settle a
    // snapshot after the pass — the snapshot is cache-only and updates both curves.
    try { this.onCompleteCb?.(`refresh-all-${game}`, game); } catch (err) {
      logger.warn(`refresh-complete hook failed: ${(err as Error).message}`);
    }
    const verb = wasCancelled ? 'cancelled' : 'complete';
    const relNote = REFRESH_RELEASE_SESSIONS ? ` · released ${released} refresh session(s)` : '';
    if (this.job.failed.length) {
      const detail = this.job.failed.map(f => `${f.username} (${f.error})`).join('; ');
      logger.warn(`Refresh-all ${verb}: ${this.job.done}/${this.job.total} – FAILED ${this.job.failed.length}${relNote}: ${detail}`);
    } else {
      logger.info(`Refresh-all ${verb}: ${this.job.done}/${this.job.total} – all OK${relNote}`);
    }
  }

  /**
   * Bulk-refresh dispatch: no-proxy (local IP) accounts go through the shared
   * LocalIpThrottle (serialized + randomized cooldown) so the host IP never trips
   * Steam's rate limit, however many are queued; proxied accounts (own exit IP)
   * refresh straight through at full concurrency.
   */
  private refreshMaybeThrottled(username: string, game: GameId, skip?: () => boolean): Promise<AccountInventory> {
    // H-INV-008: pass `skip` into the throttle so an "End Task" cancel drops queued-but-unstarted
    // local-IP accounts immediately (ThrottleSkippedError) instead of draining serially through the
    // cooldown chain. Proxied accounts start straight away — the skip is checked in the bulk worker loop.
    return this.isLocalIp(username)
      ? this.localIpThrottle.run(() => this.refreshOne(username, game), { skip })
      : this.refreshOne(username, game);
  }

  /**
   * One account, BOTH games, one throttle slot (owner request): the full CS2 fetch plus a TF2 read on
   * the SAME live session. The login (the expensive, rate-limited, storm-sensitive part) is paid once;
   * the TF2 leg is one extra web read (an account without TF2 answers with a single small empty
   * response). Fetching both keeps the Steam wallet identical in both caches by construction and keeps
   * the TF2 tab fresh without a second login pass. A TF2-only failure surfaces as a "TF2:"-tagged
   * partial failure WITHOUT voiding the committed CS2 leg; a mid-account "End Task" skips the TF2 leg.
   * The bulk worker has ALREADY consulted the per-proxy breaker before calling this, so a storming
   * proxy never reaches either leg.
   */
  private refreshBothMaybeThrottled(username: string, skip?: () => boolean): Promise<void> {
    const both = async (): Promise<void> => {
      await this.refreshOne(username, 'cs2');
      if (skip?.()) return; // "End Task" mid-account → skip the TF2 leg (CS2 is committed)
      try {
        await this.refreshOne(username, 'tf2');
      } catch (err) {
        throw new Error(`TF2: ${(err as Error).message}`);
      }
    };
    return this.isLocalIp(username) ? this.localIpThrottle.run(both, { skip }) : both();
  }

  /**
   * True when the account has no proxy (runs on the host's local IP). Anything that
   * is not an explicit 'proxy' network counts as local – matching SessionManager's
   * own fallback – so a missing/unknown network never bypasses the throttle.
   */
  private isLocalIp(username: string): boolean {
    return this.accounts.get(username)?.network?.type !== 'proxy';
  }

  /**
   * Fire-and-forget refresh used after a trade so the sender loses and the
   * receiver gains the moved items in the cache (post-trade cache fix).
   *
   * SAME discipline as the bulk refresh — this must never be the one fleet path
   * that bypasses the safety rails (however many targets a future caller passes):
   *   • BOUNDED: a scaleConcurrency-sized worker pool, never one task per target
   *     (an unbounded fan-out is the login/socket storm that kills the process).
   *   • THROTTLED: routes through refreshMaybeThrottled so no-proxy accounts go
   *     through the shared LocalIpThrottle instead of hammering Steam from one IP.
   *   • RELEASING: a session THIS refresh created is logged back out after its
   *     inventory is cached (explicit ownership via createdSession, exactly like
   *     runRefresh) — a session another op owns (e.g. the trade's sender, still
   *     live) is reused and never torn down. (C17 / INV-A6.)
   * Returns the completion promise (callers may ignore it; nothing rejects).
   */
  refreshAfterTrade(usernames: Array<string | undefined>): Promise<void> {
    const targets: string[] = [];
    const seen = new Set<string>();
    for (const u of usernames) {
      if (!u) continue;
      const k = u.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      targets.push(u);
    }
    if (targets.length === 0) return Promise.resolve();
    this.bgRefreshPasses++; // H-INV-007: make busy() see this pass while its accounts sit in the throttle queue

    const queue = [...targets];
    const workers = Math.max(1, Math.min(scaleConcurrency(queue.length), queue.length));
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const username = queue.shift()!;
        // S25: per-invocation ownership store, isolated from a concurrent fleet refresh of the same account.
        const store: { createdByCall?: boolean } = {};
        try {
          await this.ownershipCtx.run(store, () => this.refreshMaybeThrottled(username, 'cs2'));
        } catch (err) {
          logger.warn(`[${username}] post-trade refresh failed: ${(err as Error).message}`);
        } finally {
          const createdByUs = store.createdByCall === true;
          if (REFRESH_RELEASE_SESSIONS && createdByUs) {
            try {
              if (this.sessions.isLive(username)) await this.sessions.logoutAccount(username);
            } catch (err) {
              logger.warn(`[${username}] post-trade session release failed: ${(err as Error).message}`);
            }
          }
        }
      }
    };

    return Promise.all(Array.from({ length: workers }, () => worker()))
      .then(() => {
        logger.info(`Post-trade inventory refresh done: ${targets.join(', ')}`);
        try { this.onCompleteCb?.('post-trade', 'cs2'); } catch { /* history is best-effort */ }
      })
      .finally(() => { this.bgRefreshPasses = Math.max(0, this.bgRefreshPasses - 1); }); // H-INV-007: single settle point (workers never reject)
  }
}
