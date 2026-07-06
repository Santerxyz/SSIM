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
const VAULT_BAK  = vaultDir('vault.enc.bak');
const MAGIC = 'SSIMVAULT';
/** Current vault schema version (envelope `v` AND payload `version`). A file whose
 *  version is HIGHER than this was written by a NEWER SSIM — an older binary must
 *  REFUSE it (never silently rewrite it and strip the newer sections). B30. */
const VAULT_VERSION = 1;
/** Distinct error a caller can detect to show "update SSIM first" instead of the
 *  wrong-password screen (B30). */
export const VAULT_NEWER_VERSION_ERROR = 'VAULT_NEWER_VERSION';
/** Message for an UNREADABLE/mis-shaped vault envelope (unparseable JSON, wrong magic, out-of-bounds
 *  KDF params, garbage scrypt cost). A recoverable corruption shape: the catch in unlockOrCreate
 *  probes the .bak for it exactly like a GCM auth failure (H-ACC-037). */
const VAULT_CORRUPT_ERROR = 'vault.enc is corrupt or not an SSIM vault';
/** Prefix for a TRANSIENT fs error reading vault.enc (EBUSY/EPERM/EACCES/ENOENT/EMFILE — an AV lock,
 *  a race with a restore, a permissions blip). The file itself may be intact, so this NEVER triggers
 *  .bak recovery (recovering an intact-but-locked main from a one-generation-older .bak would silently
 *  lose the newest generation); it is retryable (H-ACC-037). */
export const VAULT_READ_ERROR_PREFIX = 'VAULT_READ_ERROR:';
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
  version:     number;
  accounts:    Record<string, VaultAccount>; // key: username.toLowerCase()
  tokens:      Record<string, string>;       // key: username.toLowerCase() → Steam refresh token
  csfloatKeys: Record<string, string>;       // key: username.toLowerCase() → CSFloat API key (Feature 2)
  /** Environment-level proxy URLs (may carry credentials), key: environmentId. Kept in the
   *  ENCRYPTED vault so fleet-wide proxy creds never sit plaintext in accounts.json (B20). */
  envProxies:  Record<string, string>;
  /** Per-account proxy overrides for accounts WITHOUT a full VaultAccount record (token-only /
   *  LIMITED QR imports), key: username.toLowerCase(). Lets such an account carry a dedicated
   *  proxy encrypted instead of the update being silently dropped (B42). */
  accountProxies: Record<string, string>;
  /** Unknown/newer top-level sections are PRESERVED verbatim (downgrade-safe, B30). */
  [extra: string]: unknown;
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

export class AccountVaultImpl {
  private key?:     Buffer;
  private salt?:    Buffer;
  private payload?: VaultPayload;
  private saveTimer?: NodeJS.Timeout;

  /** File paths are injectable so tests can use isolated temp vaults; production uses the
   *  fixed vault.enc / vault.enc.bak under SSIM_HOME/Vault. */
  constructor(
    private readonly vaultFile: string = VAULT_FILE,
    private readonly vaultBak:  string = VAULT_BAK,
  ) {}

