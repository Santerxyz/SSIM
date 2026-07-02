import fs from 'fs';
import { execFileSync } from 'child_process';
import { dataDir } from '../utils/paths';
import { logger } from '../utils/logger';

// ════════════════════════════════════════════════════════════════════════════
//  Single-instance guard (INV-G5 / P4). Two SSIM instances running at once have NO
//  cross-process lock on vault.enc / accounts.json / the token store, so a double-run
//  races those debounced writers → last-write-wins DATA LOSS. This guard makes a
//  double-run structurally impossible with an ATOMIC, FAIL-SAFE lock.
// ════════════════════════════════════════════════════════════════════════════

const LOCK_FILE = dataDir('ssim.lock');

/** Held open for the process lifetime so the lock file is genuinely owned (Windows keeps a
 *  default-share handle, which also resists casual deletion). Closed on release. */
let lockFd: number | undefined;

/** True if a process with this PID is currently running. */
export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } // exists, no perm
}

/**
 * The image/command name (lower-cased, e.g. "ssim-backend.exe") of a live PID, or '' if it
 * can't be determined. Used ONLY to disambiguate a RECYCLED PID: a hard-killed SSIM (an
 * uncatchable TerminateProcess/SIGKILL leaves no lock release) can have its PID reused by an
 * unrelated program, which a PID-liveness-only guard would mistake for "SSIM already running".
 * Cross-platform (POSIX via `ps`). Cheap; runs only on the rare lock-conflict path.
 */
export function processImageName(pid: number): string {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { encoding: 'utf8', windowsHide: true, timeout: 4000 });
      return (out.match(/^"([^"]+)"/)?.[1] ?? '').toLowerCase(); // first CSV column = image name
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 4000 });
    return (out.trim().split(/[\\/]/).pop() ?? '').toLowerCase();
  } catch { return ''; }
}

/**
 * PURE decision for a CONTESTED lock: given the current holder PID's liveness + image name,
 * do we RECLAIM the lock (holder gone/recycled) or REFUSE to start (a genuine second SSIM, or
 * we can't tell → fail SAFE)? Never steals the lock from a live SSIM.
 */
export function lockHolderDisposition(alive: boolean, holderImage: string, ourImage: string): 'reclaim' | 'refuse' {
  if (!alive) return 'reclaim';                                        // dead holder → stale lock
  if (holderImage !== '' && holderImage !== ourImage) return 'reclaim'; // recycled PID (different binary)
  return 'refuse';                                                     // live SSIM, or undeterminable → fail safe
}

const ourImageName = (): string => (process.execPath.split(/[\\/]/).pop() ?? '').toLowerCase();
function readLockPid(): number | null {
  try { const p = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10); return Number.isFinite(p) ? p : null; }
  catch { return null; }
}

/**
 * Single-instance guard. Returns false when ANOTHER live SSIM already holds the lock.
 *   • ATOMIC — fs.open(…, 'wx') exclusively CREATES the lock in one OS call, so two racing
 *     launches can't both pass a check-then-write TOCTOU (the old existsSync→write bug).
 *   • FAIL-SAFE — an unexpected lock IO error REFUSES to start (after bounded retries for a
 *     transient AV lock), never the old "return true" that risked a double-run.
 *   • STALE RECLAIM — a crash/kill leaves a lock whose PID is dead or recycled onto a different
 *     binary; that is reclaimed. A live SSIM (or an undeterminable holder) is never stolen.
 */
export function acquireInstanceLock(): boolean {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      lockFd = fs.openSync(LOCK_FILE, 'wx');       // atomic exclusive create — EEXIST if held
      fs.writeSync(lockFd, String(process.pid));
      try { fs.fsyncSync(lockFd); } catch { /* fsync best-effort */ }
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        logger.warn(`single-instance lock IO error (attempt ${attempt + 1}/5): ${(e as Error).message}`);
        continue;                                   // transient → retry, then fail safe below
      }
      const pid = readLockPid();
      if (pid === process.pid) return true;         // somehow already ours
      if (pid == null) {                            // unreadable lock → treat as stale, reclaim once
        try { fs.unlinkSync(LOCK_FILE); } catch { /* another proc holds it → next iter refuses */ }
        continue;
      }
      const alive = isProcessAlive(pid);
      const disp = lockHolderDisposition(alive, alive ? processImageName(pid) : '', ourImageName());
      if (disp === 'refuse') return false;          // genuine second instance → do NOT start
      logger.warn(`reclaiming stale single-instance lock (pid ${pid}${alive ? ', recycled' : ', dead'})`);
      try { fs.unlinkSync(LOCK_FILE); } catch { /* lost the race → next wx refuses */ }
    }
  }
  logger.error('could not acquire the single-instance lock after retries – refusing to start (fail-safe, no double-run)');
  return false;
}

export function releaseInstanceLock(): void {
  try { if (lockFd !== undefined) { fs.closeSync(lockFd); lockFd = undefined; } } catch { /* best-effort */ }
  try {
    if (fs.existsSync(LOCK_FILE) && parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch { /* best-effort */ }
}
