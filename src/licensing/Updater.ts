import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { spawn, execFileSync } from 'child_process';
import fsExtra from 'fs-extra';
import axios from 'axios';
import { logger } from '../utils/logger';
import { LICENSE_API_URL, LICENSE_PUBLIC_KEY, LICENSE_HTTP_TIMEOUT_MS } from './config';
import { IS_SIDECAR_MODE, dataDir } from '../utils/paths';

// ════════════════════════════════════════════════════════════════════════════
//  Updater — signed, self-replacing auto-update for the SINGLE self-contained SSIM.exe.
//
//  SSIM now ships as ONE binary: the Tauri shell with the Node backend embedded inside it. The
//  backend (this code) runs as the shell's child; the shell passes its own path as SSIM_SHELL_EXE.
//  So an update is a ONE-FILE swap: download the new SSIM.exe → verify (sha256 + Ed25519) → prove it
//  boots (anti-brick self-test) → swap SSIM_SHELL_EXE → relaunch it. The new shell re-extracts its
//  (new) embedded backend on next launch.
//
//  Flow:  GET /version → download to the app DATA dir (NOT %TEMP%) → verify sha256 + Ed25519 sig over
//         `${latest}:${sha256}` → self-test the new exe → write updater.bat → spawn detached → emit
//         SSIM_UPDATING → exit
//         → bat waits for backend + shell to die, swaps SSIM.exe, relaunches it, self-cleans.
//
//  A running .exe can't overwrite itself on Windows, so the swap is delegated to a tiny detached
//  batch launched via a hidden VBScript (so it survives our exit). The Ed25519 signature is what makes
//  this safe: a hijacked update URL can't ship a payload we'll execute, because it can't sign it.
//
//  DUAL-MODE (this client runs in BOTH the still-deployed two-file fleet AND the single-exe build):
//  the verify + self-test gates are identical; only the final swap shape differs, chosen at runtime:
//    • SINGLE-EXE  (SSIM_SHELL_EXE set)  → replace + relaunch the consolidated SSIM.exe.
//    • TWO-FILE    (sidecar, no SSIM_SHELL_EXE) → swap ssim-backend.exe in place; relaunch the existing
//      shell, which respawns the new sidecar. This keeps the deployed 1.2.x fleet auto-updatable.
//    • MIGRATION   (manifest kind:'single-exe' on a two-file install) → the artifact is the consolidated
//      SSIM.exe: replace the OLD shell (folder SSIM.exe) with it AND delete the orphaned ssim-backend.exe,
//      then relaunch — a seamless two-file→single-exe cutover with no folder reinstall.
//    • STANDALONE  (headless ssim.exe) → swap + relaunch our own exe.
//  Every shape still passes the same sha256 + Ed25519 + boot self-test before anything touches disk.
// ════════════════════════════════════════════════════════════════════════════

interface VersionInfo {
  latest: string;   // semver
  url:    string;   // download URL of the artifact (consolidated SSIM.exe, or two-file ssim-backend.exe)
  sha256: string;   // hex digest of that file
  sig:    string;   // base64url Ed25519 over `${latest}:${sha256}` — LEGACY (kind-less). Still emitted by
                    // the server for the deployed fleet; THIS client verifies `sigKind` instead.
  /**
   * base64url Ed25519 over `${latest}:${sha256}:${kind ?? 'backend'}` — the KIND-INCLUSIVE signature.
   * This client verifies THIS, so a tampered `kind` (the swap-shape selector) is rejected, not just the
   * artifact bytes. (C14 integrity fix.) Required: an update without it is refused.
   */
  sigKind?: string;
  // OPTIONAL, server-set. 'single-exe' marks a TWO-FILE→single-exe MIGRATION cut (replace the SHELL +
  // delete ssim-backend.exe). Absent / 'backend' → normal in-place swap. NOW COVERED by `sigKind`, so it
  // can no longer be forged to force the destructive migration shape on a victim.
  kind?:  'single-exe' | 'backend';
}

const http = axios.create({ timeout: LICENSE_HTTP_TIMEOUT_MS, validateStatus: () => true });

