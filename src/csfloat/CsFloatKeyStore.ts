import path from 'path';
import fsExtra from 'fs-extra';
import { logger } from '../utils/logger';
import { writeJsonAtomic } from '../utils/atomicJson';
import { dataDir } from '../utils/paths';
import { AccountVault } from '../core/AccountVault';

// ════════════════════════════════════════════════════════════════════════════
//  CsFloatKeyStore — per-account CSFloat API keys (Feature 2).
//
//  Mirrors TokenStore: in VAULT MODE keys live in the portable encrypted vault;
//  in plaintext mode they live in data/csfloat_keys.json (gitignored). A key grants
//  full marketplace access on that account → it is NEVER logged or returned raw to
//  the UI (the API only ever reports a masked tail + a "configured" boolean).
// ════════════════════════════════════════════════════════════════════════════

const KEYS_PATH = dataDir('csfloat_keys.json');

interface KeyFile { version: number; keys: Record<string, string>; }

export class CsFloatKeyStore {
  private file: KeyFile;
  constructor() { this.file = this.load(); }

  private load(): KeyFile {
    if (!fsExtra.existsSync(KEYS_PATH)) { fsExtra.ensureDirSync(path.dirname(KEYS_PATH)); return { version: 1, keys: {} }; }
    try {
      const p = fsExtra.readJsonSync(KEYS_PATH) as Partial<KeyFile> | null;
      const keys: Record<string, string> = {};
      if (p?.keys && typeof p.keys === 'object') {
        for (const [k, v] of Object.entries(p.keys)) if (typeof v === 'string' && v) keys[k] = v;
      }
      return { version: 1, keys };
    } catch { logger.warn('csfloat_keys.json unreadable — starting empty'); return { version: 1, keys: {} }; }
  }

  private save(): void {
    try { writeJsonAtomic(KEYS_PATH, this.file, { spaces: 2, mode: 0o600, backup: true }); }
    catch (err) { logger.warn(`could not persist CSFloat keys: ${(err as Error).message}`); }
  }

  private key(u: string): string { return u.toLowerCase(); }

  get(username: string): string | undefined {
    if (AccountVault.isEnabled()) return AccountVault.getCsFloatKey(username);
    return this.file.keys[this.key(username)];
  }
  has(username: string): boolean { return !!this.get(username); }

  set(username: string, apiKey: string): void {
    if (AccountVault.isEnabled()) AccountVault.setCsFloatKey(username, apiKey);
    else { this.file.keys[this.key(username)] = apiKey; this.save(); }
    logger.info(`[${username}] CSFloat API key stored`);
  }

  delete(username: string): void {
    if (AccountVault.isEnabled()) { AccountVault.deleteCsFloatKey(username); logger.info(`[${username}] CSFloat API key cleared`); return; }
    if (this.file.keys[this.key(username)]) { delete this.file.keys[this.key(username)]; this.save(); logger.info(`[${username}] CSFloat API key cleared`); }
  }

  /** Lowercase usernames that currently have a key (vault or file) — for F3 "any available key". */
  usernamesWithKeys(): string[] {
    return AccountVault.isEnabled() ? AccountVault.csfloatKeyUsernames() : Object.keys(this.file.keys);
  }
}
