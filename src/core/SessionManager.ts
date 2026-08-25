import EventEmitter from 'events';
import SteamUser from 'steam-user';
import type { AccountConfig, MaFile } from '../types/account';
import { SessionState, type ManagedSession, type WebSession, type SessionManagerEvents } from '../types/session';
import { AgentFactory, redactProxyCredentials, normalizeProxy, type HttpAgent } from '../network/AgentFactory';
import { egressRotation } from '../network/EgressRotation';
import { proxyHealth, proxyKey, isResetClass } from '../network/ProxyHealth';
import { chooseCmProtocol, noteCmOutcome, CmProtocolLabel, TCP_FAILURES_TO_DEMOTE } from '../network/CmProtocol';
import { loadMaFile, buildLogOnOptions, resolvePassword, restampTotp, generateTotpCode, msUntilNextTotp } from './LoginFlow';
import { TokenStore } from './TokenStore';
import { onTokenAuthFailure } from './accountCapability';
import { webCookiesFresh, ownsCreatedSession, WEB_COOKIE_REFRESH_MS } from './sessionHealth';
import { pickPricerIdentities, LOCAL_EGRESS, type PricerIdentity, type PricerCandidate } from '../pricing/PricerIdentityPool';
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
// FAIL FAST: a dead proxy must release the queue slot in ~15s, not tie it up for 90s × 5.
// The 5 connection retries (MAX_CONNECTION_ATTEMPTS) with backoff remain, but each attempt
// now hard-caps at 15s, so an unreachable proxy is given up on quickly instead of stalling
// the whole fleet queue behind one dead exit.
const LOGIN_TIMEOUT_MS       = 15_000;  // proxy/CM connection hard cap (was 90s → fail fast)
const WEB_SESSION_TIMEOUT_MS = 30_000;  // web cookies can lag behind loggedOn (post-login, not the dead-proxy path)
const INTER_LOGIN_DELAY_MS   = 3_500;   // delay between sequential account logins

// ─── Global login concurrency cap (anti-storm) ────────────────────────────────
// the hard ceiling on how many new logins may be handshaking at once, across every
// caller and both games. Without it, any path that fans a login-triggering request
// out over the whole fleet (a bulk refresh, a UI action looping all accounts, a
// retry storm) opens hundreds of simultaneous proxy/CM sockets at once → resource
// exhaustion → silent process death. The mass-op orchestrators (refresh/buy/sell)
// have their own 25-wide pools, but nothing capped the login PATH itself; this does,
// so no caller can ever exceed it regardless of how many fire at once. Excess logins
// queue (FIFO) and start as slots free. Per-account dedup (loginsInFlight) still
// collapses duplicate logins for the same account and never consumes a slot.
// Tunable via SSIM_MAX_CONCURRENT_LOGINS for ops; defaults to the documented 25 ceiling.
const MAX_CONCURRENT_LOGINS = resolveCapEnv('SSIM_MAX_CONCURRENT_LOGINS', process.env.SSIM_MAX_CONCURRENT_LOGINS, 1, 25, false);

// ─── Hard resident-session ceiling (structural anti-storm backstop) ────────────
// MAX_CONCURRENT_LOGINS bounds how many logins HANDSHAKE at once; it does not bound how many
// sessions stay RESIDENT afterwards. Every live session is a CM socket + a fresh per-account proxy
// agent (keepAlive sockets) + a polling TradeOfferManager, so an unbounded resident population is
// the documented resource storm that gets the process externally killed. The per-call-site releases
// (refresh / offers / mass-send / mass-sell / mass-buy / single-buy) keep each path bounded, but a
// missed release in any current or future caller would defeat them. This ceiling is the one place
// that makes the whole class structurally impossible: once this many sessions are resident, a new
// account's login is REFUSED (fast, retryable) rather than queued — so no caller can ever drive the
// live-session count past a safe socket budget. A re-login of an ALREADY-resident account is exempt
// (it replaces, never grows).
// Default 90: the field 0xC0000409 native fast-fail struck at ~115 resident sessions, so the old
// 150 ceiling sat ABOVE the danger point and never engaged before the crash. 90 keeps a wide margin
// over every 25-wide pool while capping the resident pile-up UNDER the empirical danger point, so a
// storm that outpaces session release is refused (fast, retryable) before it reaches the crash zone.
// tune via SSIM_MAX_LIVE_SESSIONS, set 0 to disable.
const MAX_LIVE_SESSIONS = resolveCapEnv('SSIM_MAX_LIVE_SESSIONS', process.env.SSIM_MAX_LIVE_SESSIONS, 25, 90, true);

