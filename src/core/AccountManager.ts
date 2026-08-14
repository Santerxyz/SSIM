import path from 'path';
import fsExtra from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';
import type {
  AccountConfig, AccountTier, AccountsDatabase, NetworkConfig,
  Environment, Folder, ProxyRule, ProxyScope, ProxyRuleKind, TreeNode, AccountTree,
} from '../types/account';
import { logger } from '../utils/logger';
import { writeJsonAtomic } from '../utils/atomicJson';
import { vaultDir } from '../utils/paths';
import { AccountVault } from './AccountVault';
import { resolveViaRules, validPool, resolveExplain, type ResolveCtx, type ResolveOutcome } from './ProxyRuleEngine';
import { normalizeProxy } from '../network/AgentFactory';
import { loadMaFileFromDisk, resolveMaFilePath } from './maFiles';

const DB_PATH    = vaultDir('accounts.json');
const DB_VERSION = 5; // v2 folders[]; v3 environments[]; v4 portable maFilePath; v5 proxyRules[] + proxyRulesAuthoritative

/**
 * Directory names that historically held maFiles. Absolute paths into any of
 * these are rewritten to the bare filename during the v4 migration – loadMaFile
 * resolves bare names against the consolidated ./mafiles dir, which makes
 * accounts.json survive machine/folder moves. Paths pointing somewhere ELSE
 * (operator keeps maFiles on another drive) are also basenamed into ./mafiles:
 * since B23 the loader can only read from the drop zone, so an other-drive path
 * is already broken — we normalize it and log a one-time "copy into ./mafiles"
 * rescue message rather than preserve a value that resolves to a wrong/missing file.
 */
const LEGACY_MAFILE_DIRS = new Set(['mafiles', 'mafiles_unlinked']);

// ─── AccountManager ───────────────────────────────────────────────────────────

