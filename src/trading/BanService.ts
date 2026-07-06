import fs from 'fs';
import path from 'path';
import axios from 'axios';

import type { AccountManager } from '../core/AccountManager';
import type { SessionManager } from '../core/SessionManager';
import type { TradeService } from './TradeService';
import type { AccountConfig } from '../types/account';
import { loadMaFile } from '../core/LoginFlow';
import { resolveMaFilePath } from '../core/maFiles';
import { TokenStore } from '../core/TokenStore';
import { logger, redactSecrets } from '../utils/logger';

// ════════════════════════════════════════════════════════════════════════════
//  BanService — comprehensive Steam ban checker
//
//  Fetches every ban type for a set of accounts and categorises them into
//  buckets (clean / VAC / game / community / economy-trade). The canonical
//  source for ALL ban types in one call is the Steam Web API endpoint
//  ISteamUser/GetPlayerBans, which returns VAC + game + community + economy
//  flags together (the public profile XML only exposes VAC + trade state).
//
//  GetPlayerBans needs a Steam Web API key. We never ask the operator to paste
//  one: a single key checks ARBITRARY SteamIDs, so we obtain key(s) from accounts
//  WITHIN each environment (auto-creating them with the account's identity_secret
//  if needed) and cache them PER-ENVIRONMENT for the process lifetime — a repeat
//  check of the same fleet re-uses the cached keys and logs in nobody. A key is
//  evicted only when Steam rejects it (401/403), so the next run re-mints just
//  that one. An explicit STEAM_WEB_API_KEY env var, when set, wins globally (zero
//  Steam round-trips) and is never cached.
//
//  SteamIDs are resolved WITHOUT a login wherever possible (live session →
//  maFile Session.SteamID → the maFile filename, which is the SteamID64), so a
//  whole folder is checked with at most one login (for the key).
// ════════════════════════════════════════════════════════════════════════════

/** Max accounts per GetPlayerBans request (Steam caps `steamids` at 100). */
const BANS_BATCH = 100;
/**
 * Hard cap on accounts checked per AUTO-acquired Web API key. After this many, the checker rotates
 * to ANOTHER key sourced from the SAME environment; a key is NEVER reused across environments. Kept
 * below Steam's 100/request limit so an environment's load is spread over a few of its OWN keys
 * rather than hammering one. (An explicit STEAM_WEB_API_KEY override is the operator's own single
 * key and is exempt — see checkBans.)
 */
const BANS_PER_KEY = 50;
/**
 * Bounded parallelism for the login-bound phases (per-env key minting + the GetPlayerBans fetches).
 * Small + FIXED on purpose: a whole-fleet check runs several environments at once instead of one at
 * a time, but never opens an unbounded number of concurrent logins (the refresh-storm failure mode).
 */
const BAN_CHECK_CONCURRENCY = 3;
/**
 * Per-account budget for the login + Web API key mint. A Steam call still pending past this is
 * abandoned (the account is marked unable to provide a key) so ONE hung account can never stall the
 * whole run — that un-timed call is the real "ban check never finishes" failure.
 */
const KEY_MINT_TIMEOUT_MS = 20_000;
/** Safety cap on how many env accounts we'll LOG IN (per environment) purely to MINT keys —
 *  already-logged-in accounts are free and don't count. Prevents a mass login for a huge env. */
const ENV_KEY_LOGIN_CAP = 25;
/** Parallel logins when resolving SteamIDs that aren't available offline (CSV imports). */
const LOGIN_RESOLVE_CONCURRENCY = 4;
/**
 * Hard cap on how many accounts a single ban check will LOG IN just to learn their SteamID.
 * A read-only ban check must never trigger a mass login: hundreds of fresh sessions (each with
 * its own SteamUser CM connection + polling TradeOfferManager) is the documented resource
 * explosion that crashes the process. Above this many offline-unresolvable accounts we skip the
 * login fallback entirely and tell the user to refresh them once (which caches their SteamID).
 */
const MAX_LOGIN_RESOLVE = 25;
/** Domain we register the throwaway Web API key under (value is irrelevant for reads). */
const KEY_DOMAIN = 'localhost';
/** SteamID64 shape (17 digits, individual-account universe). */
const STEAMID64 = /^7656\d{13}$/;

