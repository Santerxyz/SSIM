import crypto from 'crypto';
import fsExtra from 'fs-extra';
import { logger } from '../utils/logger';
import { writeJsonAtomic } from '../utils/atomicJson';
import { vaultDir } from '../utils/paths';
import type { MaFile } from '../types/account';

// ════════════════════════════════════════════════════════════════════════════
//  AccountVault — the single, PORTABLE, master-password account vault (vault.enc)
//
//  One file holds every account's secrets (password + full maFile + per-account
//  proxy) AND the Steam refresh tokens, encrypted with AES-256-GCM under a key
//  derived from the operator's Master Password via scrypt. The salt + IV + auth
//  tag live in the file header, so the file is 100% PORTABLE: copy vault.enc to
//  another VPS and unlock it with just the password — NO hardware/machine binding.
//
//  The vault is the BASE for every runtime function (login, 2FA confirmations,
//  trades, market sells): LoginFlow reads the password + maFile from here, never
//  from the plaintext mafiles/ folder, once vault mode is active.
//
//  LIMITS: protects data AT REST. A FORGOTTEN MASTER PASSWORD = UNRECOVERABLE
//  (no backdoor, by design). Keep an offline copy of the password.
// ════════════════════════════════════════════════════════════════════════════

const VAULT_FILE = vaultDir('vault.enc');
const MAGIC = 'SSIMVAULT';
// scrypt cost: N=2^15 (~tens of ms / derivation) — strong vs. brute force, fine for
// a once-per-boot unlock. maxmem raised to fit N (≈128·N·r ≈ 33 MB).
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 };

/** One bot's secret record inside the vault. */
export interface VaultAccount {
  username: string;
  password: string;
  maFile:   MaFile;
  /** Per-account proxy override (full URL, may carry credentials). Empty = inherit env. */
  proxy?:   string;
}

interface VaultPayload {
  version:  number;
  accounts: Record<string, VaultAccount>; // key: username.toLowerCase()
  tokens:   Record<string, string>;       // key: username.toLowerCase() → Steam refresh token
}

/** On-disk envelope. Header is plaintext; `ct` is the AES-256-GCM ciphertext of the payload JSON. */
interface VaultFileFormat {
  magic:  string;
  v:      number;
  kdf:    { algo: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  iv:     string;
  tag:    string;
  ct:     string;
}

class AccountVaultImpl {
  private key?:     Buffer;
  private salt?:    Buffer;
  private payload?: VaultPayload;
  private saveTimer?: NodeJS.Timeout;

  /** True if vault.enc exists on disk (used by the boot prompt to require a password). */
  exists(): boolean {
    try { return fsExtra.existsSync(VAULT_FILE); } catch { return false; }
  }

  /** True once unlocked/created → the app is running in VAULT MODE. */
  isEnabled(): boolean { return !!this.key && !!this.payload; }

  accountCount(): number { return this.payload ? Object.keys(this.payload.accounts).length : 0; }

  /** Derives the key. For an EXISTING vault the scrypt cost params come from the file
   *  header, so re-tuning the SCRYPT constants never makes an old vault undecryptable. */
  private deriveKey(password: string, salt: Buffer, params?: { N: number; r: number; p: number }): Buffer {
    const N = params?.N ?? SCRYPT.N;
    const r = params?.r ?? SCRYPT.r;
    const p = params?.p ?? SCRYPT.p;
    const maxmem = Math.max(SCRYPT.maxmem, 256 * N * r); // give scrypt room for a possibly-tuned N
    return crypto.scryptSync(Buffer.from(password, 'utf8'), salt, SCRYPT.keylen, { N, r, p, maxmem });
  }

  /**
   * Unlock an existing vault.enc, or CREATE a new empty one with `password`.
   * Throws Error('WRONG_PASSWORD') when an existing vault won't decrypt (GCM auth fail),
   * or Error(...) when vault.enc is corrupt / not an SSIM vault.
   */
  unlockOrCreate(password: string): { created: boolean } {
    if (this.exists()) {
      const file = fsExtra.readJsonSync(VAULT_FILE) as VaultFileFormat;
      if (!file || file.magic !== MAGIC || !file.kdf?.salt || !file.iv || !file.tag || !file.ct) {
        throw new Error('vault.enc is corrupt or not an SSIM vault');
      }
      const salt = Buffer.from(file.kdf.salt, 'base64');
      // Use the cost params persisted in the header (fall back to constants for older files).
      const params = (Number.isInteger(file.kdf.N) && Number.isInteger(file.kdf.r) && Number.isInteger(file.kdf.p))
        ? { N: file.kdf.N, r: file.kdf.r, p: file.kdf.p }
        : undefined;
      const key = this.deriveKey(password, salt, params);
      let plain: string;
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
        plain = Buffer.concat([decipher.update(Buffer.from(file.ct, 'base64')), decipher.final()]).toString('utf8');
      } catch {
        throw new Error('WRONG_PASSWORD'); // GCM auth failure → wrong key
      }
      this.payload = normalizePayload(JSON.parse(plain));
      this.key = key;
      this.salt = salt;
      logger.info(`[vault] unlocked (${this.accountCount()} account(s))`);
      return { created: false };
    }
    // First run: create a fresh vault with a new random salt.
    const salt = crypto.randomBytes(16);
    this.salt = salt;
    this.key = this.deriveKey(password, salt);
    this.payload = { version: 1, accounts: {}, tokens: {} };
    this.save();
    logger.info('[vault] new vault created + unlocked');
    return { created: true };
  }

