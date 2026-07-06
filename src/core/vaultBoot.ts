import fsExtra from 'fs-extra';
import path from 'path';
import readline from 'readline';
import type { AccountManager } from './AccountManager';
import type { MaFile } from '../types/account';
import { AccountVault, VAULT_NEWER_VERSION_ERROR } from './AccountVault';
import type { VaultAccount, AccountVaultImpl } from './AccountVault';
import { loadMaFileFromDisk, readCredentialsFile, listDropZoneMaFiles, parseAccountsCsv } from './maFiles';
import type { CsvRejected } from './maFiles';
import { logger } from '../utils/logger';
import { writeJsonAtomic } from '../utils/atomicJson';
import { dataDir, vaultDir } from '../utils/paths';

/**
 * True when accounts.json holds accounts whose passwords are BLANK — the signature of a prior
 * VAULT-MODE install (enterVaultMode blanked them) — while vault.enc is ABSENT. Creating a fresh
 * empty vault in that state would leave the registered accounts with NO credentials and give the
 * operator no signal that the real vault.enc is merely missing (mis-set SSIM_HOME / partial
 * restore / unmounted drive). B36. Best-effort; any read error returns false (don't block boot).
 */
export function looksLikeOrphanedVaultInstall(): boolean {
  try {
    const dbPath = vaultDir('accounts.json');
    if (!fsExtra.existsSync(dbPath)) return false;
    const db = fsExtra.readJsonSync(dbPath) as { accounts?: Array<{ password?: string }> };
    const accts = Array.isArray(db?.accounts) ? db.accounts : [];
    if (accts.length === 0) return false;
    // A prior vault-mode install has blanked passwords; a genuine fresh/plaintext install would
    // carry real passwords (or no accounts at all).
    return accts.some(a => a && (a.password === '' || a.password == null));
  } catch { return false; }
}

/** H-ACC-026: should the INTERACTIVE first-run TTY path block a silent empty-vault create right now?
 *  True on the same orphan condition the headless (l.102) and windowed (unlockPortal.ts:29) paths already
 *  guard: accounts.json holds registered accounts but vault.enc is missing, and the operator has not set
 *  SSIM_VAULT_CREATE=1 to start anew. Only ever called from the `!existing` branch, so vault.enc is already
 *  known absent. Exported for tests. */
export function shouldBlockTtyEmptyCreate(): boolean {
  return looksLikeOrphanedVaultInstall() && process.env.SSIM_VAULT_CREATE !== '1';
}

/** H-ACC-024: THE single master-password normalization rule. Every input path (headless env, the
 *  CLI prompt, the windowed unlock portal) must key the scrypt derivation off the SAME normalized
 *  form, or a vault created with a trailing/leading space (a classic paste artifact) can never be
 *  reopened from a path that trims — a hard, "wrong password" lockout with the correct password. */
export function normalizeMasterPassword(pw: string): string { return pw.trim(); }

/** H-ACC-024: the shared UNLOCK entry every path uses. Derives the key off `normalizeMasterPassword`
 *  (matching every CREATE path), so a normalized vault opens from any input path. COMPATIBILITY BRIDGE
 *  (a one-time data-migration for divergent historical normalization, NOT a band-aid retry): a vault
 *  created by the OLD windowed portal — which keyed off the raw string — was salted with the padded
 *  password. So if the trimmed form is exactly WRONG_PASSWORD and trimming actually changed the input,
 *  retry ONCE with the verbatim string to open that legacy vault. Any other error (newer-version,
 *  transient read error, corrupt file) is rethrown unchanged; two failed forms → WRONG_PASSWORD, so a
 *  genuine bad password is unaffected apart from one extra scrypt only when the input carries whitespace.
 *  The vault instance is injectable so tests can drive an isolated AccountVaultImpl. */