  /** True if vault.enc exists on disk (used by the boot prompt to require a password). */
  exists(): boolean {
    try { return fsExtra.existsSync(this.vaultFile); } catch { return false; }
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
   * Validates the plaintext envelope shape + CLAMPS the header-controlled KDF cost params, then
   * returns the decoded salt + (bounded) params + iv/tag/ct + version, or null for a bad envelope.
   * The header is UNAUTHENTICATED (GCM's tag only covers `ct`), so a crafted/corrupt file could
   * otherwise force `scryptSync` into a multi-GB allocation + a minutes-long synchronous freeze
   * (H-ACC-036). N/r/p are refused unless integer, N a power of two in 2^12–2^17, r in 1–16,
   * p in 1–4, AND 128·N·r ≤ 256 MiB — SSIM's own writes (N=2^15/r=8/p=1) sit well inside these.
   * A file with NO header N/r/p yields params=undefined (deriveKey falls back to the defaults).
   */
  private parseEnvelope(file: unknown): { salt: Buffer; params?: { N: number; r: number; p: number }; iv: string; tag: string; ct: string; v: number } | null {
    const f = file as VaultFileFormat;
    if (!f || f.magic !== MAGIC || !f.kdf?.salt || !f.iv || !f.tag || !f.ct) return null;
    let params: { N: number; r: number; p: number } | undefined;
    if (Number.isInteger(f.kdf.N) && Number.isInteger(f.kdf.r) && Number.isInteger(f.kdf.p)) {
      const { N, r, p } = f.kdf;
      const powerOfTwo = N > 0 && (N & (N - 1)) === 0;
      if (!powerOfTwo || N < 4096 || N > 131072 || r < 1 || r > 16 || p < 1 || p > 4 || 128 * N * r > 256 * 1024 * 1024) {
        return null; // out-of-bounds header cost params → treat exactly like a corrupt envelope
      }
      params = { N, r, p };
    }
    return { salt: Buffer.from(f.kdf.salt, 'base64'), params, iv: f.iv, tag: f.tag, ct: f.ct, v: f.v };
  }

  /**
   * Reads + envelope-validates a vault file and derives the key from ITS OWN header salt,
   * then decrypts. Returns the derived key/salt + plaintext, or throws:
   *   • Error('WRONG_PASSWORD')       — GCM auth failed (wrong key OR a corrupt ciphertext)
   *   • Error(VAULT_NEWER_VERSION…)   — the file's version is newer than this binary (B30)
   *   • Error('vault.enc is corrupt') — not an SSIM vault / unreadable envelope
   *   • Error('VAULT_READ_ERROR:<code>') — a TRANSIENT fs error (AV lock / permissions); retryable,
   *     never a .bak-recovery trigger (H-ACC-037)
   */
  private decryptFile(vaultPath: string, password: string): { key: Buffer; salt: Buffer; plain: string } {
    // A read that throws is either a TRANSIENT fs error (EBUSY/EPERM/… — AV lock / partial restore:
    // the file may be intact, so DON'T recover from an older .bak) or unparseable/truncated JSON
    // (a genuine corruption shape → recoverable from .bak). Classify the two apart (H-ACC-037).
    let file: VaultFileFormat;
    try {
      file = fsExtra.readJsonSync(vaultPath) as VaultFileFormat;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code) throw new Error(`${VAULT_READ_ERROR_PREFIX}${code}`);
      throw new Error(VAULT_CORRUPT_ERROR); // SyntaxError (unparseable/truncated) → corrupt, recoverable
    }
    const env = this.parseEnvelope(file);
    if (!env) {
      throw new Error(VAULT_CORRUPT_ERROR);
    }
    // Envelope version gate (B30): a file written by a NEWER SSIM must be refused with a
    // DISTINCT error (never decrypted-then-rewritten, which would strip its newer sections).
    if (Number.isFinite(Number(env.v)) && Number(env.v) > VAULT_VERSION) {
      throw new Error(VAULT_NEWER_VERSION_ERROR);
    }
    const salt = env.salt;
    // scrypt can throw on garbage header cost params that slip the clamp (or an internal limit) —
    // treat that as a corrupt envelope (recoverable from .bak), consistent with H-ACC-036's clamp.
    let key: Buffer;
    try {
      key = this.deriveKey(password, salt, env.params);
    } catch {
      throw new Error(VAULT_CORRUPT_ERROR);
    }
    let plain: string;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
      plain = Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('WRONG_PASSWORD'); // GCM auth failure → wrong key OR corrupt ciphertext
    }
    return { key, salt, plain };
  }