/** A single account's resolved ban status. */
export interface AccountBanInfo {
  username:        string;
  displayName?:    string;
  steamId:         string | null;
  /** Set when this account could not be checked (no SteamID / Steam lookup failed). */
  error?:          string;
  vacBanned:       boolean;
  vacCount:        number;
  gameBanned:      boolean;
  gameCount:       number;
  communityBanned: boolean;
  /** 'none' | 'probation' | 'banned' (lower-cased). */
  economyBan:      string;
  daysSinceLastBan: number;
  /** Buckets this account falls into: ['clean'] or a subset of vac/game/community/economy. */
  categories:      string[];
}

export interface BanCheckTotals {
  total:     number;
  clean:     number;
  vac:       number;
  game:      number;
  community: number;
  economy:   number;
  error:     number;
}

export interface BanCheckResult {
  accounts: AccountBanInfo[];
  totals:   BanCheckTotals;
  /** Diagnostic: which account provided the Web API key (or 'env'/undefined). */
  apiKeyFrom?: string;
}

/** Live progress of the single ban-check job (the UI polls this). */
export interface BanJobProgress {
  total:        number; // resolved-to-known accounts in the run
  resolved:     number; // SteamID-resolve phase completions
  keysAcquired: number; // env key acquisitions completed
  checked:      number; // GetPlayerBans records fetched (across chunks)
}

/** Snapshot of the ban-check job (delivered once via `status()`; `result` retained until next start). */
export interface BanJobStatus {
  running:   boolean;
  startedAt: number;
  progress:  BanJobProgress;
  result?:   BanCheckResult;
  error?:    string;
}

/** Raw GetPlayerBans player record (only the fields we use). */
interface SteamBanRecord {
  SteamId?:          string;
  CommunityBanned?:  boolean;
  VACBanned?:        boolean;
  NumberOfVACBans?:  number;
  DaysSinceLastBan?: number;
  NumberOfGameBans?: number;
  EconomyBan?:       string;
}

/** The two SteamCommunity methods we use, narrowed from the `[key: string]: unknown` index. */
interface CommunityWithKey {
  getWebApiKey(callback: (err: Error | null, key?: string) => void): void;
  createWebApiKey(
    options:  { domain: string; identitySecret?: string | Buffer; requestID?: string },
    callback: (err: Error | null, result?: { confirmationRequired: boolean; apiKey?: string }) => void,
  ): void;
}

export class BanService {
  /** Single live ban-check job (polled by the UI). A whole-fleet cold check can exceed the client's
   *  120s request budget, so the run is detached and the modal polls `status()` instead of awaiting
   *  the whole POST (which would time out the modal while the backend kept working). `result` is
   *  retained until the next `startCheck`, so a poll that lands after completion still receives it. */
  private job: BanJobStatus = {
    running: false, startedAt: 0,
    progress: { total: 0, resolved: 0, keysAcquired: 0, checked: 0 },
  };
  /** Per-environment Web API key cache (process-lifetime). A key is evicted only when Steam
   *  rejects it (401/403), after which the next run re-acquires one for that env. */
  private readonly envKeys = new Map<string, string[]>();
  /** Read-only token reader (vault-aware) → SteamID from the refresh-token JWT, no login. */
  private readonly tokens = new TokenStore();