export function unlockExistingVault(
  raw: string,
  opts?: { createEmptyAnyway?: boolean },
  vault: AccountVaultImpl = AccountVault,
): { created: boolean } {
  const normalized = normalizeMasterPassword(raw);
  try {
    return vault.unlockOrCreate(normalized, opts);
  } catch (e) {
    if ((e as Error).message === 'WRONG_PASSWORD' && raw !== normalized) {
      return vault.unlockOrCreate(raw, opts); // legacy portal-created vault salted with the padded password
    }
    throw e; // newer-version / transient read error / corrupt-both → unchanged
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Vault boot: the CLI master-password prompt + the non-destructive import/merge.
//  Runs once on boot (after the license gate, before the dashboard server starts),
//  so the dashboard never needs its own unlock screen.
// ════════════════════════════════════════════════════════════════════════════

const MAX_ATTEMPTS = 5;

// Set once a headless unlock succeeds via SSIM_VAULT_PASSWORD. We cache the password
// in-process so a runtime license re-gate (which calls unlockVault again) still works
// AFTER we have deleted the env var — the deletion removes it from the externally
// readable environment block, shrinking its exposure to the few seconds before unlock.
let headlessPwCache: string | undefined;

/** Reads a line from stdin, echoing '*' per typed character (so the operator can SEE that
 *  input is registering). Handles Backspace and Ctrl-C. TTY only; uses char codes so no
 *  control characters are embedded in the source. */
function maskedQuestion(query: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const NL = String.fromCharCode(10);                                 // newline
    const ERASE = String.fromCharCode(8) + ' ' + String.fromCharCode(8); // backspace, space, backspace
    stdout.write(query);
    let input = '';
    const wasRaw = !!stdin.isRaw;
    try { stdin.setRawMode?.(true); } catch { /* not a raw-capable TTY */ }
    stdin.resume();
    stdin.setEncoding('utf8');
    const cleanup = (): void => {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode?.(wasRaw); } catch { /* noop */ }
      stdin.pause();
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (code === 13 || code === 10) { cleanup(); stdout.write(NL); resolve(input); return; } // Enter
        else if (code === 3) { cleanup(); stdout.write(NL); process.exit(1); }                    // Ctrl-C
        else if (code === 127 || code === 8) { if (input.length) { input = input.slice(0, -1); stdout.write(ERASE); } } // Backspace
        else if (code >= 32) { input += ch; stdout.write('*'); }                                  // printable
      }
    };
    stdin.on('data', onData);
  });
}

/** Reads a single line from stdin with normal echo (NOT masked) — used for typed confirmations
 *  the operator SHOULD see, e.g. the H-ACC-026 orphan-vault "CREATE NEW VAULT" acknowledgement. */
function plainQuestion(query: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(query, (answer) => { rl.close(); resolve(answer); });
  });
}

/**
 * Boot-time unlock. Encryption is MANDATORY: prompts for the Master Password (masked) —
 * first run SETS a new one (confirmed twice), later runs UNLOCK the existing vault. Any
 * non-empty password (even a short PIN) is accepted; there is NO plaintext mode. Headless
 * runs (no TTY) require the SSIM_VAULT_PASSWORD env var. Exits the process on repeated failure.
 */