// ─── Idle-session reaper (anti-accumulation for SINGLE-account ops) ─────────────
// Bulk ops release the sessions they create, but SINGLE-account paths (single send /
// getTradeUrl / manual per-account refresh / post-trade refresh) leave a session resident
// with no release. Touch >150 distinct accounts via single ops in one run and the resident
// count reaches MAX_LIVE_SESSIONS → every NEW-account login is then refused. A periodic
// reaper logs out sessions that have gone IDLE (no genuine op used them within the TTL), so a
// one-shot op's leftover session is reclaimed instead of accumulating. A session in active use
// is touched (markUsed) on every op entry, so its lastActivityAt stays fresh and it is never
// reaped mid-use; the proactive cookie refresh is maintenance and deliberately does not count.
const IDLE_SESSION_TTL_MS = resolveCapEnv('SSIM_IDLE_SESSION_TTL_MS', process.env.SSIM_IDLE_SESSION_TTL_MS, 60_000, 30 * 60_000, false); // default 30 min; always ≥ 60 000 (no opt-out)
const REAPER_INTERVAL_MS = 5 * 60_000;

// ─── Retry strategy (Problem 1: transient NoConnection / proxy failures) ──────
// Steam logins over slow or rotating residential proxies frequently fail with
// TRANSIENT errors – most commonly EResult 3 (NoConnection), proxy CONNECT
// hiccups, or socket timeouts. These must not abort the account: we retry the
// same login path several times with exponential backoff before giving up.
//   • attempts per path : MAX_CONNECTION_ATTEMPTS
//   • backoff           : BACKOFF_BASE_MS, doubling each retry, capped at BACKOFF_MAX_MS
//                         (so e.g. 4s → 8s → 16s → 32s → 45s)
// Only a genuine authentication failure (see AUTH_FAILURE_ERESULTS) or a Steam
// Guard prompt on the token path aborts early.
const MAX_CONNECTION_ATTEMPTS = 5;
const BACKOFF_BASE_MS         = 4_000;
const BACKOFF_MAX_MS          = 45_000;

// steam-user's EConnectionProtocol (Auto=0, TCP=1, WebSocket=2) — the .d.ts does not expose the
// enum, so read it defensively with literal fallbacks. The label is chosen per login attempt by
// CmProtocol (TCP-first, per-proxy demotion to WebSocket when the provider blocks HTTP CONNECT
// to the CM's TCP ports 27017-27050 — the 2026-07-09 "only one provider still works" regression);
// see the client construction in performLogin.
const CM_ENUM = (SteamUser as unknown as { EConnectionProtocol?: { Auto?: number; TCP?: number; WebSocket?: number } }).EConnectionProtocol;
const CM_PROTO_ENUM: Record<CmProtocolLabel, number> = {
  auto: CM_ENUM?.Auto ?? 0,
  tcp:  CM_ENUM?.TCP ?? 1,
  ws:   CM_ENUM?.WebSocket ?? 2,
};

