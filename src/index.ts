import './bootflags'; // MUST be first – sets process flags before deps load
import fs from 'fs';
import http, { type Server } from 'http';
import { createApp, createDeps } from './api/server';
import { acquireInstanceLock, releaseInstanceLock } from './core/singleInstance';
import { listenAndAnnounce, clearStalePortFile } from './utils/serverPort';
import { logger, LOG_FILE } from './utils/logger';
import { writeCrash, writeExit, CRASH_FILE } from './utils/crashlog';
import { startMemHeartbeat, stopMemHeartbeat, HEARTBEAT_FILE } from './utils/memHeartbeat';
import { HwidService } from './licensing/HwidService';
import { LicenseClient } from './licensing/LicenseClient';
import { Updater } from './licensing/Updater';
import { runActivationPortal } from './licensing/ActivationServer';
import { printLockScreen } from './licensing/lockscreen';
import { IS_PACKAGED, IS_SIDECAR_MODE, publicDir, migrateVaultDir } from './utils/paths';
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

// ── Single-instance lock (extracted to core/singleInstance.ts for testability) ──
// See that module: an ATOMIC (fs.open 'wx'), FAIL-SAFE guard that makes a double-run —
// and the vault/accounts/token store races it causes — structurally impossible (INV-G5).

// Port selection + announcement moved to utils/serverPort.ts (listenAndAnnounce): the port is
// now chosen by the ACTUAL server bind (walking EADDRINUSE) and announced only after a successful
// bind, so SSIM never emits SSIM_PORT for a port it didn't bind. (BUG 2.)

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
async function startFullApp(): Promise<void> {
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    logger.warn(
      `SECURITY: SSIM is binding to ${HOST} – the API (credentials, trading, ` +
      `confirmations) becomes reachable from the network WITHOUT authentication. ` +
      `Only do this on a fully trusted, firewalled host.`,
    );
  }
  deps = createDeps();
  // Fresh app state → clear any money-ops quarantine that latched in a PRIOR lifecycle.
  // On first boot this is a no-op; on an in-process re-license (teardownFullApp →
  // startFullApp) the suspect session map that tripped the breaker is now discarded and
  // rebuilt, so the breaker must not survive into the clean rebuild. (INV-G6 / G-5.)
  ProcessHealth.reset();
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
  // BIND FIRST, then announce: listenAndAnnounce binds the REAL server (walking EADDRINUSE to the
  // next free port) and emits SSIM_PORT / writes data/ssim.port ONLY from the successful bind, with
  // the ACTUAL bound port — so SSIM can never announce a port it didn't bind and the shell can never
  // adopt a foreign app on the desired port. (BUG 2.)
  const srv = http.createServer(app);
  server = srv;
  try {
    activePort = await listenAndAnnounce(srv, HOST, activePort);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    writeCrash('SERVER LISTEN ERROR', e); // 250ms exit can outrun winston's async file write
    if (e.code === 'EADDRINUSE') {
      printLockScreen(`Port ${activePort} is already in use.`, 'Is SSIM already running? Close the other instance, or set PORT=<free>.');
      logger.error(`server cannot bind ${HOST}:${activePort} – EADDRINUSE (walk exhausted)`);
    } else {
      printLockScreen('The server failed to start.', e.message);
      logger.error(`server listen error: ${e.message}`);
    }
    setTimeout(() => process.exit(1), 250);
    return;
  }
  if (!IS_SIDECAR_MODE) printBanner();
  logger.info(`SSIM server started on ${HOST}:${activePort} (pid ${process.pid})`);
  openUiWindow(`http://localhost:${activePort}`);
  // Runtime errors AFTER a successful bind (not a bind failure) — log, don't treat as EADDRINUSE.
  srv.on('error', (err: NodeJS.ErrnoException) => {
    writeCrash('SERVER RUNTIME ERROR', err);
    logger.error(`server runtime error: ${err.message}`);
  });
}