export async function unlockVault(): Promise<void> {
  // A runtime license re-gate calls this again while the vault is still unlocked (teardown flushes
  // but never locks): short-circuit so we don't re-prompt for a password we already hold in memory.
  if (AccountVault.isEnabled()) { logger.info('[vault] already unlocked – re-gate skips the prompt'); return; }
  const existing = AccountVault.exists();

  // Headless (detached background child / systemd / no TTY): the vault is MANDATORY, so the
  // Master Password comes from SSIM_VAULT_PASSWORD (or the in-process cache on a re-gate).
  if (!process.stdin.isTTY) {
    // Keep the RAW env value (no pre-trim) so unlockExistingVault can key off both the normalized
    // form and, for a legacy padded-portal vault, the verbatim string (H-ACC-024). Guard on the
    // NORMALIZED form being non-empty (an all-whitespace value is still "no password").
    const envPw = process.env.SSIM_VAULT_PASSWORD || headlessPwCache;
    if (!envPw || !normalizeMasterPassword(envPw)) {
      logger.error('[vault] no interactive terminal and no SSIM_VAULT_PASSWORD set – a Master Password is required');
      process.exit(1);
    }
    // B36: refuse to CREATE a fresh empty vault over an existing farm whose vault.enc is merely
    // missing (mis-set SSIM_HOME / partial restore) — that would orphan every account. Require an
    // explicit opt-in to start anew.
    if (!existing && looksLikeOrphanedVaultInstall() && process.env.SSIM_VAULT_CREATE !== '1') {
      logger.error('[vault] accounts.json holds registered accounts but vault.enc is MISSING – refusing to create a new empty vault (their credentials would be lost). Restore vault.enc (a local vault.enc.bak with the same Master Password is auto-restored), or set SSIM_VAULT_CREATE=1 to start a NEW empty vault.');
      process.exit(1);
    }
    try {
      // createEmptyAnyway mirrors the B36 override: SSIM_VAULT_CREATE=1 skips the vault.enc.bak
      // recovery probe and starts a NEW empty vault; otherwise a missing vault.enc self-heals from
      // a matching .bak instead of orphaning the farm (H-ACC-039).
      unlockExistingVault(envPw, { createEmptyAnyway: process.env.SSIM_VAULT_CREATE === '1' });
      headlessPwCache = envPw;                       // remember for runtime re-gates
      const viaDetached = process.env.SSIM_DETACHED === '1';
      delete process.env.SSIM_VAULT_PASSWORD;        // drop it from the readable env block
      logger.info(`[vault] ${existing ? 'unlocked' : 'created'} via ${viaDetached ? 'detached handoff' : 'SSIM_VAULT_PASSWORD'}`);
      return;
    }
    catch (e) {
      // H-ACC-025: name the real cause instead of collapsing every failure into "wrong password".
      const msg = (e as Error).message;
      if (msg === VAULT_NEWER_VERSION_ERROR) logger.error('[vault] vault.enc was written by a NEWER SSIM version – update SSIM first, do not recreate the vault');
      else if (msg === 'WRONG_PASSWORD') logger.error('[vault] SSIM_VAULT_PASSWORD did not unlock the existing vault – aborting');
      else logger.error(`[vault] vault ${existing ? 'unlock' : 'creation'} failed: ${msg}`);
      process.exit(1);
    }
  }

  // Make the prompt unmissable (the launcher opens the browser only AFTER this succeeds).
  // eslint-disable-next-line no-console
  console.log(
    '\n  ════════════════════════════════════════════════════════════════\n' +
    `   SSIM VAULT — ${existing ? 'enter' : 'set'} your Master Password in THIS window, then press Enter.\n` +
    '   (encryption is required — a short PIN is fine; there is NO recovery)\n' +
    '  ════════════════════════════════════════════════════════════════',
  );

  if (!existing) {
    // H-ACC-026: same B36 orphan guard the headless (l.102) and windowed (unlockPortal.ts) paths hold —
    // if accounts.json holds registered accounts but vault.enc is missing (partial restore / AV quarantine
    // / mis-set SSIM_HOME), creating a fresh empty vault would orphan every account AND destroy the only
    // signal that vault.enc is merely missing. Refuse unless the operator TYPES an explicit acknowledgement
    // (or set SSIM_VAULT_CREATE=1 for the non-interactive bypass, parity with l.102).
    if (shouldBlockTtyEmptyCreate()) {
      // eslint-disable-next-line no-console
      console.error(
        '\n  Registered accounts exist but the vault file (vault.enc) is MISSING — likely a partial restore,\n' +
        '  an antivirus quarantine, or a mis-set SSIM_HOME. Creating a new vault now would leave every account\n' +
        '  credential-less. Restore vault.enc (a local vault.enc.bak with the same Master Password is\n' +
        '  auto-restored) or fix SSIM_HOME and relaunch — OR type exactly  CREATE NEW VAULT  to start anew.\n',
      );
      const ack = (await plainQuestion('  Type CREATE NEW VAULT to confirm, or anything else to abort: ')).trim();
      if (ack !== 'CREATE NEW VAULT') {
        // eslint-disable-next-line no-console
        console.error('  Aborting — no vault was created.');
        process.exit(1);
      }
    }
    // First run: SET a new Master Password, confirmed twice to avoid a typo lockout.
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const pw = normalizeMasterPassword(await maskedQuestion('Set a NEW Master Password (any length): '));
      // eslint-disable-next-line no-console
      if (!pw) { console.error('  A Master Password is required.\n'); continue; }
      const confirm = normalizeMasterPassword(await maskedQuestion('Confirm the Master Password: '));
      // eslint-disable-next-line no-console
      if (pw !== confirm) { console.error('  The passwords do not match — try again.\n'); continue; }
      AccountVault.unlockOrCreate(pw);
      // eslint-disable-next-line no-console
      console.log('  Vault created. KEEP THIS PASSWORD SAFE — there is no recovery.\n');
      return;
    }
    // eslint-disable-next-line no-console
    console.error('  Too many attempts — exiting.');
    process.exit(1);
  }

  // Existing vault: unlock it.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Keep the RAW typed value so the H-ACC-024 bridge can retry a legacy padded-portal vault verbatim;
    // guard on the NORMALIZED form being non-empty (a whitespace-only entry is still "no password").
    const pw = await maskedQuestion('Enter your Master Password to unlock the vault: ');
    // eslint-disable-next-line no-console
    if (!normalizeMasterPassword(pw)) { console.error('  A Master Password is required.\n'); continue; }
    try {
      unlockExistingVault(pw);
      return;
    } catch (e) {
      const msg = (e as Error).message;
      // eslint-disable-next-line no-console
      if (msg === 'WRONG_PASSWORD') console.error('  Incorrect Master Password. Try again.\n');
      // H-ACC-025: a newer-vault refusal must not print the bare VAULT_NEWER_VERSION token.
      // eslint-disable-next-line no-console
      else if (msg === VAULT_NEWER_VERSION_ERROR) { console.error('  vault.enc was written by a NEWER SSIM version — update SSIM first, do not recreate the vault.'); process.exit(1); }
      // eslint-disable-next-line no-console
      else { console.error(`  ${msg}`); process.exit(1); }
    }
  }
  // eslint-disable-next-line no-console
  console.error('  Too many failed attempts — exiting.');
  process.exit(1);
}