  /**
   * Unlock an existing vault.enc, or CREATE a new empty one with `password`.
   * If vault.enc is MISSING but a vault.enc.bak decrypts with `password`, the vault is RESTORED
   * from the backup instead of a fresh empty one being created (AV quarantine of vault.enc, a
   * partial restore, an accidental deletion — the password proves ownership of the .bak). Pass
   * `opts.createEmptyAnyway` to skip that probe and deliberately start a NEW empty vault (H-ACC-039).
   * Throws:
   *   • Error('WRONG_PASSWORD')            — the password is wrong (both vault.enc AND its .bak fail,
   *                                          OR vault.enc is missing but the .bak did not decrypt)
   *   • Error(VAULT_NEWER_VERSION_ERROR)   — the vault was written by a newer SSIM (B30)
   *   • Error('vault.enc is corrupt …')    — not an SSIM vault
   */
  unlockOrCreate(password: string, opts?: { createEmptyAnyway?: boolean }): { created: boolean } {
    if (this.exists()) {
      let key: Buffer, salt: Buffer, plain: string;
      try {
        ({ key, salt, plain } = this.decryptFile(this.vaultFile, password));
      } catch (err) {
        // A decrypt failure is either a wrong password OR a corrupt main file (bad ciphertext,
        // unparseable JSON, mis-shaped/garbage-KDF envelope). Both are recoverable: if the SAME
        // password decrypts vault.enc.bak, the FILE is bad (not the password) → recover from the
        // backup and restore it. Only when the .bak ALSO fails (or doesn't exist) is it a genuine
        // wrong password. A newer-version refusal and a TRANSIENT read error (VAULT_READ_ERROR:*,
        // AV lock — the intact main must NOT be replaced by an older .bak) are NOT decrypt
        // failures and are rethrown as-is (H-ACC-037).
        const em = (err as Error).message;
        if (em !== 'WRONG_PASSWORD' && em !== VAULT_CORRUPT_ERROR) throw err;
        const rec = this.tryRecoverFromBak(password);
        if (!rec) throw err; // both main and .bak fail → genuine wrong password / corrupt-both
        logger.error('[vault] vault.enc failed to decrypt but vault.enc.bak did — the main file is CORRUPT (password is correct). Recovering from the backup.');
        this.payload = rec.payload; this.key = rec.key; this.salt = rec.salt;
        // S5: rewrite a healthy vault.enc WITHOUT a backup pass. The default backup:true would first
        // copy the still-corrupt vault.enc OVER the just-proven-good vault.enc.bak, and a crash/AV-lock
        // between that copy and the rename would leave BOTH files corrupt → total, unrecoverable farm
        // credential loss. Writing atomically without touching .bak keeps the good backup intact: a
        // crash mid-recovery leaves vault.enc corrupt but .bak good, so the next boot re-recovers.
        // H-ACC-038: the fields above are set FIRST because save() reads them, but a persist throw
        // (disk-full/EPERM/AV-lock) would otherwise leave isEnabled()===true with nothing on disk while
        // the caller is told the unlock failed. Roll them back so a throw restores the locked state.
        try { this.save({ backup: false }); }
        catch (e) { this.key = this.salt = this.payload = undefined; throw e; }
        logger.info(`[vault] recovered from backup + rewrote vault.enc (${this.accountCount()} account(s))`);
        return { created: false };
      }
      this.payload = this.parseAndVersionCheck(plain);
      this.key = key;
      this.salt = salt;
      logger.info(`[vault] unlocked (${this.accountCount()} account(s))`);
      return { created: false };
    }
    // vault.enc is MISSING. Before treating this as a first run, probe for a recoverable
    // vault.enc.bak: if the SAME password decrypts the backup, vault.enc was quarantined/deleted
    // but the farm's credentials survive → RESTORE from the .bak rather than silently creating an
    // empty vault over the operator's only remaining copy (H-ACC-039). `createEmptyAnyway` is the
    // deliberate escape hatch (portal confirm / SSIM_VAULT_CREATE=1) for a genuine fresh start.
    let bakExists = false;
    try { bakExists = fsExtra.existsSync(this.vaultBak); } catch { bakExists = false; }
    if (!opts?.createEmptyAnyway && bakExists) {
      const rec = this.tryRecoverFromBak(password);
      if (rec) {
        this.payload = rec.payload; this.key = rec.key; this.salt = rec.salt;
        // S5: rewrite vault.enc WITHOUT a backup pass (never copy anything over the proven-good .bak).
        // H-ACC-038: roll the fields back on a persist throw so the caller-observed failure keeps the
        // vault locked (isEnabled()===false) rather than half-enabled with an unpersisted payload.
        try { this.save({ backup: false }); }
        catch (e) { this.key = this.salt = this.payload = undefined; throw e; }
        logger.info('[vault] vault.enc was missing but vault.enc.bak decrypted — restored the vault from the backup');
        logger.info(`[vault] restored from backup (${this.accountCount()} account(s))`);
        return { created: false };
      }
      // A .bak exists but did NOT decrypt with this password: do NOT create a fresh vault over a
      // possibly-recoverable farm on a typo. Report a wrong password (delete BOTH files to reset).
      throw new Error('WRONG_PASSWORD');
    }
    // First run: create a fresh vault with a new random salt.
    const salt = crypto.randomBytes(16);
    this.salt = salt;
    this.key = this.deriveKey(password, salt);
    this.payload = { version: VAULT_VERSION, accounts: {}, tokens: {}, csfloatKeys: {}, envProxies: {}, accountProxies: {} };
    // H-ACC-038: roll the fields back on a persist throw so a save failure during create leaves the
    // vault locked (isEnabled()===false) instead of enabled-in-memory with no vault.enc on disk.
    try { this.save(); }
    catch (e) { this.key = this.salt = this.payload = undefined; throw e; }
    logger.info('[vault] new vault created + unlocked');
    return { created: true };
  }

