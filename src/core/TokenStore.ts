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

// S36: a FACTORY, not a shared singleton. `{ ...EMPTY }` was a SHALLOW copy — every fresh/degraded load
// aliased the SAME `EMPTY.tokens` object, so the first `set()` mutated the module singleton and leaked
// that token into every later TokenStore (two live instances: SessionManager + BanService). Return a
// brand-new object with its own empty map each time.
const emptyFile = (): TokenFile => ({ version: 1, tokens: {} });

// H-ACC-055: a millisecond-scale AV/handle lock at boot (EBUSY/EPERM/EACCES/EMFILE/ENFILE) is a TRANSIENT
// fault, NOT corruption — routing it to the degraded latch makes the whole intact fleet-token file invisible
// for the entire run (F8 mass re-auth). Retry the synchronous read a few times with a real window (S59
// precedent) before classifying the file as unreadable. A genuine parse error / any other code still falls
// straight through to the .bak-or-degrade path.
const TRANSIENT_FS_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE']);
const TRANSIENT_READ_RETRIES = 3;
const TRANSIENT_RETRY_SLEEP_MS = 150;

/** Synchronous sleep for boot-time read retries (the event loop isn't serving yet; mirrors singleInstance.ts). */
function sleepSync(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* SAB blocked → skip the wait */ }
}

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
  // the production default). SessionManager owns the single production instance; the path stays injectable for tests.
  constructor(private readonly filePath: string = TOKENS_PATH) {
    this.file = this.load();
  }

  /** True when the file is present-but-unreadable AND we are in plaintext mode → persistence is
   *  unavailable. In VAULT MODE tokens live in the vault, so a corrupt leftover plaintext file is
   *  irrelevant and must NOT raise a false DEGRADED alarm (S35b, also silences BanService's 2nd instance). */
  isDegraded(): boolean { return this.degraded && !AccountVault.isEnabled(); }

  /** H-ACC-055: readJsonSync with a bounded retry on TRANSIENT fs codes only (AV/handle lock at boot). A
   *  parse error or any non-transient code throws on the first attempt exactly as a raw readJsonSync would,
   *  so corruption is still classified as corruption. */
  private static readJsonWithRetry(p: string): unknown {
    for (let attempt = 0; ; attempt++) {
      try {
        return fsExtra.readJsonSync(p);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt < TRANSIENT_READ_RETRIES && code && TRANSIENT_FS_CODES.has(code)) {
          sleepSync(TRANSIENT_RETRY_SLEEP_MS);
          continue;
        }
        throw err;
      }
    }
  }

  /** H-ACC-059: a missing main is a fresh install ONLY when there is no sibling .bak. If a .bak survives
   *  (main deleted by the operator/AV per the degraded-store message, or lost between save generations), it
   *  still holds the last-good fleet tokens — recover from it rather than booting silently empty and then
   *  clobbering the .bak two saves later (the S5 clobber). No .bak → genuine fresh install. */
  private missingMain(): TokenFile {
    if (fsExtra.existsSync(`${this.filePath}.bak`)) return this.recoverFromBakOrDegrade('is missing');
    fsExtra.ensureDirSync(path.dirname(this.filePath));
    return emptyFile(); // fresh install → empty is correct, NOT degraded
  }

  private load(): TokenFile {
    if (!fsExtra.existsSync(this.filePath)) {
      return this.missingMain();
    }
    try {
      const tokens = TokenStore.readTokens(TokenStore.readJsonWithRetry(this.filePath) as Partial<TokenFile> | null);
      if (tokens) return { version: 1, tokens };
      // Present but wrong SHAPE → try the .bak before degrading (S35a).
      return this.recoverFromBakOrDegrade('is present but malformed');
    } catch (err) {
      // H-ACC-055: the existsSync→read TOCTOU window can vanish the file (ENOENT). A missing file is a fresh
      // install, NOT corruption (the file's own contract) — load fresh without degrading, exactly like the
      // missing-at-boot branch above. Every other throw (incl. transient codes that survived the retry above)
      // is unreadable → try the .bak before degrading (S35a).
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.missingMain(); // H-ACC-059: same .bak check as the missing-at-boot branch
      }
      return this.recoverFromBakOrDegrade(`unreadable (${(err as Error).message})`);
    }
  }

  /** Parse the tokens map out of a loaded file object, or null when the shape is untrustworthy.
   *  #37: keep only string→non-empty-string entries; a per-entry glitch is not whole-file corruption. */
  private static readTokens(parsed: Partial<TokenFile> | null): Record<string, string> | null {
    if (!parsed || typeof parsed.tokens !== 'object' || parsed.tokens === null) return null;
    // H-ACC-056: refuse a FORWARD-format file (version > 1) rather than consume its entries as raw v1
    // tokens and rewrite it as v1 (B30 vault parity — AccountVault.parseAndVersionCheck does the same).
    // Returning null routes it to the .bak-or-degrade path → write-refusal protects the newer store.
    if (parsed.version !== undefined && Number(parsed.version) > 1) return null;
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
        // H-ACC-055: same transient-lock retry — an AV sweep that holds the main typically holds the .bak too.
        const tokens = TokenStore.readTokens(TokenStore.readJsonWithRetry(bakPath) as Partial<TokenFile> | null);
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
    return emptyFile();
  }

  private save(): boolean {
    if (this.degraded) {
      // Writing now would copy the corrupt file to .bak (clobbering the last-good backup) and overwrite
      // it — destroying the very data an operator needs to recover. Skip it. (B2.)
      logger.warn(`refresh token store is DEGRADED – NOT persisting (would clobber the corrupt ${path.basename(this.filePath)} + its .bak). Fix the file and restart.`);
      return false;
    }
    try {
      writeJsonAtomic(this.filePath, this.file, { spaces: 2, mode: 0o600, backup: true });
      return true;
    } catch (err) {
      logger.warn(`Could not persist refresh tokens: ${(err as Error).message}`);
      return false;
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

  set(username: string, token: string): boolean {
    let persisted: boolean;
    if (AccountVault.isEnabled()) {
      // S24: the vault's setToken → synchronous save() → writeJsonAtomic can THROW (disk full / EACCES /
      // AV lock). This runs INSIDE steam-user's `refreshToken` emit, so an escaping throw becomes a global
      // uncaughtException → ProcessHealth.recordUncaught; during a mass first-login (fresh vault) with a
      // disk problem, ≥3 in 60s LATCH the money breaker until restart. Degrade to the plaintext path's
      // warn-and-continue contract: the token is live for THIS session, just not persisted this attempt.
      try {
        AccountVault.setToken(username, token);
        persisted = true;
      } catch (err) {
        logger.warn(`[${username}] could not persist refresh token to the vault (token live this session only): ${(err as Error).message}`);
        persisted = false;
      }
    } else {
      this.file.tokens[this.key(username)] = token; // in-memory for THIS run
      persisted = this.save();                      // false while degraded / on write failure (see save())
    }
    // H-ACC-057: log the ACTUAL outcome — the old line logged "persisted" unconditionally, so a vault
    // setToken throw or a plaintext save() failure both printed success right after their own warn.
    if (persisted) logger.info(`[${username}] refresh token persisted`);
    else logger.info(`[${username}] refresh token held in memory only (NOT persisted this attempt)`);
    return persisted;
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