/** Validates that `folderId` is a real folder LIVING IN `envId`; returns it, else null
 *  (so a stale/foreign/typo folderId silently lands the bot at the env root rather than
 *  orphaning it). The single source of truth for "where does an imported bot go". */
function resolveTargetFolder(accounts: AccountManager, envId: string, folderId?: string | null): string | null {
  if (!folderId) return null;
  const folder = accounts.getFolder(folderId);
  return folder && folder.environmentId === envId ? folderId : null;
}

/**
 * BOOT-ONLY migration (the "upgrade from a no-vault version" path — scenario 1). Absorbs
 * credentials that are ALREADY registered in accounts.json plus the legacy refresh_tokens.json
 * into the freshly-unlocked vault, then blanks the now-vaulted plaintext out of accounts.json.
 *
 * It DELIBERATELY NEVER scans the mafiles/ drop zone. Dropping loose maFiles into mafiles/ and
 * starting the app must NOT move anything into the vault or accounts.json — loose maFiles are
 * imported ONLY by an explicit user action in the "Import Bots" UI (see importDropZoneIntoVault).
 *
 * Idempotent + non-destructive: only absorbs usernames not already vaulted; never deletes any
 * plaintext source file.
 */
export function migrateAccountsIntoVault(accounts: AccountManager): { migrated: number } {
  if (!AccountVault.isEnabled()) return { migrated: 0 };
  let migrated = 0;

  // 1) Migrate accounts that are ALREADY registered in accounts.json (plaintext password +
  //    on-disk maFile) into the vault. This is the legitimate upgrade path; these accounts were
  //    already chosen by the user in a previous version, so absorbing them is consented-to.
  for (const acc of accounts.getAllRaw()) {
    if (!acc.password || AccountVault.hasAccount(acc.username)) continue;
    let maFile;
    try { maFile = loadMaFileFromDisk(acc.maFilePath); }
    catch (e) { logger.warn(`[vault] migrate ${acc.username}: ${(e as Error).message} – skipped`); continue; }
    const proxy = acc.networkOverride?.type === 'proxy' ? acc.networkOverride.value : undefined;
    if (AccountVault.importAccount({ username: acc.username, password: acc.password, maFile, proxy })) migrated++;
  }

  // 2) Migrate existing Steam refresh tokens into the vault (then refresh_tokens.json is
  //    ignored in vault mode). Non-destructive: the old file is left on disk.
  try {
    const tokFile = dataDir('refresh_tokens.json');
    if (fsExtra.existsSync(tokFile)) {
      const tok = fsExtra.readJsonSync(tokFile) as { tokens?: Record<string, string> };
      let n = 0;
      for (const [u, t] of Object.entries(tok?.tokens ?? {})) {
        if (typeof t === 'string' && t && !AccountVault.getToken(u)) { AccountVault.setToken(u, t); n++; }
      }
      if (n) logger.info(`[vault] migrated ${n} refresh token(s) into the vault`);
    }
  } catch (e) { logger.warn(`[vault] refresh-token migration skipped: ${(e as Error).message}`); }

  // 2b) Migrate per-account CSFloat API keys into the vault. Without this, keys saved in
  //     plaintext mode become invisible after vault mode is enabled (the key store reads
  //     ONLY the active backend), orphaning them. Non-destructive: the file is left on disk.
  //     (F3 / INV-F3.)
  try {
    const keyFile = dataDir('csfloat_keys.json');
    if (fsExtra.existsSync(keyFile)) {
      const kf = fsExtra.readJsonSync(keyFile) as { keys?: Record<string, string> };
      let n = 0;
      for (const [u, k] of Object.entries(kf?.keys ?? {})) {
        if (typeof k === 'string' && k && !AccountVault.getCsFloatKey(u)) { AccountVault.setCsFloatKey(u, k); n++; }
      }
      if (n) logger.info(`[vault] migrated ${n} CSFloat API key(s) into the vault`);
    }
  } catch (e) { logger.warn(`[vault] CSFloat-key migration skipped: ${(e as Error).message}`); }

  AccountVault.save();

  // 3) SELF-HEAL the vault→org direction (H-ACC-011). accounts.json can be lost while vault.enc
  //    survives (partial restore, AV quarantine of the JSON, an EBUSY strand in migrateVaultDir).
  //    load() then boots a fresh empty database, and — because every import path refuses an
  //    already-vaulted username (hasAccount → skipped) — the surviving credentials are unreachable
  //    from the UI forever. Since the vault holds only ALREADY-CONSENTED accounts, re-registering
  //    an org record for any vault username with no accounts.json entry is safe (does NOT scan the
  //    drop zone). Accepted side effect: a crash in the delete route between accounts.remove() and
  //    AccountVault.removeAccount() (server.ts:1047-1048) resurrects that account here on next boot
  //    — non-destructive, visible in the warn below, the operator simply deletes it again.
  const fullNames  = AccountVault.listAccountUsernames();
  const tokenNames = AccountVault.listTokenUsernames().filter(u => !fullNames.includes(u));
  const relinked: string[] = [];
  for (const username of [...fullNames, ...tokenNames]) {
    if (accounts.existsRaw(username)) continue;
    if (accounts.defaultEnvironmentId() === '') accounts.createEnvironment('Standard');
    const maFilePath = tokenNames.includes(username) ? '' : `${username}.maFile`;
    accounts.addImportedAccount({ username, maFilePath, environmentId: accounts.defaultEnvironmentId(), folderId: null });
    relinked.push(username);
  }
  if (relinked.length > 0) {
    logger.warn(`[vault] re-linked ${relinked.length} vault account(s) that had no accounts.json record: ${relinked.join(', ')}`);
  }

  accounts.enterVaultMode(); // blank the now-vaulted secrets (incl. env proxies) out of accounts.json
  // Hydrate in-memory env proxies from the vault so every reader (list/edit/resolveNetwork)
  // sees the effective value on THIS and every SUBSEQUENT boot (when the disk copy is blank). B20.
  accounts.hydrateEnvProxies();
  // Quarantine the now-dead plaintext token/key files (B21). In vault mode TokenStore /
  // CsFloatKeyStore read ONLY the vault, so any entry provably in the vault is dead cleartext.
  quarantineMigratedPlaintext();

  if (migrated > 0) {
    logger.warn(`[vault] migrated ${migrated} pre-existing account(s) into the encrypted vault`);
  }
  return { migrated };
}

