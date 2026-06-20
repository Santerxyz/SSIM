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

  constructor() {
    this.file = this.load();
  }

  private load(): TokenFile {
    if (!fsExtra.existsSync(TOKENS_PATH)) {
      fsExtra.ensureDirSync(path.dirname(TOKENS_PATH));
      return { ...EMPTY };
    }
    try {
      const parsed = fsExtra.readJsonSync(TOKENS_PATH) as Partial<TokenFile> | null;
      // #37: validate shape — keep only string→non-empty-string entries; a corrupt/
      // hand-edited file must not seed garbage tokens that fail login cryptically.
      const tokens: Record<string, string> = {};
      if (parsed && parsed.tokens && typeof parsed.tokens === 'object') {
        for (const [k, v] of Object.entries(parsed.tokens)) {
          if (typeof v === 'string' && v) tokens[k] = v;
        }
      }
      return { version: 1, tokens };
    } catch {
      logger.warn('refresh_tokens.json unreadable – starting empty');
      return { ...EMPTY };
    }
  }

  private save(): void {
    try {
      writeJsonAtomic(TOKENS_PATH, this.file, { spaces: 2, mode: 0o600, backup: true });
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
      this.file.tokens[this.key(username)] = token;
      this.save();
    }
    logger.info(`[${username}] refresh token persisted`);
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
