import EventEmitter from 'events';
import SteamUser from 'steam-user';
import type { AccountConfig, MaFile } from '../types/account';
import { SessionState, type ManagedSession, type WebSession, type SessionManagerEvents } from '../types/session';
import { AgentFactory, redactProxyCredentials } from '../network/AgentFactory';
import { loadMaFile, buildLogOnOptions, resolvePassword, restampTotp, generateTotpCode, msUntilNextTotp } from './LoginFlow';
import { TokenStore } from './TokenStore';
import { onTokenAuthFailure } from './accountCapability';
import { webCookiesFresh, ownsCreatedSession } from './sessionHealth';
import { logger } from '../utils/logger';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Resolves an env-tunable safety cap, honestly and observably.
 *   • unset / blank / non-numeric        → `dflt` (silent — the normal case)
 *   • `zeroOptOut` && the literal "0"     → 0, cap DISABLED (warned; only "0", never Number('')===0)
 *   • value ≥ `min`                       → `Math.floor(value)`
 *   • value < `min` (a TIGHTER request)   → clamped UP to `min` (never down to the looser `dflt`), warned
 * An operator lowering a cap below its structural floor is met at the floor, not silently
 * replaced by the weaker default — the whole point of the finding this helper fixes.
 */
export function resolveCapEnv(
  name: string,
  raw: string | undefined,
  min: number,
  dflt: number,
  zeroOptOut: boolean,
): number {
  if (zeroOptOut && raw?.trim() === '0') {
    logger.warn(`${name}=0 – cap DISABLED`);
    return 0;
  }
  const value = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(value)) return dflt;
  if (value >= min) return Math.floor(value);
  logger.warn(`${name}=${raw} is below the minimum ${min} – clamped to ${min}`);
  return min;
}

// ─── Timeouts (generous – slow residential / rotating proxies need headroom) ──
// FAIL FAST: a dead proxy must release the queue slot in ~15s, NOT tie it up for 90s × 5.
// The 5 connection retries (MAX_CONNECTION_ATTEMPTS) with backoff remain, but each attempt
// now hard-caps at 15s, so an unreachable proxy is given up on quickly instead of stalling
// the whole fleet queue behind one dead exit.
const LOGIN_TIMEOUT_MS       = 15_000;  // proxy/CM connection hard cap (was 90s → fail fast)
const WEB_SESSION_TIMEOUT_MS = 30_000;  // web cookies can lag behind loggedOn (post-login, not the dead-proxy path)
const INTER_LOGIN_DELAY_MS   = 3_500;   // delay between sequential account logins
const WEB_SESSION_REFRESH_S  = 20 * 60; // refresh web cookies every 20 min

// ─── Global login concurrency cap (anti-storm) ────────────────────────────────
// THE hard ceiling on how many NEW logins may be handshaking at once, across EVERY
// caller and both games. Without it, any path that fans a login-triggering request
// out over the whole fleet (a bulk refresh, a UI action looping all accounts, a
// retry storm) opens hundreds of simultaneous proxy/CM sockets at once → resource
// exhaustion → silent process death. The mass-op orchestrators (refresh/buy/sell)
// have their OWN 25-wide pools, but nothing capped the login PATH itself; this does,
// so no caller can ever exceed it regardless of how many fire at once. Excess logins
// queue (FIFO) and start as slots free. Per-account dedup (loginsInFlight) still
// collapses duplicate logins for the SAME account and never consumes a slot.
// Tunable via SSIM_MAX_CONCURRENT_LOGINS for ops; defaults to the documented 25 ceiling.
const MAX_CONCURRENT_LOGINS = resolveCapEnv('SSIM_MAX_CONCURRENT_LOGINS', process.env.SSIM_MAX_CONCURRENT_LOGINS, 1, 25, false);

// ─── Hard resident-session ceiling (structural anti-storm backstop) ────────────
// MAX_CONCURRENT_LOGINS bounds how many logins HANDSHAKE at once; it does NOT bound how many
// sessions stay RESIDENT afterwards. Every live session is a CM socket + a fresh per-account proxy
// agent (keepAlive sockets) + a polling TradeOfferManager, so an unbounded resident population is
// the documented resource storm that gets the process externally killed. The per-call-site releases
// (refresh / offers / mass-send / mass-sell / mass-buy / single-buy) keep each path bounded, but a
// missed release in ANY current or future caller would defeat them. This ceiling is the one place
// that makes the whole class structurally impossible: once this many sessions are resident, a NEW
// account's login is REFUSED (fast, retryable) rather than queued — so no caller can ever drive the
// live-session count past a safe socket budget. A re-login of an ALREADY-resident account is exempt
// (it replaces, never grows). Generous default (150 » every 25-wide pool, « socket exhaustion);
// tune via SSIM_MAX_LIVE_SESSIONS, set 0 to disable.
const MAX_LIVE_SESSIONS = resolveCapEnv('SSIM_MAX_LIVE_SESSIONS', process.env.SSIM_MAX_LIVE_SESSIONS, 25, 150, true);

// ─── Idle-session reaper (anti-accumulation for SINGLE-account ops) ─────────────
// Bulk ops release the sessions they create, but SINGLE-account paths (single send /
// getTradeUrl / manual per-account refresh / post-trade refresh) leave a session resident
// with no release. Touch >150 distinct accounts via single ops in one run and the resident
// count reaches MAX_LIVE_SESSIONS → every NEW-account login is then refused (B40). A periodic
// reaper logs out sessions that have gone IDLE (no genuine op used them within the TTL), so a
// one-shot op's leftover session is reclaimed instead of accumulating. A session in active use
// is touched (markUsed) on every op entry, so its lastActivityAt stays fresh and it is never
// reaped mid-use; the proactive cookie refresh is maintenance and deliberately does NOT count.
const IDLE_SESSION_TTL_MS = resolveCapEnv('SSIM_IDLE_SESSION_TTL_MS', process.env.SSIM_IDLE_SESSION_TTL_MS, 60_000, 30 * 60_000, false); // default 30 min; always ≥ 60 000 (no opt-out)
const REAPER_INTERVAL_MS = 5 * 60_000;

