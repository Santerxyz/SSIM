import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode';
import { LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType } from 'steam-session';
import type { AccountManager } from './AccountManager';
import type { SessionManager } from './SessionManager';
import { normalizeProxy } from '../network/AgentFactory';
import { logger } from '../utils/logger';

// ════════════════════════════════════════════════════════════════════════════
//  AccountImportService — Feature 1 "Account Login"
//
//  Imports an account WITHOUT a maFile, via QR or credentials, using steam-session
//  ONLY to negotiate a refresh token. The token is persisted through the SAME
//  TokenStore the SessionManager reads (vault in vault-mode, refresh_tokens.json
//  otherwise), so the account then logs in TOKEN-FIRST with no further prompts.
//
//  A maFile-less account has NO identity_secret → it cannot confirm sell listings
//  or trade offers. It imports as the LIMITED tier; "Attach maFile → Full" upgrades
//  it later. The login negotiation is routed through the chosen environment's proxy
//  so the token is minted from the same IP the account will operate on.
//
//  Discipline: bounded active-session map (no unbounded growth), explicit QR
//  expiry, finished sessions pruned, secrets never logged, real errors surfaced.
// ════════════════════════════════════════════════════════════════════════════

export type ImportMethod = 'qr' | 'credentials';

export type ImportState =
  | 'waiting'   // QR generated / creds accepted — awaiting the user's mobile action
  | 'scanned'   // QR scanned in the Steam app (remoteInteraction) — awaiting approval
  | 'guard'     // credentials: a Steam Guard CODE is required (TOTP or email)
  | 'approved'  // authenticated — import in progress
  | 'imported'  // done — account created/updated
  | 'expired'   // the login attempt timed out (QR no longer valid)
  | 'error';    // failed (see `error`)

const SESSION_TTL_MS        = 5 * 60_000; // prune a finished/dead import session after this
const MAX_ACTIVE_IMPORTS    = 10;         // hard ceiling on concurrent in-flight imports
const LOGIN_TIMEOUT_MS      = 120_000;    // a QR/credentials login stays pollable this long, then 'expired'

interface ImportSession {
  id:              string;
  method:          ImportMethod;
  state:           ImportState;
  session:         LoginSession;
  environmentId:   string;
  createdAt:       number;
  expiresAt:       number;
  finishedAt?:     number;
  qrDataUrl?:      string;      // data: URL of the QR PNG (frontend renders it as <img>)
  guardType?:      string;      // 'DeviceCode' | 'EmailCode' when state === 'guard'
  guardDetail?:    string;      // e.g. the email domain for EmailCode
  error?:          string;
  // results (populated on 'imported')
  username?:       string;
  steamId?:        string;
  isUpdate?:       boolean;     // true when the account already existed (token refreshed)
  environmentMismatch?: boolean; // true when re-import picked an env ≠ the account's current one (not moved)
}

/** Public, secret-free snapshot of an import session for the status endpoint. */
export interface ImportStatus {
  sessionId:    string;
  method:       ImportMethod;
  state:        ImportState;
  expiresAt:    number;
  qrDataUrl?:   string;
  guardType?:   string;
  guardDetail?: string;
  error?:       string;
  username?:    string;
  steamId?:     string;
  isUpdate?:    boolean;
  environmentMismatch?: boolean;
}

export class AccountImportService {
  private readonly active = new Map<string, ImportSession>();

  constructor(
    private readonly accounts: AccountManager,
    private readonly sessions: SessionManager,
  ) {}

  // ── QR login ────────────────────────────────────────────────────────────────

