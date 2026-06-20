import { InventoryStore } from './InventoryStore';
import { InventoryManager } from './InventoryManager';
import { fetchListedItems } from './MarketListings';
import type { SessionManager } from './SessionManager';
import type { AccountManager } from './AccountManager';
import { LocalIpThrottle } from '../network/LocalIpThrottle';
import { SessionState, type ManagedSession } from '../types/session';
import type { AccountInventory, CS2Item, GameId } from '../types/inventory';
import { logger } from '../utils/logger';
import { dataDir } from '../utils/paths';
import { scaleConcurrency } from '../utils/concurrency';

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

function isRateLimited(err: unknown): boolean {
  return /429|rate.?limit/i.test((err as Error)?.message ?? '');
}

function isTransientRefreshError(err: unknown): boolean {
  const m = ((err as Error)?.message ?? '').toLowerCase();
  return /timeout|timed out|econnreset|esockettimedout|socket hang up|econnrefused|enetunreach|ehostunreach|etimedout|network|noconnection|tunnel|proxy|aborted|http 5\d\d|bad gateway|service unavailable/.test(m);
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export interface RefreshJob {
  running:     boolean;
  /** Operator pressed "End Task" — the run is winding down (remaining accounts skipped). */
  cancelling?: boolean;
  /** The run ended because it was cancelled. */
  cancelled?:  boolean;
  /** Which game this job refreshes ('cs2' default). */
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
   * CS2 inventory cache from the GAME COORDINATOR (separate file so the web and GC
   * refreshes NEVER overwrite each other). The GC record is the richer, complete
   * one (owned + tradelocked + listed), so reads PREFER it when present and fall
   * back to the web record otherwise – one source per account, never duplicated.
   */
  readonly gcStore = new InventoryStore(dataDir('inventories_gc.json'));
  private job: RefreshJob = { running: false, total: 0, done: 0, failed: [] };
  /** Co-operative cancel flag for the live bulk refresh (set by cancelRefresh()). */
  private refreshCancel = false;
  private onCompleteCb?: (reason: string) => void;
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
  onRefreshComplete(cb: (reason: string) => void): void {
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

  refreshOne(username: string, game: GameId = 'cs2'): Promise<AccountInventory> {
    // CS2 has ONE refresh and it is the COMPLETE one: the full pure-web fetch
    // (context 2 + 16 + market listings, fully categorised). The quick single-context
    // fetch (doRefreshOne) now serves only TF2 and the buy-verification path
    // (forceRefresh), where a context-2 read is exactly what's needed and must stay fast.
    if (game === 'cs2') return this.refreshOneViaGc(username);
    const key = `${game}:${username.toLowerCase()}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const p = this.doRefreshOne(username, game).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  /**
   * Like refreshOne, but GUARANTEES a fresh fetch that starts NOW (bypasses the
   * in-flight dedup). The buy-verification before/after diff must not reuse a
   * snapshot whose underlying fetch began before the order was placed, or it would
   * under-count fills. Newer callers still coalesce onto this fresh fetch.
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

  private async doRefreshOneViaGc(username: string): Promise<AccountInventory> {
    const account = this.accounts.get(username);
    if (!account) throw new Error(`Account "${username}" not found`);
    const session = await this.ensureSession(username);

    const steamId = String(session.steamId ?? '');

    // 1) Market listings FIRST. Their asset ids are excluded below so a listed item is
    //    NEVER also counted as owned/locked (one asset = one bucket). Best-effort.
    let listed: CS2Item[] = [];
    try {
      listed = InventoryManager.stack(await fetchListedItems(session));
    } catch (err) {
      logger.warn(`[${username}] market-listings fetch failed (listed bucket empty): ${(err as Error).message}`);
    }
    const listedAssetIds = new Set<string>(listed.flatMap(i => i.assetIds));

    // 2) The complete inventory from PURE WEB (no Game Coordinator): context 2 holds
    //    owned + market-bought holds; context 16 holds trade-received trade-locked AND
    //    currently-listed items. Names + exact unlock dates come straight from Steam's
    //    own descriptions (owner_descriptions "Tradable/Marketable After …"), so no
    //    schema resolver and no game-client connection are needed.
    const ctx2  = InventoryManager.parse(await InventoryManager.fetchRaw(session, 'cs2', 2),  steamId, 'cs2');
    const ctx16 = InventoryManager.parse(await InventoryManager.fetchRaw(session, 'cs2', 16), steamId, 'cs2');

    // 3) Combine, drop anything that's on the market (dedup by asset id), then stack +
    //    categorise: a future trade-lock → 'tradelocked', otherwise → 'tradable'.
    const now = Date.now();
    const ownedLockedRaw = [...ctx2, ...ctx16].filter(i => !listedAssetIds.has(i.assetId));
    const gcOwnedLockedCount = ownedLockedRaw.length; // owned+locked count, BEFORE listed are merged in
    const inv: AccountInventory = {
      username, steamId, game: 'cs2', source: 'gc',
      items:      InventoryManager.stack(ownedLockedRaw),
      totalItems: gcOwnedLockedCount,
      fetchedAt:  new Date(),
      fromCache:  false,
    };
    for (const it of inv.items) {
      it.category = (it.tradeLockExpiry && new Date(it.tradeLockExpiry).getTime() > now) ? 'tradelocked' : 'tradable';
    }

    // 4) The listed stacks form the 3rd bucket.
    if (listed.length) {
      inv.items.push(...listed);
      inv.totalItems += listed.reduce((n, i) => n + i.quantity, 0);
    }

    // Attach the wallet whenever the 'wallet' event fired — INCLUDING accounts with NO Steam
    // wallet (hasWallet=false → balance 0). A refreshed account is then always shown as a real
    // number (0 when empty); only a NEVER-refreshed account stays "—".
    if (session.wallet) {
      inv.wallet = {
        currency: session.wallet.currency,
        balance:  session.wallet.hasWallet ? session.wallet.balance : 0,
      };
    }

    // #10 money-safety: a GC handshake that settles slowly can read an EMPTY backpack
    // for an account that actually holds items. NEVER overwrite a known-non-empty GC
    // cache with a 0-owned read — the operator gates trade/sell decisions on this cache.
    // (Listed-only churn doesn't trip this; we compare the GC owned/locked count.)
    if (gcOwnedLockedCount === 0) {
      const prev = this.gcStore.get(username);
      const prevOwnedLocked = prev
        ? prev.items.filter(i => i.category !== 'listed').reduce((n, i) => n + (i.quantity || 0), 0)
        : 0;
      if (prevOwnedLocked > 0) {
        logger.warn(`[${username}] full refresh returned 0 owned/locked items but cache holds ${prevOwnedLocked} – keeping cached record (suspected partial read)`);
        return prev!;
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

  private async doRefreshOne(username: string, game: GameId): Promise<AccountInventory> {
    const account = this.accounts.get(username);
    if (!account) throw new Error(`Account "${username}" not found`);
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
    const existing = this.sessions.getSession(username);
    if (existing && existing.state === SessionState.LOGGED_IN && existing.webSession) return existing;
    return this.sessions.loginAccount(account);
  }

  // ── Bulk refresh (concurrency-limited, non-blocking job) ─────────────────────

  status(): RefreshJob { return { ...this.job, failed: [...this.job.failed] }; }

  /**
   * Starts a background refresh of `usernames` with at most `concurrency`
   * simultaneous logins. Returns the initial job state immediately; poll
   * status() for progress. Throws if a refresh is already running.
   */
  startRefresh(usernames: string[], game: GameId = 'cs2', concurrency?: number): RefreshJob {
    if (this.job.running) throw new Error('A refresh is already running');
    this.refreshCancel = false; // fresh run — clear any prior cancel request
    // Concurrency scales with the batch (5→25); an explicit caller value always wins.
    const conc = concurrency ?? scaleConcurrency(usernames.length);
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

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        if (this.refreshCancel) break; // "End Task": stop pulling new accounts; in-flight fetch finishes
        const username = queue.shift()!;
        try {
          await this.refreshMaybeThrottled(username, game);
        } catch (err) {
          this.job.failed.push({ username, error: (err as Error).message });
          logger.warn(`[${username}] ${game} refresh failed: ${(err as Error).message}`);
        } finally {
          this.job.done++;
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

    // CS2's per-account refresh writes the full-inventory (gc) cache; TF2 writes its own.
    (game === 'cs2' ? this.gcStore : this.tf2Store).flush(); // persist the batch in one atomic write
    this.job.running = false;
    this.job.cancelling = false;
    this.job.cancelled = this.refreshCancel;
    this.job.finishedAt = new Date().toISOString();
    const wasCancelled = this.refreshCancel;
    this.refreshCancel = false;
    // History snapshots track BOTH games (CS2 + a parallel TF2 series), so settle a
    // snapshot after the pass — the snapshot is cache-only and updates both curves.
    try { this.onCompleteCb?.(`refresh-all-${game}`); } catch (err) {
      logger.warn(`refresh-complete hook failed: ${(err as Error).message}`);
    }
    const verb = wasCancelled ? 'cancelled' : 'complete';
    if (this.job.failed.length) {
      const detail = this.job.failed.map(f => `${f.username} (${f.error})`).join('; ');
      logger.warn(`Refresh-all ${verb}: ${this.job.done}/${this.job.total} – FAILED ${this.job.failed.length}: ${detail}`);
    } else {
      logger.info(`Refresh-all ${verb}: ${this.job.done}/${this.job.total} – all OK`);
    }
  }

  /**
   * Bulk-refresh dispatch: no-proxy (local IP) accounts go through the shared
   * LocalIpThrottle (serialized + randomized cooldown) so the host IP never trips
   * Steam's rate limit, however many are queued; proxied accounts (own exit IP)
   * refresh straight through at full concurrency.
   */
  private refreshMaybeThrottled(username: string, game: GameId): Promise<AccountInventory> {
    return this.isLocalIp(username)
      ? this.localIpThrottle.run(() => this.refreshOne(username, game))
      : this.refreshOne(username, game);
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
   */
  refreshAfterTrade(usernames: Array<string | undefined>): void {
    const targets = usernames.filter((u): u is string => !!u);
    if (targets.length === 0) return;
    void Promise.allSettled(targets.map(u => this.refreshOne(u)))
      .then(() => {
        logger.info(`Post-trade inventory refresh done: ${targets.join(', ')}`);
        try { this.onCompleteCb?.('post-trade'); } catch { /* history is best-effort */ }
      });
  }
}