// ─── Retry strategy (Problem 1: transient NoConnection / proxy failures) ──────
// Steam logins over slow or rotating residential proxies frequently fail with
// TRANSIENT errors – most commonly EResult 3 (NoConnection), proxy CONNECT
// hiccups, or socket timeouts. These must NOT abort the account: we retry the
// SAME login path several times with exponential backoff before giving up.
//   • attempts per path : MAX_CONNECTION_ATTEMPTS
//   • backoff           : BACKOFF_BASE_MS, doubling each retry, capped at BACKOFF_MAX_MS
//                         (so e.g. 4s → 8s → 16s → 32s → 45s)
// Only a genuine authentication failure (see AUTH_FAILURE_ERESULTS) or a Steam
// Guard prompt on the token path aborts early.
const MAX_CONNECTION_ATTEMPTS = 5;
const BACKOFF_BASE_MS         = 4_000;
const BACKOFF_MAX_MS          = 45_000;

// ─── Token-invalidation criteria (Problem 2: don't nuke tokens on flaky proxies) ──
// A refresh token is a valuable, restart-proof credential. It is deleted ONLY when
// there is STRONG evidence it is actually invalid:
//   • the login fails with one of these Steam EResult codes, or
//   • Steam Guard is requested on a refresh-token login (a valid token never is).
// Network / proxy / timeout errors are explicitly NOT in this set, so they can
// never trigger token deletion – we keep the token and simply retry later.
//   5  = InvalidPassword (also emitted for an expired / revoked refresh token)
//   15 = AccessDenied
//   18 = AccountNotFound
//   65 = TwoFactorCodeMismatch
// (84 RateLimitExceeded is intentionally absent – it is transient → back off & retry.)
const AUTH_FAILURE_ERESULTS = new Set<number>([5, 15, 18, 65]);

type LoginErrorKind = 'auth' | 'connection';
type LoginError = Error & { eresult?: number; authFailure?: boolean; loginErrorKind?: LoginErrorKind; ceilingRefusal?: boolean };

/**
 * Classifies a login failure. 'auth' → credentials/token are bad (abort, and for
 * the token path delete the token). 'connection' → transient network/proxy issue
 * (retry with backoff, never delete the token).
 */
function classifyLoginError(err: LoginError): LoginErrorKind {
  if (err.authFailure) return 'auth';
  return err.eresult !== undefined && AUTH_FAILURE_ERESULTS.has(err.eresult) ? 'auth' : 'connection';
}

// ─── SessionManager ───────────────────────────────────────────────────────────

