import path from 'path';
import fsExtra from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';
import type {
  AccountConfig, AccountTier, AccountsDatabase, NetworkConfig,
  Environment, Folder, TreeNode, AccountTree,
} from '../types/account';
import { logger } from '../utils/logger';
import { writeJsonAtomic } from '../utils/atomicJson';
import { vaultDir } from '../utils/paths';
import { AccountVault } from './AccountVault';
import { loadMaFileFromDisk } from './maFiles';

const DB_PATH    = vaultDir('accounts.json');
const DB_VERSION = 4; // v2 folders[]; v3 environments[]; v4 portable maFilePath (bare filename in ./mafiles)

/**
 * Directory names that historically held maFiles. Absolute paths into any of
 * these are rewritten to the bare filename during the v4 migration – loadMaFile
 * resolves bare names against the consolidated ./mafiles dir, which makes
 * accounts.json survive machine/folder moves. Paths pointing somewhere ELSE
 * (operator keeps maFiles on another drive) are left untouched.
 */
const LEGACY_MAFILE_DIRS = new Set(['mafiles', 'mafiles_unlinked']);

// ─── AccountManager ───────────────────────────────────────────────────────────

export class AccountManager {
  private db: AccountsDatabase;

  constructor() {
    this.db = this.load();
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private load(): AccountsDatabase {
    if (!fsExtra.existsSync(DB_PATH)) {
      fsExtra.ensureDirSync(path.dirname(DB_PATH));
      const defaultEnv: Environment = {
        id: uuidv4(), name: 'Standard', proxy: '', createdAt: new Date().toISOString(),
      };
      const fresh: AccountsDatabase = {
        version: DB_VERSION, environments: [defaultEnv], folders: [], accounts: [],
        updatedAt: new Date().toISOString(),
      };
      fsExtra.writeJsonSync(DB_PATH, fresh, { spaces: 2 });
      return fresh;
    }
    let db: AccountsDatabase;
    try {
      db = fsExtra.readJsonSync(DB_PATH) as AccountsDatabase;
    } catch (err) {
      // accounts.json is present but unparseable (hand-edit typo, disk fault, a torn write). The
      // .bak written by save() (B34) exists for exactly this case — recover from it instead of
      // bricking boot or (worse) fabricating an empty fleet, which would hide a recoverable file
      // and trip the vault→org self-heal against real data (S4/S7). (H-ACC-013.)
      db = this.recoverFromBak(err as Error);
    }
    return this.migrate(db);
  }

  /**
   * H-ACC-013: recover a corrupt accounts.json from its sibling .bak, or fail loud.
   *   • .bak parses → QUARANTINE the corrupt main as accounts.json.corrupt-<epochMs> (kept for
   *     forensics, never deleted) BEFORE adopting the backup, so the next save()'s backup:true
   *     copies recovered-good data and never clobbers the good .bak with the corrupt main (S5).
   *   • .bak missing/also-corrupt → throw a single named Error. NEVER fall through to the fresh-db
   *     branch: an empty fleet fabricated from a failed read is the S4/S7 failure class.
   */
  private recoverFromBak(err: Error): AccountsDatabase {
    logger.error(`accounts.json at ${DB_PATH} is unreadable (${err.message}) — attempting recovery from ${DB_PATH}.bak`);
    const bak = `${DB_PATH}.bak`;
    let recovered: AccountsDatabase;
    try {
      recovered = fsExtra.readJsonSync(bak) as AccountsDatabase;
    } catch (bakErr) {
      throw new Error(
        `accounts.json is corrupt (${err.message}) and ${bak} could not recover it (${(bakErr as Error).message}). ` +
        `The corrupt file was left in place at ${DB_PATH}; restore it from a backup (or delete it to start fresh) and restart.`,
      );
    }
    // Rename the corrupt main away BEFORE any save so the next save() backs up recovered-good data.
    const quarantine = `${DB_PATH}.corrupt-${Date.now()}`;
    fsExtra.renameSync(DB_PATH, quarantine);
    logger.warn(`[accounts] recovered accounts.json from .bak — corrupt original kept as ${quarantine}`);
    return recovered;
  }

  /**
   * Forward-compatible migration.
   *   v1 → v2: add flat folders[].
   *   v2 → v3: add environments[]; assign a default environment to every
   *            account+folder; move each account's old `network` into
   *            `networkOverride` (so behaviour stays 1:1) and drop the now-computed
   *            `network` from disk.
   *   v3 → v4: maFiles consolidated into ./mafiles – absolute maFilePaths into
   *            the legacy dirs become bare filenames (portable across machines).
   */
  private migrate(db: AccountsDatabase): AccountsDatabase {
    let changed = false;

    if (!Array.isArray(db.folders))      { db.folders = [];      changed = true; }
    if (!Array.isArray(db.environments)) { db.environments = []; changed = true; }

    if (db.version < 3) {
      let def = db.environments[0];
      if (!def) {
        def = { id: uuidv4(), name: 'Standard', proxy: '', createdAt: new Date().toISOString() };
        db.environments.push(def);
      }
      for (const acc of db.accounts) {
        if (!acc.environmentId) acc.environmentId = def.id;
        const legacy = (acc as AccountConfig & { network?: NetworkConfig }).network;
        if (legacy && !acc.networkOverride) acc.networkOverride = legacy;
        delete (acc as AccountConfig & { network?: NetworkConfig }).network; // computed now
      }
      for (const f of db.folders) {
        if (!f.environmentId) f.environmentId = def.id;
      }
      changed = true;
    }

    if (db.version < 4) {
      let migrated = 0;
      for (const acc of db.accounts) {
        if (typeof acc.maFilePath === 'string' && path.isAbsolute(acc.maFilePath)) {
          const parent = path.basename(path.dirname(acc.maFilePath)).toLowerCase();
          if (LEGACY_MAFILE_DIRS.has(parent)) {
            acc.maFilePath = path.basename(acc.maFilePath);
            migrated++;
          }
        }
      }
      if (migrated) logger.info(`maFilePath migration: ${migrated} account(s) → portable filename in ./mafiles`);
      changed = true;
    }

    if (db.version < DB_VERSION) { db.version = DB_VERSION; changed = true; }

    if (changed) {
      logger.info(`accounts.json migrated to v${DB_VERSION}`);
      this.db = db;            // save() reads this.db
      this.save();
    }
    return db;
  }

  private save(opts?: { backup?: boolean }): void {
    this.db.updatedAt = new Date().toISOString();
    // In VAULT MODE never persist a password or a credential-bearing proxy to accounts.json
    // — BUT only blank an account that is ACTUALLY in the vault. An account that could NOT be
    // vaulted (e.g. its maFile failed to load) KEEPS its plaintext secret here, so a transient
    // problem can never destroy a real credential (non-destructive guarantee). backup:false in
    // vault mode, else the .bak would retain the pre-blank plaintext passwords.
    const vault = AccountVault.isEnabled();
    const toWrite = vault
      ? { ...this.db,
          accounts: this.db.accounts.map(a =>
            AccountVault.hasAccount(a.username)
              ? { ...a, password: '', networkOverride: a.networkOverride?.type === 'proxy' ? undefined : a.networkOverride }
              : a),
          // Environment proxies carry credentials and must NOT sit plaintext in accounts.json
          // (the file the operator is told to back up / copy between machines). Blank the
          // plaintext copy ONLY when the SAME value is provably in the encrypted vault
          // (non-destructive: a not-yet-migrated env keeps its recoverable plaintext). B20.
          environments: this.db.environments.map(e =>
            (e.proxy && e.proxy.trim() && AccountVault.getEnvProxy(e.id) === e.proxy.trim())
              ? { ...e, proxy: '' }
              : e) }
      : this.db;
    // Backup policy (B34): a .bak protects the whole fleet's org structure (env/folder/tier/
    // steamId/tradeUrl) from a bad write or hand-edit. In plaintext mode we always back up. In
    // vault mode we must NOT let the .bak retain PRE-blank plaintext — but that only happens on
    // the TRANSITION write (a vaulted account still carries an in-memory password). Once blanked
    // (steady state) the on-disk file is already secret-free, so a .bak of it leaks nothing new.
    // `secretFree` detects the steady state without a disk read: no vaulted account holds a
    // password in memory. (An unmigrated account's plaintext is already in accounts.json anyway.)
    const secretFree = !this.db.accounts.some(a => a.password && AccountVault.hasAccount(a.username));
    writeJsonAtomic(DB_PATH, toWrite, { spaces: 2, backup: opts?.backup ?? (vault ? secretFree : true) });
    logger.debug('accounts.json saved');
  }

  // ── Vault-mode helpers (used by the boot import/merge in vaultBoot.ts) ────────

  /** Raw account records (incl. the plaintext password, before migration). */
  getAllRaw(): AccountConfig[] { return this.db.accounts; }
  /** True if the username already has an org record in accounts.json. */
  existsRaw(username: string): boolean { return !!this.rawGet(username); }
  /** The default (first) environment id, for newly-dropped imported bots. */
  defaultEnvironmentId(): string { return this.db.environments[0]?.id ?? ''; }

  /** Adds a minimal org record for a brand-new vault-imported bot (NO secrets here). */
  addImportedAccount(p: { username: string; maFilePath: string; environmentId: string; folderId?: string | null }): void {
    if (this.rawGet(p.username)) return;
    this.db.accounts.push({
      id: uuidv4(), username: p.username, password: '', maFilePath: p.maFilePath,
      environmentId: p.environmentId, folderId: p.folderId ?? null,
      enabled: true, addedAt: new Date().toISOString(),
    });
    this.save();
  }

  /** Blanks the now-vaulted secrets out of accounts.json (password + proxy overrides).
   *  Only touches accounts that ACTUALLY made it into the vault — a non-vaulted account keeps
   *  its plaintext credential so it is never destroyed. Also purges the stale plaintext .bak. */
  enterVaultMode(): void {
    // Count the records this pass ACTUALLY blanked (a non-empty password cleared, or a
    // proxy-type override stripped) — enterVaultMode runs on EVERY vault-mode boot (index.ts
    // → vaultBoot.ts:228), but only the write that flips a plaintext secret to blank is a real
    // TRANSITION; a steady-state boot (everything already blank) must touch nothing. (H-ACC-020)
    let blanked = 0;
    for (const acc of this.db.accounts) {
      if (!AccountVault.hasAccount(acc.username)) continue; // not vaulted → keep plaintext (recoverable)
      if (acc.password) { acc.password = ''; blanked++; }
      if (acc.networkOverride?.type === 'proxy') { acc.networkOverride = undefined; blanked++; }
    }
    // Migrate every credential-bearing ENV proxy into the vault (B20); save() then blanks the
    // plaintext copy for envs whose proxy is now provably vaulted (non-destructive).
    let envProxiesMoved = 0;
    for (const env of this.db.environments) {
      if (env.proxy && env.proxy.trim() && AccountVault.importEnvProxy(env.id, env.proxy.trim())) envProxiesMoved++;
    }
    if (envProxiesMoved > 0) { AccountVault.save(); logger.info(`[vault] migrated ${envProxiesMoved} environment proxy/proxies into the vault`); }
    const bak = `${DB_PATH}.bak`;
    if (blanked > 0 || envProxiesMoved > 0) {
      // TRANSITION boot — H-ACC-015's sequence verbatim. Purge FIRST, then save with backup:false
      // — otherwise the save() would copy the PRE-blank plaintext main into accounts.json.bak (the
      // heuristic reads in-memory passwords, which are already blanked above, so it would wrongly
      // back up the still-plaintext DISK). Purging first also removes any plaintext-mode or
      // migrate-time .bak left earlier in this boot. Kill-point matrix: die before purge → old .bak
      // persists but is warned + retried next boot; die between purge and save → plaintext main
      // intact (non-destructive guarantee), no .bak; die after save → disk secret-free, no .bak.
      try { if (fsExtra.existsSync(bak)) fsExtra.removeSync(bak); }
      catch (e) { logger.warn(`[vault] could not remove plaintext accounts.json.bak (${(e as Error).message}) — will retry next boot`); }
      this.save({ backup: false });
      return;
    }
    // STEADY-STATE boot — nothing changed, so NO save (the pointless updatedAt bump / rewrite is
    // dropped) and NO unconditional purge. A .bak that is a STALE pre-transition plaintext backup
    // is retired here (this preserves -15's "a failed purge is retried next boot" property); a .bak
    // whose secrets are NOT provably in the vault is a recoverable rollback copy and is LEFT IN
    // PLACE (same byte-equality doctrine as quarantineMigratedPlaintext, vaultBoot.ts, B21). Matrix:
    // steady boot → main and a non-stale .bak untouched; transition boot → -15's guarantees verbatim;
    // transition purge failed → retried by this sentinel on subsequent boots until gone.
    let bakDb: AccountsDatabase;
    try { bakDb = fsExtra.readJsonSync(bak) as AccountsDatabase; }
    catch { return; } // absent or unreadable → leave it in place (nothing to prove stale)
    let plaintextSecrets = 0;
    let allVaulted = true;
    for (const acc of bakDb.accounts ?? []) {
      if (!acc.password) continue;
      plaintextSecrets++;
      if (AccountVault.getAccount(acc.username)?.password !== acc.password) allVaulted = false;
    }
    for (const env of bakDb.environments ?? []) {
      const p = env.proxy?.trim();
      if (!p) continue;
      plaintextSecrets++;
      if (AccountVault.getEnvProxy(env.id) !== p) allVaulted = false;
    }
    // Purge ONLY a .bak that holds plaintext AND every plaintext secret is byte-equal to the vault
    // (provably stale). A secret-free .bak, or one holding any not-vaulted / mismatched secret
    // (a recoverable orphan), is a legitimate rollback copy — never destroyed.
    if (plaintextSecrets > 0 && allVaulted) {
      try { fsExtra.removeSync(bak); }
      catch (e) { logger.warn(`[vault] could not remove stale plaintext accounts.json.bak (${(e as Error).message}) — will retry next boot`); }
    }
  }

  // ── Network resolution (computed, never persisted) ───────────────────────────

  /** Resolves an account's effective network: per-account override → environment proxy →
   *  local IP. In VAULT MODE the credential-bearing proxy override comes from the vault
   *  (encrypted); a non-secret local-IP bind may still live in accounts.json. */
  resolveNetwork(account: AccountConfig): NetworkConfig {
    if (AccountVault.isEnabled()) {
      // A full VaultAccount's proxy, else a token-only account's per-account proxy (B42).
      const vaultProxy = AccountVault.getAccount(account.username)?.proxy?.trim()
        ?? AccountVault.getAccountProxy(account.username);
      if (vaultProxy) return { type: 'proxy', value: vaultProxy };
      if (account.networkOverride?.type === 'localip') return account.networkOverride;
      // Env proxy: the VAULT is authoritative in vault mode (B20 — accounts.json's copy is
      // blanked once migrated); fall back to the in-memory/plaintext env proxy for a
      // not-yet-migrated environment so egress is never silently lost.
      const env = this.getEnvironment(account.environmentId);
      const envProxy = AccountVault.getEnvProxy(account.environmentId) ?? env?.proxy?.trim();
      return envProxy ? { type: 'proxy', value: envProxy } : { type: 'localip', value: '0.0.0.0' };
    }
    if (account.networkOverride) return account.networkOverride;
    const env = this.getEnvironment(account.environmentId);
    const proxy = env?.proxy?.trim();
    return proxy ? { type: 'proxy', value: proxy } : { type: 'localip', value: '0.0.0.0' };
  }

  /** The effective env proxy for the edit dialog / check-proxy: vault value in vault mode,
   *  else the plaintext env proxy. Single source so no route reads the wrong copy. (B20) */
  envProxyFor(environmentId: string): string {
    if (AccountVault.isEnabled()) {
      return AccountVault.getEnvProxy(environmentId) ?? this.getEnvironment(environmentId)?.proxy?.trim() ?? '';
    }
    return this.getEnvironment(environmentId)?.proxy?.trim() ?? '';
  }

  /** Fills each in-memory environment's proxy from the vault (vault mode) so the list view,
   *  edit dialog and sanitizeEnvironment all see the effective value even after the plaintext
   *  copy was blanked on disk. Called once at boot; does NOT persist. Idempotent. (B20) */
  hydrateEnvProxies(): void {
    if (!AccountVault.isEnabled()) return;
    for (const env of this.db.environments) {
      const v = AccountVault.getEnvProxy(env.id);
      if (v) env.proxy = v;
    }
  }

  /** Returns a copy of the account with the resolved `network` attached. */
  private withNetwork(account: AccountConfig): AccountConfig {
    return { ...account, network: this.resolveNetwork(account) };
  }

  // ── Environments ─────────────────────────────────────────────────────────────

  getEnvironments(): Environment[] { return [...this.db.environments]; }

  getEnvironment(id: string): Environment | undefined {
    return this.db.environments.find(e => e.id === id);
  }

  private getEnvironmentOrThrow(id: string): Environment {
    const env = this.getEnvironment(id);
    if (!env) throw new Error(`Environment "${id}" not found`);
    return env;
  }

  createEnvironment(name: string, proxy = '', color?: string): Environment {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Environment name must not be empty');
    const env: Environment = {
      id: uuidv4(), name: trimmed, proxy: proxy.trim(), color, createdAt: new Date().toISOString(),
    };
    this.db.environments.push(env);
    // Write-through the (credential-bearing) proxy to the encrypted vault; save() then blanks
    // the plaintext copy in accounts.json. (B20)
    if (env.proxy && AccountVault.isEnabled()) AccountVault.setEnvProxy(env.id, env.proxy);
    this.save();
    logger.info(`Environment created: ${env.name} (${env.id})`);
    return env;
  }

  updateEnvironment(id: string, changes: { name?: string; proxy?: string; color?: string }): Environment {
    const env = this.getEnvironmentOrThrow(id);
    if (typeof changes.name === 'string') {
      if (!changes.name.trim()) throw new Error('Environment name must not be empty');
      env.name = changes.name.trim();
    }
    if (typeof changes.proxy === 'string') {
      env.proxy = changes.proxy.trim();
      // Write-through to the vault (empty string clears it); save() blanks the plaintext copy. (B20)
      if (AccountVault.isEnabled()) AccountVault.setEnvProxy(env.id, env.proxy);
    }
    if (typeof changes.color === 'string') env.color = changes.color;
    this.save();
    logger.info(`Environment updated: ${env.name}`);
    return env;
  }

  /** Deletes an environment. Refused (throws) while it still holds any account. */
  deleteEnvironment(id: string): void {
    this.getEnvironmentOrThrow(id);
    const held = this.db.accounts.filter(a => a.environmentId === id);
    if (held.length > 0) {
      throw new Error(`Environment still holds ${held.length} account(s) – move them out first`);
    }
    this.db.folders      = this.db.folders.filter(f => f.environmentId !== id);
    this.db.environments = this.db.environments.filter(e => e.id !== id);
    if (AccountVault.isEnabled()) AccountVault.deleteEnvProxy(id); // drop its vaulted proxy too (B20)
    this.save();
    logger.info(`Environment deleted: ${id}`);
  }

  /** Account count per environment id. */
  countInEnvironment(environmentId: string): number {
    return this.db.accounts.filter(a => a.environmentId === environmentId).length;
  }

  // ── Account CRUD ─────────────────────────────────────────────────────────────

  add(config: {
    username:         string;
    password:         string;
    maFilePath:       string;
    environmentId:    string;
    networkOverride?: NetworkConfig;
    folderId?:        string | null;
    enabled?:         boolean;
    displayName?:     string;
    userAgent?:       string;
    tier?:            AccountTier;
  }): AccountConfig {
    if (!this.getEnvironment(config.environmentId)) {
      throw new Error(`Environment "${config.environmentId}" not found`);
    }
    const exists = this.db.accounts.some(
      a => a.username.toLowerCase() === config.username.toLowerCase(),
    );
    if (exists) throw new Error(`Account "${config.username}" already exists`);

    if (config.folderId != null) {
      const folder = this.getFolder(config.folderId);
      if (!folder) throw new Error(`Folder "${config.folderId}" not found`);
      if (folder.environmentId !== config.environmentId) {
        throw new Error('Target folder belongs to a different environment');
      }
    }

    const account: AccountConfig = {
      id:              uuidv4(),
      username:        config.username,
      password:        config.password,
      maFilePath:      config.maFilePath,
      environmentId:   config.environmentId,
      networkOverride: config.networkOverride,
      folderId:        config.folderId ?? null,
      enabled:         config.enabled ?? true,
      displayName:     config.displayName,
      userAgent:       config.userAgent,
      tier:            config.tier,
      addedAt:         new Date().toISOString(),
    };

    this.db.accounts.push(account);
    this.save();
    logger.info(`Account added: ${account.username} → env ${config.environmentId}`);
    return this.withNetwork(account);
  }

  /** Bulk add (Feature 4 bulk import). Skips duplicates, saves once. */
  addMany(items: Array<{
    username: string; password: string; maFilePath: string;
    environmentId: string; folderId?: string | null; displayName?: string;
  }>): { added: AccountConfig[]; skipped: Array<{ username: string; reason: string }> } {
    const added:   AccountConfig[]                          = [];
    const skipped: Array<{ username: string; reason: string }> = [];

    for (const item of items) {
      try {
        if (!this.getEnvironment(item.environmentId)) throw new Error('environment not found');
        if (this.db.accounts.some(a => a.username.toLowerCase() === item.username.toLowerCase())) {
          throw new Error('already exists');
        }
        if (item.folderId != null) {
          const folder = this.getFolder(item.folderId);
          if (!folder || folder.environmentId !== item.environmentId) throw new Error('invalid folder');
        }
        const account: AccountConfig = {
          id: uuidv4(), username: item.username, password: item.password, maFilePath: item.maFilePath,
          environmentId: item.environmentId, folderId: item.folderId ?? null,
          enabled: true, displayName: item.displayName, addedAt: new Date().toISOString(),
        };
        this.db.accounts.push(account);
        // Defense-in-depth (C18 / INV-A3): vault the secret in vault mode so the final
        // save() blanks the plaintext password. The sole caller already gates vault mode,
        // but vaulting here makes addMany safe regardless of caller. Best-effort per item:
        // if the maFile can't be loaded the account stays plaintext (the non-destructive
        // guarantee), exactly like the single-add path.
        if (AccountVault.isEnabled()) {
          try {
            const maFile = loadMaFileFromDisk(item.maFilePath);
            AccountVault.upsertAccount({ username: item.username, password: item.password, maFile });
          } catch (err) {
            logger.warn(`[${item.username}] bulk import: could not vault (kept plaintext until re-vaulted): ${(err as Error).message}`);
          }
        }
        added.push(this.withNetwork(account));
      } catch (err) {
        skipped.push({ username: item.username, reason: (err as Error).message });
      }
    }

    if (added.length) this.save();
    logger.info(`Bulk import: ${added.length} added, ${skipped.length} skipped`);
    return { added, skipped };
  }

  remove(username: string): boolean {
    const idx = this.db.accounts.findIndex(
      a => a.username.toLowerCase() === username.toLowerCase(),
    );
    if (idx === -1) return false;
    this.db.accounts.splice(idx, 1);
    this.save();
    logger.info(`Account removed: ${username}`);
    return true;
  }

  update(
    username: string,
    changes:  Partial<Omit<AccountConfig, 'id' | 'addedAt' | 'network'>>,
  ): AccountConfig {
    const account = this.rawGetOrThrow(username);
    const safe = { ...changes };
    delete (safe as { network?: unknown }).network; // never persist the computed field
    Object.assign(account, safe);
    this.save();
    return this.withNetwork(account);
  }

  // ── Account queries (return computed-network copies) ─────────────────────────

  get(username: string): AccountConfig | undefined {
    const raw = this.rawGet(username);
    return raw ? this.withNetwork(raw) : undefined;
  }

  private rawGet(username: string): AccountConfig | undefined {
    return this.db.accounts.find(a => a.username.toLowerCase() === username.toLowerCase());
  }

  private rawGetOrThrow(username: string): AccountConfig {
    const account = this.rawGet(username);
    if (!account) throw new Error(`Account "${username}" not found`);
    return account;
  }

  getAll():     AccountConfig[] { return this.db.accounts.map(a => this.withNetwork(a)); }
  getEnabled(): AccountConfig[] { return this.db.accounts.filter(a => a.enabled).map(a => this.withNetwork(a)); }
  count():      number          { return this.db.accounts.length; }

  /** Accounts belonging to a given environment (computed network). */
  getByEnvironment(environmentId: string): AccountConfig[] {
    return this.db.accounts.filter(a => a.environmentId === environmentId).map(a => this.withNetwork(a));
  }

  setEnabled(username: string, enabled: boolean): void {
    this.update(username, { enabled });
  }

  /**
   * Write-through cache of an account's permanent SteamID64, learned on login. Idempotent:
   * only persists when absent/changed, so a mass login writes each account's id at most once
   * (no save churn). Ignores anything that isn't a valid SteamID64 string (never the lossy
   * numeric maFile value). Safe to call on every 'loggedIn'.
   */
  rememberSteamId(username: string, steamId: string): void {
    if (!/^7656\d{13}$/.test(steamId)) return;
    const account = this.rawGet(username);
    if (!account || account.steamId === steamId) return;
    account.steamId = steamId;
    // H-ACC-019: rememberSteamId is called bare inside steam-user's 'loggedOn' emit chain, so a
    // throwing save() (writeJsonAtomic keeps its throw contract; renameSync EPERM/EBUSY under AV is
    // the classic Windows case) would become an uncaughtException and, during a mass first-login,
    // tick the money-ops breaker. The steamId is a write-through CACHE: it stays set in memory, is
    // served correctly this session, and persists with the next successful save — so a disk hiccup
    // must not cross into the emit chain. Degrade to warn-and-continue (same as S24 for TokenStore).
    try {
      this.save();
    } catch (e) {
      logger.warn(`[${account.username}] steamId cache persist failed (kept in memory; persists with the next save): ${(e as Error).message}`);
      return;
    }
    logger.debug(`[${account.username}] cached SteamID ${steamId}`);
  }

  // ── Folders (adjacency list, scoped to environment) ──────────────────────────

  getFolders(): Folder[] { return [...this.db.folders]; }

  getFolder(id: string): Folder | undefined {
    return this.db.folders.find(f => f.id === id);
  }

  /** Creates a folder in `environmentId` under `parentId` (null = environment root). */
  createFolder(name: string, environmentId: string, parentId: string | null = null): Folder {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Folder name must not be empty');
    this.getEnvironmentOrThrow(environmentId);
    if (parentId !== null) {
      const parent = this.getFolderOrThrow(parentId);
      if (parent.environmentId !== environmentId) {
        throw new Error('Parent folder belongs to a different environment');
      }
    }
    const folder: Folder = {
      id: uuidv4(), name: trimmed, parentId, environmentId, createdAt: new Date().toISOString(),
    };
    this.db.folders.push(folder);
    this.save();
    logger.info(`Folder created: ${folder.name} (${folder.id}) in env ${environmentId}`);
    return folder;
  }

  /**
   * Ensures a folder PATH (names, root→leaf) exists in `environmentId`, REUSING an existing
   * folder by name at each level and creating only the missing ones. Returns the leaf folder
   * id (null for an empty path). Used by structure-preserving imports to recreate the source's
   * folder organisation in the target environment without duplicating folders.
   */
  ensureFolderPath(environmentId: string, pathNames: string[]): string | null {
    let parentId: string | null = null;
    for (const rawName of pathNames) {
      const name = (rawName ?? '').trim();
      if (!name) continue;
      const existing = this.db.folders.find(f =>
        f.environmentId === environmentId && (f.parentId ?? null) === parentId && f.name === name);
      parentId = existing ? existing.id : this.createFolder(name, environmentId, parentId).id;
    }
    return parentId;
  }

  renameFolder(id: string, name: string): Folder {
    const folder = this.getFolderOrThrow(id);
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Folder name must not be empty');
    folder.name = trimmed;
    this.save();
    return folder;
  }

  /**
   * Moves a folder under `newParentId` (null = environment root) WITHIN the same
   * environment. Guards against cycles.
   */
  moveFolder(id: string, newParentId: string | null): Folder {
    const folder = this.getFolderOrThrow(id);
    if (newParentId !== null) {
      if (newParentId === id) throw new Error('A folder cannot be its own parent');
      const parent = this.getFolderOrThrow(newParentId);
      if (parent.environmentId !== folder.environmentId) {
        throw new Error('Cannot move a folder into a different environment');
      }
      if (this.isDescendant(newParentId, id)) {
        throw new Error('Cannot move a folder into one of its own descendants');
      }
    }
    folder.parentId = newParentId;
    this.save();
    logger.info(`Folder moved: ${folder.name} → ${newParentId ?? 'root'}`);
    return folder;
  }

  /**
   * Reorders a folder among its SIBLINGS (same environment + same parent) by one
   * step. getTree() renders siblings in `db.folders` array order, so we swap this
   * folder's array slot with the adjacent sibling's. A no-op at the top/bottom edge.
   * Returns true if a swap happened, false if already at the edge.
   */
  reorderFolder(id: string, direction: 'up' | 'down'): boolean {
    const folder = this.getFolderOrThrow(id);
    const parentKey = folder.parentId ?? null;
    const isSibling = (f: Folder) => f.environmentId === folder.environmentId && (f.parentId ?? null) === parentKey;
    const siblings = this.db.folders.filter(isSibling);
    const pos = siblings.findIndex(f => f.id === id);
    const target = direction === 'up' ? siblings[pos - 1] : siblings[pos + 1];
    if (!target) return false; // already first/last among its siblings

    const i = this.db.folders.findIndex(f => f.id === id);
    const j = this.db.folders.findIndex(f => f.id === target.id);
    [this.db.folders[i], this.db.folders[j]] = [this.db.folders[j], this.db.folders[i]];
    this.save();
    logger.info(`Folder reordered: ${folder.name} moved ${direction}`);
    return true;
  }

  /**
   * Deletes a folder NON-destructively: its child folders and accounts are
   * re-parented up to the deleted folder's own parent. Accounts are never lost.
   */
  deleteFolder(id: string): void {
    const folder = this.getFolderOrThrow(id);
    const newParent = folder.parentId;

    for (const child of this.db.folders) {
      if (child.parentId === id) child.parentId = newParent;
    }
    for (const account of this.db.accounts) {
      if (account.folderId === id) account.folderId = newParent;
    }
    this.db.folders = this.db.folders.filter(f => f.id !== id);
    this.save();
    logger.info(`Folder deleted: ${folder.name} – contents re-parented to ${newParent ?? 'root'}`);
  }

  /**
   * Moves an account into a folder (null = environment root) and optionally into
   * a different environment (which resets the folder, since folders are env-scoped).
   */
  moveAccount(username: string, folderId: string | null, environmentId?: string): AccountConfig {
    const account = this.rawGetOrThrow(username);
    let envId = account.environmentId;

    if (environmentId !== undefined && environmentId !== account.environmentId) {
      this.getEnvironmentOrThrow(environmentId);
      envId = environmentId;
      account.environmentId = envId;
      account.folderId = null; // old folder is invalid in the new environment
    }

    if (folderId != null) {
      const folder = this.getFolderOrThrow(folderId);
      if (folder.environmentId !== envId) {
        throw new Error('Target folder belongs to a different environment');
      }
      account.folderId = folderId;
    } else {
      account.folderId = null;
    }

    this.save();
    return this.withNetwork(account);
  }

  /** Builds the nested folder/account tree for ONE environment (computed networks). */
  getTree(environmentId: string): AccountTree {
    const build = (parentId: string | null): TreeNode[] =>
      this.db.folders
        .filter(f => f.environmentId === environmentId && (f.parentId ?? null) === parentId)
        .map(folder => ({
          folder,
          children: build(folder.id),
          accounts: this.accountsInFolder(folder.id, environmentId),
        }));

    return { folders: build(null), accounts: this.accountsInFolder(null, environmentId) };
  }

  // ── Folder helpers ───────────────────────────────────────────────────────────

  private accountsInFolder(folderId: string | null, environmentId: string): AccountConfig[] {
    return this.db.accounts
      .filter(a => {
        if (a.environmentId !== environmentId) return false;
        const fid = a.folderId ?? null;
        // Accounts whose folderId points at a deleted/foreign folder fall back to root.
        const resolved = fid !== null && this.getFolder(fid)?.environmentId === environmentId ? fid : null;
        return resolved === folderId;
      })
      .map(a => this.withNetwork(a));
  }

  private getFolderOrThrow(id: string): Folder {
    const folder = this.getFolder(id);
    if (!folder) throw new Error(`Folder "${id}" not found`);
    return folder;
  }

  /** True when `id` is `ancestorId` itself or sits somewhere below it. */
  private isDescendant(id: string, ancestorId: string): boolean {
    let current: string | null = id;
    const seen = new Set<string>();
    while (current !== null) {
      if (current === ancestorId) return true;
      if (seen.has(current)) break;       // guards against pre-existing cycles
      seen.add(current);
      current = this.getFolder(current)?.parentId ?? null;
    }
    return false;
  }
}