/**
 * Emit a machine-readable update marker on stdout so the Tauri shell can reflect the live phase
 * (download %, verifying, installing) on the boot splash instead of a frozen spinner. No-op outside
 * sidecar mode — a console/dev run shows the human banner instead. The shell parses these per-line
 * (see src-tauri/src/lib.rs); keep the token spellings in sync with it.
 */
function emitUpdate(line: string): void {
  try { if (IS_SIDECAR_MODE) process.stdout.write(`${line}\n`); } catch { /* stdout may be closed */ }
}

/** Prominent console notice so the operator SEES that an update is happening. */
function printUpdateBanner(from: string, to: string): void {
  const V = '\x1b[35m', B = '\x1b[1m', R = '\x1b[0m', D = '\x1b[2m';
  const line = '─'.repeat(48);
  // eslint-disable-next-line no-console
  console.log(
    `\n  ${V}${B}◆ SSIM Update${R}\n` +
    `  ${D}${line}${R}\n` +
    `   ${B}New version available${R}   ${D}v${from}${R} → ${V}${B}v${to}${R}\n` +
    `   ${D}downloading and installing – SSIM will restart shortly…${R}\n` +
    `  ${D}${line}${R}\n`,
  );
}

/** semver-ish compare → true if `remote` is strictly newer than `local`. */
function isNewer(remote: string, local: string): boolean {
  const r = remote.split('.').map(Number), l = local.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) > (l[i] ?? 0)) return true;
    if ((r[i] ?? 0) < (l[i] ?? 0)) return false;
  }
  return false;
}

