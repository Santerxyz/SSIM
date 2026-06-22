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
//  MIGRATION (existing two-file installs → this single-exe build): handled SERVER-SIDE. The license
//  server publishes a transitional manifest carrying the new SSIM.exe as the file the OLD two-file
//  updater already knows how to swap; that hop lands the consolidated exe, which then takes over with
//  this simple single-file path. This client is single-file ONLY (no dual-format).
// ════════════════════════════════════════════════════════════════════════════

interface VersionInfo {
  latest: string;   // semver
  url:    string;   // download URL of the new SSIM.exe (the single self-contained binary)
  sha256: string;   // hex digest of that file
  sig:    string;   // base64url Ed25519 signature over `${latest}:${sha256}`
}

const http = axios.create({ timeout: LICENSE_HTTP_TIMEOUT_MS, validateStatus: () => true });

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

/** 2. Stream a URL to a fresh temp file. */
async function download(info: VersionInfo): Promise<string> {
  const tmp = path.join(os.tmpdir(), `ssim_update_${Date.now()}_${process.pid}_${Math.floor(Math.random() * 1e6)}.exe`);
  const res = await http.get(info.url, { responseType: 'stream' });
  if (res.status !== 200) {
    try { res.data.destroy(); } catch { /* noop */ }
    throw new Error(`download HTTP ${res.status}`);
  }
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    res.data.pipe(out);
    out.on('finish', resolve);
    const cleanup = (err: Error): void => {
      // On any stream/write error: tear down BOTH streams and remove the partial temp file so a
      // failed update leaks neither sockets nor a multi-MB .exe scrap.
      try { out.destroy(); } catch { /* noop */ }
      try { res.data.destroy(); } catch { /* noop */ }
      try { fsExtra.removeSync(tmp); } catch { /* noop */ }
      reject(err);
    };
    out.on('error', cleanup);
    res.data.on('error', cleanup);
  });
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
 * 4. ANTI-BRICK: prove the new SSIM.exe extracts + boots its EMBEDDED backend (and that all bundled
 * deps — incl. the globaloffensive + steam stack — load) BEFORE we replace the working one. The new
 * exe is already authentic (sha256 + Ed25519). We run it with SSIM_SELFTEST=1 in an ISOLATED temp
 * home, so its ~171 MB extraction + logs never touch the live install; the shell's passthrough runs
 * the embedded backend's self-test, writes the report to <home>/.ssim-selftest.out, and exits 0 (ok)
 * / 2 (fail). We trust the EXIT CODE (reliable regardless of the exe's GUI subsystem) and confirm the
 * report for good measure. A new exe that fails to boot is REJECTED here — a bad publish can never
 * replace a working install with one that won't start.
 */
function selfTestNewExe(file: string): boolean {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim_selftest_'));
  try {
    execFileSync(file, [], {
      env: { ...process.env, SSIM_SELFTEST: '1', SSIM_HOME: home },
      timeout: 120_000, windowsHide: true, stdio: 'ignore',
    });
    let report = '';
    try { report = fs.readFileSync(path.join(home, '.ssim-selftest.out'), 'utf8'); } catch { /* no report */ }
    if (/SSIM_SELFTEST_OK/.test(report)) {
      logger.info('update self-test passed – new SSIM.exe boots its embedded backend + deps');
      return true;
    }
    logger.error(`update self-test: exit 0 but no OK report – not swapping: ${report.trim().slice(0, 300)}`);
    return false;
  } catch (err) {
    logger.error(`update self-test failed (non-zero exit / crash) – not swapping: ${(err as Error).message}`);
    return false;
  } finally {
    try { fsExtra.removeSync(home); } catch { /* best-effort */ }
  }
}

/**
 * Build the Windows .bat for the single-file swap. Pure + exported so the swap logic can be tested
 * without overwriting a live install: waits for BOTH our backend PID and the shell PID (force-kills
 * after ~12 s so a stuck shell can't deadlock it), moves the new exe over the running SSIM.exe with
 * retry (Windows can hold a file handle briefly after exit), relaunches the shell, then self-cleans.
 */
export function buildSwapScript(o: {
  tmp: string;        // downloaded new SSIM.exe
  target: string;     // the running SSIM.exe (shell) to replace AND relaunch
  backendPid: number; // our (extracted backend) PID
  shellPid: number;   // the SSIM.exe shell PID (our parent)
  vbsPath: string;    // deleted by the bat
  selfPath?: string;  // what the bat deletes last; defaults to %~f0 (itself) in production
}): string {
  const waitOrKill = (pid: number, label: string): string =>
    `set /a ${label}=0\r\n:${label}\r\n` +
    `tasklist /FI "PID eq ${pid}" | find "${pid}" >nul || goto ${label}_ok\r\n` +
    `set /a ${label}+=1\r\n` +
    `if %${label}% GEQ 12 (taskkill /F /PID ${pid} >nul 2>&1 & goto ${label}_ok)\r\n` +
    `timeout /t 1 >nul & goto ${label}\r\n:${label}_ok\r\n`;
  return (
    `@echo off\r\n` +
    waitOrKill(o.backendPid, 'wbk') +    // our backend (the extracted child)
    waitOrKill(o.shellPid, 'wsh') +      // the SSIM.exe shell
    `set /a tries=0\r\n:swap\r\n` +
    `move /Y "${o.tmp}" "${o.target}" >nul 2>&1 && goto done\r\n` +
    `set /a tries+=1\r\n` +
    `if %tries% LSS 15 (timeout /t 1 >nul & goto swap)\r\n:done\r\n` +
    `start "" "${o.target}"\r\n` +
    `del "${o.vbsPath}" >nul 2>&1\r\ndel "${o.selfPath ?? '%~f0'}"\r\n`
  );
}

/** 5. Write the swap script + launch it (hidden, detached) so it can replace us after we exit. */
function swapAndRelaunch(newExe: string): { updated: boolean; reason: string } {
  // The shell passes its own path; without it we cannot know which OUTER exe to replace, so we fail
  // honestly and keep the working install rather than guess (owner directive: no band-aids).
  const shellExe = process.env.SSIM_SHELL_EXE;
  if (!shellExe) {
    try { fsExtra.removeSync(newExe); } catch { /* noop */ }
    return { updated: false, reason: 'SSIM_SHELL_EXE not set — cannot self-update; kept current version' };
  }
  const stamp = Date.now();
  const bat = path.join(os.tmpdir(), `ssim_updater_${stamp}.bat`);
  const vbs = path.join(os.tmpdir(), `ssim_updater_${stamp}.vbs`);
  const script = buildSwapScript({
    tmp: newExe,
    target: shellExe,
    backendPid: process.pid,
    shellPid: process.ppid,
    vbsPath: vbs,
  });
  fsExtra.writeFileSync(bat, script);
  // Hidden + detached launcher: window style 0 = invisible, False = don't wait.
  fsExtra.writeFileSync(vbs, `CreateObject("WScript.Shell").Run "cmd /c ""${bat}""", 0, False\r\n`);
  spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  // Tell the shell this is an UPDATE, not a crash → it quits cleanly (no crash screen) so SSIM.exe frees up.
  try { if (IS_SIDECAR_MODE) process.stdout.write('SSIM_UPDATING\n'); } catch { /* stdout may be closed */ }
  logger.info('update staged (single-exe) – swap script launched, exiting for replacement');
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
  // BEFORE our server starts, so without this the launch window would just look frozen.
  try { if (IS_SIDECAR_MODE) process.stdout.write('SSIM_UPDATE_DOWNLOADING\n'); } catch { /* stdout may be closed */ }

  let file: string;
  try {
    file = await download(info);
  } catch (err) {
    return { updated: false, reason: `download failed: ${(err as Error).message}` };
  }
  if (!verify(file, info)) {
    fsExtra.removeSync(file);
    return { updated: false, reason: 'verification failed' };
  }
  if (!selfTestNewExe(file)) {
    fsExtra.removeSync(file);
    return { updated: false, reason: 'new exe failed its self-test – kept the current version' };
  }
  return swapAndRelaunch(file); // does not return on success (process exits)
}

export const Updater = { check, runUpdate };
