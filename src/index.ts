import './bootflags'; // MUST be first – sets process flags before deps load
import fs from 'fs';
import net from 'net';
import type { Server } from 'http';
import { createApp, createDeps } from './api/server';
import { logger, LOG_FILE } from './utils/logger';
import { writeCrash, CRASH_FILE } from './utils/crashlog';
import { startMemHeartbeat, stopMemHeartbeat, HEARTBEAT_FILE } from './utils/memHeartbeat';
import { HwidService } from './licensing/HwidService';
import { LicenseClient } from './licensing/LicenseClient';
import { Updater } from './licensing/Updater';
import { runActivationPortal } from './licensing/ActivationServer';
import { printLockScreen } from './licensing/lockscreen';
import { IS_PACKAGED, IS_SIDECAR_MODE, dataDir, publicDir, migrateVaultDir } from './utils/paths';
import { openUiWindow } from './appWindow';
import { runUnlockPortal } from './core/unlockPortal';
import { ProcessHealth } from './core/ProcessHealth';
import { AccountVault } from './core/AccountVault';
import { unlockVault, migrateAccountsIntoVault } from './core/vaultBoot';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json') as { version: string };

const PORT = Number(process.env.PORT ?? 3000);
// SECURITY: bind to localhost only by default. This tool holds credentials and
// can move real items – it must never be reachable from the LAN unless the
// operator explicitly opts in via HOST=0.0.0.0.
const HOST = process.env.HOST ?? '127.0.0.1';

// deps/server are created ONLY after the license gate passes (see bootstrap()).
let deps: ReturnType<typeof createDeps> | undefined;
let server: Server | undefined;
let activePort = PORT; // the actually-bound port (PORT, or the next free one)

// ── Single-instance lock ──────────────────────────────────────────────────────
const LOCK_FILE = dataDir('ssim.lock');

/** True if a process with this PID is currently running. */
function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } // exists, no perm
}
/** Single-instance guard: false when ANOTHER live SSIM already holds the lock. */
function acquireInstanceLock(): boolean {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (Number.isFinite(pid) && pid !== process.pid && isProcessAlive(pid)) return false;
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid)); // claim (overwrites a stale lock)
    return true;
  } catch { return true; } // never block boot on a lockfile IO error
}
function releaseInstanceLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE) && parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch { /* best-effort */ }
}
/** First free TCP port at/after `start` – handles a NON-SSIM app holding the port. */
function findFreePort(start: number, host: string, tries = 20): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = start;
    const tryPort = (): void => {
      const tester = net.createServer();
      tester.once('error', (err: NodeJS.ErrnoException) => {
        tester.close();
        if (err.code === 'EADDRINUSE' && port < start + tries) { port++; tryPort(); }
        else reject(err);
      });
      tester.once('listening', () => tester.close(() => resolve(port)));
      tester.listen(port, host);
    };
    tryPort();
  });
}

/** Prints a compact "server monitor" banner to the console on boot. */
function printBanner(): void {
  const V = '\x1b[35m', B = '\x1b[1m', R = '\x1b[0m', D = '\x1b[2m';
  const line = '─'.repeat(48);
  // eslint-disable-next-line no-console
  console.log(
    `\n  ${V}${B}◆ SSIM${R}${D}  ·  Santer Steam Inventory Manager${R}\n` +
    `  ${D}${line}${R}\n` +
    `   URL    ${B}http://localhost:${activePort}${R}\n` +
    `   Logs   ${D}${LOG_FILE}${R}\n` +
    `   Crash  ${D}${CRASH_FILE}${R}\n` +
    `   Mem    ${D}${HEARTBEAT_FILE}${R}\n` +
    `   PID    ${D}${process.pid}${R}\n` +
    `  ${D}${line}${R}\n`,
  );
}

let licenseHwid = '';
let relicensing = false; // guard against concurrent re-activation triggers

/** Sidecar mode: announce the UI port to the Tauri shell. The stdout line is the primary
 *  channel (the shell reads our stdout live); data/ssim.port is a fallback it can poll. */
function publishPort(port: number): void {
  if (!IS_SIDECAR_MODE) return;
  try { fs.writeFileSync(dataDir('ssim.port'), String(port)); } catch { /* best-effort */ }
  try { process.stdout.write(`SSIM_PORT=${port}\n`); } catch { /* stdout may be closed */ }
}

/** Sidecar mode: the Tauri shell writes "quit" to our stdin when its window closes, so we
 *  shut down gracefully (clean Steam logout) instead of being force-killed. */
