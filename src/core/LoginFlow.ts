import fs from 'fs';
import SteamTotp from 'steam-totp';
import type { AccountConfig, MaFile } from '../types/account';
import { logger } from '../utils/logger';
import { AccountVault } from './AccountVault';
import { loadMaFileFromDisk, resolveMaFilePath } from './maFiles';
import { getSteamTotpOffsetSeconds } from '../trading/steamTotpTimeout';
import { deviceLogOnFields } from '../network/accountIdentity';

// ─── maFile loading ────────────────────────────────────────────────────────────

/**
 * Returns the account's maFile. In VAULT MODE the vault is the source of truth (the
 * mafiles/ folder is no longer read for a vaulted account — requirement #4); a not-yet
 * imported account falls back to disk so a freshly-dropped bot can still be used until
 * the next merge. In plaintext mode it reads from disk as before.
 */
export function loadMaFile(account: AccountConfig): MaFile {
  if (AccountVault.isEnabled()) {
    const v = AccountVault.getAccount(account.username);
    if (v?.maFile?.shared_secret) {
      if (!v.maFile.identity_secret) {
        logger.warn(`[${account.username}] vault maFile missing identity_secret (trade confirmations won't work)`);
      }
      return v.maFile;
    }
  }
  const maFile = loadMaFileFromDisk(account.maFilePath);
  if (!maFile.identity_secret) {
    logger.warn(`[${account.username}] maFile missing identity_secret (trade confirmations won't work)`);
  }
  return maFile;
}

/**
 * The RUNTIME identity_secret presence for an account, resolved exactly the way {@link loadMaFile}
 * resolves the credential — vault then disk — so the capability the dashboard shows matches what a
 * login would actually confirm with. Tri-state on purpose (INV-B10 "unknown ≠ empty"):
 * a fs/JSON error is reported as `'unknown'`, never coerced to `'absent'`, so the caller can fall
 * back to the tier label instead of fabricating a false negative.
 *   • vault mode + the vault's maFile carries a shared_secret → classify by that maFile's
 *     identity_secret (mirrors loadMaFile's vault-hit gate; disk is never read for a vaulted bot).
 *   • otherwise read from disk: identity_secret present/absent → `'present'`/`'absent'`; a
 *     "not found" throw → `'absent'`; any other throw (JSON/fs) → `'unknown'`.
 * The disk read is memoised in a module-level cache keyed on the maFile path + its mtime, so the
 * 537-account accounts-tree GET does not re-parse every maFile on every poll (S10 hot-path lesson).
 * A statSync failure yields no cache key → return `'unknown'` (never cached).
 */
const diskPresenceCache = new Map<string, { mtimeKey: string; presence: 'present' | 'absent' | 'unknown' }>();

export function identitySecretPresence(account: AccountConfig): 'present' | 'absent' | 'unknown' {
  if (AccountVault.isEnabled()) {
    const v = AccountVault.getAccount(account.username);
    if (v?.maFile?.shared_secret) return v.maFile.identity_secret ? 'present' : 'absent';
  }
  const resolved = resolveMaFilePath(account.maFilePath);
  let mtimeKey: string;
  try {
    mtimeKey = String(fs.statSync(resolved).mtimeMs);
  } catch {
    return 'unknown'; // unstattable → no cache key → honest 'unknown' (tier fallback), never a fabricated 'absent'
  }
  const cached = diskPresenceCache.get(resolved);
  if (cached && cached.mtimeKey === mtimeKey) return cached.presence;
  let presence: 'present' | 'absent' | 'unknown';
  try {
    presence = loadMaFileFromDisk(account.maFilePath).identity_secret ? 'present' : 'absent';
  } catch (err) {
    presence = /maFile not found/.test((err as Error).message) ? 'absent' : 'unknown';
  }
  diskPresenceCache.set(resolved, { mtimeKey, presence });
  return presence;
}

