import path from 'path';
import crypto from 'crypto';
import fsExtra from 'fs-extra';
import axios from 'axios';
import { logger } from '../utils/logger';
import { writeJsonAtomic } from '../utils/atomicJson';
import { dataDir } from '../utils/paths';
import { ProcessHealth } from '../core/ProcessHealth';
import { getUpdateOutcome, getLastExitClass } from './updateStatus';
import { nextClockMeta, offlineGraceDecision } from './licenseClock';
import {
  LICENSE_API_URL,
  LICENSE_PUBLIC_KEY,
  LICENSE_HTTP_TIMEOUT_MS,
  OFFLINE_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  LICENSE_KEY_FILE,
  LICENSE_TOKEN_FILE,
  HWID_PEPPER,
} from './config';

// ════════════════════════════════════════════════════════════════════════════
//  LicenseClient – server-authoritative license enforcement
//
//  Trust model: the ONLY thing the client can verify offline is an Ed25519
//  signature made by the backend's private key. The signed token binds this
//  machine's HWID + an expiry. Therefore:
//    • A stolen token fails on another machine (HWID mismatch).
//    • A token cannot be forged (no private key on the client).
//    • Cutting the network only buys OFFLINE_GRACE_MS, then fail-closed.
// ════════════════════════════════════════════════════════════════════════════

const DATA_DIR = dataDir();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const CLIENT_VERSION: string = (require('../../package.json') as { version: string }).version;

/**
 * The health/update telemetry rider (C4). Carried on the heartbeat (and the boot-time /validate
 * recheck, so the server learns the version at boot rather than one 45-min beat later). Purely
 * ADDITIVE: the server destructures only { hwid, token } today and ignores the rest (verified), and
 * this client never reads it back, so it is backward-compatible in BOTH directions. Only defined fields
 * are sent (undefined ones are omitted) so the wire carries no nulls. It lets the server size the
 * stranded fleet by version + failure class (UPDATE_RELIABILITY.md §6.6 / BACKEND_RELIABILITY.md F10).
 */
interface HeartbeatTelemetry {
  clientVersion: string;
  moneyOpsBreakerTripped: boolean;
  lastUpdateOutcome?: string;
  lastExitClass?: string;
}
export function telemetryRider(): HeartbeatTelemetry {
  const rider: HeartbeatTelemetry = {
    clientVersion: CLIENT_VERSION,
    moneyOpsBreakerTripped: ProcessHealth.moneyOpsBlocked(),
  };
  const outcome = getUpdateOutcome();
  if (outcome) rider.lastUpdateOutcome = outcome;
  const exitClass = getLastExitClass();
  if (exitClass) rider.lastExitClass = exitClass;
  return rider;
}

export interface LicensePayload {
  hwid: string;
  exp:  number;   // unix ms – hard expiry of this token
  tier: string;   // 'b2c' | 'b2b' | ...
  key:  string;   // license key this token was issued for
  iat:  number;
}

export interface ValidateResult {
  ok:      boolean;
  reason:  string;
  payload?: LicensePayload;
}

const fileIn = (name: string): string => path.join(DATA_DIR, name);

// ── local key/token persistence ──────────────────────────────────────────────
function readKey(): string | undefined {
  const fromEnv = process.env.LICENSE_KEY?.trim();
  if (fromEnv) return fromEnv;
  const f = fileIn(LICENSE_KEY_FILE);
  return fsExtra.existsSync(f) ? fsExtra.readFileSync(f, 'utf8').trim() : undefined;
}

function readToken(): string | undefined {
  const f = fileIn(LICENSE_TOKEN_FILE);
  return fsExtra.existsSync(f) ? fsExtra.readFileSync(f, 'utf8').trim() : undefined;
}

function storeToken(token: string): void {
  fsExtra.ensureDirSync(DATA_DIR);
  // plain text file (already a signed artifact), but lock down perms like tokens
  writeJsonAtomic(fileIn(LICENSE_TOKEN_FILE) + '.json', { token }, { mode: 0o600 });
  fsExtra.writeFileSync(fileIn(LICENSE_TOKEN_FILE), token, { mode: 0o600 });
}

/** Persist the license key the user typed, so future starts can re-activate. */
export function saveKey(key: string): void {
  fsExtra.ensureDirSync(DATA_DIR);
  fsExtra.writeFileSync(fileIn(LICENSE_KEY_FILE), key.trim(), { mode: 0o600 });
}