  /** Starts a QR login attempt for the given environment. Returns the QR + sessionId. */
  async startQr(environmentId: string): Promise<ImportStatus> {
    const envId = this.resolveEnvironment(environmentId);
    this.prune();
    this.assertCapacity();

    const session = new LoginSession(EAuthTokenPlatformType.SteamClient, this.networkOptions(envId));
    // loginTimeout must be set BEFORE polling begins (i.e. before startWithQR resolves).
    session.loginTimeout = LOGIN_TIMEOUT_MS;

    const id = uuidv4();
    const now = Date.now();
    const rec: ImportSession = {
      id, method: 'qr', state: 'waiting', session, environmentId: envId,
      createdAt: now, expiresAt: now + LOGIN_TIMEOUT_MS,
    };
    this.active.set(id, rec);
    this.wireEvents(rec);

    try {
      const { qrChallengeUrl } = await session.startWithQR();
      if (!qrChallengeUrl) throw new Error('Steam did not return a QR challenge URL');
      rec.qrDataUrl = await QRCode.toDataURL(qrChallengeUrl, { margin: 2, width: 232, errorCorrectionLevel: 'M' });
      logger.info(`[import ${id.slice(0, 8)}] QR login started (env ${envId})`);
    } catch (err) {
      rec.state = 'error';
      rec.error = (err as Error).message;
      rec.finishedAt = Date.now();
      // A QR session may already be polling (e.g. toDataURL threw after startWithQR resolved) —
      // cancel it so it stops immediately instead of at the library's 120s timeout.
      try { session.cancelLoginAttempt(); } catch { /* settled */ }
      logger.error(`[import ${id.slice(0, 8)}] QR start failed: ${rec.error}`);
    }
    return this.snapshot(rec);
  }

  // ── Credentials login ─────────────────────────────────────────────────────────

  /**
   * Starts a credentials login attempt. The password is used ONCE to negotiate the
   * token and is NEVER persisted (the refresh token is the durable credential).
   * Returns the sessionId and whether a Steam Guard code is now required.
   */
  async startCredentials(p: { accountName: string; password: string; environmentId: string }): Promise<ImportStatus> {
    const accountName = (p.accountName ?? '').trim();
    if (!accountName || !p.password) throw new Error('username and password are required');
    const envId = this.resolveEnvironment(p.environmentId);
    this.prune();
    this.assertCapacity();
    if (this.accounts.get(accountName)) throw new Error(`Account "${accountName}" already exists`);

    const session = new LoginSession(EAuthTokenPlatformType.SteamClient, this.networkOptions(envId));
    // loginTimeout must be set BEFORE polling begins — confirmation-only guards start
    // polling via setImmediate as soon as startWithCredentials resolves, and the setter
    // throws once polling has started. Without this the credentials path silently used
    // the library's 30s default while expiresAt advertised the full window below.
    session.loginTimeout = LOGIN_TIMEOUT_MS;
    const id = uuidv4();
    const now = Date.now();
    const rec: ImportSession = {
      id, method: 'credentials', state: 'waiting', session, environmentId: envId,
      createdAt: now, expiresAt: now + LOGIN_TIMEOUT_MS,
    };
    this.active.set(id, rec);
    this.wireEvents(rec);

    // startWithCredentials rejects on bad password / rate-limit — finish the rec and cancel the
    // login attempt (else it keeps a capacity slot / keeps polling for the full window) before
    // rethrowing so the route's RateLimit→429 mapping still fires.
    let result;
    try {
      result = await session.startWithCredentials({ accountName, password: p.password });
    } catch (err) {
      rec.state = 'error';
      rec.error = (err as Error).message;
      rec.finishedAt = Date.now();
      try { session.cancelLoginAttempt(); } catch { /* settled */ }
      throw err;
    }
    if (result.actionRequired) {
      const codeAction = (result.validActions ?? []).find(
        a => a.type === EAuthSessionGuardType.DeviceCode || a.type === EAuthSessionGuardType.EmailCode,
      );
      if (codeAction) {
        rec.state = 'guard';
        rec.guardType = codeAction.type === EAuthSessionGuardType.EmailCode ? 'EmailCode' : 'DeviceCode';
        rec.guardDetail = codeAction.detail;
      }
      // else: confirmation-only (DeviceConfirmation/EmailConfirmation) → stays 'waiting',
      //       the user approves in-app/email and 'authenticated' fires from polling.
    }
    logger.info(`[import ${id.slice(0, 8)}] credentials login started for "${accountName}" (guard: ${rec.guardType ?? 'none'})`);
    return this.snapshot(rec);
  }