/** Tears the running app down cleanly and frees the port (for re-activation). */
async function teardownFullApp(): Promise<void> {
  LicenseClient.stopHeartbeat();
  stopMemHeartbeat();
  if (deps) {
    deps.csfloatWorker.stop();
    deps.trades.shutdown();
    deps.exchange.stop();
    deps.pricing.shutdown();
    deps.inventory.store.flush();
    deps.inventory.tf2Store.flush();
    deps.inventory.gcStore.flush();
    deps.history.flush();
    AccountVault.flush();
    deps.sessions.shutdown(); // stop the idle-session reaper (B40) before discarding the manager
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
  await startFullApp();
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
  // Remove a stale data/ssim.port from a prior run so it can never point the shell at a foreign
  // port before this process binds + announces the real one. (BUG 2.)
  clearStalePortFile();
  // Sidecar mode: accept the shell's graceful-quit signal. The port is NOT announced here anymore —
  // it is announced ONLY when a real server (activation portal / unlock portal / full app) actually
  // binds it, from inside listenAndAnnounce, with the actual bound port. (BUG 2.)
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
  // Feed the money-ops breaker too: an async rejection burst signals the same possibly-corrupt
  // in-memory state as an uncaught throw, and much of the money path is async (a rejected
  // promise, not a sync throw). Without this the breaker was blind to that whole class.
  ProcessHealth.recordUncaught(reason instanceof Error ? reason.message : String(reason));
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
  clearStalePortFile(); // don't leave data/ssim.port pointing at a now-dead port (BUG 2)
  LicenseClient.stopHeartbeat();
  stopMemHeartbeat();
  if (deps) {
    deps.csfloatWorker.stop();
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
process.on('exit', (code) => {
  // FIRST: drop the internal-exit breadcrumb (logs/exit-trace.log). Its presence proves the
  // process exited itself (and `code` names which path); its ABSENCE after a death proves an
  // uncatchable external TerminateProcess/SIGKILL. This is the discriminator the silent-death
  // investigation has been missing — synchronous, so it survives an immediate exit.
  try { writeExit(code); } catch { /* best-effort */ }
  try { releaseInstanceLock(); } catch { /* best-effort */ }
  try { clearStalePortFile(); } catch { /* best-effort */ } // never leave a stale ssim.port (BUG 2)
});

// ── Build-time packaged-VFS self-test ─────────────────────────────────────────
// build/pack.js launches the freshly-packaged exe with SSIM_SELFTEST=1 right
// after icon/metadata injection. Reaching this line at all proves pkg could read
// its appended payload (a shifted/corrupt payload dies earlier with
// "Pkg: Error reading from file."); we additionally confirm the BUNDLED frontend
// is present + non-empty, then exit WITHOUT booting (no license check, no port
// bind, no browser). Inert in every normal run (guarded by the env var).
if (process.env.SSIM_SELFTEST === '1') {
  const fails: string[] = [];
  let frontend = '';

  // 1) Bundled frontend present + readable (same pkg-VFS read path express.static uses).
  try {
    const bytes = fs.readFileSync(publicDir('index.html')).length;
    if (bytes > 0) frontend = `public/index.html=${bytes}B`; else fails.push('public/index.html=0B');
  } catch (e) { fails.push(`public/index.html:${(e as Error).message}`); }

  // 2) Runtime-critical heavy deps must actually require() IN-PACKAGE. These are LITERAL requires
  //    so pkg traces + bundles them from the entry too (belt-and-braces). globaloffensive is the
  //    headline risk — it is only LAZILY required at runtime (GcActionLayer), so a passing boot
  //    self-test would NOT otherwise prove the GC stack bundled. A throw here = a missing module
  //    or asset → the build fails LOUDLY (build/pack.js requires SSIM_SELFTEST_OK), never a silent
  //    false success. eslint-disable for the deliberate require() probes.
  /* eslint-disable @typescript-eslint/no-var-requires, global-require */
  const probe = (name: string, fn: () => unknown): void => {
    try { if (!fn()) fails.push(`${name}=empty`); } catch (e) { fails.push(`${name}:${(e as Error).message}`); }
  };
  probe('globaloffensive',           () => require('globaloffensive'));
  probe('steam-user',                () => require('steam-user'));
  probe('steamcommunity',            () => require('steamcommunity'));
  probe('steam-tradeoffer-manager',  () => require('steam-tradeoffer-manager'));
  probe('@doctormckay/stdlib',       () => require('@doctormckay/stdlib'));
  probe('protobufjs',                () => require('protobufjs'));
  probe('bytebuffer',                () => require('bytebuffer'));
  probe('long',                      () => require('long'));
  probe('steamid',                   () => require('steamid'));
  probe('steam-totp',                () => require('steam-totp'));

  // 3) globaloffensive must expose its REAL API (craft + caskets) — this only resolves if its
  //    precompiled protobufs (protobufs/generated/*.js → protobufjs) also bundled + loaded.
  probe('globaloffensive.api', () => {
    const GO = require('globaloffensive');
    return ['craft', 'addToCasket', 'removeFromCasket', 'getCasketContents']
      .every((m) => typeof GO.prototype[m] === 'function');
  });
  /* eslint-enable @typescript-eslint/no-var-requires, global-require */

  const ok = fails.length === 0;
  // The GUI-subsystem build has no console, so guard the write — the exit CODE (0 ok / 2 fail) is
  // the reliable signal build/pack.js checks. Report which deps passed + any that FAILED.
  try {
    // eslint-disable-next-line no-console
    console.log(`SSIM_SELFTEST_${ok ? 'OK' : 'FAIL'} v${pkg.version} ${frontend} deps=${ok ? 'all-loaded(GC+steam stack)' : 'FAILED[' + fails.join(' | ') + ']'}`);
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
