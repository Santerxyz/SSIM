import path from 'path';
import fsExtra from 'fs-extra';
import { logger } from '../utils/logger';
import { writeJsonAtomic } from '../utils/atomicJson';
import { dataDir } from '../utils/paths';

// ════════════════════════════════════════════════════════════════════════════
//  AppSettings — small NON-SECRET settings store (data/app_settings.json).
//  Holds the app-wide price source (Feature 3), the CSFloat "experimental"
//  feature flag and per-account CSFloat auto-accept toggles (Feature 2). Secrets
//  (CSFloat API keys, Steam tokens) never live here — they go in the vault.
// ════════════════════════════════════════════════════════════════════════════

export type PriceSource = 'steam' | 'csfloat';

interface SettingsFile {
  priceSource:         PriceSource;              // active app-wide price source (F3)
  csfloatExperimental: boolean;                  // reveal Buy Orders / Trades / Inventory + auto-accept (F2)
  csfloatAutoAccept:   Record<string, boolean>;  // lowercase username → auto-accept ON (F2)
}

const SETTINGS_PATH = dataDir('app_settings.json');
const DEFAULTS: SettingsFile = { priceSource: 'steam', csfloatExperimental: false, csfloatAutoAccept: {} };

class AppSettingsImpl {
  private file: SettingsFile;
  /** True when app_settings.json EXISTS but could not be read/parsed → the on-disk settings are
   *  untrustworthy. We surface it and REFUSE to write, so the present-but-corrupt file is never
   *  clobbered by a later toggle — recover it, then restart. A MISSING file (fresh install) is NOT
   *  degraded. Mirrors CsFloatKeyStore's S12 pattern; the OLD code silently reset to defaults, and
   *  the next set() then persisted that empty state over the good file → csfloatExperimental flips
   *  OFF and every account's auto-accept map is lost. (H-BOOT-012.) */
  private degraded = false;

  // Path injectable for tests; production uses the module SETTINGS_PATH default.
  constructor(private readonly filePath: string = SETTINGS_PATH) { this.file = this.load(); }

  /** True when app_settings.json is present-but-unreadable → toggles will not persist until the file
   *  is restored (or deleted) and the app restarted. Surfaces a banner rather than silently swallowing. */
  isDegraded(): boolean { return this.degraded; }

  private load(): SettingsFile {
    if (!fsExtra.existsSync(this.filePath)) { fsExtra.ensureDirSync(path.dirname(this.filePath)); return { ...DEFAULTS, csfloatAutoAccept: {} }; }
    try {
      const p = fsExtra.readJsonSync(this.filePath) as Partial<SettingsFile> | null;
      if (!p || typeof p !== 'object' || (p.csfloatAutoAccept !== undefined && (typeof p.csfloatAutoAccept !== 'object' || p.csfloatAutoAccept === null))) {
        // Present but wrong SHAPE → untrustworthy. DEGRADE instead of silently resetting to defaults
        // (which the next save() would persist, clobbering the good file). (H-BOOT-012)
        this.degraded = true;
        logger.error(`${this.filePath} is present but malformed – refusing to overwrite it. Settings will NOT persist; restore ${path.basename(this.filePath)} from a backup (or delete it) and restart.`);
        return { ...DEFAULTS, csfloatAutoAccept: {} };
      }
      return {
        priceSource:         p?.priceSource === 'csfloat' ? 'csfloat' : 'steam',
        csfloatExperimental: !!p?.csfloatExperimental,
        csfloatAutoAccept:   (p?.csfloatAutoAccept && typeof p.csfloatAutoAccept === 'object') ? p.csfloatAutoAccept as Record<string, boolean> : {},
      };
    } catch (err) {
      this.degraded = true;
      logger.error(`${this.filePath} unreadable – refusing to overwrite it (${(err as Error).message}). Settings will NOT persist; restore ${path.basename(this.filePath)} from a backup (or delete it) and restart.`);
      return { ...DEFAULTS, csfloatAutoAccept: {} };
    }
  }

  /** Persist to disk. Returns false (and logs) when the write was refused/failed — the mutation is
   *  memory-only and will NOT survive a restart; callers surface this instead of reporting success. */
  private save(): boolean {
    if (this.degraded) {
      logger.warn('app_settings.json is degraded — refusing to overwrite; per-account auto-accept toggles will not persist until the file is restored and the app restarted');
      return false;
    }
    try { writeJsonAtomic(this.filePath, this.file, { spaces: 2, backup: false }); return true; }
    catch (err) { logger.warn(`could not persist app settings: ${(err as Error).message}`); return false; }
  }

  getPriceSource(): PriceSource { return this.file.priceSource; }
  setPriceSource(s: PriceSource): boolean { this.file.priceSource = s === 'csfloat' ? 'csfloat' : 'steam'; return this.save(); }

  isCsfloatExperimental(): boolean { return this.file.csfloatExperimental; }
  setCsfloatExperimental(on: boolean): boolean { this.file.csfloatExperimental = !!on; return this.save(); }

  getAutoAccept(username: string): boolean { return !!this.file.csfloatAutoAccept[username.toLowerCase()]; }
  setAutoAccept(username: string, on: boolean): boolean {
    const k = username.toLowerCase();
    if (on) this.file.csfloatAutoAccept[k] = true; else delete this.file.csfloatAutoAccept[k];
    return this.save();
  }
  autoAcceptUsernames(): string[] { return Object.keys(this.file.csfloatAutoAccept); }
}

/** Process-wide singleton. */
export const AppSettings = new AppSettingsImpl();