  /** Submits a Steam Guard code for a credentials session awaiting one. */
  async submitGuard(sessionId: string, code: string): Promise<ImportStatus> {
    const rec = this.active.get(sessionId);
    if (!rec) throw new Error('login session not found or expired');
    if (rec.method !== 'credentials') throw new Error('not a credentials login session');
    const trimmed = (code ?? '').trim();
    if (!trimmed) throw new Error('a Steam Guard code is required');
    // Rejects on wrong code (e.g. TwoFactorCodeMismatch) — bubble to the route; state stays 'guard' for retry.
    await rec.session.submitSteamGuardCode(trimmed);
    // Polling (and thus the library's loginTimeout) only starts now for code guards —
    // re-anchor the service-side deadline so prune/snapshot match the real window.
    rec.expiresAt = Date.now() + LOGIN_TIMEOUT_MS;
    return this.snapshot(rec);
  }

  // ── Status / cancel ─────────────────────────────────────────────────────────

  getStatus(sessionId: string): ImportStatus | undefined {
    // Evaluate expiry on the read path — the frontend's 1.5s poll then fires hard-expiry/TTL cleanup on
    // time, so an abandoned guard session honestly reports 'expired' instead of 'guard' forever (code
    // guards never start library polling, so no 'timeout' event moves them off 'guard' on their own).
    this.prune();
    const rec = this.active.get(sessionId);
    return rec ? this.snapshot(rec) : undefined;
  }

  cancel(sessionId: string): void {
    this.prune();
    const rec = this.active.get(sessionId);
    if (!rec) return;
    // Mark terminal BEFORE deleting so a poll response that lands mid-cancel (steam-session
    // emits 'authenticated' after its network await with no post-await cancel re-check) cannot
    // finalize on a rec we've already discarded — the 'authenticated'/'error' guards observe finishedAt.
    rec.state = 'error';
    rec.error = 'cancelled';
    rec.finishedAt = Date.now();
    try { rec.session.cancelLoginAttempt(); } catch { /* already settled */ }
    this.active.delete(sessionId);
    logger.info(`[import ${sessionId.slice(0, 8)}] cancelled`);
  }

  // ── Internals ─────────────────────────────────────────────────────────────────

  private wireEvents(rec: ImportSession): void {
    const tag = rec.id.slice(0, 8);
    // An 'error' listener is mandatory — Node throws on an unhandled 'error' event.
    rec.session.on('error', (err: Error) => {
      if (rec.finishedAt) return;   // a late poll error must not overwrite 'imported'/'expired'/cancelled
      rec.state = 'error';
      rec.error = err.message;
      rec.finishedAt = Date.now();
      logger.error(`[import ${tag}] login error: ${err.message}`);
    });
    rec.session.on('timeout', () => {
      if (rec.state === 'imported' || rec.state === 'error') return;
      rec.state = 'expired';
      rec.finishedAt = Date.now();
      logger.warn(`[import ${tag}] login attempt timed out`);
    });
    rec.session.on('remoteInteraction', () => {
      if (rec.state === 'waiting') rec.state = 'scanned';
    });
    rec.session.on('authenticated', () => {
      if (rec.finishedAt || !this.active.has(rec.id)) return;   // cancelled/expired/errored → never finalize
      rec.state = 'approved';
      this.finalizeImport(rec).catch((err) => {
        rec.state = 'error';
        rec.error = (err as Error).message;
        rec.finishedAt = Date.now();
        logger.error(`[import ${tag}] import failed: ${rec.error}`);
      });
    });
  }