/**
 * Removes plaintext secrets from data/refresh_tokens.json + data/csfloat_keys.json (and their
 * .bak siblings) ONCE they are provably in the encrypted vault (B21 / INV-A3). In vault mode
 * those stores read only the vault, so a vaulted entry left in the plaintext file is a pure
 * at-rest leak that a backup would carry. SAFETY: gated on verifyDiskRoundTrip() (never delete
 * the last copy of a secret on an unverified vault), and an entry whose plaintext value is NOT
 * byte-equal to the vault copy is LEFT UNTOUCHED (recoverable). A file emptied of all migrated
 * entries — and its .bak — is deleted.
 */
export function quarantineMigratedPlaintext(): void {
  if (!AccountVault.isEnabled()) return;
  if (!AccountVault.flush() || !AccountVault.verifyDiskRoundTrip()) {
    logger.warn('[vault] plaintext quarantine skipped — vault.enc did not persist/verify from disk');
    return;
  }
  quarantinePlaintextFile(
    dataDir('refresh_tokens.json'), 'tokens', 'refresh token',
    (u) => AccountVault.getToken(u),
  );
  quarantinePlaintextFile(
    dataDir('csfloat_keys.json'), 'keys', 'CSFloat key',
    (u) => AccountVault.getCsFloatKey(u),
  );
}

/** Rewrites a `{ [section]: Record<user,secret> }` plaintext file, dropping every entry whose
 *  value byte-equals the vault copy; deletes the file + .bak when nothing recoverable remains.
 *  Exported for isolated testing (no vault singleton needed). */
