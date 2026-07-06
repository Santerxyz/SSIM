import SteamTotp from 'steam-totp';
import type { AccountConfig, MaFile } from '../types/account';
import { logger } from '../utils/logger';
import { AccountVault } from './AccountVault';
import { loadMaFileFromDisk } from './maFiles';
import { getSteamTotpOffsetSeconds } from '../trading/steamTotpTimeout';

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
  };
}

/** Refreshes the twoFactorCode on an existing logOn payload to the current 30s window. */
export function restampTotp(options: Record<string, unknown>, maFile: MaFile): void {
  options.twoFactorCode = generateTotpCode(maFile.shared_secret);
}