  /** On successful authentication: persist the token + create/refresh the LIMITED account. */
  private async finalizeImport(rec: ImportSession): Promise<void> {
    const username = rec.session.accountName;
    const token = rec.session.refreshToken;
    if (!username || !token) throw new Error('Steam returned no account name / refresh token');
    const steamId = (() => { try { return rec.session.steamID?.getSteamID64(); } catch { return undefined; } })();

    // 1) Persist the refresh token through the SessionManager's TokenStore (vault or file).
    const persisted = this.sessions.rememberRefreshToken(username, token);

    // 2) Org record. Token-only ⇒ no password, no maFile ⇒ LIMITED. accounts.json stays secret-free.
    const existing = this.accounts.get(username);
    // INV-A2: a NEW token-only account whose ONLY credential never reached disk (vault/disk problem, the
    // S24/B2 swallow) would become a permanently login-less record after restart. Abort BEFORE creating it
    // so no org record exists without a login path; the wireEvents .catch surfaces this as state 'error' and
    // a retry after fixing storage re-mints cleanly. An existing account keeps whatever login path it had.
    if (!existing && !persisted) throw new Error('refresh token could not be persisted (vault/disk problem) — import aborted; fix storage and retry');
    if (!existing) {
      this.accounts.add({
        username, password: '', maFilePath: '',
        environmentId: rec.environmentId, tier: 'limited',
      });
    }
    rec.isUpdate = !!existing;
    // Re-import into a DIFFERENT env mints the token via the picked env's IP but leaves the account
    // in its original env (we never move it silently). Flag the mismatch so the outcome is honest.
    if (existing && existing.environmentId !== rec.environmentId) {
      rec.environmentMismatch = true;
      logger.warn(`[import ${rec.id.slice(0, 8)}] token for "${username}" minted via env ${rec.environmentId} but account operates in env ${existing.environmentId}`);
    }

    // 3) Cache the permanent SteamID (validated/ignored if not a real SteamID64).
    if (steamId) this.accounts.rememberSteamId(username, steamId);

    rec.username = username;
    rec.steamId = steamId;
    rec.state = 'imported';
    rec.finishedAt = Date.now();
    logger.info(`[import ${rec.id.slice(0, 8)}] ${rec.isUpdate ? 'refreshed' : 'imported'} "${username}" as LIMITED`);
  }

  /** Maps the environment's proxy (or none) to steam-session network options.
   *  Normalizes via the same normalizeProxy every other network path applies (B24),
   *  so legacy non-URL env proxies (host:port:user:pass etc.) work here too; reads the
   *  B20 single-source envProxyFor so vault mode never uses a stale in-memory copy. */
  private networkOptions(environmentId: string): { localAddress?: string; httpProxy?: string; socksProxy?: string } {
    const raw = this.accounts.envProxyFor(environmentId);
    if (!raw) return {};
    const url = normalizeProxy(raw);
    return /^socks[45h]?:\/\//i.test(url) ? { socksProxy: url } : { httpProxy: url };
  }

  private resolveEnvironment(environmentId: string): string {
    const id = (environmentId ?? '').trim() || this.accounts.defaultEnvironmentId();
    if (!id || !this.accounts.getEnvironment(id)) throw new Error('a valid environment is required');
    return id;
  }

  private assertCapacity(): void {
    const live = [...this.active.values()].filter(r => !r.finishedAt).length;
    if (live >= MAX_ACTIVE_IMPORTS) {
      throw new Error('too many login attempts in progress — finish or cancel one first');
    }
  }

  /** Drops finished sessions past their TTL and hard-expires anything past its deadline. */
  private prune(): void {
    const now = Date.now();
    for (const [id, rec] of this.active) {
      if (rec.finishedAt && now - rec.finishedAt > SESSION_TTL_MS) {
        try { rec.session.cancelLoginAttempt(); } catch { /* settled */ }
        this.active.delete(id);
        continue;
      }
      if (!rec.finishedAt && now > rec.expiresAt && rec.state !== 'imported') {
        rec.state = 'expired';
        rec.finishedAt = now;
        try { rec.session.cancelLoginAttempt(); } catch { /* settled */ }
      }
    }
  }

  private snapshot(rec: ImportSession): ImportStatus {
    return {
      sessionId: rec.id, method: rec.method, state: rec.state, expiresAt: rec.expiresAt,
      qrDataUrl: rec.qrDataUrl, guardType: rec.guardType, guardDetail: rec.guardDetail,
      error: rec.error, username: rec.username, steamId: rec.steamId, isUpdate: rec.isUpdate,
      environmentMismatch: rec.environmentMismatch,
    };
  }
}