/** Drop the stored token so the next validate() must re-check online. */
export function clearToken(): void {
  for (const f of [fileIn(LICENSE_TOKEN_FILE), fileIn(LICENSE_TOKEN_FILE) + '.json']) {
    try { if (fsExtra.existsSync(f)) fsExtra.removeSync(f); } catch { /* best effort */ }
  }
}

// ── offline-grace integrity meta (#21) ────────────────────────────────────────
// Anchors the offline-grace window to the LAST SUCCESSFUL SERVER CONTACT (not the
// token's own iat) and tracks the highest clock value ever observed, so rolling the
// system clock back can't extend offline use indefinitely. HMAC'd with the build
// pepper so a casual hand-edit of the file is rejected (raises cost; not unbreakable).
const LICENSE_META_FILE = 'license.meta.json';
const CLOCK_SKEW_MS = 5 * 60 * 1000; // tolerate minor NTP corrections

interface LicenseMeta { lastOnlineMs: number; maxSeenMs: number; }

function metaMac(m: LicenseMeta): string {
  return crypto.createHmac('sha256', HWID_PEPPER).update(`${m.lastOnlineMs}.${m.maxSeenMs}`).digest('base64url');
}
function readMeta(): LicenseMeta | undefined {
  try {
    const f = fileIn(LICENSE_META_FILE);
    if (!fsExtra.existsSync(f)) return undefined;
    const raw = fsExtra.readJsonSync(f) as { lastOnlineMs?: unknown; maxSeenMs?: unknown; mac?: unknown };
    const lastOnlineMs = Number(raw.lastOnlineMs);
    const maxSeenMs = Number(raw.maxSeenMs);
    if (!Number.isFinite(lastOnlineMs) || !Number.isFinite(maxSeenMs)) return undefined;
    const m: LicenseMeta = { lastOnlineMs, maxSeenMs };
    if (raw.mac !== metaMac(m)) { logger.warn('license meta integrity check failed – ignoring'); return undefined; }
    return m;
  } catch { return undefined; }
}
function writeMeta(m: LicenseMeta): void {
  try {
    fsExtra.ensureDirSync(DATA_DIR);
    writeJsonAtomic(fileIn(LICENSE_META_FILE), { ...m, mac: metaMac(m) }, { mode: 0o600 });
  } catch (err) { logger.warn(`could not persist license meta: ${(err as Error).message}`); }
}
/**
 * Records a successful backend contact and advances the clock anchors. The anchors
 * advance ONLY here (server-confirmed) — never from the local clock — so a forward
 * clock jump while offline can't poison the rollback high-water mark and later lock out
 * a valid offline user. (C13 / INV-G2.)
 */
function markOnline(serverTimeMs?: number): void {
  // S26: anchor the rollback high-water mark to the SERVER'S time (accurate, NTP-synced) rather than the
  // LOCAL clock. A machine running with a forward-wrong clock WHILE online otherwise wrote that future
  // value into maxSeenMs on every beat; after the clock was corrected, an expired-token boot hit
  // `now < maxSeenMs - skew → rollback-refused` — offline grace dead until real time caught up. Fall back
  // to the local clock only when the server reported none (an old server → today's behaviour, no worse).
  const anchor = (typeof serverTimeMs === 'number' && Number.isFinite(serverTimeMs) && serverTimeMs > 0) ? serverTimeMs : Date.now();
  writeMeta(nextClockMeta(readMeta(), anchor, true));
  licenseRevoked = false; // a successful server contact means the seat is live
}

// Optional handler invoked when the backend revokes/deactivates the seat at
// runtime. If set, we hand control back to it (→ re-activation flow) instead of
// hard-exiting. If unset, we fall back to a console lock screen + exit.
let onRevoked: ((reason: string) => void) | undefined;
export function onRevocation(cb: (reason: string) => void): void {
  onRevoked = cb;
}

// Last-known seat state, so the full-app /api/system/status reflects an ACTUAL license
// check rather than the positional "any request here is licensed" assumption — the
// dashboard can then see a revocation even before the server is torn down. (INV-G1/G-1.)
let licenseRevoked = false;