// ─── Token-invalidation criteria (Problem 2: don't nuke tokens on flaky proxies) ──
// A refresh token is a valuable, restart-proof credential. It is deleted ONLY when
// there is STRONG evidence it is actually invalid:
//   • the login fails with one of these Steam EResult codes, or
//   • Steam Guard is requested on a refresh-token login (a valid token never is).
// Network / proxy / timeout errors are explicitly not in this set, so they can
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
  // concurrent callers share one login instead of destroying each other's
  // mid-handshake session. Cleared in finally when the login settles.
  private readonly loginsInFlight = new Map<string, Promise<ManagedSession>>();
  // Keys of accounts currently RE-logging-in — their prior resident session has been
  // destroyed (freeing its slot) but a fresh one is not yet inserted. occupiedCount() counts these
  // as occupied so a concurrent newcomer can't steal the slot, and the insertion re-check exempts
  // them so the re-login re-occupies its own slot ("replaces, never grows"). Added in doLoginAccount
  // before the destroy, cleared in its finally.
  private readonly reloginReservations = new Set<string>();
  // Set by logoutAll() so an in-flight login can't insert a fresh session into a manager that has
  // already been torn down (a late success would park an unmanaged live CM session + agent). Checked in
  // loginAccount / performLogin; reset by loginAll() when a deliberate new cycle starts.
  private shuttingDown = false;

  // ── Global login concurrency semaphore (see MAX_CONCURRENT_LOGINS) ──────────
  // `loginSlots` = free slots; when 0, callers park in `loginWaiters` (FIFO) and are
  // handed a slot the instant one frees. This is the ONLY gate on simultaneous logins.
  private loginSlots = MAX_CONCURRENT_LOGINS;
  private readonly loginWaiters: Array<() => void> = [];

  /** Optional login-time network resolver (wired to AccountManager.networkForLogin in createDeps).
   *  Re-resolves the account's egress at the moment of login — this is where per-login proxy
   *  rotation ADVANCES its cursor. `undefined` return ⇒ pool-lost ⇒ performLogin fail-closes the
   *  login (never falls to the host IP). Absent ⇒ use the pre-attached `account.network` (today's
   *  behaviour, fully backward compatible). */
  private loginNetworkResolver?: (account: AccountConfig) => AccountConfig['network'];

  /** Optional PEEK resolver (wired to `u => accounts.get(u)?.network` in createDeps). Reports the
   *  egress an account WOULD use right now WITHOUT advancing the rotation cursor. Only isEgressStale
   *  reads it. Absent ⇒ staleness is unknowable ⇒ isEgressStale answers false (today's behaviour). */
  private egressPeek?: (username: string) => AccountConfig['network'];

  /** Idle-session reaper handle. Unref'd so it never keeps the process alive. */
  private readonly reaperTimer?: NodeJS.Timeout;

  constructor() {
    super();
    // IDLE_SESSION_TTL_MS is always ≥ 60 000 (resolveCapEnv floors it, no opt-out), so the reaper
    // always runs. To disable the anti-storm machinery, set SSIM_MAX_LIVE_SESSIONS=0 (the ceiling), not the TTL.
    this.reaperTimer = setInterval(() => { void this.reapIdleSessions(); }, REAPER_INTERVAL_MS);
    this.reaperTimer.unref?.();
  }

  /** Wire the login-time network resolver (AccountManager.networkForLogin). Called once at
   *  createDeps. See loginNetworkResolver. */
  setLoginNetworkResolver(fn: (account: AccountConfig) => AccountConfig['network']): void {
    this.loginNetworkResolver = fn;
  }

  /** Wire the peek resolver (AccountManager.get → computed `network`). See egressPeek / isEgressStale. */
  setEgressPeekResolver(fn: (username: string) => AccountConfig['network']): void {
    this.egressPeek = fn;
  }

  /**
   * Has this account's egress changed since its resident session logged in?
   *
   * A ManagedSession pins its egress at login: the SteamUser client and `httpsAgent` are built from
   * the network resolved at that moment and CANNOT be re-pointed afterwards. Proxy-rule edits are
   * applied lazily (AccountManager.activateProxyRules: "changes take effect on each account's NEXT
   * login"), which is correct for an idle fleet — but every session-REUSING path (inventory refresh,
   * getTrader, ensureWebSession) kept handing back the session logged in over the RETIRED exit. That
   * is the "switching a job between proxy and local IP needs a restart" report: restarting SSIM was
   * simply the only way to drop those sessions. Now the reuse sites ask this first and re-login
   * instead, so a rule change is live on the very next operation.
   *
   * Answers false whenever it cannot be sure — no peek resolver, no resident session, a session
   * with no pinned network, or a peek that returns undefined (pool-lost: performLogin fail-closes
   * that on its own; forcing a re-login here would only convert it into a hard error mid-job).
   */
  isEgressStale(username: string): boolean {
    if (!this.egressPeek) return false;
    const session = this.sessions.get(username.toLowerCase());
    const pinned = session?.account?.network;
    if (!pinned) return false;
    let current: AccountConfig['network'];
    try { current = this.egressPeek(username); }
    catch { return false; }                       // a resolver that throws must never break an op
    if (!current) return false;                   // pool-lost / unknown → leave the decision to login
    if (current.type !== pinned.type) return true;
    // Same comparison AccountManager.sameEgress uses, credentials INCLUDED: a rotated user:pass on the
    // same host:port is a different identity to Steam and needs a rebuilt agent just as much as a
    // different host would. normalizeProxy is total (it falls back to prefixing a scheme), never throws.
    const norm = (n: NonNullable<AccountConfig['network']>): string =>
      n.type === 'proxy' ? normalizeProxy(n.value) : n.value;
    return norm(current) !== norm(pinned);
  }

  /** Marks a session as actively USED right now (called at every genuine op entry) so the idle
   * reaper never logs out a session an operation is currently using. */
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
      // Reap SETTLED-live sessions and settled-dead ones (DISCONNECTED/ERROR). The disconnected/error
      // handlers already deferred-destroy such a session; this is a BACKSTOP for any zombie
      // that slipped past (e.g. one already resident before this fix, or where the replacement guard
      // skipped the immediate destroy) — otherwise a non-LOGGED_IN session would linger forever.
      const reapable = s.state === SessionState.LOGGED_IN
        || s.state === SessionState.DISCONNECTED || s.state === SessionState.ERROR;
      if (!reapable) continue;
      const last = s.lastActivityAt?.getTime() ?? s.loggedInAt?.getTime() ?? 0;
      if (now - last >= IDLE_SESSION_TTL_MS) victims.push({ key, session: s });
    }
    // Re-validate identity+idleness at the destroy site against the live map — the victims list
    // was snapshotted before the per-victim await gap, so a session markUsed'd (the anti-reap signal) or
    // re-logged-in (a fresh session swapped into the key) after the scan but before its turn must be skipped,
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
   * on the status endpoint so the operator restores it before a mass refresh re-auths the fleet. */
  isTokenStoreDegraded(): boolean { return this.tokenStore.isDegraded(); }

  /** The stored Auth-v2 refresh token for an account (vault-aware), or undefined. Read-only accessor so
   * BanService decodes a SteamID from the JWT off the single production store — no second instance. */
  getStoredRefreshToken(username: string): string | undefined { return this.tokenStore.get(username); }

  /**
   * Drops the stored refresh token for an account because it is KNOWN-DEAD, not merely suspect.
   *
   * The login path deliberately never deletes a token on weak evidence (see onTokenAuthFailure /
   * INV-A2): a misclassified 'auth' verdict must not strand an account. This accessor exists for the
   * one case where the evidence is certain because SSIM itself caused it — "sign out of all devices"
   * revokes every refresh token on the account, so keeping ours would guarantee a failed token login
   * on the next use and, worse, could burn that failure as the "strong evidence" that deletes it later.
   *
   * The caller MUST have verified the account has a credential fallback (maFile + password) first —
   * for a token-only account the refresh token is the sole credential, and clearing it is unrecoverable.
   */
  clearStoredRefreshToken(username: string): void { this.tokenStore.delete(username); }

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

  /**
   * Resident population for the ceiling checks: live sessions PLUS in-flight re-login
   * reservations whose old session was already destroyed. A reserved key that has re-inserted is
   * counted once via `sessions` (the filter excludes it), so neither newcomers nor re-logins can
   * overshoot the MAX_LIVE_SESSIONS budget.
   */
  private occupiedCount(): number {
    let pending = 0;
    for (const k of this.reloginReservations) if (!this.sessions.has(k)) pending++;
    return this.sessions.size + pending;
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
    // lives here in SessionManager so it covers every caller and both games.
    const key = account.username.toLowerCase();
    const inFlight = this.loginsInFlight.get(key);
    if (inFlight) return inFlight;   // dedup: share the running login, no slot consumed
    // Refuse a new login once teardown has begun — never build a session in a manager being discarded.
    if (this.shuttingDown) {
      return Promise.reject(Object.assign(
        new Error(`${account.username}: login refused – session manager is shutting down`),
        { loginErrorKind: 'connection' as LoginErrorKind, ceilingRefusal: true },
      ));
    }
    // ── Hard resident-session ceiling ────────────────────────────────────────
    // Refuse a new account's login (fast, before consuming a slot) once the live-session
    // population is at the cap, so no caller can ever drive resident sockets past a safe budget.
    // A re-login of an account that already holds a session is exempt (it replaces, never grows); an
    // in-flight re-login whose old session was already destroyed still counts against the budget via
    // occupiedCount() (its reservation), so a newcomer can't steal the slot it will re-occupy.
    // Classified 'connection' so it bubbles as a transient, retryable per-account failure (the bulk
    // orchestrators already record it and carry on) and NEVER deletes a refresh token.
    if (MAX_LIVE_SESSIONS > 0 && !this.sessions.has(key) && this.occupiedCount() >= MAX_LIVE_SESSIONS) {
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
        // Re-resolve the egress AT login (once per non-deduped login) so per-login proxy rotation
        // advances here. A pool-lost `undefined` flows to performLogin's fail-closed refusal.
        const resolved = this.loginNetworkResolver
          ? { ...account, network: this.loginNetworkResolver(account) }
          : account;
        return await this.doLoginAccount(resolved, key);
      } finally {
        this.releaseLoginSlot();
      }
    })().finally(() => this.loginsInFlight.delete(key));
    this.loginsInFlight.set(key, p);
    return p;
  }

  /**
   * Like loginAccount, but also reports whether this call originated the login, so a
   * bulk op can release exactly the sessions it created and never tear down a session
   * another operation owns. `createdByCall` is decided SYNCHRONOUSLY here (before any
   * await), race-free with loginAccount's in-flight dedup.
   */
  async loginAccountOwned(account: AccountConfig): Promise<{ session: ManagedSession; createdByCall: boolean }> {
    const key = account.username.toLowerCase();
    const createdByCall = ownsCreatedSession(this.loginsInFlight.has(key), this.sessions.has(key));
    const session = await this.loginAccount(account);
    return { session, createdByCall };
  }

  /**
   * Persists a freshly-negotiated Auth-v2 refresh token for an account (Feature 1
   * "Account Login" import). Routes through the same TokenStore loginAccount() reads,
   * so a QR/credentials-imported account logs in TOKEN-FIRST with no further prompts —
   * landing in the portable vault in vault mode, or refresh_tokens.json otherwise.
   */
  rememberRefreshToken(username: string, token: string): boolean {
    if (typeof token === 'string' && token) return this.tokenStore.set(username, token);
    return false;
  }

  private async doLoginAccount(account: AccountConfig, key: string): Promise<ManagedSession> {
    // A re-login of an already-resident account reserves its slot before doLoginAccountInner
    // destroys the old session, so the freed slot is held for this account — occupiedCount() counts the
    // reservation (a concurrent newcomer can't take it) and the insertion re-check exempts the reserved
    // key (the re-login re-occupies its own slot, "replaces, never grows"). Released once the login settles.
    const reserved = this.sessions.has(key);
    if (reserved) this.reloginReservations.add(key);
    try {
      return await this.doLoginAccountInner(account, key);
    } finally {
      if (reserved) this.reloginReservations.delete(key);
    }
  }

  private async doLoginAccountInner(account: AccountConfig, key: string): Promise<ManagedSession> {
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
          // STRONG evidence the token is bad and we have a usable credential fallback
          // (maFile + password) → delete the token and re-login via credentials.
          logger.warn(`[${account.username}] refresh token is INVALID (${(err as Error).message}) – deleting token, full login`);
          this.tokenStore.delete(account.username);
          await this.destroySession(key);
          // …fall through to the credential login below.
        } else if (kind === 'auth') {
          // No usable credential fallback (needs maFile + password): the refresh token is
          // this account's SOLE credential. PRESERVE it — a misclassified/transient 'auth'
          // verdict must never permanently strand the account — and surface a re-import
          // requirement.
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
    // TANK: feed each login handshake outcome to the per-proxy breaker so a reset-storming
    // provider trips OPEN and bulk dials on it back off (recording is global + harmless; only the
    // BULK refresh dispatch CONSULTS the breaker — money ops never defer). Proxyless → null → no-op.
    const pkey = account.network?.type === 'proxy' ? proxyKey(account.network.value) : null;
    // SOCKS proxies must run the CM over WebSocket (steam-user hard-forces that combination);
    // detected here so chooseCmProtocol can pick it explicitly instead of tripping steam-user's warn.
    const isSocks = account.network?.type === 'proxy' && /^socks/i.test(account.network.value.trim());

    for (let attempt = 1; attempt <= MAX_CONNECTION_ATTEMPTS; attempt++) {
      // Re-chosen every attempt: two TCP connect failures demote this proxy to WebSocket, so
      // attempt 3 of the same login round (and every other account on this proxy) already
      // connects over wss:443 — a 443-only provider costs one slow round, not a dead fleet.
      const cmProto = chooseCmProtocol(pkey, isSocks);
      try {
        // The credential payload's TOTP is valid for one 30s window; a retry re-sends the
        // same object minutes later. Re-stamp a current-window code before every retry so
        // attempt 2 logs in on its first logOn instead of losing the stale-code Steam Guard
        // race against the 15s login timeout. Attempt 1 keeps the just-built code; the token
        // path ({ refreshToken }) carries no maFile and is untouched.
        if (attempt > 1 && pathLabel === 'credential' && maFile) restampTotp(logOnOptions, maFile);
        const ok = await this.performLogin(account, logOnOptions, maFile, cmProto);
        proxyHealth.record(pkey, 'ok');
        if (noteCmOutcome(pkey, cmProto, true) === 'promoted') {
          logger.info(`[cm-protocol] proxy ${pkey} PROMOTED back to TCP CM — a re-probe succeeded (the provider now allows HTTP CONNECT to the CM ports). Persisted.`);
        }
        return ok;
      } catch (err) {
        lastErr = err as LoginError;
        const kind = classifyLoginError(lastErr);
        lastErr.loginErrorKind = kind;
        // Only a reset-class transport failure trips the breaker; auth/ceiling/config do not.
        if (!lastErr.ceilingRefusal) proxyHealth.record(pkey, kind === 'connection' && isResetClass(lastErr) ? 'reset' : 'fail');
        // CM-protocol learning: only genuine connection-class failures count (an auth/ceiling
        // failure means the CM connected fine — it must never demote a healthy proxy).
        if (kind === 'connection' && !lastErr.ceilingRefusal
            && noteCmOutcome(pkey, cmProto, false) === 'demoted') {
          logger.warn(`[cm-protocol] proxy ${pkey} demoted to WebSocket CM after ${TCP_FAILURES_TO_DEMOTE} TCP connect failures – provider likely blocks HTTP CONNECT to the CM ports (27017-27050); wss:443 from now on. PERSISTED (re-probes TCP after 24h). Force globally with SSIM_CM_PROTOCOL=ws.`);
        }

        // A resident-ceiling insertion refusal — and an S48 shutdown abort — must not be retried
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
          // Tear the dead client down before bubbling up. The connection branch below
          // destroys on every attempt, but the auth branch previously threw straight
          // out, leaving an ERROR session in the map with its SteamUser client (open
          // CM/proxy socket + listeners) lingering until the next login for this user.
          await this.destroySession(account.username.toLowerCase());
          throw lastErr;
        }

        // Connection failure → discard the dead client, back off, retry.
        await this.destroySession(account.username.toLowerCase());
        if (attempt < MAX_CONNECTION_ATTEMPTS) {
          // Full-jitter backoff: without jitter, a fleet's worth of accounts failing the same
          // storming proxy in the same tick retry in LOCKSTEP, concentrating maximal simultaneous
          // TLS create/destroy churn on that provider — the exact concentrated teardown surface the
          // native fast-fail lives in. Jitter to [50%, 100%] of the exponential ceiling de-syncs the herd.
          const ceil = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
          const backoff = Math.round(ceil * (0.5 + Math.random() * 0.5));
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
    cmProto:      CmProtocolLabel = 'tcp',
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
    // protocol: TCP-first (not the default Auto). Under an httpProxy, Auto leaves ~half of CM
    // connections running over wss-TLS-through-the-proxy (a tls.connect({socket}) over the CONNECT
    // tunnel — a native-teardown-race primitive that the flaky-proxy RESET storm can trip into the
    // 0xC0000409 fast-fail). Raw-TCP CM uses Valve's own crypto (no TLSWrap over the proxy socket),
    // removing that primitive on the CM side. BUT: TCP CMs live on ports 27017-27050, and providers
    // that whitelist CONNECT :443 only cannot carry them — CmProtocol demotes such a proxy to
    // WebSocket after TCP_FAILURES_TO_DEMOTE connect failures (attemptLogin passes the per-attempt
    // choice in). The web fetch path is unaffected either way.
    const client = new SteamUser({
      ...steamUserOptions,
      protocol:         CM_PROTO_ENUM[cmProto],
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
      lastActivityAt: new Date(), // a fresh login counts as activity (reaper grace)
    };

    // Resident-ceiling re-check AT the insertion point. The check in loginAccount runs
    // before acquireLoginSlot and the entry is inserted here, up to a full backoff later — so a
    // burst admitted while the map was momentarily small could overshoot the budget. This
    // re-check is SYNCHRONOUS with the set() below (no await between), so it is race-free: once
    // the population is at the cap, a new account's insertion is refused (transient/retryable). A
    // re-login is exempt via its reservation (reloginReservations): it re-occupies the exact slot its
    // own destroy freed (growth 0), while newcomers still see that reservation as occupied through
    // occupiedCount() so the budget stays exact. We must
    // tear the freshly-built client down so it doesn't leak a CM/proxy socket.
    if (MAX_LIVE_SESSIONS > 0 && !this.sessions.has(key) && !this.reloginReservations.has(key) && this.occupiedCount() >= MAX_LIVE_SESSIONS) {
      try { client.on('error', () => { /* discarded */ }); client.logOff(); } catch { /* noop */ }
      neutralizeSteamClient(client);
      AgentFactory.destroyIfDisposable(httpsAgent);
      throw Object.assign(
        new Error(`live-session ceiling ${MAX_LIVE_SESSIONS} reached at insertion – ${account.username} skipped; retry shortly`),
        { loginErrorKind: 'connection' as LoginErrorKind, ceilingRefusal: true }, // S49: non-retryable in-slot
      );
    }

    // Teardown began while this login was handshaking — abort at the insertion point (SYNCHRONOUS with
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
    session.state = SessionState.CONNECTING;

    return new Promise<ManagedSession>((resolve, reject) => {
      let loginTimeoutHandle:      NodeJS.Timeout;
      let webSessionTimeoutHandle: NodeJS.Timeout | undefined;
      // Guards the single allowed settlement: the periodic webSession refreshes
      // (and any late events) must not re-settle this promise.
      let settled = false;

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(loginTimeoutHandle);
        if (webSessionTimeoutHandle) clearTimeout(webSessionTimeoutHandle);
        session.state    = SessionState.ERROR;
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
      // Steam also pushes this (ClientWalletInfoUpdate) whenever the balance changes on a live
      // session, so a resident session's `wallet` tracks credits without any re-login. Re-emitted
      // on the manager so callers can await the first/next value (see awaitWallet) instead of
      // racing the login promise, which resolves on 'webSession' and may beat this event (W4_40).
      client.on('wallet', (hasWallet: boolean, currency: number, balance: number) => {
        session.wallet = { hasWallet, currency, balance };
        logger.info(`[${account.username}] wallet balance ${balance} (currency ${currency})`);
        this.emit('wallet', account.username, session.wallet);
      });

      // ── accountLimitations – Steam's own verdict on what this account may do ──
      // Pushed at login (ClientIsLimitedAccount). A LIMITED account cannot use the Community
      // Market, and Steam does not say so on the endpoint itself — createbuyorder answers
      // success:1 and quietly creates nothing. Logging it here makes the one fact that explains
      // a whole class of "placed but never fills" visible for every account, at login, for free.
      client.on('accountLimitations', (...a: unknown[]) => {
        const [limited, communityBanned, locked] = a as [boolean, boolean, boolean];
        if (limited || communityBanned || locked) {
          logger.warn(`[${account.username}] Steam account limitations: ${[limited && 'LIMITED (no Community Market)', communityBanned && 'COMMUNITY BANNED', locked && 'LOCKED'].filter(Boolean).join(', ')}`);
        }
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
      // NOTE: logging on is not the same as being "ready". Steam delivers the
      // web-session cookies a few ms later via the 'webSession' event. We must
      // wait for those cookies before resolving, otherwise the InventoryManager
      // fails with "no web session cookies available" (classic race condition).
      client.once('loggedOn', () => {
        clearTimeout(loginTimeoutHandle);

        session.state     = SessionState.LOGGED_IN;
        session.steamId   = client.steamID?.getSteamID64() ?? undefined;
        session.loggedInAt = new Date();

        logger.info(`[${account.username}] Logged in  SteamID=${session.steamId}  via ${network.type}:${network.type === 'proxy' ? redactProxyCredentials(network.value) : network.value}  – awaiting web session…`);

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
      // Fires on the initial login and on every later refresh. We store the
      // cookies every time, but only the first occurrence resolves the login
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
        }, WEB_COOKIE_REFRESH_MS);
        session.cookieRefreshTimer.unref?.();
      });

      // ── error ──────────────────────────────────────────────────────────
      // PERSISTENT listener (not once): steam-user also emits fatal errors after
      // a successful login (e.g. LoggedInElsewhere). Without a live listener the
      // EventEmitter would throw and the session would linger as a LOGGED_IN
      // zombie. Post-login we mark the session dead so ensureSession() re-logs-in.
      client.on('error', (err: Error & { eresult?: number }) => {
        logger.error(`[${account.username}] Steam error  EResult=${err.eresult ?? '?'}  msg=${err.message}`);
        if (!settled) { fail(err); return; }
        session.state = SessionState.ERROR;
        this.emit('disconnected', account.username, `fatal: ${err.message}`);
        // A post-settle fatal (e.g. LoggedInElsewhere) previously left the session RESIDENT
        // in ERROR state — its TradeOfferManager kept polling every 20s on now-dead cookies
        // forever (bulk release skips it: isLive is false for ERROR), a steady background
        // request storm + pinned memory. Tear it down so 'sessionDestroyed' fires and the trader
        // poller/GC handle/agent are released. Guard against destroying a REPLACEMENT session: a
        // re-login may have already swapped a fresh session into this key, so only destroy if the
        // map still holds this exact instance. Deferred a tick so we never destroy mid-emit.
        setTimeout(() => {
          if (this.sessions.get(key) === session) void this.destroySession(key);
        }, 0).unref?.();
      });

      // ── disconnected ───────────────────────────────────────────────────
      client.on('disconnected', (eresult: number, msg?: string) => {
        session.state = SessionState.DISCONNECTED;
        const reason = msg ?? `EResult ${eresult}`;
        logger.warn(`[${account.username}] Disconnected  reason="${reason}"`);
        this.emit('disconnected', account.username, reason);
        // A post-settle CM drop (proxy blip → 'disconnected', no 'error'; autoRelogin:false) used to
        // leave the session RESIDENT in DISCONNECTED — counted against MAX_LIVE_SESSIONS, holding its proxy
        // agent + TradeOfferManager poller — and NOTHING reaped it (the error handler's B43 destroy only
        // fires on 'error'; the idle reaper skips non-LOGGED_IN). Mirror B43 here: tear it down so
        // 'sessionDestroyed' fires and the slot/agent/poller are released. Same replacement guard (only
        // destroy if the map still holds this instance — a re-login may have swapped in a fresh one) and
        // deferred a tick so we never destroy mid-emit.
        setTimeout(() => {
          if (this.sessions.get(key) === session) void this.destroySession(key);
        }, 0).unref?.();
      });

      // ── Kick off login ─────────────────────────────────────────────────
      session.state = SessionState.LOGGING_IN;

      loginTimeoutHandle = setTimeout(() => {
        fail(new Error(`Login timeout after ${LOGIN_TIMEOUT_MS / 1000}s (${account.username})`));
        try { client.logOff(); } catch { /* half-built connection – attemptLogin's destroySession completes teardown */ }
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
    // Latch shutdown first so no new login is admitted and any login mid-handshake aborts at its
    // insertion point, then drain the logins already in flight so a late success can't insert a fresh
    // session after we tear down (which would strand an unmanaged live CM session + agent). Only then
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

  /**
   * Resolve this account's wallet, waiting up to `timeoutMs` for the 'wallet' event if the CM has
   * not delivered it yet. The login promise resolves on 'webSession', which can beat 'wallet' — so
   * reading `session.wallet` straight after `loginAccount()` may see `undefined`, or (on an account
   * with no wallet) `{hasWallet:false, currency:0}`. A money read-back must not race that (W4_40).
   * Returns `undefined` if no session exists or the CM never sent one within the timeout.
   */
  async awaitWallet(username: string, timeoutMs = 5_000): Promise<ManagedSession['wallet']> {
    const key = username.toLowerCase();
    const existing = this.sessions.get(key)?.wallet;
    if (existing) return existing;
    if (!this.sessions.has(key)) return undefined;
    return new Promise((resolve) => {
      const done = (w: ManagedSession['wallet']): void => {
        clearTimeout(timer);
        this.off('wallet', onWallet);
        resolve(w);
      };
      const onWallet = (u: string, w: ManagedSession['wallet']): void => { if (u.toLowerCase() === key) done(w); };
      const timer = setTimeout(() => done(this.sessions.get(key)?.wallet), timeoutMs);
      timer.unref?.();
      this.on('wallet', onWallet);
    });
  }

  getAllSessions(): ManagedSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Up to `limit` authenticated identities for the background price fill (2026-07-10 root-cause fix):
   * logged-in sessions with FRESH web cookies, reduced to {username, cookies, agent}. PricerIdentityPool
   * builds the Cookie header + drops any candidate without a real steamLoginSecure. The fill sends these
   * cookies over each account's own egress agent so priceoverview draws that account's per-session budget
   * instead of the anonymous per-IP budget the shared pool leaves exhausted. Read fresh on every fill, so
   * the identity set naturally tracks which sessions are currently live.
   *
   * `maxPerExit` bounds how many of the returned identities may share ONE exit IP — the load-bearing
   * safety cap, since Steam meters per exit (see PricingService's pacing note). A proxy MEASURED to
   * rotate its exit per connection is exempt: its sessions do not share an IP, so each is bucketed as
   * its own exit. That verdict comes from `egressRotation`, which is probed in the background here and
   * defaults to "static" (the safe pace) until proven otherwise — so the first fill after boot, an
   * unmeasured proxy, and a failed probe all behave exactly as an ordinary static proxy.
   */
  pricerIdentities(limit: number, maxPerExit = 1): PricerIdentity[] {
    const candidates: PricerCandidate[] = [];
    const agentsByExit = new Map<string, HttpAgent[]>();
    for (const s of this.sessions.values()) {
      if (s.state === SessionState.LOGGED_IN && s.webSession && webCookiesFresh(s.webSession.obtainedAt)) {
        // The exit this session actually leaves through, pinned at login (see isEgressStale) — the
        // same value for two accounts on one proxy, so the pool can spread its picks across IPs.
        const net = s.account.network;
        const proxied = net?.type === 'proxy';
        const egressKey = proxied ? `proxy:${proxyKey(net!.value) ?? net!.value}` : LOCAL_EGRESS;
        candidates.push({
          username: s.account.username, cookies: s.webSession.cookies, agent: s.httpsAgent, egressKey,
          // Only a MEASURED rotating proxy earns per-session exits. Unmeasured, mid-probe, failed
          // probe, and the host IP (which never rotates) all fall through to the safe shared-exit
          // treatment — see network/EgressRotation.
          rotatingExit: proxied && egressRotation.isRotating(egressKey),
        });
        // Collect live agents per proxy so the rotation probe can use two DIFFERENT connections.
        if (proxied) {
          const list = agentsByExit.get(egressKey);
          if (list) { if (list.length < 2) list.push(s.httpsAgent); } else agentsByExit.set(egressKey, [s.httpsAgent]);
        }
      }
    }
    // Fire-and-forget measurement for any proxy whose verdict is stale. Never awaited: selection
    // stays synchronous and this fill uses the CURRENT verdict; a new one applies from the next.
    for (const [key, agents] of agentsByExit) egressRotation.observe(key, agents);
    // NOTE: every web-ready session is offered, not the first `limit * 2`. The old cap was a
    // micro-optimisation that silently defeated the pool's whole job: it truncated the candidate list
    // in map (insertion) order, so on a fleet where the first sessions share a proxy the pool could
    // not find the other exits even though they were live. Selection is O(candidates) and runs once
    // per fill, so scanning them all costs nothing worth having.
    return pickPricerIdentities(candidates, limit, maxPerExit);
  }

  /**
   * True when the account currently has a live (logged-in) or mid-login session.
   * Bulk operations check this before they touch an account so they release ONLY the
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
    //    'error' handler must exist at every instant of teardown. Attach a no-op
    //    before logOff (belt: covers a client whose real handlers were never wired),
    //    and RE-attach it in its own try after the listener sweep — if the sweep
    //    throws, the earlier catch must not also swallow the re-attach.
    const noopError = (): void => { /* session already torn down */ };
    try { existing.client.on('error', noopError); } catch { /* noop */ }
    try { existing.client.logOff(); } catch { /* already gone */ }
    // 2b) Neutralize the discarded client so it can NEVER resurrect itself. This is
    //    the core of the native-crash / login-storm class: steam-user's logOff() does
    //    not clear _logonMsgTimeout — a teardown landing while a ClientLogon is in
    //    flight (the exact 15s-timeout / connection-retry teardown a proxy ECONNRESET
    //    storm triggers hundreds of times) leaves that 5s timer alive; it fires
    //    _disconnect()+_enqueueLogonAttempt() → logOn(true), fully reconnecting a
    //    client SSIM already deleted from the map — an invisible CM session +
    //    heartbeat + login retries counted by NOTHING (outside MAX_CONCURRENT_LOGINS /
    //    MAX_LIVE_SESSIONS), and later a LoggedInElsewhere kick of the account's real
    //    login. steam-user exposes no destroy(), so we defensively silence the exact
    //    reconnect machinery (all guarded; unknown-field access is a safe no-op).
    neutralizeSteamClient(existing.client);
    // 3) Drop all listeners (they capture the session in their closures)…
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

  // ── Web-session maintenance ──────────────────────────────────────────────────

  /**
   * True when the session is fully usable for web API calls (logged in + cookies).
   */
  isReady(username: string): boolean {
    const s = this.sessions.get(username.toLowerCase());
    // Not just "a webSession object exists" — its cookies must still be FRESH, or a
    // call would run on silently-expired cookies.
    return !!s && s.state === SessionState.LOGGED_IN && !!s.webSession && webCookiesFresh(s.webSession.obtainedAt);
  }
}

// ─── Standalone helpers ─────────────────────────────────────────────────────────

/**
 * Defensively prevents a discarded steam-user client from resurrecting itself after
 * teardown. steam-user offers no public destroy(), and its logOff() leaves reconnect
 * machinery armed (notably _logonMsgTimeout, which is not cleared by
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
 * This keeps the same underlying CM/proxy connection open – critical when using
 * rotating residential proxies, where a full re-login would land on a new IP and
 * trip Steam's security filter.
 */
export function refreshWebSession(session: ManagedSession, timeoutMs = WEB_SESSION_TIMEOUT_MS): Promise<void> {
  // Dedup concurrent refreshes (#30): the proactive 20-min timer and an ad-hoc caller
  // must share one in-flight webLogOn rather than firing two with mismatched 'webSession'
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
