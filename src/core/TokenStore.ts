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

  /** True when the file is present-but-unreadable AND we are in plaintext mode → persistence is
   *  unavailable. In VAULT MODE tokens live in the vault, so a corrupt leftover plaintext file is
   *  irrelevant and must NOT raise a false DEGRADED alarm (S35b, also silences BanService's 2nd instance). */
  isDegraded(): boolean { return this.degraded && !AccountVault.isEnabled(); }

  private load(): TokenFile {
    if (!fsExtra.existsSync(this.filePath)) {
      fsExtra.ensureDirSync(path.dirname(this.filePath));
      return { ...EMPTY }; // fresh install → empty is correct, NOT degraded
    }
    try {
      const tokens = TokenStore.readTokens(fsExtra.readJsonSync(this.filePath) as Partial<TokenFile> | null);
      if (tokens) return { version: 1, tokens };
      // Present but wrong SHAPE → try the .bak before degrading (S35a).
      return this.recoverFromBakOrDegrade('is present but malformed');
    } catch (err) {
      // Present but unreadable/corrupt → try the .bak before degrading (S35a).
      return this.recoverFromBakOrDegrade(`unreadable (${(err as Error).message})`);
    }
  }

  /** Parse the tokens map out of a loaded file object, or null when the shape is untrustworthy.
   *  #37: keep only string→non-empty-string entries; a per-entry glitch is not whole-file corruption. */
  private static readTokens(parsed: Partial<TokenFile> | null): Record<string, string> | null {
    if (!parsed || typeof parsed.tokens !== 'object' || parsed.tokens === null) return null;
    const tokens: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.tokens)) if (typeof v === 'string' && v) tokens[k] = v;
    return tokens;
  }

  /**
   * S35a: before declaring the store degraded, try the sibling .bak (the vault does this in B33). If the
   * backup is a valid token file, recover its tokens AND repair the corrupt main from it — writing with
   * backup:false so the corrupt main is never copied over the good .bak (the S5 clobber). Only when the
   * .bak is missing/invalid (or the repair write itself fails) do we degrade.
   */
  private recoverFromBakOrDegrade(reason: string): TokenFile {
    const bakPath = `${this.filePath}.bak`;
    const base = path.basename(this.filePath);
    try {
      if (fsExtra.existsSync(bakPath)) {
        const tokens = TokenStore.readTokens(fsExtra.readJsonSync(bakPath) as Partial<TokenFile> | null);
        if (tokens) {
          const recovered: TokenFile = { version: 1, tokens };
          try {
            // backup:false — NEVER copy the corrupt main over the good .bak (the S5 clobber lesson).
            writeJsonAtomic(this.filePath, recovered, { spaces: 2, mode: 0o600, backup: false });
            logger.warn(`${this.filePath} ${reason} but ${base}.bak is valid – recovered ${Object.keys(tokens).length} token(s) from the backup and repaired the main file (no fleet re-auth).`);
            return recovered; // healthy again
          } catch (writeErr) {
            this.degraded = true; // couldn't repair main; use recovered tokens in-memory but never clobber
            logger.error(`${this.filePath} ${reason}; recovered tokens from ${base}.bak in-memory but could NOT repair the main file (${(writeErr as Error).message}). Persistence disabled until you restore ${base} and restart.`);
            return recovered;
          }
        }
      }
    } catch { /* .bak also unreadable → degrade below */ }
    this.degraded = true;
    logger.error(`${this.filePath} ${reason} and no valid ${base}.bak – refusing to overwrite it. Refresh tokens will NOT persist; restore it from ${base}.bak (or delete it) and restart.`);
    return { ...EMPTY };
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