export function quarantinePlaintextFile(
  file: string,
  section: 'tokens' | 'keys',
  label: string,
  vaultGet: (username: string) => string | undefined,
): void {
  try {
    if (!fsExtra.existsSync(file)) return;
    const parsed = fsExtra.readJsonSync(file) as Record<string, unknown>;
    const map = (parsed?.[section] && typeof parsed[section] === 'object')
      ? parsed[section] as Record<string, string> : {};
    let removed = 0;
    const kept: Record<string, string> = {};
    for (const [u, v] of Object.entries(map)) {
      if (typeof v === 'string' && v && vaultGet(u) === v) removed++;   // safely vaulted → drop plaintext
      else if (typeof v === 'string' && v) kept[u] = v;                 // differs / not vaulted → keep (recoverable)
    }
    if (removed === 0) return;
    if (Object.keys(kept).length === 0) {
      fsExtra.removeSync(file);
      try { fsExtra.removeSync(`${file}.bak`); } catch { /* best-effort */ }
      logger.warn(`[vault] quarantined ${removed} plaintext ${label}(s): deleted ${path.basename(file)} (+ .bak) — all copies are now in the encrypted vault`);
    } else {
      // S37: ATOMIC write — this module's contract is "never delete the last copy", so a power-cut
      // mid-rewrite must not tear the kept-secrets file (temp→fsync→rename).
      writeJsonAtomic(file, { ...parsed, [section]: kept }, { spaces: 2, mode: 0o600 });
      // H-ACC-035: the pre-existing .bak is a one-generation copy of the LAST full write, so it still
      // holds the just-quarantined secrets. Rewrite it to the same kept-only map (no nested backup)
      // so the delete branch's "no vaulted secret survives in plaintext at rest" contract also holds
      // here. Best-effort — the main file is already clean.
      const bak = `${file}.bak`;
      if (fsExtra.existsSync(bak)) {
        try { writeJsonAtomic(bak, { ...parsed, [section]: kept }, { spaces: 2, mode: 0o600 }); } catch { /* best-effort; main file is already clean */ }
      }
      logger.warn(`[vault] quarantined ${removed} plaintext ${label}(s) from ${path.basename(file)}; kept ${Object.keys(kept).length} not-yet-vaulted entry/entries`);
    }
  } catch (e) {
    logger.warn(`[vault] plaintext ${label} quarantine skipped: ${(e as Error).message}`);
  }
}

/**
 * EXPLICIT drop-zone import — the ONLY path that pulls loose maFiles out of mafiles/. Driven
 * solely by the "Import Bots" modal: the operator must pick the accounts, the target environment
 * and the target folder. Imports the SELECTED maFiles (matched by filename) into the vault and
 * creates one org entry per bot in the chosen env/folder. Never touches an un-selected file,
 * never falls back to a "default" environment, never deletes the plaintext sources.
 *
 *   - targetEnvId     REQUIRED; the caller (route) has already validated it is a real environment.
 *   - targetFolderId  the modal's folder choice; null == the env root (a legitimate user choice).
 *   - selectedFiles   the ticked *.maFile filenames; an entry NOT in this set is never imported.
 */
export function importDropZoneIntoVault(
  accounts: AccountManager,
  targetEnvId: string,
  targetFolderId: string | null,
  selectedFiles: string[],
): { imported: number; skipped: number; reasons: Array<{ file: string; reason: string }> } {
  if (!AccountVault.isEnabled() || !targetEnvId) return { imported: 0, skipped: 0, reasons: [] };
  const allow = new Set(selectedFiles.map((f) => path.basename(String(f)))); // basename: no path traversal
  if (allow.size === 0) return { imported: 0, skipped: 0, reasons: [] };

  const creds = readCredentialsFile();
  const targetFolder = resolveTargetFolder(accounts, targetEnvId, targetFolderId);
  const { entries, unreadable } = listDropZoneMaFiles();
  const seen = new Set<string>(); // ticked filenames the drop-zone scan actually saw (usable or not)
  let imported = 0;
  let skipped = 0;
  const reasons: Array<{ file: string; reason: string }> = [];
  for (const entry of entries) {
    if (!allow.has(entry.file)) continue; // not ticked by the operator → NEVER import
    seen.add(entry.file);
    // Skip if already vaulted OR already an accounts.json record (protects an un-vaulted orphan
    // from being overwritten by a re-dropped maFile).
    if (AccountVault.hasAccount(entry.accountName) || accounts.existsRaw(entry.accountName)) { skipped++; reasons.push({ file: entry.file, reason: 'already imported' }); continue; }
    const password = creds.get(entry.accountName.toLowerCase());
    if (!password) { skipped++; reasons.push({ file: entry.file, reason: 'no password in accounts.txt' }); continue; } // no password → unusable
    if (AccountVault.importAccount({ username: entry.accountName, password, maFile: entry.maFile })) {
      imported++;
      accounts.addImportedAccount({ username: entry.accountName, maFilePath: entry.file, environmentId: targetEnvId, folderId: targetFolder });
    } else {
      skipped++;
      reasons.push({ file: entry.file, reason: 'unusable maFile (no shared_secret)' });
    }
  }
  // Every TICKED file must be accounted for: a ticked file that the scan flagged unreadable, or one
  // no longer on disk, is skipped-with-reason — never a silent no-op (H-ACC-078's invariant:
  // imported + skipped(with reasons) === submitted).
  for (const u of unreadable) { if (allow.has(u.file)) { seen.add(u.file); skipped++; reasons.push({ file: u.file, reason: u.reason }); } }
  for (const file of allow) { if (!seen.has(file)) { skipped++; reasons.push({ file, reason: 'file not found in mafiles/' }); } }

  if (imported) {
    AccountVault.save();
    accounts.enterVaultMode(); // blank the now-vaulted secrets out of accounts.json
    logger.warn(`[vault] imported ${imported} selected maFile(s) into the encrypted vault (${skipped} skipped)`);
    const line = '─'.repeat(66);
    // eslint-disable-next-line no-console
    console.warn(
      `\n  \x1b[33m${line}\n` +
      `  NOTICE: ${imported} account(s) were imported into the secure vault.\n` +
      `  For your own security, please MANUALLY DELETE the plaintext files in the\n` +
      `  'mafiles/' folder and 'mafiles/accounts.txt'. SSIM will NOT delete them for you.\n` +
      `  ${line}\x1b[0m\n`,
    );
  }
  return { imported, skipped, reasons };
}

