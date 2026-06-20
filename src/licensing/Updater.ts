import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { spawn } from 'child_process';
import fsExtra from 'fs-extra';
import axios from 'axios';
import { logger } from '../utils/logger';
import { LICENSE_API_URL, LICENSE_PUBLIC_KEY, LICENSE_HTTP_TIMEOUT_MS } from './config';
import { IS_SIDECAR_MODE } from '../utils/paths';

// ════════════════════════════════════════════════════════════════════════════
//  Updater – signed, self-replacing auto-update flow (Windows .exe)
//
//  Flow:  version check → download to %TEMP% → verify sha256 + Ed25519 sig
//         → write updater.bat → spawn detached → exit → bat replaces exe + relaunch
//
//  A running .exe cannot overwrite itself on Windows, so the actual file swap is
//  delegated to a tiny detached batch script that waits for our PID to die.
//  The signature check is what makes auto-update safe: a hijacked update URL
//  cannot ship a payload we will execute, because it can't sign it.
// ════════════════════════════════════════════════════════════════════════════

interface VersionInfo {
  latest: string;   // semver
  url:    string;   // download URL of the new exe
  sha256: string;   // hex digest of the new exe
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

/** 2. Stream the new exe to a temp file. */
async function download(info: VersionInfo): Promise<string> {
  const tmp = path.join(os.tmpdir(), `ssim_update_${Date.now()}.exe`);
  const res = await http.get(info.url, { responseType: 'stream' });
  if (res.status !== 200) {
    // Drain the already-open response stream so its socket isn't leaked, then fail.
    try { res.data.destroy(); } catch { /* noop */ }
    throw new Error(`download HTTP ${res.status}`);
  }
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    res.data.pipe(out);
    out.on('finish', resolve);
    const cleanup = (err: Error): void => {
      // On any stream/write error: tear down BOTH streams and remove the partial
      // temp file so a failed update leaks neither sockets nor multi-MB .exe scraps.
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
 * 4. Write the swap script and launch it so it can replace us after we exit.
 *
 *  CRITICAL (Windows): a plain `spawn('cmd', …, {detached:true}).unref()` is NOT
 *  enough – the child shares our console and gets torn down the instant we
 *  process.exit() moments later, so the swap never runs (the bat dies in its
 *  wait loop). We therefore launch the bat through a tiny HIDDEN VBScript
 *  (WScript.Shell.Run, window-style 0, wait=false): WScript starts the bat in
 *  its own process, invisible, fully decoupled from us, surviving our exit.
 *
 *  The bat: waits for our PID to die → retries `move` for up to 15s (Windows can
 *  hold the old exe's file handle briefly after exit) → relaunches → self-cleans.
 */
function swapAndRelaunch(newExe: string): void {
  const target = process.execPath; // the running backend exe (ssim-backend.exe under the Tauri shell)
  const stamp = Date.now();
  const bat = path.join(os.tmpdir(), `ssim_updater_${stamp}.bat`);
  const vbs = path.join(os.tmpdir(), `ssim_updater_${stamp}.vbs`);

  // Two-artifact (Tauri) model: the backend is a SIDECAR of SSIM.exe. We swap ssim-backend.exe, but
  // must wait for BOTH the sidecar AND its parent shell to exit (the shell follows the sidecar out
  // via its Terminated handler) before relaunching the SHELL — which respawns the freshly-swapped
  // sidecar (and the single-instance guard is safe because the old shell is already gone).
  // Standalone/headless: wait for our PID only and relaunch the swapped exe itself.
  const sidecar = IS_SIDECAR_MODE;
  const relaunch = sidecar ? path.join(path.dirname(target), 'SSIM.exe') : target;
  const waitFor = (pid: number, label: string): string =>
    `:${label}\r\ntasklist /FI "PID eq ${pid}" | find "${pid}" >nul && (timeout /t 1 >nul & goto ${label})\r\n`;

  const script =
    `@echo off\r\n` +
    waitFor(process.pid, 'wbk') +
    (sidecar ? waitFor(process.ppid, 'wsh') : '') +
    `set /a tries=0\r\n` +
    `:swap\r\n` +
    `move /Y "${newExe}" "${target}" >nul 2>&1 && goto done\r\n` +
    `set /a tries+=1\r\n` +
    `if %tries% LSS 15 (timeout /t 1 >nul & goto swap)\r\n` +
    `:done\r\n` +
    `start "" "${relaunch}"\r\n` +
    `del "${vbs}" >nul 2>&1\r\n` +
    `del "%~f0"\r\n`;
  fsExtra.writeFileSync(bat, script);
  // Hidden + detached launcher: window style 0 = invisible, False = don't wait.
  fsExtra.writeFileSync(vbs, `CreateObject("WScript.Shell").Run "cmd /c ""${bat}""", 0, False\r\n`);
  spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  logger.info('update staged – swap script launched, exiting for replacement');
  // Give WScript a moment to spin the bat up as an independent process before we
  // vanish (do NOT unref – we want this delay to actually elapse).
  setTimeout(() => process.exit(0), 800);
}

/** Full orchestration; safe to call on boot or from a manual trigger. */
export async function runUpdate(currentVersion: string): Promise<{ updated: boolean; reason: string }> {
  const info = await check(currentVersion);
  if (!info) return { updated: false, reason: 'up-to-date' };
  printUpdateBanner(currentVersion, info.latest);
  logger.info(`update available: ${currentVersion} → ${info.latest}`);
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
  swapAndRelaunch(file); // does not return (process exits)
  return { updated: true, reason: 'swapping' };
}

export const Updater = { check, runUpdate };