function listenForShellQuit(): void {
  try {
    process.stdin.resume();
    process.stdin.on('data', (buf) => {
      if (buf.toString().toLowerCase().includes('quit')) void shutdown('tauri shell closed');
    });
    process.stdin.on('error', () => { /* pipe closed → ignore */ });
  } catch { /* no stdin available → ignore */ }
}

/** Builds the real app and starts listening. Called ONLY once licensed. */
function startFullApp(): void {
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    logger.warn(
      `SECURITY: SSIM is binding to ${HOST} – the API (credentials, trading, ` +
      `confirmations) becomes reachable from the network WITHOUT authentication. ` +
      `Only do this on a fully trusted, firewalled host.`,
    );
  }
  deps = createDeps();
  // Non-destructive UPGRADE migration ONLY: absorb accounts ALREADY registered in accounts.json
  // (+ legacy refresh tokens) into the vault, then blank the plaintext secrets. This NEVER scans
  // the mafiles/ drop zone — loose maFiles are imported solely by the explicit "Import Bots" UI,
  // so starting the app with files sitting in mafiles/ no longer auto-imports anything.
  migrateAccountsIntoVault(deps.accounts);
  // Memory trajectory recorder: writes rss/heap/handles + live fleet counts to
  // logs/mem-heartbeat.log so a silent death is diagnosable from its last sample
  // (rising trend ⇒ leak; flat-then-stops ⇒ external kill). Unref'd + never throws.
  startMemHeartbeat(() => ({
    sessions: deps?.sessions.getAllSessions().length ?? 0,
    traders:  deps?.trades.traderCount ?? 0,
  }));
  const app = createApp(deps);
  server = app.listen(activePort, HOST, () => {
    if (!IS_SIDECAR_MODE) printBanner();
    logger.info(`SSIM server started on ${HOST}:${activePort} (pid ${process.pid})`);
    openUiWindow(`http://localhost:${activePort}`);
  });
  // A busy port (a second SSIM copy) would otherwise throw an unhandled 'error'
  // and crash the window. Surface a clear notice instead.
  server.on('error', (err: NodeJS.ErrnoException) => {
    writeCrash('SERVER LISTEN ERROR', err); // 250ms exit can outrun winston's async file write
    if (err.code === 'EADDRINUSE') {
      printLockScreen(`Port ${activePort} is already in use.`, 'Is SSIM already running? Close the other instance, or set PORT=<free>.');
      logger.error(`server cannot bind ${HOST}:${activePort} – EADDRINUSE`);
    } else {
      printLockScreen('The server failed to start.', err.message);
      logger.error(`server listen error: ${err.message}`);
    }
    setTimeout(() => process.exit(1), 250);
  });
}

/** Tears the running app down cleanly and frees the port (for re-activation). */
async function teardownFullApp(): Promise<void> {
  LicenseClient.stopHeartbeat();
  stopMemHeartbeat();
  if (deps) {
    deps.trades.shutdown();
    deps.exchange.stop();
    deps.pricing.shutdown();
    deps.inventory.store.flush();
    deps.inventory.tf2Store.flush();
    deps.inventory.gcStore.flush();
    deps.history.flush();
    AccountVault.flush();
    await deps.sessions.logoutAll().catch(() => undefined);
    deps = undefined;
  }
  if (server) {
    const s = server;
    server = undefined;
    await new Promise<void>((resolve) => {
      try { (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); } catch { /* noop */ }
      s.close(() => resolve());
    });
  }
}

/**
 * Boot-time auto-update gate. Asks the license backend for the latest published
 * version; if a newer SIGNED exe exists it is downloaded, verified (sha256 +
 * Ed25519) and staged via updater.bat — the process then exits to be replaced
 * by the new exe. Returns true when an update was staged (the caller must STOP
 * booting). Any failure fails OPEN: we log it and keep running the current
 * version rather than dead-ending the user.
 *
 * Guarded by IS_PACKAGED so `npm run dev` / `node dist` never swaps node.exe.
 */
async function maybeAutoUpdate(): Promise<boolean> {
  if (!IS_PACKAGED) return false;
  try {
    const res = await Updater.runUpdate(pkg.version);
    if (res.updated) return true; // updater.bat launched → process exits shortly
    if (res.reason !== 'up-to-date') {
      logger.warn(`auto-update not applied: ${res.reason} – continuing on v${pkg.version}`);
    }
  } catch (err) {
    logger.warn(`auto-update failed: ${(err as Error).message} – continuing on v${pkg.version}`);
  }
  return false;
}