// ── token crypto ──────────────────────────────────────────────────────────────
// Token wire format:  base64url(payloadJSON) + "." + base64url(ed25519Sig)
function verifyToken(token: string): LicensePayload | null {
  try {
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const payloadBuf = Buffer.from(body, 'base64url');
    const ok = crypto.verify(
      null,                                // Ed25519 → algorithm is implicit
      payloadBuf,
      LICENSE_PUBLIC_KEY,
      Buffer.from(sig, 'base64url'),
    );
    if (!ok) return null;
    const payload = JSON.parse(payloadBuf.toString('utf8')) as LicensePayload;
    // Runtime shape validation (#39): a signed-but-malformed token must be REJECTED, not
    // cast blindly — a missing exp/iat would otherwise drive the grace math with NaN
    // (`now < NaN` is false, an accidental fail-state rather than a deliberate one).
    if (typeof payload?.hwid !== 'string' || typeof payload?.key !== 'string'
      || !Number.isFinite(payload?.exp) || !Number.isFinite(payload?.iat)) {
      logger.warn('license token payload failed shape validation – rejecting');
      return null;
    }
    return payload;
  } catch (err) {
    logger.warn(`license token verify failed: ${(err as Error).message}`);
    return null;
  }
}

const http = axios.create({
  baseURL: LICENSE_API_URL,
  timeout: LICENSE_HTTP_TIMEOUT_MS,
  validateStatus: () => true, // we branch on status ourselves
});

// ── registration (first run) ──────────────────────────────────────────────────
/** POST /activate – binds key↔hwid on the backend and returns a signed token. */
async function activate(key: string, hwid: string): Promise<ValidateResult> {
  try {
    const res = await http.post('/activate', { key, hwid });
    if (res.status === 200 && typeof res.data?.token === 'string') {
      const payload = verifyToken(res.data.token);
      if (!payload) return { ok: false, reason: 'The server returned an invalid token.' };
      if (payload.hwid !== hwid) return { ok: false, reason: 'Token HWID mismatch.' };
      storeToken(res.data.token);
      markOnline(res.data?.serverTime); // S26: anchor to the server's time, not the local clock
      logger.info(`license activated (tier=${payload.tier})`);
      return { ok: true, reason: 'activated', payload };
    }
    if (res.status === 409) return { ok: false, reason: 'This license is already bound to another machine (seat in use).' };
    if (res.status === 404) return { ok: false, reason: 'Unknown license key.' };
    return { ok: false, reason: `Activation failed (HTTP ${res.status}).` };
  } catch (err) {
    return { ok: false, reason: `License server unreachable: ${(err as Error).message}` };
  }
}

// ── boot validation ───────────────────────────────────────────────────────────
/**
 * The boot gatekeeper's single entry point. Strategy:
 *   1. Have a valid, non-expired, HWID-matching signed token? → allow
 *      (best-effort async online recheck, non-blocking).
 *   2. Token expired but within OFFLINE_GRACE since iat? → allow (offline grace).
 *   3. Otherwise → must (re)activate online with the license key.
 */
export async function validate(hwid: string): Promise<ValidateResult> {
  const token = readToken();
  if (token) {
    const payload = verifyToken(token);
    const storedKey = readKey();
    // #48: a valid token must also be FOR the locally active key. If a different key is
    // stored (e.g. the operator pasted a new one), the old token is not trusted — force a
    // fresh activation. (No stored key → the signed, HWID-bound token stands on its own.)
    if (payload && payload.hwid === hwid && (!storedKey || payload.key === storedKey)) {
      const now = Date.now();
      if (now < payload.exp) {
        // Do NOT advance maxSeenMs from the local clock here — it is advanced only on a
        // server-confirmed contact (markOnline, via the recheck below), so a forward clock
        // jump can't poison the rollback anchor and later lock out a valid user. (C13/INV-G2.)
        void onlineRecheck(hwid, token); // fire-and-forget; on success markOnline() advances anchors
        return { ok: true, reason: 'token-valid', payload };
      }
      // Expired → offline grace, anchored to the LAST SERVER CONTACT (not the token's
      // own iat), and REFUSED if the system clock was rolled back below the highest
      // value we have ever seen (the clock-rollback bypass — #21). Pure decision; no
      // local-clock write happens on any branch (C13).
      const decision = offlineGraceDecision(now, readMeta(), OFFLINE_GRACE_MS, CLOCK_SKEW_MS);
      if (decision === 'no-meta') {
        // No integrity record. A valid token's meta is always created at activation/
        // first online contact, so its absence means it was deleted/tampered (or we have
        // never been online) → DO NOT fall back to the token's own iat (that is exactly
        // the rollback bypass). Force an online re-check instead. (#21 fully closed.)
        logger.warn('license token expired and no integrity record present – offline grace refused; re-activating online');
      } else if (decision === 'rollback-refused') {
        logger.error('system clock rolled back below last-seen time – offline grace refused; re-activating online');
      } else if (decision === 'within-grace') {
        logger.warn('license token expired – running on offline grace (anchored to last server contact)');
        return { ok: true, reason: 'offline-grace', payload };
      } else {
        logger.info('license token expired and grace elapsed – re-activating');
      }
    } else {
      logger.warn('stored license token invalid for this machine – re-activating');
    }
  }

  const key = readKey();
  if (!key) {
    return {
      ok: false,
      reason: 'No license key found.',
    };
  }
  return activate(key, hwid);
}

