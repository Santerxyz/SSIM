import EventEmitter from 'events';
import SteamUser from 'steam-user';
import type { AccountConfig, MaFile } from '../types/account';
import { SessionState, type ManagedSession, type WebSession } from '../types/session';
import { AgentFactory } from '../network/AgentFactory';
import { loadMaFile, buildLogOnOptions, generateTotpCode, msUntilNextTotp } from './LoginFlow';
import { TokenStore } from './TokenStore';
import { logger } from '../utils/logger';

// ─── Constants ────────────────────────────────────────────────────────────────

// ─── Timeouts (generous – slow residential / rotating proxies need headroom) ──
// FAIL FAST: a dead proxy must release the queue slot in ~15s, NOT tie it up for 90s × 5.
// The 5 connection retries (MAX_CONNECTION_ATTEMPTS) with backoff remain, but each attempt
// now hard-caps at 15s, so an unreachable proxy is given up on quickly instead of stalling
// the whole fleet queue behind one dead exit.
const LOGIN_TIMEOUT_MS       = 15_000;  // proxy/CM connection hard cap (was 90s → fail fast)
const WEB_SESSION_TIMEOUT_MS = 30_000;  // web cookies can lag behind loggedOn (post-login, not the dead-proxy path)
const INTER_LOGIN_DELAY_MS   = 3_500;   // delay between sequential account logins
const WEB_SESSION_REFRESH_S  = 20 * 60; // refresh web cookies every 20 min

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
type LoginError = Error & { eresult?: number; authFailure?: boolean; loginErrorKind?: LoginErrorKind };

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

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly tokenStore = new TokenStore();
  // Per-account in-flight login dedup (keyed by lowercase username). Ensures
  // concurrent callers share ONE login instead of destroying each other's
  // mid-handshake session. Cleared in finally when the login settles.
  private readonly loginsInFlight = new Map<string, Promise<ManagedSession>>();

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
    if (inFlight) return inFlight;
    const p = this.doLoginAccount(account, key).finally(() => this.loginsInFlight.delete(key));
    this.loginsInFlight.set(key, p);
    return p;
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
        if (kind === 'auth') {
          // STRONG evidence the token itself is bad → delete it and re-login fully.
          logger.warn(`[${account.username}] refresh token is INVALID (${(err as Error).message}) – deleting token, full login`);
          this.tokenStore.delete(account.username);
          await this.destroySession(key);
          // …fall through to the credential login below.
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
        return await this.performLogin(account, logOnOptions, maFile);
      } catch (err) {
        lastErr = err as LoginError;
        const kind = classifyLoginError(lastErr);
        lastErr.loginErrorKind = kind;

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
    // AccountManager always attaches a resolved `network` (env proxy or override);
    // fall back to local IP if it's somehow missing.
    const network = account.network ?? { type: 'localip' as const, value: '0.0.0.0' };
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
    };

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

        logger.info(`[${account.username}] Logged in  SteamID=${session.steamId}  via ${network.type}:${network.value}  – awaiting web session…`);

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
      });

      // ── disconnected ───────────────────────────────────────────────────
      client.on('disconnected', (eresult: number, msg?: string) => {
        const prev = session.state;
        session.state = SessionState.DISCONNECTED;
        const reason = msg ?? `EResult ${eresult}`;
        logger.warn(`[${account.username}] Disconnected  reason="${reason}"`);
        this.transition(session, prev, SessionState.DISCONNECTED);
        this.emit('disconnected', account.username, reason);
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
    await this.destroySession(username.toLowerCase());
  }

  async logoutAll(): Promise<void> {
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
      network:    s.account.network ? `${s.account.network.type}:${s.account.network.value}` : 'unknown',
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
    try { existing.client.logOff(); } catch { /* already gone */ }
    // 2) Drop ALL listeners (they capture the session in their closures), but
    //    keep a no-op 'error' handler: steam-user can still emit async errors
    //    after logOff, and an unhandled 'error' event would crash the process.
    try {
      existing.client.removeAllListeners();
      existing.client.on('error', () => { /* session already torn down */ });
    } catch { /* noop */ }
    // 3) Close the per-account proxy agent's pooled sockets. A fresh proxy agent is
    //    built on every login (AgentFactory.fromProxy, never reused), so without this
    //    each of the many re-logins a flaky-proxy fleet performs would orphan an agent +
    //    its sockets → OS handle/memory leak. The SHARED local-IP pool agent is skipped.
    AgentFactory.destroyIfDisposable(existing.httpsAgent);
    // 4) Release credential-bearing references (cookies) eagerly.
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
    return !!s && s.state === SessionState.LOGGED_IN && !!s.webSession;
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
