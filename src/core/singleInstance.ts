import fs from 'fs';
import path from 'path';
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
 * do we RECLAIM the lock (holder gone/recycled), REFUSE to start (a genuine second SSIM), or
 * RETRY (S59: the holder is alive but we couldn't read its image — tasklist blocked/timeout — so give it
 * another chance before fail-safe refusing, instead of an immediate residual lockout). Never steals the
 * lock from a live SSIM.
 */
export function lockHolderDisposition(alive: boolean, holderImage: string, ourImage: string): 'reclaim' | 'refuse' | 'retry' {
  if (!alive) return 'reclaim';                          // dead holder → stale lock
  if (holderImage === '') return 'retry';               // S59: undeterminable image → retry before refusing
  if (holderImage !== ourImage) return 'reclaim';        // recycled PID (different binary)
  return 'refuse';                                       // live SSIM with our image → genuine second instance
}

/** S59: a SYNCHRONOUS sleep for the boot-time lock retries (the event loop isn't serving yet). Atomics.wait
 *  blocks the thread without a busy-wait; a real AV/handle lock lasts seconds, so the old sleep-less retry
 *  loop (all 5 attempts in microseconds) was useless — this gives each retry a real window. */
const LOCK_RETRY_SLEEP_MS = 300;
function sleepSync(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* SAB blocked → skip the wait */ }
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
  // FRESH INSTALL: on first run data/ does not exist yet, so fs.open(lock,'wx') would throw
  // ENOENT — which the fail-safe path below would misread as a lock IO error and REFUSE to
  // start, bricking every first launch. Ensure the lock's directory exists first.
  try { fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true }); } catch { /* best-effort; open() reports the real problem */ }
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
        sleepSync(LOCK_RETRY_SLEEP_MS);             // S59: give a transient AV/handle lock a real window
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
      if (disp === 'retry') {                       // S59: holder alive but image undeterminable (tasklist
        // blocked/timeout) — sleep and retry the whole check instead of an immediate residual lockout; if
        // it stays undeterminable across all attempts we still fail safe (the loop exits → refuse below).
        sleepSync(LOCK_RETRY_SLEEP_MS);
        continue;
      }
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
