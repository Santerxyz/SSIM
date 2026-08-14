import path from 'path';
import fs from 'fs';
import fsExtra from 'fs-extra';

// Monotonic per-process counter so two writes to the same target (even from the same
// PID, e.g. a debounced store flush racing a force-flush) never share a temp filename
// and clobber each other's half-written temp (#18). Combined with a random suffix.
let tmpSeq = 0;
function uniqueTmpSuffix(): string {
  tmpSeq = (tmpSeq + 1) >>> 0;
  return `${process.pid}.${tmpSeq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Windows returns these when the target is transiently held open by another process
// (AV real-time scan, Search indexing, a backup agent). The temp is already fsync'd,
// so retrying the rename after a short window recovers instead of losing a good write.
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
const RENAME_MAX_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 8; // per-attempt synchronous back-off; ≤ ~32ms total across the retries
function renameOverLockedTarget(tmp: string, file: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      // Permanent codes (ENOSPC / ENAMETOOLONG / EROFS / …) throw at once; only a
      // transient lock is worth re-attempting, and only until the attempt cap.
      if (!TRANSIENT_RENAME_CODES.has(code) || attempt >= RENAME_MAX_ATTEMPTS) throw err;
      const wake = Date.now() + RENAME_BACKOFF_MS; // sync fn cannot await; brief busy-wait
      while (Date.now() < wake) { /* give the transient lock a real window to release */ }
    }
  }
}

/**
 * Crash-safe JSON persistence: writes to a sibling temp file first and renames
 * it over the target. A plain writeJsonSync truncates the target before writing,
 * so a crash/power loss mid-write would destroy the file – fatal for
 * accounts.json (all credentials) or refresh_tokens.json (all sessions).
 * rename() on the same volume is atomic on Windows and POSIX. On Windows the
 * rename-over-an-existing-target can transiently fail with EPERM/EACCES/EBUSY
 * when an AV/indexer/backup momentarily holds the target open; because the temp
 * is already fsync'd, that case is retried briefly rather than lost.
 */
export function writeJsonAtomic(
  file: string,
  data: unknown,
  opts?: { spaces?: number; mode?: number; backup?: boolean },
): void {
  fsExtra.ensureDirSync(path.dirname(file));

  // Optional one-generation backup of the previous good state (.bak). Written
  // through a fsync'd temp + rename so a crash mid-copy can't tear the existing
  // .bak, and copied with the same mode as the main write so a secret file's
  // backup inherits its owner-only perms rather than defaulting world-readable.
  if (opts?.backup && fs.existsSync(file)) {
    const bak = `${file}.bak`;
    const bakTmp = `${bak}.${uniqueTmpSuffix()}.tmp`;
    try {
      fs.copyFileSync(file, bakTmp);
      if (opts?.mode !== undefined) { try { fs.chmodSync(bakTmp, opts.mode); } catch { /* best-effort */ } }
      try {
        const fd = fs.openSync(bakTmp, 'r+');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      } catch { /* durability flush is best-effort */ }
      fs.renameSync(bakTmp, bak);
    } catch {
      try { if (fs.existsSync(bakTmp)) fs.unlinkSync(bakTmp); } catch { /* best-effort */ }
      /* backup stays best-effort — never abort the main write */
    }
  }

  const tmp = `${file}.${uniqueTmpSuffix()}.tmp`;
  try {
    fsExtra.writeJsonSync(tmp, data, { spaces: opts?.spaces, mode: opts?.mode });
    // Flush the temp file's data to disk before the rename, so a hard power loss
    // can't leave the renamed target pointing at a zero-length / partial file
    // (a torn inode on POSIX; a partially-written entry on NTFS).
    // Best-effort: a fsync failure must never abort an otherwise-good write.
    try {
      const fd = fs.openSync(tmp, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch { /* durability flush is best-effort */ }
    renameOverLockedTarget(tmp, file);
  } catch (err) {
    // Never leave a partial temp behind (disk-full / EACCES / AV lock on rename).
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best-effort */ }
    throw err; // preserve the throw contract callers rely on
  }
}