/** Best-effort: ask the backend whether this seat is still live. */
async function onlineRecheck(hwid: string, token: string): Promise<void> {
  try {
    // Rider (C4) so the server learns clientVersion/last-outcome at BOOT, not one 45-min beat later.
    const res = await http.post('/validate', { hwid, token, ...telemetryRider() });
    if (res.status === 200) {
      if (res.data?.status === 'revoked') {
        logger.error('LICENSE REVOKED by backend.');
        void handleRevoked('This license has been revoked.');
      } else {
        markOnline(res.data?.serverTime); // S26: anchor to the server's time, not the local clock
      }
    }
  } catch {
    /* offline → grace window governs; ignore */
  }
}

// ── heartbeat (runtime validation) ────────────────────────────────────────────
let heartbeatTimer: NodeJS.Timeout | undefined;

/** Starts periodic re-validation. Server can revoke a seat between beats. */
export function startHeartbeat(hwid: string): void {
  const token = readToken();
  if (!token) return;
  heartbeatTimer = setInterval(() => {
    void heartbeat(hwid);
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref(); // never keep the process alive just for the heartbeat
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}

async function heartbeat(hwid: string): Promise<void> {
  const token = readToken();
  if (!token) return;
  try {
    // Health/update telemetry rider (C4) — additive; the server ignores unknown keys.
    const res = await http.post('/heartbeat', { hwid, token, ...telemetryRider() });
    // Revocation is signalled ONLY by the server's authoritative body marker
    // (contract: 403 `{status:'revoked'}`). A BARE 403 with no such body is almost always an
    // intermediary — a WAF, captive portal, or auth proxy — NOT the license server; treating it
    // as a revocation tore down every live session, cleared the token, and forced re-activation
    // on a transient network condition. Require the body marker; ride the offline grace otherwise.
    if (res.data?.status === 'revoked') {
      void handleRevoked('This license has been deactivated by the server.');
      return;
    }
    if (res.status === 403) {
      logger.warn('[license] heartbeat got a bare HTTP 403 with no revoked marker – treating as a transient intermediary block (NOT revoking); riding offline grace');
      return;
    }
    if (res.status === 200) {
      markOnline(res.data?.serverTime); // S26: anchor to the server's time, not the local clock
      if (typeof res.data?.token === 'string') {
        // backend may hand back a freshly-extended token → roll the offline window
        const next = verifyToken(res.data.token);
        if (next && next.hwid === hwid) storeToken(res.data.token);
      }
    }
  } catch {
    /* transient network error – ride the offline grace window */
  }
}

/**
 * Called when the backend revokes/deactivates the seat at runtime.
 * If a revocation handler is registered (the app's "re-activation" flow), hand
 * over to it. Otherwise fall back to a console lock screen + exit.
 */
async function handleRevoked(reason: string): Promise<void> {
  licenseRevoked = true; // surface to /api/system/status before the server is rebound
  stopHeartbeat();
  if (onRevoked) { onRevoked(reason); return; }
  const { printLockScreen } = await import('./lockscreen');
  printLockScreen(reason);
  // give winston a tick to flush, then exit non-zero
  setTimeout(() => process.exit(1), 250).unref();
}

export const LicenseClient = {
  validate, activate, saveKey, clearToken,
  startHeartbeat, stopHeartbeat, onRevocation,
  /** Last-known revoked state for the status route (INV-G1). */
  isRevoked: (): boolean => licenseRevoked,
};