  /** Encrypt the in-memory payload and atomically (re)write vault.enc with a fresh IV. */
  save(): void {
    if (!this.key || !this.salt || !this.payload) return;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(this.payload), 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    const file: VaultFileFormat = {
      magic: MAGIC, v: 1,
      kdf: { algo: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: this.salt.toString('base64') },
      cipher: 'aes-256-gcm', iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64'),
    };
    writeJsonAtomic(VAULT_FILE, file, { spaces: 0, mode: 0o600, backup: true });
  }

  /** Debounced save for high-frequency writes (token churn during mass login). */
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; this.save(); }, 1_500);
    this.saveTimer.unref?.();
  }

  /** Flush any pending debounced save (call on shutdown). */
  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    this.save();
  }

  /** Decrypts an EXTERNAL vault.enc (from another device) with the given password, WITHOUT
   *  touching this process's own vault. Returns its accounts+tokens, or null on wrong
   *  password / corrupt file. Used by "Import SSIM Vault" to merge another farm. */
  decryptExternalVault(rawContent: string, password: string): { accounts: Record<string, VaultAccount>; tokens: Record<string, string> } | null {
    try {
      const file = JSON.parse(rawContent) as VaultFileFormat;
      if (!file || file.magic !== MAGIC || !file.kdf?.salt || !file.iv || !file.tag || !file.ct) return null;
      const salt = Buffer.from(file.kdf.salt, 'base64');
      const params = (Number.isInteger(file.kdf.N) && Number.isInteger(file.kdf.r) && Number.isInteger(file.kdf.p))
        ? { N: file.kdf.N, r: file.kdf.r, p: file.kdf.p } : undefined;
      const key = this.deriveKey(password, salt, params);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(file.ct, 'base64')), decipher.final()]).toString('utf8');
      const payload = normalizePayload(JSON.parse(plain));
      return { accounts: payload.accounts, tokens: payload.tokens };
    } catch { return null; }
  }

  // ── Accounts ────────────────────────────────────────────────────────────────

  getAccount(username: string): VaultAccount | undefined {
    return this.payload?.accounts[username.toLowerCase()];
  }
  hasAccount(username: string): boolean { return !!this.getAccount(username); }

  /** Add or replace an account's secrets; saves immediately (a credential change). */
  upsertAccount(acc: VaultAccount): void {
    if (!this.payload) throw new Error('vault not unlocked');
    this.payload.accounts[acc.username.toLowerCase()] = acc;
    this.save();
  }

  /** Add ONLY if the username is not already present. Returns true if added. Does NOT
   *  save (the caller batches a single save after a bulk import). */
  importAccount(acc: VaultAccount): boolean {
    if (!this.payload) throw new Error('vault not unlocked');
    // NEVER vault an unusable record: a maFile without shared_secret or a blank password would
    // make hasAccount() true and cause the caller (enterVaultMode) to blank the account's
    // RECOVERABLE plaintext in accounts.json — destroying the last copy of a real credential.
    if (!acc.maFile?.shared_secret || !acc.password) return false;
    const k = acc.username.toLowerCase();
    if (this.payload.accounts[k]) return false;
    this.payload.accounts[k] = acc;
    return true;
  }

  removeAccount(username: string): void {
    if (!this.payload) return;
    const k = username.toLowerCase();
    if (this.payload.accounts[k] || this.payload.tokens[k]) {
      delete this.payload.accounts[k];
      delete this.payload.tokens[k];
      this.save();
    }
  }

  // ── Refresh tokens (consolidated into the same portable file) ────────────────

  getToken(username: string): string | undefined { return this.payload?.tokens[username.toLowerCase()]; }
  setToken(username: string, token: string): void {
    if (!this.payload) return;
    this.payload.tokens[username.toLowerCase()] = token;
    this.scheduleSave();
  }
  deleteToken(username: string): void {
    if (!this.payload) return;
    const k = username.toLowerCase();
    if (this.payload.tokens[k]) { delete this.payload.tokens[k]; this.scheduleSave(); }
  }
}

/** Defensive shape normalization for a decrypted payload (corrupt/older file safety). */
function normalizePayload(p: unknown): VaultPayload {
  const obj = (p && typeof p === 'object') ? p as Record<string, unknown> : {};
  return {
    version:  1,
    accounts: (obj.accounts && typeof obj.accounts === 'object') ? obj.accounts as Record<string, VaultAccount> : {},
    tokens:   (obj.tokens && typeof obj.tokens === 'object') ? obj.tokens as Record<string, string> : {},
  };
}

/** Process-wide singleton. */
export const AccountVault = new AccountVaultImpl();
