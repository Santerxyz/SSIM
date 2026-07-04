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
  /** True when csfloat_keys.json EXISTS but could not be read/parsed → the on-disk key memory is
   *  untrustworthy. We surface it and REFUSE to write, so the present-but-corrupt file (and its .bak)
   *  is never clobbered — recover it, then restart. A MISSING file (fresh install) is NOT degraded.
   *  Mirrors the TokenStore / DeliveredStore B2 pattern; the OLD code silently reset to empty, and the
   *  next set()/delete() then persisted that empty state over the good file + its .bak → all keys lost,
   *  pricing silently falls back to Steam and the auto-accept worker skips every account. (S12.) */
  private degraded = false;

  // Path injectable for tests; production uses the module KEYS_PATH default.
  constructor(private readonly filePath: string = KEYS_PATH) { this.file = this.load(); }

  /** True when the file is present-but-unreadable AND we are in plaintext mode. In vault mode keys are
   *  read from the vault, so a corrupt leftover file is irrelevant (no false alarm). */
  isDegraded(): boolean { return this.degraded && !AccountVault.isEnabled(); }

  private load(): KeyFile {
    if (!fsExtra.existsSync(this.filePath)) { fsExtra.ensureDirSync(path.dirname(this.filePath)); return { version: 1, keys: {} }; }
    try {
      const p = fsExtra.readJsonSync(this.filePath) as Partial<KeyFile> | null;
      if (!p || typeof p.keys !== 'object' || p.keys === null) {
        // Present but wrong SHAPE → untrustworthy. DEGRADE instead of silently resetting to empty (which
        // the next set()/delete() would persist, clobbering the good file + its .bak). (S12)
        this.degraded = true;
        logger.error(`${this.filePath} is present but malformed – refusing to overwrite it. CSFloat keys will NOT persist; restore it from ${path.basename(this.filePath)}.bak (or delete it) and restart.`);
        return { version: 1, keys: {} };
      }
      const keys: Record<string, string> = {};
      for (const [k, v] of Object.entries(p.keys)) if (typeof v === 'string' && v) keys[k] = v;
      return { version: 1, keys };
    } catch (err) {
      this.degraded = true;
      logger.error(`${this.filePath} unreadable – refusing to overwrite it (${(err as Error).message}). CSFloat keys will NOT persist; restore it from ${path.basename(this.filePath)}.bak (or delete it) and restart.`);
      return { version: 1, keys: {} };
    }
  }

  private save(): void {
    if (this.degraded) {
      logger.warn(`CSFloat key store is DEGRADED – NOT persisting (would clobber the corrupt ${path.basename(this.filePath)} + its .bak). Fix the file and restart.`);
      return;
    }
    try { writeJsonAtomic(this.filePath, this.file, { spaces: 2, mode: 0o600, backup: true }); }
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
