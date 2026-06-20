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
//  one: a single key checks ARBITRARY SteamIDs, so we obtain ONE key from any
//  of our own logged-in accounts (auto-creating it with the account's
//  identity_secret if needed) and cache it for the process lifetime. An explicit
//  STEAM_WEB_API_KEY env var, when set, wins (zero Steam round-trips).
//
//  SteamIDs are resolved WITHOUT a login wherever possible (live session →
//  maFile Session.SteamID → the maFile filename, which is the SteamID64), so a
//  whole folder is checked with at most one login (for the key).
// ════════════════════════════════════════════════════════════════════════════

/** Max accounts per GetPlayerBans request (Steam caps `steamids` at 100). */
const BANS_BATCH = 100;
/** How many accounts we'll try (each possibly a fresh login) before giving up on a key. */
const MAX_KEY_ATTEMPTS = 8;
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
  /** Cached Steam Web API key (process-lifetime). Cleared if Steam rejects it. */
  private apiKey?: string;
  private apiKeyFrom?: string;
  /** Read-only token reader (vault-aware) → SteamID from the refresh-token JWT, no login. */
  private readonly tokens = new TokenStore();

  constructor(
    private readonly accounts: AccountManager,
    private readonly sessions: SessionManager,
    private readonly trades:   TradeService,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Checks every given account for all Steam ban types and returns the
   * categorised result. Per-account failures (no SteamID, Steam didn't return a
   * record) surface as `error` on that account and NEVER abort the others.
   */
  async checkBans(usernames: string[]): Promise<BanCheckResult> {
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

    const infos: AccountBanInfo[] = [];
    const bySteamId = new Map<string, AccountBanInfo>();
    const unresolved: Array<{ account: AccountConfig; info: AccountBanInfo }> = [];
    for (const acc of accs) {
      const steamId = this.resolveSteamId(acc);
      const info: AccountBanInfo = {
        username: acc.username, displayName: acc.displayName, steamId,
        vacBanned: false, vacCount: 0, gameBanned: false, gameCount: 0,
        communityBanned: false, economyBan: 'none', daysSinceLastBan: 0, categories: [],
      };
      infos.push(info);
      if (steamId) bySteamId.set(steamId, info);
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

    const targets = [...bySteamId.keys()];
    if (targets.length > 0) {
      let apiKey: string;
      try {
        apiKey = await this.ensureApiKey(accs.map(a => a.username));
      } catch (err) {
        const msg = `Ban lookup unavailable: ${(err as Error).message}`;
        for (const info of infos) if (!info.error) info.error = msg;
        logger.warn(`[bans] ${redactSecrets(msg)}`);
        return this.finalize(infos);
      }

      for (let i = 0; i < targets.length; i += BANS_BATCH) {
        const batch = targets.slice(i, i + BANS_BATCH);
        try {
          const players = await this.fetchBans(apiKey, batch);
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
          const msg = `Ban lookup failed: ${(err as Error).message}`;
          for (const sid of batch) {
            const info = bySteamId.get(sid);
            if (info && !info.error) info.error = msg;
          }
          logger.warn(`[bans] ${redactSecrets(msg)}`);
        }
      }
    }

    return this.finalize(infos);
  }

  // ── Categorisation ───────────────────────────────────────────────────────────

  /** Assigns each account's category buckets and computes the totals. */
  private finalize(infos: AccountBanInfo[]): BanCheckResult {
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
    return { accounts: infos, totals, apiKeyFrom: this.apiKeyFrom };
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
        try {
          await this.trades.getTrader(account.username); // logs in if needed (+ persists a refresh token)
          const sid = this.sessions.getSession(account.username)?.steamId;
          if (sid && STEAMID64.test(sid)) { info.steamId = sid; bySteamId.set(sid, info); }
          else info.error = 'Logged in but no SteamID was returned';
        } catch (err) {
          info.error = `Login failed: ${(err as Error).message}`;
          logger.warn(`[bans] ${account.username}: SteamID login-resolve failed (${(err as Error).message})`);
        }
      }
    };
    const n = Math.max(1, Math.min(LOGIN_RESOLVE_CONCURRENCY, items.length));
    await Promise.all(Array.from({ length: n }, () => worker()));
  }

  // ── Steam Web API key acquisition ────────────────────────────────────────────

  /**
   * Returns a usable Steam Web API key: the STEAM_WEB_API_KEY env override, the
   * cached key, or one fetched/created from the first account that can provide it.
   * Tries already-logged-in accounts first to avoid unnecessary logins.
   */
  private async ensureApiKey(usernames: string[]): Promise<string> {
    const envKey = (process.env.STEAM_WEB_API_KEY ?? '').trim();
    if (envKey) { this.apiKeyFrom = 'env'; return envKey; }
    if (this.apiKey) return this.apiKey;

    // Candidate order: scoped accounts that are already logged in → other scoped
    // accounts (may need a login) → ANY other already-logged-in managed bot. The key
    // is just an API credential; the data returned is still only about the scoped
    // SteamIDs, so reusing another ready bot's key keeps a single clean-account check
    // working even when that one account can't mint a key.
    const scopedSet = new Set(usernames.map(u => u.toLowerCase()));
    const ready = usernames.filter(u => this.sessions.isReady(u));
    const rest  = usernames.filter(u => !this.sessions.isReady(u));
    const extra = this.sessions.getAllSessions()
      .map(s => s.account.username)
      .filter(u => !scopedSet.has(u.toLowerCase()) && this.sessions.isReady(u));
    const ordered = [...new Set([...ready, ...rest, ...extra])];

    let attempts = 0;
    let lastErr: Error | undefined;
    for (const username of ordered) {
      if (attempts >= MAX_KEY_ATTEMPTS) break;
      attempts++;
      try {
        const trader = await this.trades.getTrader(username);
        const community = trader.community as unknown as CommunityWithKey;
        let key = await this.getExistingKey(community);
        if (!key) key = await this.createKey(community, this.identitySecretOf(username));
        if (key) {
          this.apiKey = key;
          this.apiKeyFrom = username;
          logger.info(`[bans] obtained Steam Web API key via ${username}`);
          return key;
        }
      } catch (err) {
        lastErr = err as Error;
        logger.warn(`[bans] ${username}: could not provide an API key (${(err as Error).message})`);
      }
    }
    throw new Error(lastErr ? lastErr.message : 'no account could provide a Steam Web API key');
  }

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
   * A 401/403 invalidates the cached key so the next run re-acquires one.
   */
  private async fetchBans(apiKey: string, steamIds: string[]): Promise<SteamBanRecord[]> {
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/` +
      `?key=${encodeURIComponent(apiKey)}&steamids=${steamIds.join(',')}`;
    const r = await axios.get(url, { timeout: 15_000, proxy: false, validateStatus: () => true });
    if (r.status === 401 || r.status === 403) {
      if (this.apiKeyFrom !== 'env') { this.apiKey = undefined; this.apiKeyFrom = undefined; } // re-acquire next time
      throw new Error('Steam rejected the Web API key');
    }
    if (r.status !== 200 || !r.data || !Array.isArray(r.data.players)) {
      throw new Error(`Steam HTTP ${r.status}`);
    }
    return r.data.players as SteamBanRecord[];
  }
}