/**
 * Imports a CSV (`username,password,shared_secret,identity_secret`) into the unlocked vault.
 * Merges ONLY usernames not already in the vault (idempotent), creates an org entry for each
 * new bot, and blanks accounts.json secrets — same non-destructive contract as the drop zone.
 * No maFile on disk is needed; the secret is built straight from the CSV row.
 */
export function importCsvIntoVault(accounts: AccountManager, csvText: string, targetEnvId: string, targetFolderId: string | null = null): { imported: number; skipped: number; rejected: CsvRejected[] } {
  if (!AccountVault.isEnabled() || !targetEnvId) return { imported: 0, skipped: 0, rejected: [] };
  const { rows, rejected } = parseAccountsCsv(csvText);
  const env = targetEnvId; // STRICT: the explicitly-chosen target env — never a guessed default
  const folderId = resolveTargetFolder(accounts, env, targetFolderId);
  let imported = 0;
  let skipped = rejected.length; // parser-dropped rows are lost input — count them (H-ACC-078)
  for (const r of rows) {
    // Skip if already vaulted OR if the username is already an accounts.json record —
    // INCLUDING an un-vaulted "orphan" (maFile failed to load at boot) whose recoverable
    // plaintext must NOT be silently overwritten/blanked by an arbitrary CSV row. CSV only
    // ADDS brand-new bots; it never touches an existing account's credentials.
    if (AccountVault.hasAccount(r.username) || accounts.existsRaw(r.username)) { skipped++; continue; }
    const maFile: MaFile = { account_name: r.username, shared_secret: r.shared_secret, identity_secret: r.identity_secret };
    if (AccountVault.importAccount({ username: r.username, password: r.password, maFile })) {
      imported++;
      accounts.addImportedAccount({ username: r.username, maFilePath: `${r.username}.maFile`, environmentId: env, folderId });
    } else {
      skipped++; // unusable row (missing shared_secret/password)
    }
  }
  if (imported) {
    AccountVault.save();
    accounts.enterVaultMode();
    logger.info(`[vault] CSV import: ${imported} new account(s) added, ${skipped} skipped`);
  }
  return { imported, skipped, rejected };
}

/** Builds lcUsername → folder-name PATH (root→leaf) from an exported accounts.json, so the
 *  source farm's folder ORGANISATION can be recreated in the target environment. Defensive:
 *  any malformed input yields an empty map (accounts then simply land at the env root). */
function folderPathsFromAccountsJson(raw: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  try {
    const db = JSON.parse(raw) as {
      folders?:  Array<{ id: string; name: string; parentId?: string | null }>;
      accounts?: Array<{ username?: string; folderId?: string | null }>;
    };
    const byId = new Map((Array.isArray(db.folders) ? db.folders : []).map(f => [f.id, f]));
    const pathOf = (folderId: string | null | undefined): string[] => {
      const names: string[] = [];
      const seen = new Set<string>();
      let cur = folderId ?? null;
      while (cur && byId.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        const f = byId.get(cur)!;
        names.unshift(f.name);
        cur = f.parentId ?? null;
      }
      return names;
    };
    for (const a of (Array.isArray(db.accounts) ? db.accounts : [])) {
      if (a?.username) out.set(a.username.toLowerCase(), pathOf(a.folderId));
    }
  } catch { /* malformed accounts.json → no structure recreated */ }
  return out;
}