  constructor(
    private readonly accounts: AccountManager,
    private readonly sessions: SessionManager,
    private readonly trades:   TradeService,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Starts the ban check as a DETACHED job and returns immediately. Single-flight: throws if a job
   * is already running. The whole run (which can exceed the client's 120s request budget on a cold
   * fleet) executes in the background; the caller polls `status()`. The S33 finalizer clears
   * `running` and records any thrown error on every exit path, so a crash never latches the job.
   */
  startCheck(usernames: string[]): void {
    if (this.job.running) throw new Error('A ban check is already running');
    this.job = {
      running: true, startedAt: Date.now(),
      progress: { total: 0, resolved: 0, keysAcquired: 0, checked: 0 },
    };
    void this.checkBans(usernames, this.job.progress)
      .then((result) => { this.job.result = result; })
      .catch((err) => {
        this.job.error = redactSecrets((err as Error).message);
        logger.error(`[bans] check job crashed – ${this.job.error}`);
      })
      .finally(() => { this.job.running = false; });
  }

  /** Snapshot of the live ban-check job. `result` is delivered once complete and retained until the
   *  next `startCheck`, so a poll landing after the run finishes still gets it. */
  status(): BanJobStatus {
    return {
      running: this.job.running, startedAt: this.job.startedAt,
      progress: { ...this.job.progress }, result: this.job.result, error: this.job.error,
    };
  }

  /**
   * Checks every given account for all Steam ban types and returns the
   * categorised result. Per-account failures (no SteamID, Steam didn't return a
   * record) surface as `error` on that account and NEVER abort the others.
   * `progress` (when given, via `startCheck`) is incremented in place so the UI can poll live counts.
   */
  async checkBans(usernames: string[], progress?: BanJobProgress): Promise<BanCheckResult> {
    // De-dupe (case-insensitively) + resolve to known accounts, preserving order.
    const seen = new Set<string>();
    const accs: AccountConfig[] = [];
    for (const u of usernames) {
      const acc = this.accounts.get(u);
      if (!acc) continue;
      const key = acc.username.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      accs.push(acc);
    }
    if (progress) progress.total = accs.length;

    const infos: AccountBanInfo[] = [];
    const bySteamId = new Map<string, AccountBanInfo>();
    const unresolved: Array<{ account: AccountConfig; info: AccountBanInfo }> = [];
    for (const acc of accs) {
      const steamId = this.resolveSteamId(acc);
      if (progress) progress.resolved++;
      const info: AccountBanInfo = {
        username: acc.username, displayName: acc.displayName, steamId,
        vacBanned: false, vacCount: 0, gameBanned: false, gameCount: 0,
        communityBanned: false, economyBan: 'none', daysSinceLastBan: 0, categories: [],
      };
      infos.push(info);
      // Two accounts can never legitimately share one SteamID64: a duplicate here means a config
      // anomaly (two entries pointing at one maFile, a stale cached steamId, a re-import under an
      // alias). First-in wins deterministically; the loser is flagged, not silently overwritten and
      // reported clean. Null-steamId accounts still go to `unresolved` exactly as before.
      const prev = steamId ? bySteamId.get(steamId) : undefined;
      if (steamId && !prev) bySteamId.set(steamId, info);
      else if (prev) info.error = `Duplicate SteamID64 — same Steam account as "${prev.username}"; fix the duplicate registration`;
      else unresolved.push({ account: acc, info });
    }

    // Login fallback: a CSV-imported account has NO maFile/SteamID on disk and (until its first
    // login) no refresh-token JWT to decode — its SteamID is only obtainable by logging it in.
    // CRITICAL (crash fix): cap this hard. A big fleet (e.g. a freshly imported 500+ accounts)
    // would otherwise mass-login here and crash the process. Only auto-login a small batch; above
    // the cap, leave them unresolved with an actionable message (one normal refresh caches the
    // SteamID, after which ban checks resolve them offline forever).
    if (unresolved.length > 0) {
      if (unresolved.length <= MAX_LOGIN_RESOLVE) {
        await this.resolveViaLogin(unresolved, bySteamId);
        for (const { info } of unresolved) {
          if (!info.steamId && !info.error) info.error = 'Could not resolve SteamID (login failed / no credentials)';
        }
      } else {
        logger.warn(`[bans] ${unresolved.length} account(s) have no cached SteamID — skipping mass login (cap ${MAX_LOGIN_RESOLVE}) to avoid a crash; they need one refresh first`);
        for (const { info } of unresolved) {
          if (!info.steamId && !info.error) info.error = 'SteamID not cached yet — refresh this account once, then re-check bans';
        }
      }
    }

    // Diagnostic ONLY: which key source served this run. A run-local var (not instance state) so a
    // run that resolved no target reports `undefined` instead of the previous run's value, a rejected
    // per-env key doesn't null it mid-run, and two concurrent checks can't overwrite each other's.
    let keySource: 'env' | 'per-env' | undefined;
    const targets = [...bySteamId.keys()];
    if (targets.length > 0) {
      // ── F3c: PER-ENVIRONMENT key scoping ──────────────────────────────────────
      // An explicit STEAM_WEB_API_KEY is the operator's own single key → it wins globally
      // (documented escape hatch; bypasses per-env scoping by their choice). Otherwise every
      // environment is checked ONLY with key(s) sourced from accounts WITHIN that env, capped
      // at BANS_PER_KEY accounts/key and rotated across same-env keys — never cross-env.
      const overrideKey = (process.env.STEAM_WEB_API_KEY ?? '').trim();
      if (overrideKey) {
        keySource = 'env';
        const batches: string[][] = [];
        for (let i = 0; i < targets.length; i += BANS_BATCH) batches.push(targets.slice(i, i + BANS_BATCH));
        await mapLimit(batches, BAN_CHECK_CONCURRENCY, (batch) => this.fetchChunk(overrideKey, batch, bySteamId, undefined, progress));
        return this.finalize(infos, keySource);
      }
      keySource = 'per-env';
      await this.checkPerEnvironment(accs, bySteamId, progress);
    }

    return this.finalize(infos, keySource);
  }

  /**
   * F3c orchestration: group the resolved (has-SteamID) accounts by environment, acquire up to
   * the needed number of keys from accounts WITHIN each environment, then plan + execute the
   * 20-per-key chunks with strict per-env isolation. Accounts an env can't cover (more accounts
   * than 20 × the keys it could provide) are surfaced with a clear, actionable error.
   */
  private async checkPerEnvironment(accs: AccountConfig[], bySteamId: Map<string, AccountBanInfo>, progress?: BanJobProgress): Promise<void> {
    // envId → all usernames in it (potential key sources); and the resolved (steamId,env) targets.
    const envUsernames = new Map<string, string[]>();
    for (const acc of accs) {
      const list = envUsernames.get(acc.environmentId) ?? [];
      list.push(acc.username);
      envUsernames.set(acc.environmentId, list);
    }
    const targetsByEnv = new Map<string, string[]>(); // envId → steamids
    const flatTargets: Array<{ steamId: string; envId: string }> = [];
    for (const [sid, info] of bySteamId) {
      const envId = this.accounts.get(info.username)?.environmentId ?? '__none__';
      const list = targetsByEnv.get(envId) ?? [];
      list.push(sid);
      targetsByEnv.set(envId, list);
      flatTargets.push({ steamId: sid, envId });
    }

    // Acquire keys per env (sized to what that env needs), sourced ONLY from that env's accounts.
    // Threaded ACROSS environments (BAN_CHECK_CONCURRENCY): several envs mint at once, but each env
    // still mints sequentially WITHIN itself, so concurrent logins stay bounded (≈ the concurrency).
    const acquired = await mapLimit([...targetsByEnv], BAN_CHECK_CONCURRENCY, async ([envId, sids]) => {
      const needed = Math.ceil(sids.length / BANS_PER_KEY);
      const keys = await this.acquireEnvKeys(envId, envUsernames.get(envId) ?? [], needed);
      if (progress) progress.keysAcquired += keys.length;
      return [envId, keys] as [string, string[]];
    });
    const keysByEnv = new Map<string, string[]>(acquired);

    // Pure plan: which key index of which env covers which steamids, and what's uncovered.
    const keyCounts = new Map([...keysByEnv].map(([env, keys]) => [env, keys.length]));
    const { assignments, uncovered } = planPerEnvBanChecks(flatTargets, keyCounts);

    // Execute the GetPlayerBans chunks, also threaded — each uses ITS env's k-th key (strict per-env
    // isolation preserved) and a disjoint set of steamids, so the shared-map writes never collide.
    await mapLimit(assignments, BAN_CHECK_CONCURRENCY, async (a) => {
      const key = keysByEnv.get(a.envId)?.[a.keyIndex];
      if (!key) return; // defensive — planner never emits an assignment beyond keyCounts
      await this.fetchChunk(key, a.steamIds, bySteamId, () => {
        const arr = this.envKeys.get(a.envId);
        if (arr) this.envKeys.set(a.envId, arr.filter((k) => k !== key));
      }, progress);
    });
    // Surface uncovered accounts (env had more accounts than its keys could cover, or none).
    for (const u of uncovered) {
      const info = bySteamId.get(u.steamId);
      if (!info || info.error) continue;
      const provided = keysByEnv.get(u.envId)?.length ?? 0;
      info.error = provided === 0
        ? 'No Steam Web API key available in this environment (no account here could provide one)'
        : `Environment has more accounts than its API keys can cover (${provided} key(s) × ${BANS_PER_KEY}); add/enable more key-capable accounts here`;
    }
  }

  /**
   * Acquires up to `needed` Web API keys from accounts WITHIN one environment (never another).
   * Already-logged-in env accounts are tried first (free); minting from a not‑yet‑logged‑in
   * account counts against ENV_KEY_LOGIN_CAP so a huge env never triggers a mass login. Each
   * account sources at most ONE key. Returns the keys it could get (may be fewer than needed).
   */
  private async acquireEnvKeys(envId: string, candidates: string[], needed: number): Promise<string[]> {
    if (needed <= 0 || candidates.length === 0) return [];
    const ready = candidates.filter((u) => this.sessions.isReady(u));
    const rest  = candidates.filter((u) => !this.sessions.isReady(u));
    const ordered = [...new Set([...ready, ...rest])];
    // Seed from the process-lifetime cache: a prior run's keys for this env need no re-login. The
    // `keys.length >= needed` guard below then skips ALL minting when the cache already covers us.
    const keys: string[] = [...(this.envKeys.get(envId) ?? [])];
    let logins = 0;
    for (const username of ordered) {
      if (keys.length >= needed) break;
      const willLogin = !this.sessions.isReady(username);
      if (willLogin && logins >= ENV_KEY_LOGIN_CAP) continue;
      // Snapshot live-ness so we release ONLY a session WE create just to mint a key. A key needs
      // the account live only for the one getWebApiKey/createWebApiKey call below.
      const wasLiveBefore = this.sessions.isLive(username);
      if (willLogin) logins++; // count the ATTEMPT up front so a timeout still respects the login cap
      // Whole per-account mint (login + key fetch/create). Hoisted so the release can chain to THIS
      // promise: a stalled call is abandoned by the ~20s budget below (the account provides no key,
      // instead of hanging the run), but the session release still fires the moment OUR mint settles.
      const mint = (async () => {
        const trader = await this.trades.getTrader(username); // logs in if needed
        const community = trader.community as unknown as CommunityWithKey;
        let k = await this.getExistingKey(community);
        if (!k) k = await this.createKey(community, this.identitySecretOf(username));
        return k;
      })();
      try {
        const key = await withTimeout(mint, KEY_MINT_TIMEOUT_MS, `${username} key mint`);
        if (key) keys.push(key);
      } catch (err) {
        logger.warn(`[bans] env ${envId}: ${username} could not provide a key (${(err as Error).message})`);
      } finally {
        // Release the session this key-mint created — chained to the mint promise, so a login that
        // lands after our timeout releases when IT settles, not at a blind later instant. Best-effort.
        if (!wasLiveBefore) this.releaseWhenSettled(username, mint);
      }
    }
    this.envKeys.set(envId, keys); // cache for the process lifetime; evicted only on a Steam 401/403
    logger.info(`[bans] env ${envId}: acquired ${keys.length}/${needed} key(s) (${logins} login(s))`);
    return keys;
  }

  /** Release a session WE created to mint a key — chained to OUR OWN login/mint promise, not a blind
   *  wall-clock timer. On the happy/failed path `op` is already settled so `drop` runs on the next
   *  microtask (identical to the old immediate drop); on the timeout path the release fires the
   *  moment OUR login/mint actually lands (or fails) — including a semaphore-queued login that lands
   *  long after our timeout — so it can never yank a session another flow just created, and never
   *  leaves the post-horizon leak a fixed 20s timer misses. If `op` never settles, the idle reaper
   *  (S11) reclaims the session — a bounded outcome, not the old timer's blind blast radius. */
  private releaseWhenSettled(username: string, op: Promise<unknown>): void {
    const drop = (): void => { if (this.sessions.isLive(username)) void this.sessions.logoutAccount(username).catch(() => undefined); };
    void op.then(drop, drop);
  }

  /** Fetches one chunk of SteamIDs with `apiKey` and folds the results into `bySteamId`.
   *  Per-account failures stay scoped to this chunk and never abort the others. When Steam
   *  rejects the key (401/403), `onKeyRejected` (if given) evicts it from the per-env cache so
   *  the next run re-mints — the env-override key passes none (it is never cached). */
  private async fetchChunk(
    apiKey: string,
    batch: string[],
    bySteamId: Map<string, AccountBanInfo>,
    onKeyRejected?: () => void,
    progress?: BanJobProgress,
  ): Promise<void> {
    if (batch.length === 0) return;
    try {
      const players = await this.fetchBansWithRetry(apiKey, batch);
      const returned = new Set<string>();
      for (const p of players) {
        const sid = String(p.SteamId ?? '');
        const info = bySteamId.get(sid);
        if (!info) continue;
        returned.add(sid);
        info.vacCount        = Number(p.NumberOfVACBans) || 0;
        info.vacBanned       = !!p.VACBanned || info.vacCount > 0;
        info.gameCount       = Number(p.NumberOfGameBans) || 0;
        info.gameBanned      = info.gameCount > 0;
        info.communityBanned = !!p.CommunityBanned;
        info.economyBan      = String(p.EconomyBan ?? 'none').toLowerCase();
        info.daysSinceLastBan = Number(p.DaysSinceLastBan) || 0;
      }
      for (const sid of batch) {
        if (returned.has(sid)) continue;
        const info = bySteamId.get(sid);
        if (info && !info.error) info.error = 'Steam returned no ban record';
      }
    } catch (err) {
      if ((err as { keyRejected?: boolean }).keyRejected) onKeyRejected?.();
      const msg = `Ban lookup failed: ${redactSecrets((err as Error).message)}`;
      for (const sid of batch) {
        const info = bySteamId.get(sid);
        if (info && !info.error) info.error = msg;
      }
      logger.warn(`[bans] ${msg}`);
    } finally {
      if (progress) progress.checked += batch.length; // chunk processed (fetched or errored) → advance
    }
  }

  /** Calls `fetchBans` with a bounded, classified retry: at most 3 attempts (1s then 4s back-off),
   *  retrying ONLY a transient failure (429/5xx, a login-wall/malformed 200) or an untagged network
   *  throw (axios ECONNRESET etc. — no `transient` tag). A `keyRejected` (401/403) or any other
   *  permanent failure (other 4xx) throws on the first attempt unchanged — a retry can't fix it and
   *  would waste the key. Worst-case added latency ≤ ~5s per chunk. The thrown error is surfaced by
   *  `fetchChunk` per-account with its (now accurate) message. */
  private async fetchBansWithRetry(apiKey: string, batch: string[]): Promise<SteamBanRecord[]> {
    const delays = [1_000, 4_000]; // between attempts 1→2 and 2→3
    let attempt = 0;
    for (;;) {
      try {
        return await this.fetchBans(apiKey, batch);
      } catch (err) {
        const e = err as { transient?: boolean; keyRejected?: boolean };
        // Retry a tagged-transient error OR an untagged network throw (no `transient`, not keyRejected).
        const retryable = e.transient === true || (e.transient === undefined && !e.keyRejected);
        if (!retryable || attempt >= delays.length) throw err;
        await sleep(delays[attempt++]);
      }
    }
  }

  // ── Categorisation ───────────────────────────────────────────────────────────

  /** Assigns each account's category buckets and computes the totals. */
  private finalize(infos: AccountBanInfo[], apiKeyFrom?: string): BanCheckResult {
    const totals: BanCheckTotals = { total: infos.length, clean: 0, vac: 0, game: 0, community: 0, economy: 0, error: 0 };
    for (const info of infos) {
      if (info.error) { info.categories = []; totals.error++; continue; }
      const cats: string[] = [];
      if (info.vacBanned)       { cats.push('vac');       totals.vac++; }
      if (info.gameBanned)      { cats.push('game');      totals.game++; }
      if (info.communityBanned) { cats.push('community'); totals.community++; }
      if (info.economyBan !== 'none') { cats.push('economy'); totals.economy++; }
      if (cats.length === 0)    { cats.push('clean');     totals.clean++; }
      info.categories = cats;
    }
    return { accounts: infos, totals, apiKeyFrom };
  }

  // ── SteamID resolution (no login required) ───────────────────────────────────

  /**
   * Resolves an account's SteamID64 as an EXACT string, without a login where possible.
   *
   * CRITICAL: the maFile's `Session.SteamID` is a raw JSON NUMBER (e.g. 76561198…353) that
   * exceeds Number.MAX_SAFE_INTEGER, so JSON.parse silently ROUNDS it to a different id —
   * querying that wrong id is what made every ban result wrong. We therefore take the id
   * ONLY from precision-safe string sources: the live session, the SteamID64 filename, the
   * raw maFile text (regex), or a string `steamid` field — NEVER the parsed number.
   */
  private resolveSteamId(account: AccountConfig): string | null {
    // 0) Cached on accounts.json from a prior login (exact string, login-free, permanent).
    if (account.steamId && STEAMID64.test(account.steamId)) return account.steamId;

    // 1) Live session — getSteamID64() is an exact string.
    const live = this.sessions.getSession(account.username)?.steamId;
    if (live && STEAMID64.test(live)) return live;

    // 2) The maFile FILENAME is the exact SteamID64 in this app (files are named by it).
    const base = path.basename(account.maFilePath ?? '').replace(/\.maFile$/i, '');
    if (STEAMID64.test(base)) return base;

    // 3) Raw maFile text → regex the digits as a STRING (precision-safe), for non-id filenames.
    try {
      const raw = fs.readFileSync(resolveMaFilePath(account.maFilePath), 'utf-8');
      const m = raw.match(/"(?:SteamID|steamid)"\s*:\s*"?(7656\d{13})"?/);
      if (m) return m[1];
    } catch { /* no readable on-disk maFile (vault / CSV import) */ }

    // 4) A STRING steamid on the parsed maFile (numbers are unsafe — see above).
    try {
      const mf = loadMaFile(account);
      if (typeof mf.steamid === 'string' && STEAMID64.test(mf.steamid)) return mf.steamid;
    } catch { /* ignore */ }

    // 5) The stored refresh-token JWT — its `sub` claim is the exact SteamID64 (no login).
    //    Covers CSV imports (no maFile/SteamID on disk) once they've logged in at least once.
    const fromToken = this.steamIdFromToken(account.username);
    if (fromToken) return fromToken;

    return null;
  }

  /** Decodes the account's stored refresh-token JWT and returns its `sub` (SteamID64), or null. */
  private steamIdFromToken(username: string): string | null {
    const token = this.tokens.get(username);
    if (!token) return null;
    try {
      const seg = token.split('.')[1];
      if (!seg) return null;
      const json = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const sub = (JSON.parse(json) as { sub?: unknown }).sub;
      return typeof sub === 'string' && STEAMID64.test(sub) ? sub : null;
    } catch { return null; }
  }

  /**
   * Last-resort SteamID resolution for accounts with NO offline source (typically CSV imports
   * that have never logged in): logs each in (bounded concurrency) via its trader and reads the
   * session's SteamID. Per-account login failures set `error`; they never abort the others.
   */
  private async resolveViaLogin(
    items:     Array<{ account: AccountConfig; info: AccountBanInfo }>,
    bySteamId: Map<string, AccountBanInfo>,
  ): Promise<void> {
    const queue = [...items];
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const { account, info } = queue.shift()!;
        // The SteamID is read synchronously right after login, so this login is ours to release.
        const wasLiveBefore = this.sessions.isLive(account.username);
        // Hoisted so the release chains to THIS login promise (not a blind timer): a login that lands
        // after our timeout releases when it settles, and can't yank a session another flow started.
        const login = this.trades.getTrader(account.username); // logs in if needed (+ persists a refresh token)
        try {
          // ~20s budget so a stuck login can't hang the resolve pass either.
          await withTimeout(login, KEY_MINT_TIMEOUT_MS, `${account.username} login`);
          const sid = this.sessions.getSession(account.username)?.steamId;
          if (sid && STEAMID64.test(sid)) {
            const prev = bySteamId.get(sid);
            // Same guard as registration: first-in wins, a duplicate is flagged not overwritten.
            if (prev && prev !== info) info.error = `Duplicate SteamID64 — same Steam account as "${prev.username}"; fix the duplicate registration`;
            else { info.steamId = sid; bySteamId.set(sid, info); }
          }
          else info.error = 'Logged in but no SteamID was returned';
        } catch (err) {
          info.error = `Login failed: ${redactSecrets((err as Error).message)}`;
          logger.warn(`[bans] ${account.username}: SteamID login-resolve failed (${(err as Error).message})`);
        } finally {
          // Release the session this resolve created — chained to the login promise, so a login that
          // lands after our timeout releases when IT settles, not at a blind later instant. Best-effort.
          if (!wasLiveBefore) this.releaseWhenSettled(account.username, login);
        }
      }
    };
    const n = Math.max(1, Math.min(LOGIN_RESOLVE_CONCURRENCY, items.length));
    await Promise.all(Array.from({ length: n }, () => worker()));
  }

  // ── Steam Web API key acquisition (per-environment; see acquireEnvKeys above) ──

  /** This account's identity_secret (for auto-confirming key creation), or undefined. */
  private identitySecretOf(username: string): string | undefined {
    const acc = this.accounts.get(username);
    if (!acc) return undefined;
    try { return loadMaFile(acc).identity_secret || undefined; }
    catch { return undefined; }
  }

  /** Resolves the account's EXISTING Web API key, or null if it has none. */
  private getExistingKey(community: CommunityWithKey): Promise<string | null> {
    return new Promise((resolve) => {
      community.getWebApiKey((err, key) => resolve(!err && key ? key : null));
    });
  }

  /** Registers a fresh Web API key, auto-accepting the mobile confirmation via identity_secret. */
  private createKey(community: CommunityWithKey, identitySecret?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      community.createWebApiKey({ domain: KEY_DOMAIN, identitySecret }, (err, result) => {
        if (err) return reject(err);
        if (result?.apiKey) return resolve(result.apiKey);
        if (result?.confirmationRequired) return reject(new Error('API key creation needs a manual mobile confirmation'));
        reject(new Error('API key creation returned no key'));
      });
    });
  }

  // ── GetPlayerBans ────────────────────────────────────────────────────────────

  /**
   * Calls ISteamUser/GetPlayerBans for up to 100 SteamIDs. Routed DIRECT (proxy:false)
   * like the other api.steampowered.com reads — ban data is independent of egress IP.
   * A 401/403 tags the throw `keyRejected` so `fetchChunk` evicts the key from the per-env
   * cache; the next run re-mints one for that environment.
   */
  private async fetchBans(apiKey: string, steamIds: string[]): Promise<SteamBanRecord[]> {
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/` +
      `?key=${encodeURIComponent(apiKey)}&steamids=${steamIds.join(',')}`;
    const r = await axios.get(url, { timeout: 15_000, proxy: false, validateStatus: () => true });
    if (r.status === 401 || r.status === 403) {
      // Per-env cache eviction is fetchChunk's onKeyRejected (keyed off the keyRejected tag below);
      // the env-override key is never cached (fetchChunk passes no callback), so nothing to evict here.
      throw Object.assign(new Error('Steam rejected the Web API key'), { transient: false, keyRejected: true });
    }
    if (r.status === 429 || r.status >= 500) {
      throw Object.assign(new Error(`Steam HTTP ${r.status}`), { transient: true }); // rate-limit / server error → retry
    }
    if (r.status !== 200) {
      throw Object.assign(new Error(`Steam HTTP ${r.status}`), { transient: false }); // other 4xx → permanent
    }
    if (!r.data || !Array.isArray(r.data.players)) {
      // 200 with a login-wall/maintenance HTML body or a malformed shape → treat as transient (retry).
      throw Object.assign(new Error('Steam returned an unexpected body (login wall or malformed response)'),
        { transient: true });
    }
    return r.data.players as SteamBanRecord[];
  }
}

/**
 * PURE planner for F3c per-environment ban-key scoping (unit-tested in isolation, no live deps).
 * Given the resolved targets (each tagged with its environment) and how many keys each
 * environment has, produce the chunk assignments — every assignment's SteamIDs all belong to a
 * single environment (strict cross-env isolation by construction), each chunk ≤ `perKey`, and
 * key indices rotate 0..k-1 within the env — plus the targets that cannot be covered (an env
 * with more accounts than keys × perKey, or with 0 keys). The orchestrator (`checkPerEnvironment`)
 * feeds this the per-env key counts it actually acquired and executes the plan.
 */
export function planPerEnvBanChecks(
  targets: Array<{ steamId: string; envId: string }>,
  keysByEnv: Map<string, number>,
  perKey: number = BANS_PER_KEY,
): {
  assignments: Array<{ envId: string; keyIndex: number; steamIds: string[] }>;
  uncovered: Array<{ steamId: string; envId: string }>;
} {
  const cap = Math.max(1, Math.floor(perKey)); // never 0/negative → would loop or never cover
  const byEnv = new Map<string, string[]>();
  for (const t of targets) {
    const list = byEnv.get(t.envId) ?? [];
    list.push(t.steamId);
    byEnv.set(t.envId, list);
  }
  const assignments: Array<{ envId: string; keyIndex: number; steamIds: string[] }> = [];
  const uncovered: Array<{ steamId: string; envId: string }> = [];
  for (const [envId, sids] of byEnv) {
    const keys = Math.max(0, Math.floor(keysByEnv.get(envId) ?? 0));
    const capacity = keys * cap;
    for (let k = 0; k < keys; k++) {
      const chunk = sids.slice(k * cap, Math.min((k + 1) * cap, capacity));
      if (chunk.length === 0) break;
      assignments.push({ envId, keyIndex: k, steamIds: chunk });
    }
    for (const sid of sids.slice(capacity)) uncovered.push({ steamId: sid, envId });
  }
  return { assignments, uncovered };
}

/**
 * Bounded-concurrency map: runs `fn` over `items` with at most `limit` promises in flight at once,
 * preserving result order. This is how the ban checker "threads" its login-bound work — fast, but
 * with a HARD ceiling on concurrent logins so it can never become the unbounded fan-out that crashed
 * the process during refresh storms.
 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/** Rejects if `p` hasn't settled within `ms`. The underlying Steam call may keep running, but we
 *  STOP WAITING on it — so a stalled getWebApiKey/createWebApiKey/login can never hang the check. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