  /** Parses decrypted JSON, refuses a payload whose version is newer than this binary (B30),
   *  and normalizes the shape while PRESERVING unknown/newer sections (downgrade-safe). */
  private parseAndVersionCheck(plain: string): VaultPayload {
    const raw = JSON.parse(plain) as Record<string, unknown>;
    if (Number.isFinite(Number(raw.version)) && Number(raw.version) > VAULT_VERSION) {
      throw new Error(VAULT_NEWER_VERSION_ERROR);
    }
    return normalizePayload(raw);
  }

  /** Attempts to decrypt vault.enc.bak with `password`. Returns the recovered material or null. */
  private tryRecoverFromBak(password: string): { key: Buffer; salt: Buffer; payload: VaultPayload } | null {
    try {
      if (!fsExtra.existsSync(this.vaultBak)) return null;
      const { key, salt, plain } = this.decryptFile(this.vaultBak, password);
      return { key, salt, payload: this.parseAndVersionCheck(plain) };
    } catch { return null; }
  }

  /** Encrypt the in-memory payload and atomically (re)write vault.enc with a fresh IV.
   *  `backup` defaults true (keep a one-generation vault.enc.bak of the prior good state); the
   *  recovery path passes false so it never copies a corrupt main over a proven-good .bak (S5). */
  save(opts?: { backup?: boolean }): void {
    if (!this.key || !this.salt || !this.payload) return;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(this.payload), 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    const file: VaultFileFormat = {
      magic: MAGIC, v: VAULT_VERSION,
      kdf: { algo: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: this.salt.toString('base64') },
      cipher: 'aes-256-gcm', iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64'),
    };
    writeJsonAtomic(this.vaultFile, file, { spaces: 0, mode: 0o600, backup: opts?.backup ?? true });
  }

