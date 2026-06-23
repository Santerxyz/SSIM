import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { spawn, execFileSync } from 'child_process';
import fsExtra from 'fs-extra';
import axios from 'axios';
import { logger } from '../utils/logger';
import { LICENSE_API_URL, LICENSE_PUBLIC_KEY, LICENSE_HTTP_TIMEOUT_MS } from './config';
import { IS_SIDECAR_MODE } from '../utils/paths';

// ════════════════════════════════════════════════════════════════════════════
//  Updater — signed, self-replacing auto-update for the SINGLE self-contained SSIM.exe.
//
//  SSIM now ships as ONE binary: the Tauri shell with the Node backend embedded inside it. The
//  backend (this code) runs as the shell's child; the shell passes its own path as SSIM_SHELL_EXE.
//  So an update is a ONE-FILE swap: download the new SSIM.exe → verify (sha256 + Ed25519) → prove it
//  boots (anti-brick self-test) → swap SSIM_SHELL_EXE → relaunch it. The new shell re-extracts its
//  (new) embedded backend on next launch.
//
//  Flow:  GET /version → download to %TEMP% → verify sha256 + Ed25519 sig over `${latest}:${sha256}`
//         → self-test the new exe → write updater.bat → spawn detached → emit SSIM_UPDATING → exit
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
  sig:    string;   // base64url Ed25519 signature over `${latest}:${sha256}`
  // OPTIONAL, server-set. 'single-exe' marks a TWO-FILE→single-exe MIGRATION cut: the artifact is the
  // consolidated SSIM.exe and a two-file client must replace its SHELL + delete ssim-backend.exe (not
  // swap the backend in place). Absent / 'backend' → normal in-place swap. Not covered by `sig` (which
  // signs latest:sha256) — but it only SELECTS the swap shape; the artifact is still fully authenticated,
  // so the worst a forged flag can do is misplace an already-signed exe (a broken install, never RCE).
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
  const tmp = path.join(os.tmpdir(), `ssim_update_${Date.now()}_${process.pid}_${Math.floor(Math.random() * 1e6)}.exe`);
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
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(tmp, { flags: res.status === 206 ? 'a' : 'w' });
        let idle: NodeJS.Timeout;
        const fail = (err: Error): void => {
          clearTimeout(idle);
          // Tear down BOTH streams but KEEP the partial file — the next attempt resumes from it.
          try { out.destroy(); } catch { /* noop */ }
          try { res.data.destroy(); } catch { /* noop */ }
          reject(err);
        };
        const arm = (): void => {
          clearTimeout(idle);
          idle = setTimeout(() => fail(new Error('stalled — no data')), STALL_MS);
          // Drive the splash progress bar. bytesWritten is this-hop only; add the resume offset.
          if (total > 0) {
            const done = startHave + out.bytesWritten;
            const pct = Math.min(99, Math.floor((done / total) * 100));
            if (pct !== lastPct) {
              lastPct = pct;
              emitUpdate(`SSIM_UPDATE_PROGRESS::${pct}::${(done / 1048576).toFixed(0)}::${(total / 1048576).toFixed(0)}`);
            }
          }
        };
        res.data.on('data', arm);
        res.data.on('error', fail);
        res.data.pipe(out);
        out.on('error', fail);
        out.on('finish', () => { clearTimeout(idle); resolve(); });
        arm();
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

/** 3. Integrity (sha256) + authenticity (Ed25519) gate before we trust the file. */
function verify(file: string, info: VersionInfo): boolean {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (digest !== info.sha256) {
    logger.error('update sha256 mismatch – discarding download');
    return false;
  }
  const sigOk = crypto.verify(
    null,
    Buffer.from(`${info.latest}:${info.sha256}`),
    LICENSE_PUBLIC_KEY,
    Buffer.from(info.sig, 'base64url'),
  );
  if (!sigOk) logger.error('update signature invalid – possible tampering, discarding');
  return sigOk;
}

/**
 * 4. ANTI-BRICK: prove the new artifact boots + loads all bundled deps (incl. the globaloffensive +
 * steam stack) BEFORE we replace the working one. The artifact is already authentic (sha256 + Ed25519).
 * We run it with SSIM_SELFTEST=1 in an ISOLATED temp home (its extraction + logs never touch the live
 * install) and exit 0 (ok) / 2 (fail).
 *
 * DUAL: the OK marker arrives by a DIFFERENT channel per artifact, so we accept EITHER —
 *   • console ssim-backend.exe (two-file fleet artifact) prints `SSIM_SELFTEST_OK` to STDOUT, and
 *   • the GUI SSIM.exe (single-exe artifact) has no usable stdout, so its shell passthrough writes the
 *     report to <home>/.ssim-selftest.out.
 * A non-zero exit (self-test FAIL = 2) throws → caught → rejected. A bad publish can never replace a
 * working install with one that won't start.
 */
function selfTestNewExe(file: string): boolean {
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
    if (/SSIM_SELFTEST_OK/.test(stdout) || /SSIM_SELFTEST_OK/.test(report)) {
      logger.info('update self-test passed – new artifact boots + loads its deps');
      return true;
    }
    logger.error(`update self-test: exit 0 but no OK marker (stdout+file) – not swapping: ${(stdout || report).trim().slice(0, 300)}`);
    return false;
  } catch (err) {
    logger.error(`update self-test failed (non-zero exit / crash) – not swapping: ${(err as Error).message}`);
    return false;
  } finally {
    try { fsExtra.removeSync(home); } catch { /* best-effort */ }
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
  return (
    `@echo off\r\n` +
    waitOrKill(o.backendPid, 'wbk') +                          // our backend
    (o.shellPid != null ? waitOrKill(o.shellPid, 'wsh') : '') + // the shell (if any)
    `set /a tries=0\r\n:swap\r\n` +
    `move /Y "${o.tmp}" "${o.target}" >nul 2>&1 && goto done\r\n` +
    `set /a tries+=1\r\n` +
    `if %tries% LSS 15 (timeout /t 1 >nul & goto swap)\r\n:done\r\n` +
    dels +                                                     // remove orphaned files (migration)
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
  if (!selfTestNewExe(file)) {
    fsExtra.removeSync(file);
    return { updated: false, reason: 'new exe failed its self-test – kept the current version' };
  }
  return swapAndRelaunch(file, info); // does not return on success (process exits)
}

export const Updater = { check, runUpdate };
