import path from 'path';
import fs from 'fs';

// ════════════════════════════════════════════════════════════════════════════
//  paths.ts – the single source of truth for on-disk locations.
//
//  WHY this EXISTS:
//  When SSIM ships as a packaged exe (@yao-pkg/pkg), the code and the bundled
//  frontend (public/, shipped as a pkg "assets" entry) live in a read-only
//  virtual filesystem inside the binary. Everything we READ-WRITE at runtime
//  (accounts, maFiles, tokens, inventories, logs, license files) cannot live in
//  that read-only image — it must live NEXT TO the exe on the real disk instead.
//
//  process.cwd() is not a safe anchor for a shipped exe: it is wherever the
//  process was launched from (a desktop shortcut with a different "Start in",
//  a parent script, %SystemRoot% …), not necessarily the exe's folder. The
//  stable anchor is the directory that physically contains the exe:
//      path.dirname(process.execPath)
//
//  In dev (ts-node / `node dist/index.js`) there is no exe, so we fall back to
//  process.cwd() and the existing repo layout keeps working unchanged.
// ════════════════════════════════════════════════════════════════════════════

/** True when running inside a pkg-packaged binary (pkg injects process.pkg). */
export const IS_PACKAGED: boolean = Boolean((process as unknown as { pkg?: unknown }).pkg);

/**
 * True when SSIM runs as the Node BACKEND SIDECAR spawned by the Tauri desktop shell
 * (the shell sets SSIM_SIDECAR=1). The Tauri window owns the UI + the process lifecycle.
 * In this mode SSIM serves the dashboard + unlocks the vault via the in-window WEB portal
 * (no console for the master password), SKIPS the console log transport (stdout is reserved
 * for the shell handshake), and publishes its port on stdout (`SSIM_PORT=<n>`) + data/ssim.port
 * so the shell knows where to point the WebView. The single flag the launch flow keys off.
 */
export const IS_SIDECAR_MODE: boolean = IS_PACKAGED && process.env.SSIM_SIDECAR === '1';

/**
 * The base directory for all on-disk files that travel NEXT TO the exe in the
 * shipped zip. The Tauri desktop shell sets SSIM_HOME to the folder these should live in
 * (the portable folder next to the shell exe in production; the repo root in dev), which
 * DECOUPLES the data location from wherever the sidecar binary itself sits. Without it:
 * packaged → the exe's own folder; dev → the project working dir.
 */
export const BASE_DIR: string = process.env.SSIM_HOME
  ? path.resolve(process.env.SSIM_HOME)
  : (IS_PACKAGED ? path.dirname(process.execPath) : process.cwd());

/** Join segments onto the base dir (the unzipped SSIM folder / repo root). */
export const baseDir = (...segs: string[]): string => path.join(BASE_DIR, ...segs);

/** Read-write application data (tokens cache, inventories, license, prices…). */
export const dataDir = (...segs: string[]): string => path.join(BASE_DIR, 'data', ...segs);

/**
 * The portable VAULT folder — holds the two files that ARE the bot farm and that the
 * operator backs up / moves to another machine: the encrypted `vault.enc` (all secrets)
 * and `accounts.json` (the org/structure, secrets blanked). Kept together so a backup is
 * "copy the Vault/ folder". (License files stay in data/ — they are HWID-bound, not portable.)
 */
export const vaultDir = (...segs: string[]): string => path.join(BASE_DIR, 'Vault', ...segs);

/** One-time move of vault.enc + accounts.json from the legacy data/ location into Vault/.
 *  MUST run before AccountVault/AccountManager read their files, or an existing vault would
 *  be ignored and a fresh one created. Best-effort + idempotent (skips if the target exists). */
export function migrateVaultDir(): void {
  try {
    fs.mkdirSync(vaultDir(), { recursive: true });
    for (const name of ['vault.enc', 'accounts.json', 'vault.enc.bak', 'accounts.json.bak']) {
      const from = dataDir(name);
      const to = vaultDir(name);
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
    }
    // BOTH-PRESENT guard: for the two PRIMARY files, a leftover data/<name> after the loop
    // means the rename was skipped because Vault/<name> already existed — an ambiguous
    // two-source state (operator restored a legacy backup over a migrated Vault/). We NEVER
    // auto-pick a winner (mtime is not authoritative for which vault the operator wants):
    // the app adopts the Vault/ copy, but the orphaned data/ copy must not vanish silently.
    // Signal it so it survives to the operator/dashboard; never move/delete/overwrite here.
    const conflicts: string[] = [];
    for (const name of ['vault.enc', 'accounts.json']) {
      const stray = dataDir(name);
      if (!fs.existsSync(stray)) continue;
      const adopted = vaultDir(name);
      const strayM = fs.statSync(stray).mtime.toISOString();
      const adoptedM = fs.statSync(adopted).mtime.toISOString();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      (require('./logger') as typeof import('./logger')).logger.warn(
        `VAULT LOCATION CONFLICT: ignoring stale ${stray} (mtime ${strayM}); the app is using ${adopted} (mtime ${adoptedM})`,
      );
      conflicts.push(`${name}: IGNORED ${stray} (mtime ${strayM}) | USING ${adopted} (mtime ${adoptedM})`);
    }
    if (conflicts.length) {
      fs.writeFileSync(dataDir('VAULT_LOCATION_CONFLICT.txt'), conflicts.join('\n') + '\n');
    }
  } catch { /* best-effort: the app creates fresh files in Vault/ if needed */ }
}

/** Log output directory (ssim.log, error.log). */
export const logsDir = (...segs: string[]): string => path.join(BASE_DIR, 'logs', ...segs);

/**
 * Frontend (Dashboard HTML/JS/CSS + license.html). As of v1.0.4 it is BUNDLED
 * INTO the exe (pkg "assets"), so it is read from the binary's read-only snapshot
 * — not from disk next to the exe. We anchor it to __dirname (this module's own
 * location) instead of BASE_DIR so it resolves to the payload in every mode:
 *   packaged → <snapshot>/dist/utils → ../../public = <snapshot>/public  (VFS)
 *   dev/tsc  → <repo>/{src|dist}/utils → ../../public = <repo>/public     (disk)
 * Riding inside the exe keeps front- and backend in lockstep: a self-update swaps
 * only ssim.exe and now carries the matching frontend with it (fixes the old
 * "exe updated, external public/ left stale" desync).
 */
export const publicDir = (...segs: string[]): string =>
  path.join(__dirname, '..', '..', 'public', ...segs);

/**
 * Steam maFiles directory (repo/zip root). the single home for all maFiles:
 * registered accounts reference files in here (by bare filename), and the
 * bulk-import flow scans this same folder for not-yet-registered files.
 * (Formerly split across maFiles/ and data/mafiles_unlinked/ – consolidated.)
 */
export const maFilesDir = (...segs: string[]): string => path.join(BASE_DIR, 'mafiles', ...segs);