  /** Debounced save for high-frequency writes (token churn during mass login). */
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; try { this.save(); } catch (e) { logger.warn(`[vault] debounced save failed — token/CSFloat-key changes since the last successful save remain unpersisted until the next save or the shutdown flush: ${(e as Error).message}`); } }, 1_500);
    this.saveTimer.unref?.();
  }

  /** Flush any pending debounced save (call on shutdown). Returns true if persisted (or nothing
   *  to persist); false if the save threw — the failure is logged loudly but NEVER propagated, so
   *  a locked/read-only vault dir at exit cannot wedge the graceful-shutdown latch (H-ACC-041). */
  flush(): boolean {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    if (!this.isEnabled()) return true;
    try { this.save(); return true; }
    catch (e) { logger.error(`[vault] flush failed — token/key changes since the last successful save are NOT persisted: ${(e as Error).message}`); return false; }
  }

  /**
   * PROVES the current payload is persisted + decryptable from disk: re-reads vault.enc and
   * decrypts it with the in-memory key. Used as a hard gate before deleting any plaintext
   * secret source (B21) — we never remove the last copy of a secret on an unverified vault.
   */
  verifyDiskRoundTrip(): boolean {
    if (!this.key) return false;
    try {
      const env = this.parseEnvelope(fsExtra.readJsonSync(this.vaultFile));
      if (!env) return false;
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(env.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString('utf8');
      return !!JSON.parse(plain) && typeof JSON.parse(plain) === 'object';
    } catch { return false; }
  }

  /** Decrypts an EXTERNAL vault.enc (from another device) with the given password, WITHOUT
   *  touching this process's own vault. Returns its accounts+tokens, or null on wrong
   *  password / corrupt file. Throws Error(VAULT_NEWER_VERSION_ERROR) when the source file
   *  was written by a NEWER SSIM (B30/H-ACC-043) so the caller can tell the operator to update
   *  rather than collapsing it into a password error. Used by "Import SSIM Vault" to merge a farm. */
  decryptExternalVault(rawContent: string, password: string): { accounts: Record<string, VaultAccount>; tokens: Record<string, string> } | null {
    try {
      const env = this.parseEnvelope(JSON.parse(rawContent));
      if (!env) return null;
      // A source vault from a NEWER SSIM must NOT collapse into the wrong-password `null` (B30):
      // surface it as VAULT_NEWER_VERSION_ERROR so the import route can tell the operator to update
      // SSIM instead of re-typing a correct password forever. Rethrown from the catch below so the
      // generic swallow can't turn it back into null. H-ACC-043.
      if (Number.isFinite(Number(env.v)) && Number(env.v) > VAULT_VERSION) throw new Error(VAULT_NEWER_VERSION_ERROR);
      const key = this.deriveKey(password, env.salt, env.params);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString('utf8');
      const payload = normalizePayload(JSON.parse(plain));
      return { accounts: payload.accounts, tokens: payload.tokens };
    } catch (e) {
      if ((e as Error).message === VAULT_NEWER_VERSION_ERROR) throw e; // distinct error survives the generic catch
      return null;
    }
  }

  // ── Accounts ────────────────────────────────────────────────────────────────

  getAccount(username: string): VaultAccount | undefined {
    // Defensive copy: never hand a live reference into the encrypted payload — a caller
    // mutating the record (e.g. the PATCH route setting v.password) must not touch the store
    // until it explicitly upserts, so a later-failed edit leaves memory/disk untorn.
    const rec = this.payload?.accounts[username.toLowerCase()];
    return rec ? structuredClone(rec) : undefined;
  }
  hasAccount(username: string): boolean { return !!this.getAccount(username); }
  /** Full-record usernames (lowercase) currently in the vault — for the boot vault→org heal
   *  (re-link a vaulted account that lost its accounts.json record). H-ACC-011. */
  listAccountUsernames(): string[] { return this.payload ? Object.keys(this.payload.accounts) : []; }
  /** Token-only usernames (lowercase) currently in the vault (QR/LIMITED imports whose sole
   *  credential is the refresh token) — same boot vault→org heal. H-ACC-011. */
  listTokenUsernames(): string[] { return this.payload ? Object.keys(this.payload.tokens) : []; }

  /** Add or replace an account's secrets; saves immediately (a credential change). */
  upsertAccount(acc: VaultAccount): void {
    if (!this.payload) throw new Error('vault not unlocked');
    this.payload.accounts[acc.username.toLowerCase()] = structuredClone(acc);
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
    this.payload.accounts[k] = structuredClone(acc);
    return true;
  }

  removeAccount(username: string): void {
    if (!this.payload) return;
    const k = username.toLowerCase();
    if (this.payload.accounts[k] || this.payload.tokens[k] || this.payload.csfloatKeys[k] || this.payload.accountProxies[k]) {
      delete this.payload.accounts[k];
      delete this.payload.tokens[k];
      delete this.payload.csfloatKeys[k];
      delete this.payload.accountProxies[k];
      this.save();
    }
  }

  // ── Refresh tokens (consolidated into the same portable file) ────────────────

  getToken(username: string): string | undefined { return this.payload?.tokens[username.toLowerCase()]; }
  setToken(username: string, token: string): void {
    if (!this.payload) return;
    const k = username.toLowerCase();
    // First-mint (B32): a just-imported token-only LIMITED account has the refresh token as its
    // SOLE credential. The 1.5s debounced+unref'd save could be lost to a kill/power-loss in the
    // window, stranding a registered account with no login path. Persist a FIRST token
    // SYNCHRONOUSLY; keep the debounce only for token ROTATION churn (an existing token updating).
    const firstMint = !this.payload.tokens[k];
    this.payload.tokens[k] = token;
    if (firstMint) this.save(); else this.scheduleSave();
  }
  deleteToken(username: string): void {
    if (!this.payload) return;
    const k = username.toLowerCase();
    if (this.payload.tokens[k]) { delete this.payload.tokens[k]; this.scheduleSave(); }
  }

  // ── CSFloat API keys (per account, consolidated into the portable vault) ─────
  getCsFloatKey(username: string): string | undefined { return this.payload?.csfloatKeys[username.toLowerCase()]; }
  setCsFloatKey(username: string, key: string): void {
    if (!this.payload) return;
    const k = username.toLowerCase();
    // First-set (B32 parity): the first CSFloat key for an account is its sole marketplace
    // credential; a 1.5s debounced+unref'd save could be lost to a kill/power-loss in the window,
    // stranding an account the operator was told is "configured". Persist a FIRST key
    // SYNCHRONOUSLY; keep the debounce only for key ROTATION churn (an existing key updating).
    const firstSet = !this.payload.csfloatKeys[k];
    this.payload.csfloatKeys[k] = key;
    if (firstSet) this.save(); else this.scheduleSave();
  }
  deleteCsFloatKey(username: string): void {
    if (!this.payload) return;
    const k = username.toLowerCase();
    if (this.payload.csfloatKeys[k]) { delete this.payload.csfloatKeys[k]; this.scheduleSave(); }
  }
  /** Usernames (lowercase) that currently have a CSFloat key — for F3 "any available key". */
  csfloatKeyUsernames(): string[] { return this.payload ? Object.keys(this.payload.csfloatKeys) : []; }

  // ── Environment proxies (credential-bearing → kept encrypted, never in accounts.json) ──
  getEnvProxy(environmentId: string): string | undefined {
    const v = this.payload?.envProxies[environmentId];
    return v && v.trim() ? v : undefined;
  }
  /** Set (non-empty) or clear (empty/undefined) an environment's proxy. Saves immediately. */
  setEnvProxy(environmentId: string, proxy: string | undefined): void {
    if (!this.payload) throw new Error('vault not unlocked');
    const val = (proxy ?? '').trim();
    if (val) this.payload.envProxies[environmentId] = val;
    else delete this.payload.envProxies[environmentId];
    this.save();
  }
  /** Import an env proxy WITHOUT saving (boot migration batches one save). Returns true if stored. */
  importEnvProxy(environmentId: string, proxy: string): boolean {
    if (!this.payload) throw new Error('vault not unlocked');
    const val = (proxy ?? '').trim();
    if (!val || this.payload.envProxies[environmentId]) return false;
    this.payload.envProxies[environmentId] = val;
    return true;
  }
  deleteEnvProxy(environmentId: string): void {
    if (!this.payload) return;
    if (this.payload.envProxies[environmentId]) { delete this.payload.envProxies[environmentId]; this.save(); }
  }

  // ── Per-account proxy for token-only accounts (no full VaultAccount record) — B42 ──
  getAccountProxy(username: string): string | undefined {
    const v = this.payload?.accountProxies[username.toLowerCase()];
    return v && v.trim() ? v : undefined;
  }
  setAccountProxy(username: string, proxy: string | undefined): void {
    if (!this.payload) throw new Error('vault not unlocked');
    const k = username.toLowerCase();
    const val = (proxy ?? '').trim();
    if (val) this.payload.accountProxies[k] = val;
    else delete this.payload.accountProxies[k];
    this.save();
  }
}