/** 1. Ask the backend what the latest published version is. */
async function check(currentVersion: string): Promise<VersionInfo | null> {
  try {
    const res = await http.get(`${LICENSE_API_URL}/version`);
    if (res.status !== 200) return null;
    const info = res.data as VersionInfo;
    return isNewer(info.latest, currentVersion) ? info : null;
  } catch (err) {
    logger.warn(`update check failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Stream `src` to `dest`, resolving ONLY after the file descriptor is fsync'd AND CLOSED.
 *
 * THE FIX (Windows EACCES on self-test): the previous code resolved on the writable stream's `finish`
 * event, which fires when the bytes have been handed to the OS but BEFORE the fd is closed (Node closes
 * it asynchronously via autoClose, emitting `close` afterwards). Because runUpdate() runs
 * download→verify→self-test synchronously within ONE event-loop turn (microtasks), the libuv fd-close
 * macrotask had not yet run — so we still held an OPEN WRITABLE HANDLE to the .exe when execFileSync
 * asked Windows to CreateProcess it. Windows can't load an image that another handle still has open for
 * write → ERROR_ACCESS_DENIED / sharing violation → `spawnSync … EACCES`. (Reads still worked, so
 * verify()'s sha256 passed, because libuv opens the write stream with FILE_SHARE_READ — execution does
 * not share with a writer.) Resolving on `close` (after an fsync for durability) guarantees the handle
 * is released AND the bytes are on disk before anyone executes the file.
 *
 * KEEPS whatever is already on disk on error (the download loop resumes from the partial). Exported for
 * tests.
 */
export function pipeToFile(
  src: NodeJS.ReadableStream,
  dest: string,
  opts: { append: boolean; stallMs: number; onData?: (hopBytes: number) => void },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(dest, { flags: opts.append ? 'a' : 'w' });
    let fd: number | undefined;
    let idle: NodeJS.Timeout | undefined;
    let settled = false;
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (idle) clearTimeout(idle);
      if (err) {
        // Tear down BOTH streams but KEEP whatever is on disk — the next attempt resumes from it.
        try { out.destroy(); } catch { /* noop */ }
        try { (src as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.(); } catch { /* noop */ }
        reject(err);
      } else {
        resolve();
      }
    };
    const arm = (): void => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => settle(new Error('stalled — no data')), opts.stallMs);
      opts.onData?.(out.bytesWritten); // bytesWritten is this-hop only; the caller adds the resume offset
    };
    out.on('open', (f: number) => { fd = f; });
    src.on('data', arm);
    src.on('error', settle);
    out.on('error', settle);
    // Durability: force the bytes to disk while the fd is still open…
    out.on('finish', () => {
      if (idle) clearTimeout(idle);
      try { if (fd !== undefined) fs.fsyncSync(fd); } catch { /* fd may already be gone — best-effort */ }
    });
    // …and resolve ONLY once the fd is CLOSED (handle released) — the crux of the EACCES fix.
    out.on('close', () => settle());
    src.pipe(out);
    arm(); // arm the stall timer immediately so a socket that never sends a byte still aborts
  });
}

/**
 * Where we stage the downloaded exe for the self-test + swap. We DELIBERATELY use the app's own data
 * dir (next to the install / SSIM_HOME) instead of %LOCALAPPDATA%\Temp:
 *   • %TEMP% is the location most commonly blocked for EXECUTION by AppLocker / SRP / the Defender
 *     Attachment Manager on managed machines → CreateProcess of the self-test exe returns
 *     ERROR_ACCESS_DENIED (EACCES). The app's data dir is already trusted + writable by the running
 *     app, so executing the staged exe from there is not blocked by those %TEMP%-scoped rules.
 *   • it sits on the SAME volume as the install target, so the swap's `move /Y` is an atomic rename
 *     rather than a cross-volume copy (faster, and far less exposed to an AV scan mid-copy).
 * Falls back to os.tmpdir() only if the data dir can't be created (a broken SSIM_HOME), preserving the
 * previous behaviour rather than dead-ending the update.
 */
function updatesStageDir(): string {
  try {
    const d = dataDir('updates');
    fs.mkdirSync(d, { recursive: true });
    return d;
  } catch {
    return os.tmpdir();
  }
}

/** Best-effort sweep of leftover staged exes from previous (crashed) runs so they don't accumulate in
 *  the persistent data dir. Keeps `keep` (the file we're about to write). */
function sweepStaleStaged(dir: string, keep: string): void {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^ssim_update_.*\.exe$/i.test(name)) continue;
      const p = path.join(dir, name);
      if (path.resolve(p) !== path.resolve(keep)) { try { fsExtra.removeSync(p); } catch { /* may be in use */ } }
    }
  } catch { /* dir unreadable — nothing to sweep */ }
}

/**
 * 2. Stream the new SSIM.exe to a temp file — RESUMABLY. The single binary is ~185 MB, and a download
 * that big over a real connection gets cut off mid-stream often enough that an all-or-nothing GET can
 * loop forever (every reset throws away everything and restarts from zero — exactly what stranded the
 * fleet). So we fetch it in resumable hops: each drop re-requests with `Range: bytes=<have>-` and
 * APPENDS from where we stopped, until the whole file is on disk. The server answers 206 + Content-Range,
 * so this is a plain partial-content fetch. An idle-stall guard aborts a silently-wedged socket so the
 * retry loop can resume it instead of hanging the launch. The partial file is KEPT between attempts
 * (that is the whole point) and removed only if we ultimately fail. verify()'s sha256 is the backstop:
 * a misassembled file can never be swapped in.
 */
async function download(info: VersionInfo): Promise<string> {
  const stageDir = updatesStageDir();
  const tmp = path.join(stageDir, `ssim_update_${Date.now()}_${process.pid}_${Math.floor(Math.random() * 1e6)}.exe`);
  sweepStaleStaged(stageDir, tmp); // clear any orphaned exe from a previous crashed run
  const MAX_ATTEMPTS = 40;   // each good hop ADVANCES, so this tolerates ~40 drops, not 40 full restarts
  const STALL_MS = 30_000;   // no bytes for 30 s on an open socket → wedged; abort so we can resume it
  let total = 0;             // learned from the first response (Content-Length / Content-Range)
  let lastErr = '';
  let lastPct = -1;          // throttle splash progress emits to once per whole percent (≤100 lines total)

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let have = 0;
    try { have = fs.statSync(tmp).size; } catch { /* no partial yet */ }
    if (total > 0 && have >= total) break; // already whole

    try {
      const headers: Record<string, string> = have > 0 ? { Range: `bytes=${have}-` } : {};
      // No axios timeout on the body (we guard idle ourselves); we need the raw stream to resume.
      const res = await http.get(info.url, { responseType: 'stream', headers, timeout: 0 });

      if (res.status === 200) {
        // Full body (first fetch, or server ignored Range) → (re)start clean from zero.
        if (have > 0) { try { fs.truncateSync(tmp, 0); } catch { /* noop */ } have = 0; }
        total = Number(res.headers['content-length']) || total;
      } else if (res.status === 206) {
        const m = String(res.headers['content-range'] || '').match(/\/(\d+)\s*$/); // bytes a-b/TOTAL
        if (m) total = Number(m[1]);
      } else {
        try { res.data.destroy(); } catch { /* noop */ }
        throw new Error(`HTTP ${res.status}`);
      }

      const startHave = have; // bytes already on disk before this hop (resume offset)
      // Write via pipeToFile: it fsyncs + waits for the fd to CLOSE before resolving, so the staged
      // exe carries no lingering write handle when the self-test executes it (the EACCES fix).
      await pipeToFile(res.data, tmp, {
        append: res.status === 206,
        stallMs: STALL_MS,
        onData: (hopBytes) => {
          // Drive the splash progress bar. hopBytes is this-hop only; add the resume offset.
          if (total > 0) {
            const done = startHave + hopBytes;
            const pct = Math.min(99, Math.floor((done / total) * 100));
            if (pct !== lastPct) {
              lastPct = pct;
              emitUpdate(`SSIM_UPDATE_PROGRESS::${pct}::${(done / 1048576).toFixed(0)}::${(total / 1048576).toFixed(0)}`);
            }
          }
        },
      });

      try { have = fs.statSync(tmp).size; } catch { /* noop */ }
      if (total === 0 || have >= total) break;          // whole file on disk → done
      logger.warn(`update download short (${have}/${total} bytes) – resuming`); // server closed early
    } catch (err) {
      lastErr = (err as Error).message;
      let got = 0; try { got = fs.statSync(tmp).size; } catch { /* noop */ }
      logger.warn(`update download interrupted at ${(got / 1048576).toFixed(0)} MB (${lastErr}) – resume ${attempt}/${MAX_ATTEMPTS}`);
      await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 5000)));
    }
  }

  let finalSize = 0; try { finalSize = fs.statSync(tmp).size; } catch { /* noop */ }
  if (finalSize === 0 || (total > 0 && finalSize < total)) {
    try { fsExtra.removeSync(tmp); } catch { /* noop */ }
    throw new Error(`download incomplete after ${MAX_ATTEMPTS} attempts (${finalSize}/${total || '?'} bytes)${lastErr ? ` – last: ${lastErr}` : ''}`);
  }
  return tmp;
}

/**
 * Verifies the KIND-INCLUSIVE update signature: Ed25519 over
 * `${latest}:${sha256}:${kind ?? 'backend'}`. `kind` defaults to 'backend' identically on the
 * server (`signing.js`), so both sides sign/verify the same bytes. Returns false if `sigKind`
 * is absent or doesn't verify — a tampered `kind` changes the payload, so the signature no
 * longer matches and the destructive swap-shape cannot be forced. Pure (key passed in) so it
 * is unit-testable with a throwaway keypair. (C14.)
 */
export function verifyUpdateSignature(
  info: { latest: string; sha256: string; kind?: string; sigKind?: string },
  publicKeyPem: string,
): boolean {
  if (!info.sigKind) return false;
  const kindTag = info.kind ?? 'backend';
  try {
    return crypto.verify(
      null,
      Buffer.from(`${info.latest}:${info.sha256}:${kindTag}`),
      publicKeyPem,
      Buffer.from(info.sigKind, 'base64url'),
    );
  } catch {
    return false;
  }
}

/** 3. Integrity (sha256) + authenticity (Ed25519 over latest:sha256:kind) gate before we trust the file. */
function verify(file: string, info: VersionInfo): boolean {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (digest !== info.sha256) {
    logger.error('update sha256 mismatch – discarding download');
    return false;
  }
  // Authenticity gate: require the KIND-INCLUSIVE signature so a forged swap-shape `kind`
  // (the migration/delete selector) is rejected — not just the artifact bytes. An update
  // manifest without `sigKind` is refused (the server must dual-sign first; that is why the
  // server rollout ships BEFORE this client). (C14.)
  if (!info.sigKind) {
    logger.error('update manifest has no kind-inclusive signature (sigKind) – refusing update');
    return false;
  }
  const sigOk = verifyUpdateSignature(info, LICENSE_PUBLIC_KEY);
  if (!sigOk) logger.error('update signature invalid (kind-inclusive) – possible tampering, discarding');
  return sigOk;
}

/** Outcome of one self-test spawn, split into a "retryable lock" vs a "real, keep-current" failure. */
export type SelfTestOutcome =
  | { ok: true }
  | { ok: false; kind: 'lock' | 'crash' | 'no-marker'; errno?: string; detail: string };

/**
 * Classify a thrown execFileSync error so we retry ONLY a transient permission/lock condition and NEVER
 * a genuine failure (which must keep the current version — the anti-brick guard):
 *   • the child RAN and exited non-zero (self-test FAIL = 2) → numeric `.status`, no spawn errno →
 *     'crash'. REAL failure: keep current, do NOT retry. This is what preserves the guard.
 *   • the child could not be SPAWNED with EACCES/EBUSY/EPERM/ETXTBSY → a lingering write handle, an AV
 *     scan, or a MOTW/SmartScreen block → 'lock' (RETRYABLE).
 *   • anything else (ENOENT bad path, a kill/timeout signal) → 'crash'.
 * Pure + exported so the keep-current-on-real-failure property is unit-testable without a real exe.
 */
export function classifySpawnError(err: unknown): Extract<SelfTestOutcome, { ok: false }> {
  const e = (err ?? {}) as NodeJS.ErrnoException & { status?: number | null; signal?: string | null };
  // A numeric exit status means the image LOADED and ran, then self-reported failure → real, not a lock.
  if (typeof e.status === 'number') return { ok: false, kind: 'crash', detail: `exit ${e.status}` };
  const errno = e.code;
  if (errno && ['EACCES', 'EBUSY', 'EPERM', 'ETXTBSY', 'UNKNOWN'].includes(errno)) {
    return { ok: false, kind: 'lock', errno, detail: `${e.syscall || 'spawnSync'} ${errno}` };
  }
  return { ok: false, kind: 'crash', errno, detail: `${errno || e.signal || 'spawn-error'}: ${String(e.message || '').slice(0, 160)}` };
}

/**
 * Strip the Mark-of-the-Web (NTFS `Zone.Identifier` alternate data stream) from a staged file so
 * SmartScreen / the Defender Attachment Manager doesn't block CreateProcess of it with
 * ERROR_ACCESS_DENIED (EACCES). A file we wrote ourselves via fs normally carries NO MOTW, so this is
 * defence-in-depth (and it is re-applied between retries in case an AV re-tags the file). Best-effort,
 * no-op on non-NTFS / when absent. Returns whether a tag was actually removed (for tests/logging).
 */
export function stripMarkOfTheWeb(file: string): boolean {
  try {
    fs.unlinkSync(`${file}:Zone.Identifier`); // remove the ADS by its stream name
    return true;
  } catch {
    return false; // ENOENT (none present — the common case for an fs-written file) or non-NTFS volume
  }
}

/**
 * One self-test spawn → a classified outcome. Boots the new exe with SSIM_SELFTEST=1 in an ISOLATED temp
 * home (its extraction + logs never touch the live install) and exit 0 (ok) / 2 (fail).
 *
 * DUAL: the OK marker arrives by a DIFFERENT channel per artifact, so we accept EITHER —
 *   • console ssim-backend.exe (two-file fleet artifact) prints `SSIM_SELFTEST_OK` to STDOUT, and
 *   • the GUI SSIM.exe (single-exe artifact) has no usable stdout, so its shell passthrough writes the
 *     report to <home>/.ssim-selftest.out.
 */
function runSelfTestOnce(file: string): SelfTestOutcome {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim_selftest_'));
  try {
    // Capture stdout (NOT 'ignore') so a console artifact's marker is visible; a GUI artifact simply
    // yields empty stdout and we fall back to the file report. execFileSync throws on a non-zero exit.
    const stdout = (execFileSync(file, [], {
      env: { ...process.env, SSIM_SELFTEST: '1', SSIM_HOME: home },
      timeout: 120_000, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    }) || '').toString();
    let report = '';
    try { report = fs.readFileSync(path.join(home, '.ssim-selftest.out'), 'utf8'); } catch { /* no file report */ }
    if (/SSIM_SELFTEST_OK/.test(stdout) || /SSIM_SELFTEST_OK/.test(report)) return { ok: true };
    return { ok: false, kind: 'no-marker', detail: (stdout || report).trim().slice(0, 300) };
  } catch (err) {
    return classifySpawnError(err);
  } finally {
    try { fsExtra.removeSync(home); } catch { /* best-effort */ }
  }
}

const SELFTEST_BACKOFF_MS = [300, 900, 2000, 4000]; // bounded retry for a transient handle/AV/MOTW lock
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 4. ANTI-BRICK: prove the new artifact boots + loads all bundled deps (incl. the globaloffensive +
 * steam stack) BEFORE we replace the working one — now with a bounded retry-with-backoff so a transient
 * EACCES/EBUSY (a not-yet-released handle, an AV mid-scan, a MOTW tag) doesn't strand the update, while
 * a GENUINE failure still keeps the current version. The artifact is already authentic (sha256 + Ed25519).
 *
 * KEEP-CURRENT GUARD INTACT: only a 'lock' outcome is retried; a 'crash' (non-zero exit / hang) or a
 * 'no-marker' boot returns false immediately and we do NOT swap. Even after the retries are exhausted we
 * still return false — never a weakening. Each failure logs its precise, distinguishable reason (errno /
 * exit code / path) so future field failures are diagnosable. `runOnce`/`backoffMs` are injectable for
 * tests.
 */
export async function selfTestNewExe(
  file: string,
  runOnce: (f: string) => SelfTestOutcome = runSelfTestOnce,
  backoffMs: readonly number[] = SELFTEST_BACKOFF_MS,
): Promise<boolean> {
  stripMarkOfTheWeb(file); // clear any Mark-of-the-Web before the first attempt
  for (let attempt = 0; ; attempt++) {
    const r = runOnce(file);
    if (r.ok) {
      logger.info(`update self-test passed – new artifact boots + loads its deps${attempt ? ` (after ${attempt} retr${attempt === 1 ? 'y' : 'ies'})` : ''}`);
      return true;
    }
    // A REAL failure (ran and failed, hung, or produced no OK marker) is NOT retried — keep the current
    // version. This IS the anti-brick guard; do not weaken it.
    if (r.kind !== 'lock') {
      logger.error(`update self-test failed – not swapping [${r.kind}]: ${r.detail}`);
      return false;
    }
    // A spawn-level permission/lock condition (EACCES/EBUSY/…): retry with backoff, re-stripping MOTW.
    if (attempt < backoffMs.length) {
      logger.warn(`update self-test spawn lock (${r.detail}) on ${file} – retry ${attempt + 1}/${backoffMs.length} after ${backoffMs[attempt]}ms`);
      await sleep(backoffMs[attempt]);
      stripMarkOfTheWeb(file);
      continue;
    }
    // Exhausted retries on a PERSISTENT lock → STILL keep the current version (guard intact), but say so.
    logger.error(`update self-test still locked (${r.detail}) after ${backoffMs.length} retries – not swapping: ${file}`);
    return false;
  }
}

/**
 * Build the Windows .bat for the swap. Pure + exported so the swap logic can be tested without
 * overwriting a live install. Waits for our backend PID and (when given) the shell PID — force-killing
 * after ~12 s so a stuck process can't deadlock it — then moves the new exe over `target` with retry
 * (Windows can hold a file handle briefly after exit), deletes any orphaned files, relaunches, self-cleans.
 *
 * Generalised over the four swap shapes: `target` (file to replace) and `relaunch` (exe to start) can
 * differ — e.g. a two-file backend swap replaces ssim-backend.exe but relaunches the shell SSIM.exe; a
 * migration replaces the shell SSIM.exe and deletes the orphaned ssim-backend.exe via `deletePaths`.
 */
export function buildSwapScript(o: {
  tmp: string;                 // downloaded new exe
  target: string;              // the file to REPLACE with tmp
  relaunch: string;            // the exe to START after the swap
  relaunchUpdatedFlag?: boolean; // pass --ssim-updated (single-exe shell shows the "Update installed" splash)
  backendPid: number;          // our PID — always waited for
  shellPid?: number;           // parent shell PID; omit for headless standalone
  deletePaths?: string[];      // extra files to remove AFTER the swap (e.g. orphaned ssim-backend.exe on migration)
  vbsPath: string;             // deleted by the bat
  selfPath?: string;           // what the bat deletes last; defaults to %~f0 (itself) in production
}): string {
  const waitOrKill = (pid: number, label: string): string =>
    `set /a ${label}=0\r\n:${label}\r\n` +
    `tasklist /FI "PID eq ${pid}" | find "${pid}" >nul || goto ${label}_ok\r\n` +
    `set /a ${label}+=1\r\n` +
    `if %${label}% GEQ 12 (taskkill /F /PID ${pid} >nul 2>&1 & goto ${label}_ok)\r\n` +
    `timeout /t 1 >nul & goto ${label}\r\n:${label}_ok\r\n`;
  const dels = (o.deletePaths ?? []).map((p) => `del /F /Q "${p}" >nul 2>&1\r\n`).join('');
  // The orphan-delete (e.g. deleting the running ssim-backend.exe on a migration) MUST run
  // ONLY after a CONFIRMED successful swap. Before, `dels` ran unconditionally after the
  // move loop, so a move that never succeeded (AV/file lock) still deleted the orphan AND
  // relaunched the un-swapped target → a bricked install. Now a successful `move` jumps to
  // :swapped (→ dels), and an exhausted retry jumps to :swapfail (skips dels). Both paths
  // still relaunch + self-clean, so a failed swap degrades to a no-op update, never a brick.
  // (C14 / INV-G3.)
  return (
    `@echo off\r\n` +
    waitOrKill(o.backendPid, 'wbk') +                          // our backend
    (o.shellPid != null ? waitOrKill(o.shellPid, 'wsh') : '') + // the shell (if any)
    `set /a tries=0\r\n:swap\r\n` +
    `move /Y "${o.tmp}" "${o.target}" >nul 2>&1 && goto swapped\r\n` +
    `set /a tries+=1\r\n` +
    `if %tries% LSS 15 (timeout /t 1 >nul & goto swap)\r\n` +
    `goto swapfail\r\n` +                                       // move never succeeded → SKIP the delete
    `:swapped\r\n` +
    dels +                                                     // orphan delete — ONLY after a confirmed swap
    `:swapfail\r\n` +
    `start "" "${o.relaunch}"${o.relaunchUpdatedFlag ? ' --ssim-updated' : ''}\r\n` +
    `del "${o.vbsPath}" >nul 2>&1\r\ndel "${o.selfPath ?? '%~f0'}"\r\n`
  );
}

/**
 * 5. Write the swap script + launch it (hidden, detached) so it can replace us after we exit. Picks the
 * swap SHAPE from the runtime environment + manifest, so this single client serves the deployed two-file
 * fleet, the single-exe build, and the one-time migration between them.
 */
function swapAndRelaunch(newExe: string, info: VersionInfo): { updated: boolean; reason: string } {
  const stamp = Date.now();
  const bat = path.join(os.tmpdir(), `ssim_updater_${stamp}.bat`);
  const vbs = path.join(os.tmpdir(), `ssim_updater_${stamp}.vbs`);
  const shellExe = process.env.SSIM_SHELL_EXE;            // set ONLY by the single-exe shell
  const installDir = path.dirname(process.execPath);
  const siblingShell = path.join(installDir, 'SSIM.exe'); // the two-file GUI shell next to ssim-backend.exe

  let script: string;
  let mode: string;
  if (shellExe) {
    // (1) SINGLE-EXE: replace + relaunch the consolidated SSIM.exe (shell + embedded backend).
    script = buildSwapScript({
      tmp: newExe, target: shellExe, relaunch: shellExe, relaunchUpdatedFlag: true,
      backendPid: process.pid, shellPid: process.ppid, vbsPath: vbs,
    });
    mode = 'single-exe';
  } else if (info.kind === 'single-exe' && IS_SIDECAR_MODE && fs.existsSync(siblingShell)) {
    // (2) MIGRATION two-file → single-exe: the artifact IS the consolidated SSIM.exe. Replace the OLD
    // shell with it, DELETE the now-orphaned ssim-backend.exe (our own running file), relaunch SSIM.exe.
    script = buildSwapScript({
      tmp: newExe, target: siblingShell, relaunch: siblingShell, relaunchUpdatedFlag: true,
      backendPid: process.pid, shellPid: process.ppid, deletePaths: [process.execPath], vbsPath: vbs,
    });
    mode = 'two-file→single-exe migration';
  } else if (IS_SIDECAR_MODE) {
    // (3) TWO-FILE backend update: swap ssim-backend.exe in place; relaunch the EXISTING shell, which
    // respawns the freshly-swapped sidecar. No SSIM_SHELL_EXE → it's the OLD shell, so no --ssim-updated.
    script = buildSwapScript({
      tmp: newExe, target: process.execPath, relaunch: siblingShell,
      backendPid: process.pid, shellPid: process.ppid, vbsPath: vbs,
    });
    mode = 'two-file backend';
  } else {
    // (4) HEADLESS standalone (no shell): swap our own exe and relaunch it directly.
    script = buildSwapScript({
      tmp: newExe, target: process.execPath, relaunch: process.execPath,
      backendPid: process.pid, vbsPath: vbs,
    });
    mode = 'standalone';
  }

  fsExtra.writeFileSync(bat, script);
  // Hidden + detached launcher: window style 0 = invisible, False = don't wait.
  fsExtra.writeFileSync(vbs, `CreateObject("WScript.Shell").Run "cmd /c ""${bat}""", 0, False\r\n`);
  spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  // Tell the shell this is an UPDATE, not a crash → quit cleanly so the file frees up. The single-exe
  // shell acts on this; the old two-file shell ignores it (it already follows its sidecar out on exit).
  emitUpdate('SSIM_UPDATING');
  logger.info(`update staged (${mode}) – swap script launched, exiting for replacement`);
  // Give WScript a moment to spin the bat up as an independent process before we vanish (do NOT unref).
  setTimeout(() => process.exit(0), 800);
  return { updated: true, reason: 'swapping' };
}

/** Full orchestration; safe to call on boot or from a manual trigger. */
export async function runUpdate(currentVersion: string): Promise<{ updated: boolean; reason: string }> {
  const info = await check(currentVersion);
  if (!info) return { updated: false, reason: 'up-to-date' };
  printUpdateBanner(currentVersion, info.latest);
  logger.info(`update available: ${currentVersion} → ${info.latest}`);
  // Tell the shell to show "Downloading update…" on its splash — the download can be ~175 MB and runs
  // BEFORE our server starts, so without this the launch window would just look frozen. The version
  // rides along so the splash can name what it's installing ("Downloading update v1.2.3…").
  emitUpdate(`SSIM_UPDATE_DOWNLOADING::${info.latest}`);

  let file: string;
  try {
    file = await download(info);
  } catch (err) {
    return { updated: false, reason: `download failed: ${(err as Error).message}` };
  }
  // Verify (sha256, fast) + anti-brick self-test (boots the new exe, can take up to ~2 min). Both
  // are silent on disk, so flag the phase or the splash looks stuck on "Downloading" the whole time.
  emitUpdate('SSIM_UPDATE_VERIFYING');
  if (!verify(file, info)) {
    fsExtra.removeSync(file);
    return { updated: false, reason: 'verification failed' };
  }
  if (!(await selfTestNewExe(file))) {
    fsExtra.removeSync(file);
    return { updated: false, reason: 'new exe failed its self-test – kept the current version' };
  }
  return swapAndRelaunch(file, info); // does not return on success (process exits)
}

export const Updater = { check, runUpdate };