/**
 * The gate: validate the license; if invalid, open the activation portal and
 * wait for a valid key. Then check for a newer version, and finally start the
 * full app + runtime heartbeat.
 */
async function gateAndRun(): Promise<void> {
  let result = await LicenseClient.validate(licenseHwid);
  if (!result.ok) {
    logger.warn(`not licensed (${result.reason}) – opening activation portal`);
    await runActivationPortal(licenseHwid, activePort, HOST, pkg.version);
    result = await LicenseClient.validate(licenseHwid); // uses freshly stored token
    if (!result.ok) {
      printLockScreen(result.reason, `HWID ${licenseHwid}`);
      logger.error(`license still invalid after activation: ${result.reason}`);
      process.exit(1);
    }
  }
  logger.info(`license gate passed (${result.reason}, tier=${result.payload?.tier ?? '?'})`);
  // Only licensed clients update. If a newer exe is staged the process exits
  // here to be swapped, so we must not fall through to startFullApp().
  if (await maybeAutoUpdate()) return;
  // Unlock (or create) the portable account vault BEFORE constructing anything that touches
  // credentials. Sidecar (Tauri) mode has no console, so it unlocks via the in-window web portal;
  // dev (CLI prompt) and headless (SSIM_VAULT_PASSWORD) keep using unlockVault().
  if (IS_SIDECAR_MODE && !process.env.SSIM_VAULT_PASSWORD) {
    await runUnlockPortal(activePort, HOST);
  } else {
    await unlockVault();
  }
  startFullApp();
  LicenseClient.startHeartbeat(licenseHwid);
}

/**
 * Runtime revocation/expiry → instead of a dead-end shutdown, gracefully stop
 * the app and return to the activation portal so a NEW key can be entered.
 * (If the backend merely re-activated/extended the SAME key, re-validation
 * succeeds automatically and the app comes straight back up.)
 */
async function onLicenseLost(reason: string): Promise<void> {
  if (relicensing) return;
  relicensing = true;
  logger.warn(`license lost at runtime: ${reason} – returning to activation portal`);
  try {
    await teardownFullApp();
    LicenseClient.clearToken(); // force a fresh online check / new key
    await gateAndRun();
  } finally {
    relicensing = false;
  }
}

// ── License gatekeeper ────────────────────────────────────────────────────────
// HARD BLOCKER: nothing that touches Steam, credentials or items is constructed
// until the local HWID + license key validate against the remote backend.
// If unlicensed (or revoked at runtime), we don't dead-end – we run a friendly
// web portal so the user can paste a key. Once valid, the real app takes over.
async function bootstrap(): Promise<void> {
  // One-time: move vault.enc + accounts.json into the portable Vault/ folder BEFORE anything
  // reads them (else an existing vault would be ignored and a fresh one created).
  migrateVaultDir();
  // Single-instance guard: a 2nd SSIM would fight over the port + Steam sessions.
  if (!acquireInstanceLock()) {
    // Leave a trace: a second instance bailing on the lock otherwise exits with NO
    // crash-log entry, which reads as a "silent crash" when an operator relaunches
    // over a still-running copy. Recording it here lets the heartbeat/crash logs tell
    // the two apart (lock-abort = operational, not a real crash — Phenomenon A).
    writeCrash('SINGLE-INSTANCE LOCK ABORT (another SSIM is already running – not a crash)', new Error('lock held'));
    printLockScreen('SSIM is already running!', 'Another SSIM instance is already running – close it first.');
    logger.error('another SSIM instance is already running (lockfile) – aborting second start');
    setTimeout(() => process.exit(1), 250);
    return;
  }
  // Dynamic port: if PORT is held by ANOTHER program, take the next free one
  // instead of crashing. (A second SSIM was already blocked above.)
  try {
    activePort = await findFreePort(PORT, HOST);
    if (activePort !== PORT) logger.warn(`port ${PORT} is busy – using free port ${activePort} instead`);
  } catch { activePort = PORT; /* fall back; startFullApp's error handler covers it */ }
  // Sidecar mode: announce the UI port to the Tauri shell + accept its graceful-quit signal.
  publishPort(activePort);
  if (IS_SIDECAR_MODE) listenForShellQuit();
  licenseHwid = HwidService.getHwid();
  logger.info(`license gate: validating seat for hwid ${licenseHwid.slice(0, 12)}…`);
  // Runtime revocation → re-activation flow instead of hard exit.
  LicenseClient.onRevocation((reason) => void onLicenseLost(reason));
  await gateAndRun();
}