/** Defensive shape normalization for a decrypted payload (corrupt/older file safety).
 *  PRESERVES unknown/newer top-level sections (spread first) so an older binary that reads
 *  a newer-but-same-version vault never DROPS sections it doesn't recognise on the next save
 *  (B30 downgrade-safety); the known sections are then coerced to safe shapes. */
function normalizePayload(p: unknown): VaultPayload {
  const obj = (p && typeof p === 'object') ? p as Record<string, unknown> : {};
  const version = Number(obj.version);
  return {
    ...obj,
    version:     Number.isFinite(version) && version > 0 ? version : VAULT_VERSION,
    accounts:    (obj.accounts && typeof obj.accounts === 'object') ? obj.accounts as Record<string, VaultAccount> : {},
    tokens:      (obj.tokens && typeof obj.tokens === 'object') ? obj.tokens as Record<string, string> : {},
    csfloatKeys: (obj.csfloatKeys && typeof obj.csfloatKeys === 'object') ? obj.csfloatKeys as Record<string, string> : {},
    envProxies:  (obj.envProxies && typeof obj.envProxies === 'object') ? obj.envProxies as Record<string, string> : {},
    accountProxies: (obj.accountProxies && typeof obj.accountProxies === 'object') ? obj.accountProxies as Record<string, string> : {},
  };
}

/** Process-wide singleton. */
export const AccountVault = new AccountVaultImpl();
