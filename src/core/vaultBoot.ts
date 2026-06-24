import fsExtra from 'fs-extra';
import path from 'path';
import type { AccountManager } from './AccountManager';
import type { MaFile } from '../types/account';
import { AccountVault } from './AccountVault';
import { loadMaFileFromDisk, readCredentialsFile, listDropZoneMaFiles, parseAccountsCsv } from './maFiles';
import { logger } from '../utils/logger';
import { dataDir } from '../utils/paths';

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

/**
 * Boot-time unlock. Encryption is MANDATORY: prompts for the Master Password (masked) —
 * first run SETS a new one (confirmed twice), later runs UNLOCK the existing vault. Any
 * non-empty password (even a short PIN) is accepted; there is NO plaintext mode. Headless
 * runs (no TTY) require the SSIM_VAULT_PASSWORD env var. Exits the process on repeated failure.
 */
export async function unlockVault(): Promise<void> {
  const existing = AccountVault.exists();

  // Headless (detached background child / systemd / no TTY): the vault is MANDATORY, so the
  // Master Password comes from SSIM_VAULT_PASSWORD (or the in-process cache on a re-gate).
  if (!process.stdin.isTTY) {
    const envPw = process.env.SSIM_VAULT_PASSWORD?.trim() || headlessPwCache;
    if (!envPw) {
      logger.error('[vault] no interactive terminal and no SSIM_VAULT_PASSWORD set – a Master Password is required');
      process.exit(1);
    }
    try {
      AccountVault.unlockOrCreate(envPw);
      headlessPwCache = envPw;                       // remember for runtime re-gates
      const viaDetached = process.env.SSIM_DETACHED === '1';
      delete process.env.SSIM_VAULT_PASSWORD;        // drop it from the readable env block
      logger.info(`[vault] ${existing ? 'unlocked' : 'created'} via ${viaDetached ? 'detached handoff' : 'SSIM_VAULT_PASSWORD'}`);
      return;
    }
    catch { logger.error('[vault] SSIM_VAULT_PASSWORD did not unlock the existing vault – aborting'); process.exit(1); }
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
    // First run: SET a new Master Password, confirmed twice to avoid a typo lockout.
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const pw = (await maskedQuestion('Set a NEW Master Password (any length): ')).trim();
      // eslint-disable-next-line no-console
      if (!pw) { console.error('  A Master Password is required.\n'); continue; }
      const confirm = (await maskedQuestion('Confirm the Master Password: ')).trim();
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
    const pw = (await maskedQuestion('Enter your Master Password to unlock the vault: ')).trim();
    // eslint-disable-next-line no-console
    if (!pw) { console.error('  A Master Password is required.\n'); continue; }
    try {
      AccountVault.unlockOrCreate(pw);
      return;
    } catch (e) {
      // eslint-disable-next-line no-console
      if ((e as Error).message === 'WRONG_PASSWORD') console.error('  Incorrect Master Password. Try again.\n');
      else { console.error(`  ${(e as Error).message}`); process.exit(1); }
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
  accounts.enterVaultMode(); // blank the now-vaulted secrets out of accounts.json

  if (migrated > 0) {
    logger.warn(`[vault] migrated ${migrated} pre-existing account(s) into the encrypted vault`);
  }
  return { migrated };
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
): { imported: number; skipped: number } {
  if (!AccountVault.isEnabled() || !targetEnvId) return { imported: 0, skipped: 0 };
  const allow = new Set(selectedFiles.map((f) => path.basename(String(f)))); // basename: no path traversal
  if (allow.size === 0) return { imported: 0, skipped: 0 };

  const creds = readCredentialsFile();
  const targetFolder = resolveTargetFolder(accounts, targetEnvId, targetFolderId);
  let imported = 0;
  let skipped = 0;
  for (const entry of listDropZoneMaFiles()) {
    if (!allow.has(entry.file)) continue; // not ticked by the operator → NEVER import
    // Skip if already vaulted OR already an accounts.json record (protects an un-vaulted orphan
    // from being overwritten by a re-dropped maFile).
    if (AccountVault.hasAccount(entry.accountName) || accounts.existsRaw(entry.accountName)) { skipped++; continue; }
    const password = creds.get(entry.accountName.toLowerCase());
    if (!password) { skipped++; continue; } // no password in accounts.txt → unusable
    if (AccountVault.importAccount({ username: entry.accountName, password, maFile: entry.maFile })) {
      imported++;
      accounts.addImportedAccount({ username: entry.accountName, maFilePath: entry.file, environmentId: targetEnvId, folderId: targetFolder });
    } else {
      skipped++;
    }
  }

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
  return { imported, skipped };
}

/**
 * Imports a CSV (`username,password,shared_secret,identity_secret`) into the unlocked vault.
 * Merges ONLY usernames not already in the vault (idempotent), creates an org entry for each
 * new bot, and blanks accounts.json secrets — same non-destructive contract as the drop zone.
 * No maFile on disk is needed; the secret is built straight from the CSV row.
 */
export function importCsvIntoVault(accounts: AccountManager, csvText: string, targetEnvId: string, targetFolderId: string | null = null): { imported: number; skipped: number } {
  if (!AccountVault.isEnabled() || !targetEnvId) return { imported: 0, skipped: 0 };
  const rows = parseAccountsCsv(csvText);
  const env = targetEnvId; // STRICT: the explicitly-chosen target env — never a guessed default
  const folderId = resolveTargetFolder(accounts, env, targetFolderId);
  let imported = 0;
  let skipped = 0;
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
  return { imported, skipped };
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
    const username = acc?.username || k;
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
  if (imported) {
    AccountVault.save();
    accounts.enterVaultMode();
    logger.info(`[vault] external-vault import: ${imported} new account(s) added, ${skipped} skipped${folderPaths ? ' (folder structure recreated)' : ''}`);
  }
  return { imported, skipped };
}
