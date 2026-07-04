import path from 'path';
import fsExtra from 'fs-extra';
import { logger } from '../utils/logger';
import { writeJsonAtomic } from '../utils/atomicJson';
import { dataDir } from '../utils/paths';
import { AccountVault } from './AccountVault';

const TOKENS_PATH = dataDir('refresh_tokens.json');

interface TokenFile {
  version: number;
  /** username (lowercase) → Auth-v2 refresh token */
  tokens:  Record<string, string>;
}

const EMPTY: TokenFile = { version: 1, tokens: {} };

// ════════════════════════════════════════════════════════════════════════════
//  TokenStore – persists Steam Auth-v2 refresh tokens to disk per account
//
//  A refresh token lets us log in WITHOUT the password + maFile 2FA, and it
//  survives PC/server restarts and IP changes – exactly like a browser session.
//  These tokens are sensitive (full account access) → file is gitignored.
// ════════════════════════════════════════════════════════════════════════════

export class TokenStore {
  private file: TokenFile;
  /**
   * True when the file EXISTS but could NOT be read/parsed → the on-disk token memory is untrustworthy.
   * In this state we (a) surface it, and (b) REFUSE to write, so a present-but-corrupt file (and its
   * .bak) is never clobbered — recover it, then restart. A MISSING file (fresh install) is NOT degraded.
   * This mirrors the CsFloatDeliveredStore DEGRADED pattern (commit 3aad540): the old behaviour silently
   * reset to empty, which — on the shared refresh-token file — would have dropped every stored token and
   * mass-re-authed the fleet on the next refresh (BACKEND_RELIABILITY.md F8). (B2.)
   */
  private degraded = false;

  // Path is injectable so the degraded/missing/valid cases are unit-testable (the module TOKENS_PATH is
  // the production default). Two live instances exist (SessionManager, BanService); each loads independently.
  constructor(private readonly filePath: string = TOKENS_PATH) {
    this.file = this.load();
  }

  /** True when the file is present-but-unreadable → callers must treat persistence as unavailable. */
  isDegraded(): boolean { return this.degraded; }

  private load(): TokenFile {
    if (!fsExtra.existsSync(this.filePath)) {
      fsExtra.ensureDirSync(path.dirname(this.filePath));
      return { ...EMPTY }; // fresh install → empty is correct, NOT degraded
    }
    try {
      const parsed = fsExtra.readJsonSync(this.filePath) as Partial<TokenFile> | null;
      if (!parsed || typeof parsed.tokens !== 'object' || parsed.tokens === null) {
        // Present but wrong SHAPE → the whole-file token memory is untrustworthy. DEGRADE (don't silently
        // reset to empty, which would drop every token) and keep the file untouched for recovery.
        this.degraded = true;
        logger.error(`${this.filePath} is present but malformed – refusing to overwrite it. Refresh tokens will NOT persist; restore it from ${path.basename(this.filePath)}.bak (or delete it) and restart.`);
        return { ...EMPTY };
      }
      // #37: keep only string→non-empty-string entries; a per-entry glitch is not whole-file corruption.
      const tokens: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.tokens)) {
        if (typeof v === 'string' && v) tokens[k] = v;
      }
      return { version: 1, tokens };
    } catch (err) {
      // Present but unreadable/corrupt → we lost the token memory. DEGRADE, never silently reset.
      this.degraded = true;
      logger.error(`${this.filePath} unreadable – refusing to overwrite it (${(err as Error).message}). Refresh tokens will NOT persist; restore it from ${path.basename(this.filePath)}.bak (or delete it) and restart.`);
      return { ...EMPTY };
    }
  }

  private save(): void {
    if (this.degraded) {
      // Writing now would copy the corrupt file to .bak (clobbering the last-good backup) and overwrite
      // it — destroying the very data an operator needs to recover. Skip it. (B2.)
      logger.warn(`refresh token store is DEGRADED – NOT persisting (would clobber the corrupt ${path.basename(this.filePath)} + its .bak). Fix the file and restart.`);
      return;
    }
    try {
      writeJsonAtomic(this.filePath, this.file, { spaces: 2, mode: 0o600, backup: true });
    } catch (err) {
      logger.warn(`Could not persist refresh tokens: ${(err as Error).message}`);
    }
  }

  private key(username: string): string {
    return username.toLowerCase();
  }

  get(username: string): string | undefined {
    // VAULT MODE: tokens live in the portable vault. Plaintext mode: the json file.
    if (AccountVault.isEnabled()) return AccountVault.getToken(username);
    return this.file.tokens[this.key(username)];
  }

  has(username: string): boolean {
    return this.get(username) !== undefined;
  }

  set(username: string, token: string): void {
    if (AccountVault.isEnabled()) {
      AccountVault.setToken(username, token);
    } else {
      this.file.tokens[this.key(username)] = token; // in-memory for THIS run
      this.save();                                  // no-op while degraded (see save())
    }
    logger.info(`[${username}] refresh token persisted${this.degraded && !AccountVault.isEnabled() ? ' (in-memory only – store degraded)' : ''}`);
  }

  delete(username: string): void {
    if (AccountVault.isEnabled()) {
      AccountVault.deleteToken(username);
      logger.info(`[${username}] stored refresh token cleared`);
      return;
    }
    if (this.file.tokens[this.key(username)]) {
      delete this.file.tokens[this.key(username)];
      this.save();
      logger.info(`[${username}] stored refresh token cleared`);
    }
  }
}