/**
 * Merges ANOTHER device's vault.enc (raw file content + its own master password) into THIS
 * vault. Only brand-new usernames are added (never overwrites an existing account), so it is
 * non-destructive. When the source's accounts.json is also supplied (rawAccountsJson), each
 * imported bot is placed into its ORIGINAL folder path (recreated by name in the target env),
 * so the folder organisation survives the split between accounts.json (org) and vault.enc
 * (secrets). Returns counts, or null if the password is wrong / the file isn't a vault.
 */
export function importExternalVault(accounts: AccountManager, rawVaultContent: string, password: string, rawAccountsJson: string | undefined, targetEnvId: string, targetFolderId: string | null = null): { imported: number; skipped: number } | null {
  if (!AccountVault.isEnabled() || !targetEnvId) return { imported: 0, skipped: 0 };
  const ext = AccountVault.decryptExternalVault(rawVaultContent, password);
  if (!ext) return null; // wrong password or not an SSIM vault
  const env = targetEnvId; // STRICT: the explicitly-chosen target env — never a guessed default
  // An explicitly-chosen target folder WINS over the source farm's recreated structure:
  // the user picked a destination in the modal, so honour it for every imported bot.
  const explicitFolder = resolveTargetFolder(accounts, env, targetFolderId);
  const folderPaths = (!explicitFolder && rawAccountsJson) ? folderPathsFromAccountsJson(rawAccountsJson) : null;
  let imported = 0;
  let skipped = 0;
  for (const [k, acc] of Object.entries(ext.accounts)) {
    // decryptExternalVault CASTS payload.accounts verbatim (AccountVault.ts:497) — an entry may be
    // null / a non-object / carry a non-string username or password (a hand-edited, corrupt or
    // crafted source vault). Guard the shape BEFORE any deref: the map KEY is the canonical username
    // and is used only when the entry omits its own; a PRESENT non-string username is a corrupt row
    // (it would otherwise win the old `acc?.username || k` fallback and TypeError at
    // hasAccount(u).toLowerCase()), so it is rejected as unusable rather than silently key-renamed.
    const rawU = (acc && typeof acc === 'object') ? (acc as VaultAccount).username : undefined;
    const u = (rawU === undefined || rawU === '') ? k : rawU;
    if (!acc || typeof acc !== 'object' || typeof (acc as VaultAccount).password !== 'string' || typeof u !== 'string') { skipped++; continue; } // unusable-row
    const username = u;
    if (!username || AccountVault.hasAccount(username) || accounts.existsRaw(username)) { skipped++; continue; }
    if (AccountVault.importAccount({ username, password: acc.password, maFile: acc.maFile, proxy: acc.proxy })) {
      imported++;
      let folderId: string | null = explicitFolder;
      if (!folderId) {
        const folderNamePath = folderPaths?.get(username.toLowerCase());
        folderId = (folderNamePath && folderNamePath.length) ? accounts.ensureFolderPath(env, folderNamePath) : null;
      }
      accounts.addImportedAccount({ username, maFilePath: `${username}.maFile`, environmentId: env, folderId });
      const tok = ext.tokens[k];
      if (typeof tok === 'string' && tok) AccountVault.setToken(username, tok); // carry over the refresh token too
    } else {
      skipped++;
    }
  }
  // Token-only (LIMITED / QR-imported) accounts exist in the source vault ONLY as a payload.tokens
  // entry with no accounts record, so the loop above never sees them and they were silently dropped
  // — the merge looked complete while a farm's QR accounts went missing (B35). Carry them over: a
  // registered org record (limited tier) + the refresh token (its sole credential).
  for (const [k, tok] of Object.entries(ext.tokens)) {
    if (typeof tok !== 'string' || !tok) continue;
    if (ext.accounts[k]) continue;                                   // already handled above
    if (AccountVault.getToken(k) || accounts.existsRaw(k)) { skipped++; continue; } // already local
    const folderNamePath = folderPaths?.get(k);
    const folderId = explicitFolder ?? ((folderNamePath && folderNamePath.length) ? accounts.ensureFolderPath(env, folderNamePath) : null);
    accounts.addImportedAccount({ username: k, maFilePath: '', environmentId: env, folderId, tier: 'limited' });
    AccountVault.setToken(k, tok);
    imported++;
  }
  if (imported) {
    AccountVault.save();
    accounts.enterVaultMode();
    logger.info(`[vault] external-vault import: ${imported} new account(s) added, ${skipped} skipped${folderPaths ? ' (folder structure recreated)' : ''}`);
  }
  return { imported, skipped };
}