// ─── TOTP generation ───────────────────────────────────────────────────────────

/**
 * Generates a fresh TOTP code from the given shared_secret.
 * TOTP codes rotate every 30 s; call this immediately before use.
 * Corrects for local-vs-Steam clock skew with the same authoritative offset the S6 layer maintains
 * for every confirmation/money path, so credential logins survive a skewed local clock (offset 0 until
 * one is learned → byte-identical to the raw-clock behaviour).
 */
export function generateTotpCode(sharedSecret: string): string {
  return SteamTotp.generateAuthCode(sharedSecret, getSteamTotpOffsetSeconds());
}

/**
 * Returns milliseconds until the current TOTP code expires.
 * Useful for scheduling retries after a "wrong code" error.
 * Uses the Steam-corrected epoch so the window boundary matches the code above.
 */
export function msUntilNextTotp(): number {
  const epoch = Math.floor(Date.now() / 1000) + getSteamTotpOffsetSeconds();
  return (30 - (epoch % 30)) * 1000;
}

// ─── logOn payload builder ─────────────────────────────────────────────────────

export interface LogOnOptions {
  accountName:      string;
  password:         string;
  twoFactorCode:    string;
  rememberPassword: boolean;
  /** The PC this account claims to be — see network/accountIdentity. Without it steam-user
   *  sends an empty machine_name and steam-session falls back to a hostname shared by the
   *  whole fleet. */
  machineName:      string;
  /** The account's claimed LAN address, obfuscated by steam-user into obfuscated_private_ip.
   *  Without it every account reports 0, which no real Steam client does. */
  logonID:          string;
  [key: string]:    unknown; // satisfies steam-user's index-signature requirement
}

/**
 * Resolves the credential login password for an account (single source of truth so the
 * capability check and the logOn builder can never drift). VAULT MODE: the password is in
 * the vault (accounts.json's is blanked). A BLANK vault password (`||`, not `??`) must never
 * mask a recoverable plaintext one — fall back to the on-disk record. Plaintext mode: use
 * the on-disk account record.
 */
export function resolvePassword(account: AccountConfig): string {
  const vaultPw = AccountVault.isEnabled() ? AccountVault.getAccount(account.username)?.password : undefined;
  return vaultPw || account.password;
}

/**
 * Builds the credential logOn payload. The embedded twoFactorCode is valid only for the
 * current 30s window — any caller that re-sends this payload later (retry loops) must call
 * {@link restampTotp} immediately before each send, or a stale-window code races the login timeout.
 */
export function buildLogOnOptions(account: AccountConfig, maFile: MaFile): LogOnOptions {
  return {
    accountName:      account.username,
    password:         resolvePassword(account),
    twoFactorCode:    generateTotpCode(maFile.shared_secret),
    rememberPassword: false,
    ...deviceLogOnFields(account.username),
  };
}

export interface TokenLogOnOptions {
  refreshToken:  string;
  machineName:   string;
  logonID:       string;
  [key: string]: unknown;
}

/**
 * Builds the TOKEN logOn payload — the everyday login for the whole fleet.
 *
 * It exists as its own builder purely so the device fields cannot be forgotten here. They were
 * (2026-08-27 audit): the token path is the one that runs all day, steam-user keeps `machine_name`
 * for a refreshToken logon, and `webLogOn()` rebuilds its LoginSession from these same details — so
 * an omission here would put the installation-wide hostname back on every account while the
 * credential path, which almost never runs, looked correct.
 */
export function buildTokenLogOnOptions(username: string, refreshToken: string): TokenLogOnOptions {
  return { refreshToken, ...deviceLogOnFields(username) };
}

/** Refreshes the twoFactorCode on an existing logOn payload to the current 30s window. */
export function restampTotp(options: Record<string, unknown>, maFile: MaFile): void {
  options.twoFactorCode = generateTotpCode(maFile.shared_secret);
}
