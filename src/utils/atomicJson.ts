import path from 'path';
import fs from 'fs';
import fsExtra from 'fs-extra';

// Monotonic per-process counter so two writes to the SAME target (even from the same
// PID, e.g. a debounced store flush racing a force-flush) never share a temp filename
// and clobber each other's half-written temp (#18). Combined with a random suffix.
let tmpSeq = 0;
function uniqueTmpSuffix(): string {
  tmpSeq = (tmpSeq + 1) >>> 0;
  return `${process.pid}.${tmpSeq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Crash-safe JSON persistence: writes to a sibling temp file first and renames
 * it over the target. A plain writeJsonSync truncates the target BEFORE writing,
 * so a crash/power loss mid-write would destroy the file – fatal for
 * accounts.json (all credentials) or refresh_tokens.json (all sessions).
 * rename() on the same volume is atomic on Windows and POSIX.
 */
export function writeJsonAtomic(
  file: string,
  data: unknown,
  opts?: { spaces?: number; mode?: number; backup?: boolean },
): void {
  fsExtra.ensureDirSync(path.dirname(file));

  // Optional one-generation backup of the previous good state (.bak).
  if (opts?.backup && fs.existsSync(file)) {
    try { fs.copyFileSync(file, `${file}.bak`); } catch { /* best-effort */ }
  }

  const tmp = `${file}.${uniqueTmpSuffix()}.tmp`;
  try {
    fsExtra.writeJsonSync(tmp, data, { spaces: opts?.spaces, mode: opts?.mode });
    // Flush the temp file's data to disk BEFORE the rename, so a hard power loss
    // can't leave the renamed target pointing at a zero-length / partial inode.
    // Best-effort: a fsync failure must never abort an otherwise-good write.
    try {
      const fd = fs.openSync(tmp, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch { /* durability flush is best-effort */ }
    fs.renameSync(tmp, file);
  } catch (err) {
    // Never leave a partial temp behind (disk-full / EACCES / AV lock on rename).
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best-effort */ }
    throw err; // preserve the throw contract callers rely on
  }
}