export class AccountManager {
  private db: AccountsDatabase;
  /** Per-account proxy rotation counter (usernameLower → cursor). In-memory; the engine seeds it
   *  deterministically from fnv1a(username), so a restart re-seeds without persistence. */
  private readonly proxyCursor = new Map<string, number>();

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
      writeJsonAtomic(DB_PATH, fresh, { spaces: 2 });
      return fresh;
    }
    let db: AccountsDatabase;
    try {
      db = fsExtra.readJsonSync(DB_PATH) as AccountsDatabase;
    } catch (err) {
      // accounts.json is present but unparseable (hand-edit typo, disk fault, a torn write). The
      // .bak written by save() exists for exactly this case — recover from it instead of
      // bricking boot or (worse) fabricating an empty fleet, which would hide a recoverable file
      // and trip the vault→org self-heal against real data.
      db = this.recoverFromBak(err as Error);
    }
    // The file parsed but its shape is unusable — `accounts` missing/non-array (every
    // later .some/.map throws a TypeError far from the cause) or `version` missing/non-numeric (a
    // hand-merge artifact where `undefined < 3` is false → migrate() silently skips forever). Do
    // not coerce accounts to [] (fabricated emptiness, S4 class) or default version (guessing risks
    // re-running/skipping migrations against unknown state) — route into the same H-ACC-013
    // recovery machinery (try .bak → quarantine → loud failure) as a torn write.
    if (!AccountManager.isValidDbShape(db)) {
      db = this.recoverFromBak(new Error('accounts.json is missing its `accounts` array or a numeric `version`'));
    }
    // A NEWER SSIM wrote this file (the single-file auto-updater rolled us back, or two builds share
    // a data dir). An older build cannot understand v5 proxy rules — if it migrated/blanked against
    // them it could silently resolve the whole fleet to the operator's host IP. REFUSE loudly rather
    // than mis-resolve (mirrors the vault's newer-version gate, B30). The operator updates to continue.
    if (db.version > DB_VERSION) {
      throw new Error(
        `accounts.json is version ${db.version} but this SSIM build supports up to v${DB_VERSION}. ` +
        `It was written by a NEWER SSIM — running an older build against it could silently mis-resolve ` +
        `proxies and leak the host IP. Update SSIM to continue.`,
      );
    }
    return this.migrate(db);
  }

  /**
   * Minimal load-time shape gate. A parseable file whose `accounts` is not an array,
   * or whose `version` is not a finite number, is unusable — treat it as corrupt (recover from
   * .bak or fail loud) rather than let it reach migrate()/save() and throw a bare TypeError, or
   * pass every version-gated migration on `undefined < N === false`.
   */
  private static isValidDbShape(db: unknown): db is AccountsDatabase {
    return !!db && typeof db === 'object'
      && Array.isArray((db as AccountsDatabase).accounts)
      && typeof (db as AccountsDatabase).version === 'number'
      && Number.isFinite((db as AccountsDatabase).version);
  }

  /**
   * Recover a corrupt accounts.json from its sibling .bak, or fail loud.
   *   • .bak parses → QUARANTINE the corrupt main as accounts.json.corrupt-<epochMs> (kept for
   *     forensics, never deleted) before adopting the backup, so the next save()'s backup:true
   * copies recovered-good data and never clobbers the good .bak with the corrupt main.
   *   • .bak missing/also-corrupt → throw a single named Error. NEVER fall through to the fresh-db
   *     branch: an empty fleet fabricated from a failed read is the S4/S7 failure class.
   */
  private recoverFromBak(err: Error): AccountsDatabase {
    logger.error(`accounts.json at ${DB_PATH} is unreadable (${err.message}) — attempting recovery from ${DB_PATH}.bak`);
    const bak = `${DB_PATH}.bak`;
    let recovered: AccountsDatabase;
    try {
      recovered = fsExtra.readJsonSync(bak) as AccountsDatabase;
      // The .bak must itself be a usable database — a shape-invalid backup is no better
      // than a torn one; do not swap one broken shape for another.
      if (!AccountManager.isValidDbShape(recovered)) {
        throw new Error('the backup is missing its `accounts` array or a numeric `version`');
      }
    } catch (bakErr) {
      throw new Error(
        `accounts.json is corrupt (${err.message}) and ${bak} could not recover it (${(bakErr as Error).message}). ` +
        `The corrupt file was left in place at ${DB_PATH}; restore it from a backup (or delete it to start fresh) and restart.`,
      );
    }
    // Rename the corrupt main away before any save so the next save() backs up recovered-good data.
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
   *   v4 → v5: add proxyRules[] + proxyRulesAuthoritative (STRUCTURAL only here — the synthesis +
   *            equivalence proof + cutover run later in migrateProxyRules(), once the vault is ready).
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
          // Since B23 the loader (resolveMaFilePath) basenames every path into ./mafiles — an
          // absolute maFilePath can no longer read outside the drop zone. So normalize all
          // absolute paths to the bare filename the loader actually honors, not just the legacy
          // dirs. An other-drive path that isn't in ./mafiles is broken; surface it once (rescue
          // message) instead of persisting a value that silently resolves to a wrong/missing file.
          const parent = path.basename(path.dirname(acc.maFilePath)).toLowerCase();
          const base = path.basename(acc.maFilePath);
          if (!LEGACY_MAFILE_DIRS.has(parent) && !fsExtra.existsSync(resolveMaFilePath(base))) {
            logger.warn(`maFile for ${acc.username} must live in ./mafiles — copy ${base} there and re-import.`);
          }
          acc.maFilePath = base;
          migrated++;
        }
      }
      if (migrated) logger.info(`maFilePath migration: ${migrated} account(s) → portable filename in ./mafiles`);
      changed = true;
    }

    if (db.version < 5) {
      // STRUCTURAL only. The real synthesis + equivalence proof + cutover run in migrateProxyRules()
      // (after the vault→org heal + env-proxy hydration are ready). Here we just ensure the fields
      // exist so the resolver's `proxyRulesAuthoritative` gate is well-defined.
      if (!Array.isArray(db.proxyRules)) db.proxyRules = [];
      if (typeof db.proxyRulesAuthoritative !== 'boolean') db.proxyRulesAuthoritative = false;
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
    // — BUT only blank an account that is actually in the vault. An account that could not be
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
          // Environment proxies carry credentials and must not sit plaintext in accounts.json
          // (the file the operator is told to back up / copy between machines). Blank the
          // plaintext copy ONLY when the same value is provably in the encrypted vault
          // (non-destructive: a not-yet-migrated env keeps its recoverable plaintext). B20.
          environments: this.db.environments.map(e =>
            (e.proxy && e.proxy.trim() && AccountVault.getEnvProxy(e.id) === e.proxy.trim())
              ? { ...e, proxy: '' }
              : e),
          // Proxy-rule pools carry credentials too — blank the plaintext copy ONLY when the same
          // pool is provably in the vault (non-destructive: a not-yet-vaulted pool keeps its
          // recoverable plaintext). hydrateRuleProxies refills it in memory at boot. Mirrors env. B20.
          proxyRules: (this.db.proxyRules ?? []).map(r =>
            (r.kind === 'pool' && r.proxies.length && AccountManager.sameProxyList(AccountVault.getRuleProxies(r.id), r.proxies))
              ? { ...r, proxies: [] }
              : r) }
      : this.db;
    // Backup policy: a .bak protects the whole fleet's org structure (env/folder/tier/
    // steamId/tradeUrl) from a bad write or hand-edit. In plaintext mode we always back up. In
    // vault mode we must not let the .bak retain PRE-blank plaintext — but that only happens on
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
  addImportedAccount(p: { username: string; maFilePath: string; environmentId: string; folderId?: string | null; tier?: AccountTier }): void {
    if (this.rawGet(p.username)) return;
    // Validate env/folder before the push (parity with add()): a dangling environmentId would
    // create a record invisible in every env-scoped tree yet still counted in fleet ops.
    this.getEnvironmentOrThrow(p.environmentId);
    if (p.folderId != null) {
      const folder = this.getFolder(p.folderId);
      if (!folder) throw new Error(`Folder "${p.folderId}" not found`);
      if (folder.environmentId !== p.environmentId) {
        throw new Error('Target folder belongs to a different environment');
      }
    }
    this.db.accounts.push({
      id: uuidv4(), username: p.username, password: '', maFilePath: p.maFilePath,
      environmentId: p.environmentId, folderId: p.folderId ?? null,
      ...(p.tier ? { tier: p.tier } : {}),
      enabled: true, addedAt: new Date().toISOString(),
    });
    this.save();
  }

  /** Blanks the now-vaulted secrets out of accounts.json (password + proxy overrides).
   *  Only touches accounts that actually made it into the vault — a non-vaulted account keeps
   *  its plaintext credential so it is never destroyed. Also purges the stale plaintext .bak. */
  enterVaultMode(): void {
    // Count the records this pass actually blanked (a non-empty password cleared, or a
    // proxy-type override stripped) — enterVaultMode runs on every vault-mode boot (index.ts
    // → vaultBoot.ts:228), but only the write that flips a plaintext secret to blank is a real
    // TRANSITION; a steady-state boot (everything already blank) must touch nothing.
    let blanked = 0;
    for (const acc of this.db.accounts) {
      if (!AccountVault.hasAccount(acc.username)) continue; // not vaulted → keep plaintext (recoverable)
      if (acc.password) { acc.password = ''; blanked++; }
      if (acc.networkOverride?.type === 'proxy') { acc.networkOverride = undefined; blanked++; }
    }
    // Migrate every credential-bearing ENV proxy into the vault; save() then blanks the
    // plaintext copy for envs whose proxy is now provably vaulted (non-destructive).
    let envProxiesMoved = 0;
    for (const env of this.db.environments) {
      if (env.proxy && env.proxy.trim() && AccountVault.importEnvProxy(env.id, env.proxy.trim())) envProxiesMoved++;
    }
    if (envProxiesMoved > 0) { AccountVault.save(); logger.info(`[vault] migrated ${envProxiesMoved} environment proxy/proxies into the vault`); }
    const bak = `${DB_PATH}.bak`;
    if (blanked > 0 || envProxiesMoved > 0) {
      // TRANSITION boot — H-ACC-015's sequence verbatim. Purge first, then save with backup:false
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
    // whose secrets are not provably in the vault is a recoverable rollback copy and is LEFT IN
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
    // Purge ONLY a .bak that holds plaintext and every plaintext secret is byte-equal to the vault
    // (provably stale). A secret-free .bak, or one holding any not-vaulted / mismatched secret
    // (a recoverable orphan), is a legitimate rollback copy — never destroyed.
    if (plaintextSecrets > 0 && allVaulted) {
      try { fsExtra.removeSync(bak); }
      catch (e) { logger.warn(`[vault] could not remove stale plaintext accounts.json.bak (${(e as Error).message}) — will retry next boot`); }
    }
  }

  // ── Network resolution (computed, never persisted) ───────────────────────────

  /** LEGACY pre-cutover resolver: per-account override → environment proxy → local IP (vault-aware).
   *  Used ONLY while `proxyRulesAuthoritative` is false (via resolveOutcome) and by the migration
   *  equivalence proof. The AUTHORITATIVE entry points are resolveOutcome / networkForLogin (the rule
   *  engine). Private — nothing outside AccountManager reads the legacy chain directly (T2). */
  private legacyResolveNetwork(account: AccountConfig): NetworkConfig {
    if (AccountVault.isEnabled()) {
      // A full VaultAccount's proxy, else a token-only account's per-account proxy.
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

  /** Dispatch: the rule engine when authoritative, else the legacy chain above. `atLogin=false`
   *  (peek) for reads/display; `atLogin=true` (advance the rotation cursor) only at login. */
  private resolveOutcome(account: AccountConfig, atLogin: boolean): ResolveOutcome {
    if (this.db.proxyRulesAuthoritative) return resolveViaRules(account, this.ruleCtx(atLogin));
    return { kind: 'network', network: this.legacyResolveNetwork(account) };
  }

  /** Build an engine ResolveCtx. `precompute` builds the per-rule valid-pool + target-Set maps once
   *  (T3) — pass it only for a FULL-FLEET sweep (snapshotEffective / resolutionPreview / the proof),
   *  where a single ctx is reused across every account; per-account reads pass it false so the engine
   *  falls back to the cheap single-rule path and no per-read precompute is wasted. */
  private ruleCtx(atLogin: boolean, precompute = false): ResolveCtx {
    const rules = this.db.proxyRules ?? [];
    const ctx: ResolveCtx = {
      rules,
      folders: { get: (id: string) => this.getFolder(id) },
      atLogin,
      cursor:  this.proxyCursor,
    };
    if (precompute) {
      ctx.validPools = new Map(rules.map(r => [r.id, r.kind === 'pool' ? validPool(r.proxies) : []]));
      ctx.targetSets = new Map(rules.map(r => [r.id, new Set(r.targets)]));
    }
    return ctx;
  }

  /** Login-time network resolution — ADVANCES the rotation cursor (call once per login).
   *  `undefined` ⇒ the winning pool rule hydrated EMPTY (crash between vault+disk writes, or
   *  accounts.json moved to a machine without the vault) ⇒ the caller MUST refuse the login rather
   *  than fall to the host IP. SessionManager wires this via setLoginNetworkResolver. */
  networkForLogin(account: AccountConfig): NetworkConfig | undefined {
    const out = this.resolveOutcome(account, true);
    if (out.kind === 'network') return out.network;
    logger.error(
      `[proxy-rules] ${account.username}: winning rule ${out.ruleId} has a vaulted pool but it ` +
      `hydrated EMPTY — refusing login (never fall to the host IP). Restore the vault / re-run migration.`,
    );
    return undefined;
  }

  /** The effective env proxy for the edit dialog / check-proxy: vault value in vault mode,
   * else the plaintext env proxy. Single source so no route reads the wrong copy. */
  envProxyFor(environmentId: string): string {
    if (AccountVault.isEnabled()) {
      return AccountVault.getEnvProxy(environmentId) ?? this.getEnvironment(environmentId)?.proxy?.trim() ?? '';
    }
    return this.getEnvironment(environmentId)?.proxy?.trim() ?? '';
  }

  /** Fills each in-memory environment's proxy from the vault (vault mode) so the list view,
   *  edit dialog and sanitizeEnvironment all see the effective value even after the plaintext
   * copy was blanked on disk. Called once at boot; does not persist. Idempotent. */
  hydrateEnvProxies(): void {
    if (!AccountVault.isEnabled()) return;
    for (const env of this.db.environments) {
      const v = AccountVault.getEnvProxy(env.id);
      if (v) env.proxy = v;
    }
  }

  /** Returns a copy of the account with the resolved `network` attached. A `pool-lost` outcome
   *  attaches NO network → SessionManager fail-closes any login built from this copy (defence in
   *  depth beside networkForLogin). */
  private withNetwork(account: AccountConfig): AccountConfig {
    const out = this.resolveOutcome(account, false);
    return { ...account, network: out.kind === 'network' ? out.network : undefined };
  }

  // ── Proxy-rules migration / hydration (v5) ───────────────────────────────────

  /** Fills each rule's in-memory pool from the vault (vault mode) — UNION disk ∪ vault so a stale
   *  vault subset can never drop a disk-resident member. Runs at boot before any login can occur
   *  (index.ts, right after migrateAccountsIntoVault). Idempotent. Mirrors hydrateEnvProxies. */
  hydrateRuleProxies(): void {
    if (!AccountVault.isEnabled()) return;
    let reVaulted = 0;
    for (const rule of this.db.proxyRules ?? []) {
      if (rule.kind !== 'pool') continue;
      const vaulted = AccountVault.getRuleProxies(rule.id);
      if (!vaulted || !vaulted.length) continue;
      if (!rule.proxies || rule.proxies.length === 0) {
        rule.proxies = [...vaulted];                          // disk blanked → refill from the vault
      } else {
        const seen = new Set(rule.proxies);                  // disk holds a pool → UNION (never lose a member)
        for (const p of vaulted) if (!seen.has(p)) { rule.proxies.push(p); seen.add(p); }
      }
      // F9: on external file skew (a hand-copied vault.enc/accounts.json from different points) the
      // union differs from both the vault copy and the blanked disk copy. Re-vault the union NOW so
      // save() can re-blank the disk — otherwise `sameProxyList` can never match a superset and the
      // credential union is re-written PLAINTEXT into accounts.json/.bak on every subsequent save.
      if (!AccountManager.sameProxyList(vaulted, rule.proxies)) {
        AccountVault.setRuleProxies(rule.id, rule.proxies);   // OVERWRITE (import would skip the present key)
        reVaulted++;
      }
    }
    if (reVaulted > 0) {
      // Transition write: purge the (plaintext-union) .bak first, then save(backup:false) so the
      // pre-blank plaintext disk copy is never snapshotted (verbatim the enterVaultMode sequence).
      const bak = `${DB_PATH}.bak`;
      try { if (fsExtra.existsSync(bak)) fsExtra.removeSync(bak); }
      catch (e) { logger.warn(`[proxy-rules] could not purge accounts.json.bak (${(e as Error).message}) — will retry next boot`); }
      this.save({ backup: false });
      logger.info(`[proxy-rules] re-vaulted ${reVaulted} rule pool(s) after disk∪vault skew — disk copies re-blanked.`);
    }
  }

  /**
   * Synthesize proxy rules from the legacy env/account proxy config and, IF every account's egress
   * is provably unchanged under them, make the rules AUTHORITATIVE. ADDITIVE: legacy proxy fields are
   * NEVER blanked (a rolled-back older build still resolves the old egress). Idempotent + re-runnable
   * every boot until it cuts over. MUST run after the vault→org heal + hydrateEnvProxies +
   * hydrateRuleProxies (index.ts, right after migrateAccountsIntoVault).
   */
  migrateProxyRules(): void {
    if (this.db.proxyRulesAuthoritative) return; // already cut over

    // 1) Synthesize once (re-run boots reuse the existing synthesized set + its vaulted pools).
    if (!this.db.proxyRules || this.db.proxyRules.length === 0) {
      this.db.proxyRules = this.synthesizeRules();
      if (AccountVault.isEnabled()) {
        // Vault the pools NOW so no plaintext pool ever hits disk (the env proxies they mirror are
        // already blanked+vaulted — a plaintext pool copy would re-leak them). Transition write:
        // purge the .bak first, then save({backup:false}) so a pre-blank plaintext main can't be
        // copied into accounts.json.bak (verbatim the enterVaultMode sequence).
        let moved = 0;
        for (const r of this.db.proxyRules) {
          if (r.kind === 'pool' && r.proxies.length && AccountVault.importRuleProxies(r.id, r.proxies)) moved++;
        }
        if (moved > 0) AccountVault.save();
        const bak = `${DB_PATH}.bak`;
        try { if (fsExtra.existsSync(bak)) fsExtra.removeSync(bak); }
        catch (e) { logger.warn(`[proxy-rules] could not purge accounts.json.bak (${(e as Error).message}) — will retry next boot`); }
        this.save({ backup: false });
      } else {
        this.save(); // plaintext mode: the pool sits plaintext alongside the (equally plaintext) legacy fields
      }
    }

    // 2) Prove equivalence over the UNION of org + vault + token + account-proxy usernames.
    const ctx = this.ruleCtx(false, true); // peek + precompute (full-fleet sweep) — never advance the cursor
    const mismatches: string[] = [];
    for (const username of this.migrationAccountUnion()) {
      const account = this.rawGet(username);
      if (!account) continue; // the heal ran first, so this is only a defensive skip
      const oldNet  = this.legacyResolveNetwork(account);      // legacy (authoritative still false)
      const outcome = resolveViaRules(account, ctx);
      if (outcome.kind !== 'network' || !AccountManager.sameEgress(oldNet, outcome.network)) {
        mismatches.push(username);
      }
    }

    if (mismatches.length > 0) {
      logger.warn(
        `[proxy-rules] NOT cutting over: ${mismatches.length} account(s) resolve differently under rules ` +
        `(${mismatches.slice(0, 5).join(', ')}${mismatches.length > 5 ? '…' : ''}). Legacy proxy config stays ` +
        `authoritative; will retry next boot.`,
      );
      return; // rules synthesized + vaulted, but not live — re-attempt next boot
    }

    // 3) Cut over. Legacy fields are intentionally LEFT populated (downgrade-rollback insurance).
    this.db.proxyRulesAuthoritative = true;
    this.save();
    logger.info(`[proxy-rules] cut over to ${this.db.proxyRules.length} rule(s) — every account's egress verified unchanged.`);
  }

  private synthesizeRules(): ProxyRule[] {
    const rules: ProxyRule[] = [];
    const now = new Date().toISOString();
    let priority = 0;

    // ENV rules: group environments by their EFFECTIVE proxy (vault-aware). Empty proxy = local IP =
    // no rule (the no-match default already resolves to local IP, matching today).
    const envByProxy = new Map<string, string[]>(); // normalized proxy → env ids
    for (const env of this.db.environments) {
      const eff = this.envProxyFor(env.id);
      if (!eff) continue;
      const norm = normalizeProxy(eff);
      const list = envByProxy.get(norm) ?? [];
      list.push(env.id);
      envByProxy.set(norm, list);
    }
    for (const [norm, envIds] of envByProxy) {
      rules.push({ id: uuidv4(), scope: 'environment', targets: envIds, kind: 'pool', proxies: [norm], priority: priority++, enabled: true, createdAt: now });
    }

    // ACCOUNT rules: per-account overrides. Proxy overrides (grouped by value) get LOWER priority
    // indices so they outrank a co-account forced-local, reproducing resolveNetwork's proxy-before-
    // localip order; forced-local overrides collect into one 'local' rule. Monotonic priorities → no
    // two synthesized rules ever tie on (tier, depth, priority).
    const acctByProxy = new Map<string, string[]>(); // normalized proxy → usernames(lower)
    const forcedLocal: string[] = [];
    for (const username of this.migrationAccountUnion()) {
      const acct = this.rawGet(username);
      if (!acct) continue;
      const ov = this.accountOverrideProxy(acct);
      if (ov) {
        const norm = normalizeProxy(ov);
        const list = acctByProxy.get(norm) ?? [];
        list.push(username.toLowerCase());
        acctByProxy.set(norm, list);
      } else if (acct.networkOverride?.type === 'localip') {
        forcedLocal.push(username.toLowerCase());
      }
    }
    for (const [norm, users] of acctByProxy) {
      rules.push({ id: uuidv4(), scope: 'account', targets: users, kind: 'pool', proxies: [norm], priority: priority++, enabled: true, createdAt: now });
    }
    if (forcedLocal.length) {
      rules.push({ id: uuidv4(), scope: 'account', targets: forcedLocal, kind: 'local', proxies: [], priority: priority++, enabled: true, createdAt: now });
    }
    return rules;
  }

  /** The per-account proxy override the legacy resolver would use (vault-aware), or undefined. */
  private accountOverrideProxy(account: AccountConfig): string | undefined {
    if (AccountVault.isEnabled()) {
      return AccountVault.getAccount(account.username)?.proxy?.trim() ?? AccountVault.getAccountProxy(account.username);
    }
    return account.networkOverride?.type === 'proxy' ? account.networkOverride.value.trim() : undefined;
  }

  /** Union of every username that could carry an egress: org records + vault full/token records +
   *  B42 per-account proxy keys. Prevents a token-only account's proxy being missed by synthesis. */
  private migrationAccountUnion(): string[] {
    const set = new Set<string>();
    for (const a of this.db.accounts) set.add(a.username.toLowerCase());
    if (AccountVault.isEnabled()) {
      for (const u of AccountVault.listAccountUsernames())      set.add(u);
      for (const u of AccountVault.listTokenUsernames())        set.add(u);
      for (const u of AccountVault.listAccountProxyUsernames()) set.add(u);
    }
    return [...set];
  }

  /** Read-only snapshot of the proxy rules (in-memory pools; caller MUST redact before display). */
  getProxyRules(): ProxyRule[] {
    return (this.db.proxyRules ?? []).map(r => ({ ...r, targets: [...r.targets], proxies: [...r.proxies] }));
  }

  isProxyRulesAuthoritative(): boolean { return !!this.db.proxyRulesAuthoritative; }

  /** Force the current rules live — the operator explicitly activates after reviewing the resolution
   *  preview, when the automatic equivalence proof did not cut over (or after hand-editing rules).
   *  Vaults every pool + sets the authoritative flag. Changes take effect on each account's NEXT
   *  login/refresh (lazy — no live session is disturbed). */
  activateProxyRules(): string[] {
    const before = this.snapshotEffective(); // straddle the flag flip → the legacy→rules egress delta (F5)
    if (AccountVault.isEnabled()) {
      let moved = 0; // T5: import each pool, then one vault re-encrypt (was one save PER rule)
      for (const r of this.db.proxyRules ?? []) {
        if (r.kind === 'pool' && r.proxies.length && AccountVault.importRuleProxies(r.id, r.proxies)) moved++;
      }
      if (moved > 0) AccountVault.save();
    }
    this.db.proxyRulesAuthoritative = true;
    this.save();
    return this.affectedSince(before); // F5: the route eagerly invalidates the CSFloat client for exactly these
  }

  /** F3: when rules are AUTHORITATIVE, ensure each given account is pinned by an account-scope rule to
   *  its dedicated proxy (or forced local IP) — otherwise an account imported/created after cutover has
   *  its `networkOverride`/vault proxy ignored by the engine and rides a broader rule (or the host IP).
   *  Groups by distinct proxy value (mirrors synthesizeRules): find-or-create one account-scope pool
   *  rule per proxy + one shared `kind:'local'` rule for forced-local. Legacy fields are still written
   *  by the caller (constraint 4). No-op pre-cutover (the legacy chain still resolves). */
  ensureAccountProxyRules(entries: Array<{ username: string; proxy?: string; forcedLocal?: boolean }>): void {
    if (!this.db.proxyRulesAuthoritative) return;
    if (!this.db.proxyRules) this.db.proxyRules = [];
    const byProxy = new Map<string, string[]>(); // normalized proxy → usernames(lower)
    const forcedLocal: string[] = [];
    for (const e of entries) {
      const u = e.username.toLowerCase();
      const p = (e.proxy ?? '').trim();
      if (p) {
        const norm = normalizeProxy(p);
        const list = byProxy.get(norm) ?? [];
        if (!list.includes(u)) list.push(u);
        byProxy.set(norm, list);
      } else if (e.forcedLocal) {
        if (!forcedLocal.includes(u)) forcedLocal.push(u);
      }
    }
    let changed = false;
    const addTargets = (rule: ProxyRule, users: string[]): void => { for (const u of users) if (!rule.targets.includes(u)) rule.targets.push(u); };
    for (const [norm, users] of byProxy) {
      let rule = this.db.proxyRules.find(r => r.scope === 'account' && r.kind === 'pool' && r.proxies.length === 1 && r.proxies[0] === norm);
      if (rule) { addTargets(rule, users); }
      else {
        rule = { id: uuidv4(), scope: 'account', targets: [...users], kind: 'pool', proxies: [norm], priority: this.db.proxyRules.length, enabled: true, createdAt: new Date().toISOString() };
        this.db.proxyRules.push(rule);
      }
      if (AccountVault.isEnabled()) AccountVault.importRuleProxies(rule.id, rule.proxies);
      changed = true;
    }
    if (forcedLocal.length) {
      let rule = this.db.proxyRules.find(r => r.scope === 'account' && r.kind === 'local');
      if (rule) { addTargets(rule, forcedLocal); }
      else {
        rule = { id: uuidv4(), scope: 'account', targets: [...forcedLocal], kind: 'local', proxies: [], priority: this.db.proxyRules.length, enabled: true, createdAt: new Date().toISOString() };
        this.db.proxyRules.push(rule);
      }
      changed = true;
    }
    if (changed) {
      if (AccountVault.isEnabled()) AccountVault.save(); // batch the vault imports (T5-style)
      this.reindexProxyRules();
      this.save();
    }
  }

  /** All folders (flat), for the proxy-rules target pickers / resolution preview. */
  getAllFolders(): Folder[] { return this.db.folders.map(f => ({ ...f })); }

  /** "Who gets what" — the effective resolution for every account under the CURRENT rules (evaluated
   *  regardless of the authoritative flag, so it can be reviewed before activation). The caller MUST
   *  redact each network.value before display. */
  resolutionPreview(): Array<{
    username: string; environmentId: string; folderId: string | null;
    network: NetworkConfig | null; ruleId: string | null; ruleName: string | null;
    scope: string | null; conflicts: string[]; poolLost: boolean;
  }> {
    const ruleById = new Map((this.db.proxyRules ?? []).map(r => [r.id, r]));
    const ctx = this.ruleCtx(false, true); // one precomputed ctx for the full-fleet sweep (T3)
    return this.db.accounts.map(a => {
      const ex = resolveExplain(a, ctx);
      const rule = ex.ruleId ? ruleById.get(ex.ruleId) : undefined;
      return {
        username: a.username, environmentId: a.environmentId, folderId: a.folderId ?? null,
        network: ex.network, ruleId: ex.ruleId, ruleName: rule?.name ?? null,
        scope: ex.scope, conflicts: ex.overlaps, poolLost: ex.poolLost,
      };
    });
  }

  /** Distinct proxy egress values across the fleet's EFFECTIVE resolution (rules when
   *  authoritative, else the legacy chain). Peek only — never advances a rotation cursor.
   *  For read-only, session-less fan-out work (the pricing fill) that should ride the fleet's
   *  proxies instead of hammering Steam from the host IP. Local-IP/pool-lost outcomes are
   *  excluded; order is stable (first-seen). */
  distinctEgressProxies(): string[] {
    const out = new Set<string>();
    const ctx = this.db.proxyRulesAuthoritative ? this.ruleCtx(false, true) : null;
    for (const a of this.db.accounts) {
      const o = ctx ? resolveViaRules(a, ctx) : { kind: 'network' as const, network: this.legacyResolveNetwork(a) };
      if (o.kind === 'network' && o.network?.type === 'proxy' && o.network.value?.trim()) out.add(o.network.value.trim());
    }
    return [...out];
  }

  // ── Proxy-rule CRUD (v5) ─────────────────────────────────────────────────────
  // Each mutation returns the usernames whose EFFECTIVE egress changed, so the route can eagerly
  // csfloat.invalidateClient them (a lazy Steam session but an eager CSFloat client — otherwise the
  // marketplace client keeps egressing over the retired IP). When rules aren't authoritative the
  // resolver still uses the legacy chain, so `affected` is naturally empty (dormant edits).

  private snapshotEffective(): Map<string, string> {
    const m = new Map<string, string>();
    // T3: build one precomputed ctx for the whole-fleet sweep (the mutation hot path resolves every
    // account twice) instead of per-account. Peek only — never advances a rotation cursor.
    const ctx = this.db.proxyRulesAuthoritative ? this.ruleCtx(false, true) : null;
    for (const a of this.db.accounts) {
      const out = ctx ? resolveViaRules(a, ctx) : { kind: 'network' as const, network: this.legacyResolveNetwork(a) };
      m.set(a.username.toLowerCase(), out.kind === 'network' ? JSON.stringify(out.network) : 'POOL_LOST');
    }
    return m;
  }

  private affectedSince(before: Map<string, string>): string[] {
    const after = this.snapshotEffective();
    const changed: string[] = [];
    for (const [u, val] of after) if (before.get(u) !== val) changed.push(u);
    return changed;
  }

  /** Priority IS the array index — reassign a dense unique rank after every mutation so two rules
   *  can never tie on (tier, depth, priority). */
  private reindexProxyRules(): void {
    (this.db.proxyRules ?? []).forEach((r, i) => { r.priority = i; });
  }

  private static readonly SCOPES: readonly ProxyScope[]    = ['global', 'environment', 'folder', 'account'];
  private static readonly KINDS:  readonly ProxyRuleKind[] = ['pool', 'local'];
  /** F10: reject an unknown scope/kind at the MANAGER (the API), not just the route — an unvalidated
   *  `scope:'Account'` skips every target check + the lowercasing, persists, and never matches. */
  private static assertScope(s: unknown): ProxyScope {
    if (typeof s === 'string' && (AccountManager.SCOPES as readonly string[]).includes(s)) return s as ProxyScope;
    throw new Error(`Invalid rule scope "${String(s)}" (expected global|environment|folder|account)`);
  }
  private static assertKind(k: unknown): ProxyRuleKind {
    if (typeof k === 'string' && (AccountManager.KINDS as readonly string[]).includes(k)) return k as ProxyRuleKind;
    throw new Error(`Invalid rule kind "${String(k)}" (expected pool|local)`);
  }

  private validateRuleTargets(scope: ProxyScope, targets: string[]): string[] {
    if (scope === 'global') return [];
    const clean = [...new Set((targets ?? []).map(t => (t ?? '').trim()).filter(Boolean))];
    for (const t of clean) {
      if (scope === 'environment' && !this.getEnvironment(t)) throw new Error(`Environment "${t}" not found`);
      if (scope === 'folder'      && !this.getFolder(t))      throw new Error(`Folder "${t}" not found`);
      if (scope === 'account'     && !this.rawGet(t))         throw new Error(`Account "${t}" not found`);
    }
    return scope === 'account' ? clean.map(t => t.toLowerCase()) : clean;
  }

  addProxyRule(input: {
    name?: string; scope: ProxyScope; targets: string[]; kind: ProxyRuleKind;
    proxies?: string[]; pinPerAccount?: boolean; enabled?: boolean;
  }): { rule: ProxyRule; affected: string[] } {
    if (!this.db.proxyRules) this.db.proxyRules = [];
    // Validate EVERYTHING before touching state (F6 no-partial-writes / F10 enums / F7 empty pool).
    const scope = AccountManager.assertScope(input.scope);
    const kind  = AccountManager.assertKind(input.kind);
    const targets = this.validateRuleTargets(scope, input.targets ?? []);
    const pool = kind === 'local' ? [] : validPool(input.proxies ?? []);
    if (kind === 'pool' && pool.length === 0) {
      throw new Error(`${(input.proxies ?? []).length ? `0 of ${(input.proxies ?? []).length} proxies are valid` : 'a proxy pool needs at least one valid proxy'} — rule not saved`);
    }
    const before = this.snapshotEffective();
    const rule: ProxyRule = {
      id: uuidv4(),
      name: input.name?.trim() || undefined,
      scope, targets, kind, proxies: pool,
      pinPerAccount: input.pinPerAccount || undefined,
      priority: this.db.proxyRules.length,
      enabled: input.enabled ?? true,
      createdAt: new Date().toISOString(),
    };
    this.db.proxyRules.push(rule);
    this.reindexProxyRules();
    if (AccountVault.isEnabled() && pool.length) AccountVault.setRuleProxies(rule.id, pool);
    this.save();
    return { rule, affected: this.affectedSince(before) };
  }

  updateProxyRule(id: string, patch: {
    name?: string | null; scope?: ProxyScope; targets?: string[]; kind?: ProxyRuleKind;
    proxies?: string[]; pinPerAccount?: boolean; enabled?: boolean;
  }): { rule: ProxyRule; affected: string[] } {
    const rule = (this.db.proxyRules ?? []).find(r => r.id === id);
    if (!rule) throw new Error(`Proxy rule "${id}" not found`);
    // F6: compute + VALIDATE everything into locals; assign onto the live rule only after every check
    // passes, so a failing PATCH never leaves memory diverged from disk.
    const nextScope = patch.scope !== undefined ? AccountManager.assertScope(patch.scope) : rule.scope; // F10
    const nextKind  = patch.kind  !== undefined ? AccountManager.assertKind(patch.kind)   : rule.kind;   // F10
    const nextTargets = (patch.targets !== undefined || patch.scope !== undefined)
      ? this.validateRuleTargets(nextScope, patch.targets ?? rule.targets)
      : rule.targets;
    let nextPool: string[] = rule.proxies;
    let vaultAction: 'set' | 'delete' | 'none' = 'none';
    if (nextKind === 'local') {
      nextPool = [];
      vaultAction = 'delete';
    } else if (patch.proxies !== undefined) {
      nextPool = validPool(patch.proxies);
      if (nextPool.length === 0) { // F2/F7: never let a pool rule transition to an empty pool via the API
        throw new Error(`0 of ${(patch.proxies ?? []).length} proxies are valid — rule not saved`);
      }
      vaultAction = 'set';
    } else if (nextKind === 'pool' && rule.kind === 'local') {
      throw new Error('switching to a proxy pool requires at least one valid proxy — rule not saved'); // F2/F7
    }
    const nextName = patch.name !== undefined
      ? ((typeof patch.name === 'string' && patch.name.trim()) ? patch.name.trim() : undefined)
      : rule.name;
    const nextPin = patch.pinPerAccount !== undefined ? (patch.pinPerAccount || undefined) : rule.pinPerAccount;
    const nextEnabled = patch.enabled !== undefined ? patch.enabled : rule.enabled;
    // All checks passed — mutate + persist.
    const before = this.snapshotEffective();
    rule.name = nextName; rule.scope = nextScope; rule.targets = nextTargets;
    rule.kind = nextKind; rule.proxies = nextPool; rule.pinPerAccount = nextPin; rule.enabled = nextEnabled;
    if (AccountVault.isEnabled()) {
      if (vaultAction === 'set') AccountVault.setRuleProxies(rule.id, nextPool);
      else if (vaultAction === 'delete') AccountVault.deleteRuleProxies(rule.id);
    }
    this.save();
    return { rule, affected: this.affectedSince(before) };
  }

  deleteProxyRule(id: string): { affected: string[] } {
    const rules = this.db.proxyRules ?? [];
    const idx = rules.findIndex(r => r.id === id);
    if (idx < 0) throw new Error(`Proxy rule "${id}" not found`);
    const before = this.snapshotEffective();
    rules.splice(idx, 1);
    this.reindexProxyRules();
    if (AccountVault.isEnabled()) AccountVault.deleteRuleProxies(id);
    this.save();
    return { affected: this.affectedSince(before) };
  }

  reorderProxyRules(orderedIds: string[]): { affected: string[] } {
    const rules = this.db.proxyRules ?? [];
    const before = this.snapshotEffective();
    const byId = new Map(rules.map(r => [r.id, r]));
    const next: ProxyRule[] = [];
    for (const id of orderedIds) { const r = byId.get(id); if (r) { next.push(r); byId.delete(id); } }
    for (const r of byId.values()) next.push(r); // append any not mentioned (safety)
    this.db.proxyRules = next;
    this.reindexProxyRules();
    this.save();
    return { affected: this.affectedSince(before) };
  }

  private static sameEgress(a: NetworkConfig, b: NetworkConfig): boolean {
    if (a.type !== b.type) return false;
    return a.type === 'proxy' ? normalizeProxy(a.value) === normalizeProxy(b.value) : a.value === b.value;
  }

  private static sameProxyList(a: string[] | undefined, b: string[] | undefined): boolean {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
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
    // the plaintext copy in accounts.json.
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
      // Write-through to the vault (empty string clears it); save() blanks the plaintext copy.
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
        // Defense-in-depth: vault the secret in vault mode so the final
        // save() blanks the plaintext password. The sole caller already gates vault mode,
        // but vaulting here makes addMany safe regardless of caller. Best-effort per item:
        // if the maFile can't be loaded the account stays plaintext (the non-destructive
        // guarantee), exactly like the single-add path.
        if (AccountVault.isEnabled()) {
          try {
            const maFile = loadMaFileFromDisk(item.maFilePath);
            AccountVault.upsertAccount({ username: item.username, password: item.password, maFile });
            // Vault now owns the secret — blank the in-memory plaintext copy so `secretFree`
            // (save(), l.216) stays true and B34 backups keep running. Identical semantics to
            // enterVaultMode (l.253) and the single-add route. ONLY after a successful upsert:
            // the catch path below keeps plaintext (non-destructive guarantee).
            account.password = '';
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

  /** Renames are not supported — every secret store keys on username. */
  update(
    username: string,
    changes:  Partial<Omit<AccountConfig, 'id' | 'addedAt' | 'network' | 'username'>>,
  ): AccountConfig {
    const account = this.rawGetOrThrow(username);
    const safe = { ...changes };
    delete (safe as { network?: unknown }).network;   // never persist the computed field
    delete (safe as { username?: unknown }).username; // renames desync the vault key from the org record
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
    // RememberSteamId is called bare inside steam-user's 'loggedOn' emit chain, so a
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

  /** Builds the nested folder/account tree for one environment (computed networks). */
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