// Declaration merging wires the hand-written SessionManagerEvents contract onto the
// class's inherited EventEmitter surface: this.emit and every external on/once/off
// subscriber are now type-checked against SessionManagerEvents instead of bare
// (event: string, ...args: any[]). Renaming an event, changing an argument, or
// altering a payload type becomes a compile error instead of a runtime break.
// Listeners that declare fewer parameters than the signature stay assignable.
export interface SessionManager {
  on<K extends keyof SessionManagerEvents>(event: K, listener: SessionManagerEvents[K]): this;
  once<K extends keyof SessionManagerEvents>(event: K, listener: SessionManagerEvents[K]): this;
  off<K extends keyof SessionManagerEvents>(event: K, listener: SessionManagerEvents[K]): this;
  emit<K extends keyof SessionManagerEvents>(event: K, ...args: Parameters<SessionManagerEvents[K]>): boolean;
}

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly tokenStore = new TokenStore();
  // Per-account in-flight login dedup (keyed by lowercase username). Ensures
  // concurrent callers share ONE login instead of destroying each other's
  // mid-handshake session. Cleared in finally when the login settles.
  private readonly loginsInFlight = new Map<string, Promise<ManagedSession>>();
  // S48: set by logoutAll() so an in-flight login can't insert a fresh session into a manager that has
  // already been torn down (a late success would park an unmanaged live CM session + agent). Checked in
  // loginAccount / performLogin; reset by loginAll() when a deliberate new cycle starts.
  private shuttingDown = false;

  // ── Global login concurrency semaphore (see MAX_CONCURRENT_LOGINS) ──────────
  // `loginSlots` = free slots; when 0, callers park in `loginWaiters` (FIFO) and are
  // handed a slot the instant one frees. This is the ONLY gate on simultaneous logins.
  private loginSlots = MAX_CONCURRENT_LOGINS;
  private readonly loginWaiters: Array<() => void> = [];

  /** Idle-session reaper handle (B40). Unref'd so it never keeps the process alive. */
  private readonly reaperTimer?: NodeJS.Timeout;

  constructor() {
    super();
    // IDLE_SESSION_TTL_MS is always ≥ 60 000 (resolveCapEnv floors it, no opt-out), so the reaper
    // always runs. To disable the anti-storm machinery, set SSIM_MAX_LIVE_SESSIONS=0 (the ceiling), not the TTL.
    this.reaperTimer = setInterval(() => { void this.reapIdleSessions(); }, REAPER_INTERVAL_MS);
    this.reaperTimer.unref?.();
  }

  /** Marks a session as actively USED right now (called at every genuine op entry) so the idle
   *  reaper never logs out a session an operation is currently using. (B40) */
  markUsed(username: string): void {
    const s = this.sessions.get(username.toLowerCase());
    if (s) s.lastActivityAt = new Date();
  }

  /** Logs out LOGGED_IN sessions untouched for longer than the idle TTL, freeing resident slots.
   *  Skips any account with an in-flight login. Serialized-ish (best-effort; failures ignored). */
  private async reapIdleSessions(now: number = Date.now()): Promise<void> {
    const victims: Array<{ key: string; session: ManagedSession }> = [];
    for (const [key, s] of this.sessions) {
      if (this.loginsInFlight.has(key)) continue;               // a login is mid-flight → leave it
      // S11: reap SETTLED-live sessions AND settled-dead ones (DISCONNECTED/ERROR). The disconnected/error
      // handlers already deferred-destroy such a session (B43 / S11); this is a BACKSTOP for any zombie
      // that slipped past (e.g. one already resident before this fix, or where the replacement guard
      // skipped the immediate destroy) — otherwise a non-LOGGED_IN session would linger forever.
      const reapable = s.state === SessionState.LOGGED_IN
        || s.state === SessionState.DISCONNECTED || s.state === SessionState.ERROR;
      if (!reapable) continue;
      const last = s.lastActivityAt?.getTime() ?? s.loggedInAt?.getTime() ?? 0;
      if (now - last >= IDLE_SESSION_TTL_MS) victims.push({ key, session: s });
    }
    // H-ACC-002: re-validate identity+idleness at the destroy site against the LIVE map — the victims list
    // was snapshotted before the per-victim await gap, so a session markUsed'd (the anti-reap signal) or
    // re-logged-in (a fresh session swapped into the key) AFTER the scan but BEFORE its turn must be skipped,
    // not torn down mid-op. The checks and the destroy run with NO await between them → race-free on the one
    // thread. Call destroySession DIRECTLY, not logoutAccount, whose await-in-flight-then-destroy would
    // re-open the very gap this closes (and could tear down a replacement session).
    for (const { key, session } of victims) {
      const username = session.account.username;
      if (this.loginsInFlight.has(key)) continue;               // a re-login started in the gap → leave it
      const cur = this.sessions.get(key);
      if (cur !== session) continue;                            // replaced (or already gone) → not our victim
      const last = cur.lastActivityAt?.getTime() ?? cur.loggedInAt?.getTime() ?? 0;
      if (Date.now() - last < IDLE_SESSION_TTL_MS) continue;    // markUsed'd in the gap → rescued
      try { await this.destroySession(key); logger.info(`[${username}] idle session reaped (>${Math.round(IDLE_SESSION_TTL_MS / 60000)}min unused) – slot freed`); }
      catch (err) { logger.warn(`[${username}] idle-session reap failed: ${(err as Error).message}`); }
    }
  }

  /** Stops the reaper (call on teardown/re-license so a discarded manager leaves no timer). */
  shutdown(): void {
    if (this.reaperTimer) clearInterval(this.reaperTimer);
  }

  /** True when the refresh-token store is DEGRADED (present-but-corrupt file → not persisting). Surfaced
   *  on the status endpoint so the operator restores it before a mass refresh re-auths the fleet. (B2.) */
  isTokenStoreDegraded(): boolean { return this.tokenStore.isDegraded(); }

  /** Acquire one login slot, awaiting (FIFO) if all are in use. */
  private acquireLoginSlot(): Promise<void> {
    if (this.loginSlots > 0) { this.loginSlots--; return Promise.resolve(); }
    return new Promise<void>((resolve) => this.loginWaiters.push(resolve));
  }

  /** Release one login slot — handed directly to the next waiter, else returned to the pool. */
  private releaseLoginSlot(): void {
    const next = this.loginWaiters.shift();
    if (next) next();              // hand the slot straight to the next waiter (count unchanged)
    else this.loginSlots++;        // no waiter → return it to the free pool
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Logs an account in and resolves once it is LOGGED_IN with web cookies ready.
   *
   * Login strategy (browser-like persistence):
   *   1. If a refresh token is stored on disk, log in with it – NO password, NO
   *      2FA, survives PC restarts and IP changes.
   *   2. On token failure (expired/revoked) the token is cleared and we fall
   *      back to a full credential + maFile-TOTP login. The fresh refresh token
   *      emitted by that login is persisted for next time.
   */
  async loginAccount(account: AccountConfig): Promise<ManagedSession> {
    // ── In-flight guard ────────────────────────────────────────────────────
    // If a login for this account is already running, return its promise instead
    // of starting a second one. Two concurrent callers (InventoryService refresh,
    // TradeService/MarketService getTrader, a trade's getTradeUrl, or a cs2-vs-tf2
    // refresh of the same account) would otherwise each call destroySession() on
    // the other's mid-handshake client and kill each other's login. The guard
    // lives HERE in SessionManager so it covers EVERY caller and both games.
    const key = account.username.toLowerCase();
    const inFlight = this.loginsInFlight.get(key);
    if (inFlight) return inFlight;   // dedup: share the running login, no slot consumed
    // S48: refuse a NEW login once teardown has begun — never build a session in a manager being discarded.
    if (this.shuttingDown) {
      return Promise.reject(Object.assign(
        new Error(`${account.username}: login refused – session manager is shutting down`),
        { loginErrorKind: 'connection' as LoginErrorKind, ceilingRefusal: true },
      ));
    }
    // ── Hard resident-session ceiling ────────────────────────────────────────
    // Refuse a NEW account's login (fast, before consuming a slot) once the live-session
    // population is at the cap, so no caller can ever drive resident sockets past a safe budget.
    // A re-login of an account that already holds a session is exempt (it replaces, never grows).
    // Classified 'connection' so it bubbles as a transient, retryable per-account failure (the bulk
    // orchestrators already record it and carry on) and NEVER deletes a refresh token.
    if (MAX_LIVE_SESSIONS > 0 && !this.sessions.has(key) && this.sessions.size >= MAX_LIVE_SESSIONS) {
      return Promise.reject(Object.assign(
        new Error(`live-session ceiling ${MAX_LIVE_SESSIONS} reached – ${account.username} skipped (a bulk op may not be releasing sessions); retry shortly`),
        { loginErrorKind: 'connection' as LoginErrorKind, ceilingRefusal: true },
      ));
    }
    // Wrap the real login in the global concurrency slot. A queued caller holds NO
    // resources while it waits — it only begins handshaking once a slot frees. The
    // slot is released the moment the login settles (success OR failure), and the
    // dedup entry is cleared in the same breath so the next caller can start fresh.
    const p = (async (): Promise<ManagedSession> => {
      await this.acquireLoginSlot();
      try {
        return await this.doLoginAccount(account, key);
      } finally {
        this.releaseLoginSlot();
      }
    })().finally(() => this.loginsInFlight.delete(key));
    this.loginsInFlight.set(key, p);
    return p;
  }

  /**
   * Like loginAccount, but also reports whether THIS call originated the login, so a
   * bulk op can release exactly the sessions it created and never tear down a session
   * another operation owns. `createdByCall` is decided SYNCHRONOUSLY here (before any
   * await), race-free with loginAccount's in-flight dedup. (C17 / INV-A6.)
   */
  async loginAccountOwned(account: AccountConfig): Promise<{ session: ManagedSession; createdByCall: boolean }> {
    const key = account.username.toLowerCase();
    const createdByCall = ownsCreatedSession(this.loginsInFlight.has(key), this.sessions.has(key));
    const session = await this.loginAccount(account);
    return { session, createdByCall };
  }

  /**
   * Persists a freshly-negotiated Auth-v2 refresh token for an account (Feature 1
   * "Account Login" import). Routes through the SAME TokenStore loginAccount() reads,
   * so a QR/credentials-imported account logs in TOKEN-FIRST with no further prompts —
   * landing in the portable vault in vault mode, or refresh_tokens.json otherwise.
   */
  rememberRefreshToken(username: string, token: string): boolean {
    if (typeof token === 'string' && token) return this.tokenStore.set(username, token);
    return false;
  }

  private async doLoginAccount(account: AccountConfig, key: string): Promise<ManagedSession> {
    await this.destroySession(key);

    // Load the maFile up front (best-effort). It carries identity_secret, which
    // trade confirmations need REGARDLESS of which login path we take, so we
    // attach it to the session even on the token path.
    const maFile = this.tryLoadMaFile(account);

    // 1) Try the stored refresh token first (retried on connection errors).
    const storedToken = this.tokenStore.get(account.username);
    if (storedToken) {
      try {
        logger.info(`[${account.username}] logging in with stored refresh token (no password/2FA)…`);
        return await this.attemptLogin(account, { refreshToken: storedToken }, maFile, 'token');
      } catch (err) {
        const kind = (err as LoginError).loginErrorKind ?? 'connection';
        if (kind === 'auth' && onTokenAuthFailure({ hasMaFile: !!maFile, hasPassword: !!resolvePassword(account) }) === 'delete-and-retry') {
          // STRONG evidence the token is bad AND we have a usable credential fallback
          // (maFile + password) → delete the token and re-login via credentials.
          logger.warn(`[${account.username}] refresh token is INVALID (${(err as Error).message}) – deleting token, full login`);
          this.tokenStore.delete(account.username);
          await this.destroySession(key);
          // …fall through to the credential login below.
        } else if (kind === 'auth') {
          // No usable credential fallback (needs maFile + password): the refresh token is
          // this account's SOLE credential. PRESERVE it — a misclassified/transient 'auth'
          // verdict must never permanently strand the account — and surface a re-import
          // requirement. (INV-A2 / C8.)
          logger.error(`[${account.username}] token login failed (auth) with no usable credential fallback (needs maFile + password) – token PRESERVED; account needs re-import (QR/credentials)`);
          throw err;
        } else {
          // Connection/proxy problem after all retries → the token is almost
          // certainly still valid. KEEP it and abort this round; a later attempt
          // (next refresh) can reuse it once the proxy/network recovers.
          logger.error(`[${account.username}] token login failed after ${MAX_CONNECTION_ATTEMPTS} attempts (connection) – token PRESERVED, aborting this round`);
          throw err;
        }
      }
    }

    // 2) Full credential + maFile-TOTP login (also retried on connection errors).
    if (!maFile) throw new Error(`maFile required for credential login: ${account.username}`);
    return this.attemptLogin(account, buildLogOnOptions(account, maFile), maFile, 'credential');
  }

  /**
   * Runs {@link performLogin} with the retry strategy documented at the top of the
   * file: 'connection' failures are retried up to MAX_CONNECTION_ATTEMPTS times
   * with exponential backoff; 'auth' failures abort immediately. The error thrown
   * on exhaustion/abort carries `.loginErrorKind` so the caller can decide whether
   * to delete the refresh token.
   */
  private async attemptLogin(
    account:      AccountConfig,
    logOnOptions: Record<string, unknown>,
    maFile:       MaFile | undefined,
    pathLabel:    'token' | 'credential',
  ): Promise<ManagedSession> {
    let lastErr: LoginError = Object.assign(new Error('login not attempted'), { loginErrorKind: 'connection' as LoginErrorKind });

    for (let attempt = 1; attempt <= MAX_CONNECTION_ATTEMPTS; attempt++) {
      try {
        // The credential payload's TOTP is valid for one 30s window; a retry re-sends the
        // SAME object minutes later. Re-stamp a current-window code before every retry so
        // attempt 2 logs in on its first logOn instead of losing the stale-code Steam Guard
        // race against the 15s login timeout. Attempt 1 keeps the just-built code; the token
        // path ({ refreshToken }) carries no maFile and is untouched.
        if (attempt > 1 && pathLabel === 'credential' && maFile) restampTotp(logOnOptions, maFile);
        return await this.performLogin(account, logOnOptions, maFile);
      } catch (err) {
        lastErr = err as LoginError;
        const kind = classifyLoginError(lastErr);
        lastErr.loginErrorKind = kind;

        // S49: a resident-ceiling insertion refusal (B46) — and an S48 shutdown abort — must NOT be retried
        // in-slot. Retrying holds a login slot through ~60s of backoff and rebuilds/tears down a client each
        // time: a starvation amplifier exactly when the ceiling is saturated. The client was already torn
        // down in performLogin; bubble straight up so the caller retries the whole account later (a slot may
        // have freed by then). classified 'connection' → the bulk orchestrators record it and carry on.
        if (lastErr.ceilingRefusal) {
          logger.warn(`[${account.username}] ${pathLabel} login: ${lastErr.message} – not retrying in-slot`);
          throw lastErr;
        }

        // Auth failure → no point retrying; bubble up so loginAccount can react.
        if (kind === 'auth') {
          logger.warn(`[${account.username}] ${pathLabel} login: authentication failed (EResult=${lastErr.eresult ?? 'n/a'}) – not retrying`);
          // Tear the dead client down BEFORE bubbling up. The connection branch below
          // destroys on every attempt, but the auth branch previously threw straight
          // out, leaving an ERROR session in the map with its SteamUser client (open
          // CM/proxy socket + listeners) lingering until the next login for this user.
          await this.destroySession(account.username.toLowerCase());
          throw lastErr;
        }

        // Connection failure → discard the dead client, back off, retry.
        await this.destroySession(account.username.toLowerCase());
        if (attempt < MAX_CONNECTION_ATTEMPTS) {
          const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
          logger.warn(`[${account.username}] ${pathLabel} login attempt ${attempt}/${MAX_CONNECTION_ATTEMPTS} failed (connection: ${lastErr.message}) – retrying in ${Math.round(backoff / 1000)}s`);
          await sleep(backoff);
        }
      }
    }

    logger.error(`[${account.username}] ${pathLabel} login: all ${MAX_CONNECTION_ATTEMPTS} attempts failed (connection) – giving up for now`);
    lastErr.loginErrorKind = 'connection';
    throw lastErr;
  }

  /** Loads the maFile, returning undefined (with a warning) instead of throwing. */
  private tryLoadMaFile(account: AccountConfig): MaFile | undefined {
    try {
      return loadMaFile(account);
    } catch (err) {
      logger.warn(`[${account.username}] maFile not loaded (${(err as Error).message}) – trade confirmations disabled`);
      return undefined;
    }
  }

  /**
   * Single login attempt with a fully isolated SteamUser instance. `logOnOptions`
   * is either `{ refreshToken }` or full `{ accountName, password, twoFactorCode }`.
   * `maFile` is only needed for the credential path (to answer Steam Guard).
   */
  private performLogin(
    account:      AccountConfig,
    logOnOptions: Record<string, unknown>,
    maFile?:      MaFile,
  ): Promise<ManagedSession> {
    const key = account.username.toLowerCase();
    const isTokenLogin = !!logOnOptions.refreshToken;

    // ── Per-account network isolation ──────────────────────────────────────
    // httpsAgent is stored on the session and reused by the InventoryManager.
    // AccountManager ALWAYS attaches a resolved `network` (env proxy or override) via
    // withNetwork on every query path. A missing `network` means a caller hand-built an
    // AccountConfig and bypassed that layer — REFUSE rather than fail open to the host IP,
    // which would log a proxy-isolated farm account in from the operator's real IP with no
    // error (Steam then links the account to the home IP). Mirrors the server.ts:724 refusal.
    if (!account.network) {
      throw Object.assign(
        new Error(`${account.username}: no resolved network attached (caller bypassed AccountManager.withNetwork) – refusing to log in without the account's proxy/binding`),
        { loginErrorKind: 'connection' as LoginErrorKind, ceilingRefusal: true }, // S49: deterministic config error → not retried in-slot
      );
    }
    const network = account.network;
    const { steamUserOptions, httpsAgent } = AgentFactory.create(network);

    // ── Create a fresh, isolated SteamUser instance ────────────────────────
    const client = new SteamUser({
      ...steamUserOptions,
      dataDirectory:    null,   // we persist the refresh token ourselves (TokenStore)
      autoRelogin:      false,  // we handle reconnection ourselves
      singleSentryfile: false,
      enablePicsCache:  false,
    });

    const session: ManagedSession = {
      account,
      client,
      httpsAgent,
      maFile,
      state:         SessionState.CONNECTING,
      loginAttempts: 0,
      lastActivityAt: new Date(), // a fresh login counts as activity (reaper grace)
    };

    // Resident-ceiling re-check AT the insertion point (B46). The check in loginAccount runs
    // BEFORE acquireLoginSlot and the entry is inserted here, up to a full backoff later — so a
    // burst admitted while the map was momentarily small could overshoot the budget. This
    // re-check is SYNCHRONOUS with the set() below (no await between), so it is race-free: once
    // the map is at the cap, a NEW account's insertion is refused (transient/retryable). A
    // re-login of an already-resident account is exempt (it replaces, never grows). We must
    // tear the freshly-built client down so it doesn't leak a CM/proxy socket.
    if (MAX_LIVE_SESSIONS > 0 && !this.sessions.has(key) && this.sessions.size >= MAX_LIVE_SESSIONS) {
      try { client.on('error', () => { /* discarded */ }); client.logOff(); } catch { /* noop */ }
      neutralizeSteamClient(client);
      AgentFactory.destroyIfDisposable(httpsAgent);
      throw Object.assign(
        new Error(`live-session ceiling ${MAX_LIVE_SESSIONS} reached at insertion – ${account.username} skipped; retry shortly`),
        { loginErrorKind: 'connection' as LoginErrorKind, ceilingRefusal: true }, // S49: non-retryable in-slot
      );
    }

    // S48: teardown began while this login was handshaking — abort at the insertion point (SYNCHRONOUS with
    // the set() below, so race-free) rather than parking a fresh session in a manager being discarded. Tear
    // the freshly-built client down so it doesn't leak a CM/proxy socket.
    if (this.shuttingDown) {
      try { client.on('error', () => { /* discarded */ }); client.logOff(); } catch { /* noop */ }
      neutralizeSteamClient(client);
      AgentFactory.destroyIfDisposable(httpsAgent);
      throw Object.assign(
        new Error(`${account.username}: login aborted at insertion – session manager is shutting down`),
        { loginErrorKind: 'connection' as LoginErrorKind, ceilingRefusal: true },
      );
    }

    this.sessions.set(key, session);
    this.transition(session, SessionState.DISCONNECTED, SessionState.CONNECTING);

    return new Promise<ManagedSession>((resolve, reject) => {
      let loginTimeoutHandle:      NodeJS.Timeout;
      let webSessionTimeoutHandle: NodeJS.Timeout | undefined;
      // Guards the single allowed settlement: the periodic webSession refreshes
      // (and any late events) must NOT re-settle this promise.
      let settled = false;

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(loginTimeoutHandle);
        if (webSessionTimeoutHandle) clearTimeout(webSessionTimeoutHandle);
        session.state    = SessionState.ERROR;
        session.lastError = err.message;
        this.emit('error', account.username, err);
        reject(err);
      };

      const succeed = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(loginTimeoutHandle);
        if (webSessionTimeoutHandle) clearTimeout(webSessionTimeoutHandle);
        resolve(session);
      };

      // ── refreshToken – persist for browser-like, restart-proof logins ──
      client.on('refreshToken', (token: string) => {
        if (typeof token === 'string' && token) this.tokenStore.set(account.username, token); // #37: never persist a non-string token
      });

      // ── wallet – capture Steam balance (fires shortly after login) ─────
      client.on('wallet', (hasWallet: boolean, currency: number, balance: number) => {
        session.wallet = { hasWallet, currency, balance };
        logger.info(`[${account.username}] wallet balance ${balance} (currency ${currency})`);
      });

      // ── steamGuard – handle 2FA challenge (credential path only) ───────
      client.on('steamGuard', (domain: string | null, callback: (code: string) => void, lastCodeWrong: boolean) => {
        // A VALID refresh token never triggers Steam Guard. If it does, the token
        // is invalid → flag as an auth failure so the caller deletes it (Problem 2).
        if (isTokenLogin) {
          const e: LoginError = new Error(`Steam Guard requested on refresh-token login – token invalid (${account.username})`);
          e.authFailure = true;
          fail(e);
          return;
        }
        if (domain !== null) {
          fail(new Error(`Email-based Steam Guard not supported (account: ${account.username})`));
          return;
        }
        if (!maFile) {
          fail(new Error(`Steam Guard requested without maFile (credential login) – ${account.username}`));
          return;
        }

        if (lastCodeWrong) {
          // Wait for the next TOTP window before retrying
          const wait = msUntilNextTotp() + 500;
          logger.warn(`[${account.username}] TOTP rejected – retrying in ${wait}ms`);
          // #40: don't fire on an already-settled (failed/torn-down) login, and unref so a
          // pending retry never keeps the process alive.
          const totpTimer = setTimeout(() => { if (!settled) callback(generateTotpCode(maFile.shared_secret)); }, wait);
          totpTimer.unref?.();
        } else {
          callback(generateTotpCode(maFile.shared_secret));
        }
      });

      // ── loggedOn ───────────────────────────────────────────────────────
      // NOTE: logging on is NOT the same as being "ready". Steam delivers the
      // web-session cookies a few ms later via the 'webSession' event. We must
      // wait for those cookies before resolving, otherwise the InventoryManager
      // fails with "no web session cookies available" (classic race condition).
      client.once('loggedOn', () => {
        clearTimeout(loginTimeoutHandle);

        session.state     = SessionState.LOGGED_IN;
        session.steamId   = client.steamID?.getSteamID64() ?? undefined;
        session.loggedInAt = new Date();
        session.loginAttempts++;

        logger.info(`[${account.username}] Logged in  SteamID=${session.steamId}  via ${network.type}:${network.type === 'proxy' ? redactProxyCredentials(network.value) : network.value}  – awaiting web session…`);

        this.transition(session, SessionState.LOGGING_IN, SessionState.LOGGED_IN);
        this.emit('loggedIn', account.username, session.steamId ?? '');

        // Request web cookies (fires 'webSession' shortly after)
        client.webLogOn();

        // Separate deadline for the cookies. If Steam never delivers them, the
        // account logged in but is unusable for web API calls → treat as failure.
        webSessionTimeoutHandle = setTimeout(() => {
          fail(new Error(
            `Web session timeout after ${WEB_SESSION_TIMEOUT_MS / 1000}s ` +
            `(logged in but no cookies received) – ${account.username}`,
          ));
          try { client.logOff(); } catch { /* noop */ }
        }, WEB_SESSION_TIMEOUT_MS);
      });

      // ── webSession ─────────────────────────────────────────────────────
      // Fires on the initial login AND on every later refresh. We store the
      // cookies every time, but only the FIRST occurrence resolves the login
      // promise (subsequent refreshes just update the stored cookies).
      client.on('webSession', (sessionId: string, cookies: string[]) => {
        session.webSession = { sessionId, cookies, obtainedAt: new Date() };
        logger.info(`[${account.username}] Web session ready  cookies=${cookies.length}`);
        this.emit('webSession', account.username, session.webSession);

        // The account is only truly "ready" once cookies are stored.
        succeed();

        // Proactively refresh web cookies before they expire. The handle is
        // stored on the session (and the previous one cleared) so destroySession
        // can cancel it – otherwise the closure keeps the dead client alive.
        if (session.cookieRefreshTimer) clearTimeout(session.cookieRefreshTimer);
        session.cookieRefreshTimer = setTimeout(() => {
          if (session.state === SessionState.LOGGED_IN) {
            logger.debug(`[${account.username}] Refreshing web session…`);
            // Route through the deduped refresher (#30) so this never races an ad-hoc one.
            void refreshWebSession(session).catch((e) =>
              logger.warn(`[${account.username}] proactive web-session refresh failed: ${(e as Error).message}`));
          }
        }, WEB_SESSION_REFRESH_S * 1000);
        session.cookieRefreshTimer.unref?.();
      });

      // ── error ──────────────────────────────────────────────────────────
      // PERSISTENT listener (not once): steam-user also emits fatal errors AFTER
      // a successful login (e.g. LoggedInElsewhere). Without a live listener the
      // EventEmitter would throw and the session would linger as a LOGGED_IN
      // zombie. Post-login we mark the session dead so ensureSession() re-logs-in.
      client.on('error', (err: Error & { eresult?: number }) => {
        logger.error(`[${account.username}] Steam error  EResult=${err.eresult ?? '?'}  msg=${err.message}`);
        if (!settled) { fail(err); return; }
        const prev = session.state;
        session.lastError = err.message;
        this.transition(session, prev, SessionState.ERROR);
        this.emit('disconnected', account.username, `fatal: ${err.message}`);
        // B43: a post-settle fatal (e.g. LoggedInElsewhere) previously left the session RESIDENT
        // in ERROR state — its TradeOfferManager kept polling every 20s on now-dead cookies
        // forever (bulk release skips it: isLive is false for ERROR), a steady background
        // request storm + pinned memory. Tear it down so 'sessionDestroyed' fires and the trader
        // poller/GC handle/agent are released. Guard against destroying a REPLACEMENT session: a
        // re-login may have already swapped a fresh session into this key, so only destroy if the
        // map still holds THIS exact instance. Deferred a tick so we never destroy mid-emit.
        setTimeout(() => {
          if (this.sessions.get(key) === session) void this.destroySession(key);
        }, 0).unref?.();
      });

      // ── disconnected ───────────────────────────────────────────────────
      client.on('disconnected', (eresult: number, msg?: string) => {
        const prev = session.state;
        session.state = SessionState.DISCONNECTED;
        const reason = msg ?? `EResult ${eresult}`;
        logger.warn(`[${account.username}] Disconnected  reason="${reason}"`);
        this.transition(session, prev, SessionState.DISCONNECTED);
        this.emit('disconnected', account.username, reason);
        // S11: a post-settle CM drop (proxy blip → 'disconnected', no 'error'; autoRelogin:false) used to
        // leave the session RESIDENT in DISCONNECTED — counted against MAX_LIVE_SESSIONS, holding its proxy
        // agent + TradeOfferManager poller — and NOTHING reaped it (the error handler's B43 destroy only
        // fires on 'error'; the idle reaper skips non-LOGGED_IN). Mirror B43 here: tear it down so
        // 'sessionDestroyed' fires and the slot/agent/poller are released. Same replacement guard (only
        // destroy if the map still holds THIS instance — a re-login may have swapped in a fresh one) and
        // deferred a tick so we never destroy mid-emit.
        setTimeout(() => {
          if (this.sessions.get(key) === session) void this.destroySession(key);
        }, 0).unref?.();
      });

      // ── Kick off login ─────────────────────────────────────────────────
      session.state = SessionState.LOGGING_IN;

      loginTimeoutHandle = setTimeout(() => {
        fail(new Error(`Login timeout after ${LOGIN_TIMEOUT_MS / 1000}s (${account.username})`));
        client.logOff();
      }, LOGIN_TIMEOUT_MS);

      const mode = logOnOptions.refreshToken ? 'refreshToken' : 'credentials';
      logger.info(`[${account.username}] Initiating login (${mode})…`);
      client.logOn(logOnOptions);
    });
  }

  /**
   * Logs in all enabled accounts sequentially with a short delay between each
   * to avoid Steam's per-IP login rate-limit.
   */
  async loginAll(
    accounts:  AccountConfig[],
    delayMs:   number = INTER_LOGIN_DELAY_MS,
  ): Promise<{ ok: ManagedSession[]; failed: Array<{ username: string; error: string }> }> {
    this.shuttingDown = false; // S48: a deliberate new login cycle clears any prior teardown latch
    const ok:     ManagedSession[]                              = [];
    const failed: Array<{ username: string; error: string }>   = [];

    const enabled = accounts.filter(a => a.enabled);
    logger.info(`Starting login for ${enabled.length} account(s)…`);

    for (let i = 0; i < enabled.length; i++) {
      const account = enabled[i];
      try {
        const session = await this.loginAccount(account);
        ok.push(session);
      } catch (err) {
        const msg = (err as Error).message;
        logger.error(`Failed: ${account.username}  reason="${msg}"`);
        failed.push({ username: account.username, error: msg });
      }

      if (i < enabled.length - 1 && delayMs > 0) {
        await sleep(delayMs);
      }
    }

    logger.info(`Login complete – ok=${ok.length}  failed=${failed.length}`);
    return { ok, failed };
  }

  // ── Logout ─────────────────────────────────────────────────────────────────

  async logoutAccount(username: string): Promise<void> {
    const key = username.toLowerCase();
    // If a login for this account is mid-handshake, let it SETTLE before tearing the
    // session down — otherwise destroySession races the in-flight performLogin and can
    // leave a half-built client. This also makes a proxy-edit's logout deterministic: the
    // old-proxy login finishes and is destroyed, and the next login uses the freshly-set
    // proxy (resolveNetwork reads it at login time). (INV-A4 / A-4.)
    const inFlight = this.loginsInFlight.get(key);
    if (inFlight) { try { await inFlight; } catch { /* a failed login still needs teardown */ } }
    await this.destroySession(key);
  }

  async logoutAll(): Promise<void> {
    // S48: latch shutdown FIRST so no new login is admitted and any login mid-handshake aborts at its
    // insertion point, THEN drain the logins already in flight so a late success can't insert a fresh
    // session AFTER we tear down (which would strand an unmanaged live CM session + agent). Only then
    // destroy the resident sessions.
    this.shuttingDown = true;
    const inFlight = [...this.loginsInFlight.values()];
    if (inFlight.length) await Promise.allSettled(inFlight);
    for (const key of this.sessions.keys()) {
      await this.destroySession(key);
    }
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  getSession(username: string): ManagedSession | undefined {
    return this.sessions.get(username.toLowerCase());
  }

  getAllSessions(): ManagedSession[] {
    return [...this.sessions.values()];
  }

  /**
   * True when the account currently has a live (logged-in) or mid-login session.
   * Bulk operations check this BEFORE they touch an account so they release ONLY the
   * sessions they themselves create — never one the user already had live (e.g. one
   * mid-trade) or that another op logged in concurrently. LOGGING_IN counts as live so
   * an in-flight login the user just kicked off isn't treated as "ours" to tear down.
   */
  isLive(username: string): boolean {
    const s = this.sessions.get(username.toLowerCase());
    return !!s && (s.state === SessionState.LOGGED_IN || s.state === SessionState.LOGGING_IN);
  }

  getStatus(): Array<{
    username:  string;
    state:     SessionState;
    steamId?:  string;
    network:   string;
    loggedInAt?: string;
  }> {
    return this.getAllSessions().map(s => ({
      username:   s.account.username,
      state:      s.state,
      steamId:    s.steamId,
      network:    s.account.network ? `${s.account.network.type}:${s.account.network.type === 'proxy' ? redactProxyCredentials(s.account.network.value) : s.account.network.value}` : 'unknown',
      loggedInAt: s.loggedInAt?.toISOString(),
    }));
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async destroySession(key: string): Promise<void> {
    const existing = this.sessions.get(key);
    if (!existing) return;
    // 1) Cancel the pending cookie-refresh timer (would otherwise pin the dead
    //    client + closure in memory for up to 20 minutes per re-login).
    if (existing.cookieRefreshTimer) {
      clearTimeout(existing.cookieRefreshTimer);
      existing.cookieRefreshTimer = undefined;
    }
    // 2) Teardown listener discipline: an unhandled 'error' event throws, so a live
    //    'error' handler must exist at EVERY instant of teardown. Attach a no-op
    //    BEFORE logOff (belt: covers a client whose real handlers were never wired),
    //    and RE-attach it in its own try after the listener sweep — if the sweep
    //    throws, the earlier catch must not also swallow the re-attach.
    const noopError = (): void => { /* session already torn down */ };
    try { existing.client.on('error', noopError); } catch { /* noop */ }
    try { existing.client.logOff(); } catch { /* already gone */ }
    // 2b) Neutralize the discarded client so it can NEVER resurrect itself. This is
    //    the core of the native-crash / login-storm class: steam-user's logOff() does
    //    NOT clear _logonMsgTimeout — a teardown landing while a ClientLogon is in
    //    flight (the exact 15s-timeout / connection-retry teardown a proxy ECONNRESET
    //    storm triggers hundreds of times) leaves that 5s timer alive; it fires
    //    _disconnect()+_enqueueLogonAttempt() → logOn(true), fully reconnecting a
    //    client SSIM already deleted from the map — an invisible CM session +
    //    heartbeat + login retries counted by NOTHING (outside MAX_CONCURRENT_LOGINS /
    //    MAX_LIVE_SESSIONS), and later a LoggedInElsewhere kick of the account's real
    //    login. steam-user exposes no destroy(), so we defensively silence the exact
    //    reconnect machinery (all guarded; unknown-field access is a safe no-op).
    neutralizeSteamClient(existing.client);
    // 3) Drop ALL listeners (they capture the session in their closures)…
    try { existing.client.removeAllListeners(); } catch { /* noop */ }
    // …then restore the no-op 'error' handler: steam-user can still emit async
    // errors after logOff, and an unhandled 'error' event would crash the process.
    try { existing.client.on('error', noopError); } catch { /* noop */ }
    // 4) Retire the per-account proxy agent. A fresh proxy agent is built on every
    //    login (AgentFactory.fromProxy, never reused), so it must be released here —
    //    but NEVER destroyed while it still owns in-flight sockets/requests (the
    //    teardown-quiescence invariant; see AgentFactory.destroyIfDisposable). The
    //    SHARED local-IP pool agent is skipped inside.
    AgentFactory.destroyIfDisposable(existing.httpsAgent);
    // 5) Release credential-bearing references (cookies) eagerly.
    existing.webSession = undefined;
    existing.state = SessionState.DISCONNECTED;
    this.sessions.delete(key);
    // Consumers holding per-session resources (e.g. TradeService's traders with
    // their 5s pollers) listen for this to shut those down – no zombie pollers.
    this.emit('sessionDestroyed', existing.account.username);
    logger.info(`Session destroyed: ${existing.account.username}`);
  }

  private transition(session: ManagedSession, prev: SessionState, next: SessionState): void {
    session.state = next;
    this.emit('stateChange', session.account.username, prev, next);
  }

  // ── Web-session maintenance ──────────────────────────────────────────────────

  /**
   * True when the session is fully usable for web API calls (logged in + cookies).
   */
  isReady(username: string): boolean {
    const s = this.sessions.get(username.toLowerCase());
    // Not just "a webSession object exists" — its cookies must still be FRESH, or a
    // call would run on silently-expired cookies (C16 / INV-A5).
    return !!s && s.state === SessionState.LOGGED_IN && !!s.webSession && webCookiesFresh(s.webSession.obtainedAt);
  }

  /**
   * Silently refreshes the web-session cookies for an already logged-in account
   * WITHOUT re-running the full login flow (no Steam Guard, same open CM/proxy
   * connection → no IP hop). Delegates to the standalone refreshWebSession().
   */
  async refreshWebSession(username: string): Promise<void> {
    const session = this.sessions.get(username.toLowerCase());
    if (!session) throw new Error(`No session for ${username}`);
    await refreshWebSession(session);
  }
}

// ─── Standalone helpers ─────────────────────────────────────────────────────────

/**
 * Defensively prevents a discarded steam-user client from resurrecting itself after
 * teardown. steam-user offers no public destroy(), and its logOff() leaves reconnect
 * machinery armed (notably _logonMsgTimeout, which is NOT cleared by
 * _cleanupClosedConnection — verified in node_modules/steam-user 5.x). Left alone,
 * that timer fires _enqueueLogonAttempt() → logOn(true) and brings a client SSIM has
 * already deleted from its map back to life: an uncapped CM login-retry storm that is
 * the leading suspect for the field 0xC0000409 fast-fail under a proxy ECONNRESET
 * storm at fleet scale.
 *
 * We reach into documented-stable 5.x internals, every access guarded so a future
 * rename simply degrades to a partial no-op (never a throw): clear the logon-message
 * timeout, cancel reconnect/backoff timers, mark the connection closed, and finally
 * REPLACE logOn with an inert stub so even an already-resolved backoff promise's
 * `this.logOn(true)` cannot reconnect. Idempotent and safe on any object.
 */
export function neutralizeSteamClient(client: unknown): void {
  if (!client || typeof client !== 'object') return;
  const c = client as Record<string, unknown> & {
    _logonMsgTimeout?: NodeJS.Timeout;
    _heartbeatInterval?: NodeJS.Timeout;
    _cancelReconnectTimers?: (dontClearBackoffTime?: boolean) => void;
    logOn?: (...a: unknown[]) => unknown;
  };
  try { if (c._logonMsgTimeout) clearTimeout(c._logonMsgTimeout); } catch { /* noop */ }
  try { if (c._heartbeatInterval) clearInterval(c._heartbeatInterval); } catch { /* noop */ }
  try { c._cancelReconnectTimers?.(); } catch { /* noop */ }
  try { c._connectionClosed = true; } catch { /* noop */ }
  // The ultimate backstop: a torn-down client must never log on again, whatever
  // internal timer/promise tries to. A no-op logOn makes resurrection impossible.
  try { c.logOn = (): void => { /* client torn down — no resurrection */ }; } catch { /* noop */ }
}


/**
 * Triggers client.webLogOn() on an existing, logged-in SteamUser instance and
 * resolves once fresh cookies arrive (updating session.webSession in place).
 * This keeps the SAME underlying CM/proxy connection open – critical when using
 * rotating residential proxies, where a full re-login would land on a new IP and
 * trip Steam's security filter.
 */
export function refreshWebSession(session: ManagedSession, timeoutMs = WEB_SESSION_TIMEOUT_MS): Promise<void> {
  // Dedup concurrent refreshes (#30): the proactive 20-min timer and an ad-hoc caller
  // must share ONE in-flight webLogOn rather than firing two with mismatched 'webSession'
  // listeners racing for the same event.
  if (session.webRefreshInFlight) return session.webRefreshInFlight;
  const p = new Promise<void>((resolve, reject) => {
    const client = session.client;

    const timer = setTimeout(() => {
      client.removeListener('webSession', onWeb);
      reject(new Error(`web session refresh timeout (${timeoutMs / 1000}s) for ${session.account.username}`));
    }, timeoutMs);

    const onWeb = (sessionId: string, cookies: string[]): void => {
      clearTimeout(timer);
      session.webSession = { sessionId, cookies, obtainedAt: new Date() };
      logger.info(`[${session.account.username}] web session silently refreshed  cookies=${cookies.length}`);
      resolve();
    };

    client.once('webSession', onWeb);
    client.webLogOn();
  }).finally(() => { if (session.webRefreshInFlight === p) session.webRefreshInFlight = undefined; });
  session.webRefreshInFlight = p;
  return p;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
