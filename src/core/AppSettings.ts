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
  version:             number;
  priceSource:         PriceSource;              // active app-wide price source (F3)
  csfloatExperimental: boolean;                  // reveal Buy Orders / Trades / Inventory + auto-accept (F2)
  csfloatAutoAccept:   Record<string, boolean>;  // lowercase username → auto-accept ON (F2)
}

const SETTINGS_PATH = dataDir('app_settings.json');
const DEFAULTS: SettingsFile = { version: 1, priceSource: 'steam', csfloatExperimental: false, csfloatAutoAccept: {} };

class AppSettingsImpl {
  private file: SettingsFile;
  constructor() { this.file = this.load(); }

  private load(): SettingsFile {
    try {
      if (!fsExtra.existsSync(SETTINGS_PATH)) { fsExtra.ensureDirSync(path.dirname(SETTINGS_PATH)); return { ...DEFAULTS, csfloatAutoAccept: {} }; }
      const p = fsExtra.readJsonSync(SETTINGS_PATH) as Partial<SettingsFile> | null;
      return {
        version:             1,
        priceSource:         p?.priceSource === 'csfloat' ? 'csfloat' : 'steam',
        csfloatExperimental: !!p?.csfloatExperimental,
        csfloatAutoAccept:   (p?.csfloatAutoAccept && typeof p.csfloatAutoAccept === 'object') ? p.csfloatAutoAccept as Record<string, boolean> : {},
      };
    } catch { logger.warn('app_settings.json unreadable — using defaults'); return { ...DEFAULTS, csfloatAutoAccept: {} }; }
  }

  private save(): void {
    try { writeJsonAtomic(SETTINGS_PATH, this.file, { spaces: 2, backup: false }); }
    catch (err) { logger.warn(`could not persist app settings: ${(err as Error).message}`); }
  }

  getPriceSource(): PriceSource { return this.file.priceSource; }
  setPriceSource(s: PriceSource): void { this.file.priceSource = s === 'csfloat' ? 'csfloat' : 'steam'; this.save(); }

  isCsfloatExperimental(): boolean { return this.file.csfloatExperimental; }
  setCsfloatExperimental(on: boolean): void { this.file.csfloatExperimental = !!on; this.save(); }

  getAutoAccept(username: string): boolean { return !!this.file.csfloatAutoAccept[username.toLowerCase()]; }
  setAutoAccept(username: string, on: boolean): void {
    const k = username.toLowerCase();
    if (on) this.file.csfloatAutoAccept[k] = true; else delete this.file.csfloatAutoAccept[k];
    this.save();
  }
  autoAcceptUsernames(): string[] { return Object.keys(this.file.csfloatAutoAccept); }
}

/** Process-wide singleton. */
export const AppSettings = new AppSettingsImpl();