// ── Live-operation safety net ─────────────────────────────────────────────────
// A stray throw inside a vendor callback (steamcommunity/request fire callbacks
// outside our try/catch reach) must not take down 100s of live bot sessions.
// Both cases are logged loudly to logs/error.log instead of crashing.
process.on('unhandledRejection', (reason) => {
  writeCrash('UNHANDLED REJECTION', reason); // sync sink first – survives an immediate exit
  logger.error(`UNHANDLED REJECTION: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});
process.on('uncaughtException', (err) => {
  writeCrash('UNCAUGHT EXCEPTION (server kept alive)', err); // sync sink first; winston is async
  logger.error(`UNCAUGHT EXCEPTION (server kept alive): ${err.stack ?? err.message}`);
  // A single stray throw is survivable; a BURST trips the money-ops circuit breaker so
  // new buys/sells/trades are refused until restart (corrupt in-memory state safety).
  ProcessHealth.recordUncaught(err.message);
});

// ── Graceful shutdown – release all Steam sessions cleanly ────────────────────
async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received – shutting down…`);
  releaseInstanceLock();
  LicenseClient.stopHeartbeat();
  stopMemHeartbeat();
  if (deps) {
    deps.trades.shutdown();
    deps.exchange.stop();
    deps.pricing.shutdown();
    deps.inventory.store.flush();
    deps.inventory.tf2Store.flush();
    deps.inventory.gcStore.flush();
    deps.history.flush();
    AccountVault.flush();
    await deps.sessions.logoutAll().catch(() => undefined);
  }
  if (server) server.close(() => process.exit(0));
  // Hard-exit fallback if connections linger
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT',  () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// ── External-termination breadcrumbs ──────────────────────────────────────────
// The packaged app is GUI-subsystem (no console), so the old console-close → SIGHUP →
// hard-kill crash CANNOT occur there. These handlers remain a harmless safety net for the
// dev/headless console build and for logoff/shutdown: record a breadcrumb and exit cleanly,
// so any external termination is traceable instead of a "silent vanish".
for (const sig of ['SIGHUP', 'SIGBREAK'] as const) {
  process.on(sig, () => {
    writeCrash(`${sig} (console closed / parent terminated – EXTERNAL, not a crash)`, new Error(sig));
    try { releaseInstanceLock(); } catch { /* best-effort */ }
    process.exit(130);
  });
}
// Belt-and-braces (#38): release the single-instance lock on ANY process exit so a
// leftover lockfile never blocks the next start. (SIGKILL can't be caught — the
// stale-PID liveness check in acquireInstanceLock() covers that case.)
process.on('exit', () => { try { releaseInstanceLock(); } catch { /* best-effort */ } });

// ── Build-time packaged-VFS self-test ─────────────────────────────────────────
// build/pack.js launches the freshly-packaged exe with SSIM_SELFTEST=1 right
// after icon/metadata injection. Reaching this line at all proves pkg could read
// its appended payload (a shifted/corrupt payload dies earlier with
// "Pkg: Error reading from file."); we additionally confirm the BUNDLED frontend
// is present + non-empty, then exit WITHOUT booting (no license check, no port
// bind, no browser). Inert in every normal run (guarded by the env var).
if (process.env.SSIM_SELFTEST === '1') {
  let ok = false;
  let detail = '';
  try {
    const indexHtml = publicDir('index.html');
    // readFileSync exercises the SAME pkg-VFS read path express.static relies on
    // (not just stat), so a pass here means the dashboard will actually serve.
    const bytes = fs.readFileSync(indexHtml).length;
    ok = bytes > 0;
    detail = `public/index.html=${bytes}B`;
  } catch (e) {
    detail = (e as Error).message;
  }
  // The GUI-subsystem build has no console, so guard the write — the exit CODE (0 ok / 2 fail)
  // is the reliable signal the build + verification check.
  try {
    // eslint-disable-next-line no-console
    console.log(`SSIM_SELFTEST_${ok ? 'OK' : 'FAIL'} v${pkg.version} ${detail}`);
  } catch { /* no console in GUI-subsystem mode */ }
  process.exit(ok ? 0 : 2);
}

// Ignite. A throw here means the gate itself broke → fail closed.
void bootstrap().catch((err) => {
  writeCrash('BOOTSTRAP FATAL', err); // sync sink before the immediate exit below
  printLockScreen('License check failed.', (err as Error).message);
  logger.error(`bootstrap crashed: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
