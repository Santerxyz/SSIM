import './bootflags'; // MUST be first – sets process flags before deps load
import fs from 'fs';
import http, { type Server } from 'http';
import { createApp, createDeps } from './api/server';
import { acquireInstanceLock, releaseInstanceLock, lockRefusalDetail } from './core/singleInstance';
import { listenAndAnnounce, clearStalePortFile, clearOwnPortFile } from './utils/serverPort';
import { logger, LOG_FILE } from './utils/logger';
import { writeCrash, writeExit, CRASH_FILE } from './utils/crashlog';
import { startMemHeartbeat, stopMemHeartbeat, HEARTBEAT_FILE } from './utils/memHeartbeat';
import { HwidService, HwidUnavailableError } from './licensing/HwidService';
import { LicenseClient } from './licensing/LicenseClient';
import { Updater } from './licensing/Updater';
import { consumeCrashMarker } from './utils/crashMarker';
import { setLastExitClass, setPriorCrash } from './licensing/updateStatus';
import { startUpdateScheduler, stopUpdateScheduler } from './licensing/updateScheduler';
import { runActivationPortal } from './licensing/ActivationServer';
import { printLockScreen } from './licensing/lockscreen';
import { IS_PACKAGED, IS_SIDECAR_MODE, publicDir, migrateVaultDir } from './utils/paths';
import { openUiWindow } from './appWindow';
import { runUnlockPortal } from './core/unlockPortal';
import { ProcessHealth } from './core/ProcessHealth';
import { AccountVault } from './core/AccountVault';
import { unlockVault, migrateAccountsIntoVault } from './core/vaultBoot';
import { installSteamTotpTimeout, primeSteamTotpOffset } from './trading/steamTotpTimeout';
import { quiesceMoneyOps } from './utils/quiesce';
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

// S14 / H-XCT-005: the SINGLE source of truth for "an interruptible real-item op is in
// flight". The update SWAP defers on this (isBusy below), and so do the graceful-shutdown
// and re-license teardown paths (quiesceMoneyOps), so a buy/sell/trade/craft/move is never
// severed mid-commit by an exit. A mass-sell, trade-up craft or casket move hard-exited mid-
// flight loses unconfirmed listings / an irreversible craft's outcome / an in-flight move.
const isBusy = (): boolean => !!deps && (
  deps.trades.busy() || deps.buy.busy() || deps.inventory.busy() ||
  deps.market.busy() || deps.tradeup.busy() || deps.casket.busy()
);
// Bounded drain budget shared by shutdown() and teardownFullApp(); the hard-exit fallback
// and the shell close watchdog (lib.rs) both strictly exceed this so the drain has room.
const QUIESCE_TIMEOUT_MS = 6000;
// H-BOOT-001: brief pause before the single re-license re-bind retry, giving the OS / an AV hold
// time to release the previously-bound port before we dead-end.
const RELICENSE_REBIND_RETRY_MS = 750;
// H-LIC-016: back-off between retries when the hardware fingerprint is momentarily degraded (a
// transient machineId read / MAC churn on first boot). We NEVER bind a seat to a degraded id — that
// burns a second seat on the next healthy boot — so we wait for the factors to recover instead.
const HWID_RETRY_MS = 2000;

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
// H-BOOT-001: true once the UI port has been bound at least once. FIRST boot dead-ends on a
// bind failure (nothing to lose); a re-bind during a runtime re-license (onLicenseLost) instead
// throws BindFailedError so the caller can return to the portal rather than hard-kill the process.
let everBound = false;

/** A recoverable UI-port bind failure raised on a re-license re-bind (NOT first boot). Signals
 *  onLicenseLost to retry/return-to-portal instead of process.exit — a momentary EADDRINUSE in the
 *  sub-second teardown→rebind gap must not kill the operator's window. (H-BOOT-001.) */
class BindFailedError extends Error {
  constructor(public readonly code: string | undefined, message: string) {
    super(message);
    this.name = 'BindFailedError';
  }
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
    // S51: the shell pipes to our stdin; if the SHELL dies, that pipe hits EOF ('end'). The backend used
    // to keep running ORPHANED — holding every Steam session, the CSFloat worker, the UI port + the
    // single-instance lock — so the NEXT launch lock-screened with "already running" and nothing visible
    // to close. Treat EOF as a graceful-shutdown signal (clean logout, release the port + lock). NOT a
    // respawn — the process exits (owner directive: no auto-restart band-aids).
    process.stdin.on('end', () => { void shutdown('tauri shell exited (stdin EOF)'); });
  } catch { /* no stdin available → ignore */ }
}

/** Bind-failure handler shared by startFullApp. On a re-license re-bind (`!firstBoot`) it THROWS
 *  BindFailedError so onLicenseLost can return to the portal / retry rather than hard-kill the
 *  process and every live Steam session. On FIRST boot it keeps the original dead-end behaviour
 *  BYTE-IDENTICAL (print the lockscreen + schedule exit in 250ms) and returns, so startFullApp's
 *  caller does not observe a throw on boot. (H-BOOT-001.) */
function handleListenError(e: NodeJS.ErrnoException, opts: { firstBoot: boolean }): void {
  writeCrash('SERVER LISTEN ERROR', e); // 250ms exit can outrun winston's async file write
  if (!opts.firstBoot) {
    // Recoverable: the previous server just released this port; a transient EADDRINUSE in the
    // teardown→rebind gap must not dead-end the re-license. Hand the classification to the caller.
    logger.warn(`re-license re-bind failed on ${HOST}:${activePort} (${e.code ?? e.message}) – returning to caller`);
    throw new BindFailedError(e.code, e.message);
  }
  if (e.code === 'EADDRINUSE') {
    printLockScreen(`Port ${activePort} is already in use.`, 'Is SSIM already running? Close the other instance, or set PORT=<free>.');
    logger.error(`server cannot bind ${HOST}:${activePort} – EADDRINUSE (walk exhausted)`);
  } else {
    printLockScreen('The server failed to start.', e.message);
    logger.error(`server listen error: ${e.message}`);
  }
  setTimeout(() => process.exit(1), 250);
}

/** Builds the real app and starts listening. Called ONLY once licensed.
 *  `firstBoot` is false when re-invoked after a prior successful bind (a runtime re-license):
 *  a bind failure then THROWS BindFailedError instead of exiting, so the caller can recover.
 *  Returns true once the UI port is bound. On a FIRST-BOOT bind failure handleListenError
 *  schedules exit(1) and RETURNS (no throw), so this returns false — gateAndRun then stops
 *  before arming the heartbeat/update scheduler against a server that never listened. (H-BOOT-002.) */
async function startFullApp(opts: { firstBoot: boolean } = { firstBoot: true }): Promise<boolean> {
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
  // Proxy rules (v5): hydrate rule pools from the vault, then synthesize → prove-equivalence → cut
  // over (idempotent; re-runs every boot until proven). MUST come after the vault→org heal + env
  // proxy hydration (inside migrateAccountsIntoVault) and BEFORE any login can occur (createApp and
  // the refresh scheduler come later), so a blanked-but-not-yet-hydrated pool never logs an account
  // in over the host IP.
  deps.accounts.hydrateRuleProxies();
  deps.accounts.migrateProxyRules();
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
    // On first boot handleListenError schedules exit(1) and RETURNS (dead-end, as before) → we
    // return false without arming post-bind services. On a re-license re-bind it THROWS
    // BindFailedError (recoverable) → propagates to onLicenseLost, which retries / returns to the
    // portal. (H-BOOT-001 / H-BOOT-002.)
    handleListenError(err as NodeJS.ErrnoException, { firstBoot: opts.firstBoot });
    return false;
  }
  everBound = true; // H-BOOT-001: a re-bind after this point can recover instead of hard-exiting
  if (!IS_SIDECAR_MODE) printBanner();
  logger.info(`SSIM server started on ${HOST}:${activePort} (pid ${process.pid})`);
  // Build-identity marker (grep this to know EXACTLY which build is running — the fleet has had
  // several exes swapped in/out during the crash hunt). Names the version, the Node runtime the
  // backend is packaged on (the 0xC0000409 hunt turns on Node 24 vs 22), and confirms the proxy-tank
  // resilience layer is present in THIS binary (its absence = a pre-tank build).
  logger.info(`SSIM BUILD v${pkg.version} · Node ${process.version} · resilience=proxy-tank(breaker+failfast+tcp+sticky-release)`);
  openUiWindow(`http://localhost:${activePort}`);
  // Runtime errors AFTER a successful bind (not a bind failure) — log, don't treat as EADDRINUSE.
  srv.on('error', (err: NodeJS.ErrnoException) => {
    writeCrash('SERVER RUNTIME ERROR', err);
    logger.error(`server runtime error: ${err.message}`);
  });
  return true; // bound — gateAndRun may now arm the heartbeat + update scheduler. (H-BOOT-002.)
}

/** Tears the running app down cleanly and frees the port (for re-activation). */
async function teardownFullApp(): Promise<void> {
  // H-XCT-005: let an in-flight buy/sell/trade/craft/move settle (bounded) BEFORE severing
  // sessions, so a re-license does not tear a money op's web session out mid-commit.
  const drained = await quiesceMoneyOps(isBusy, { timeoutMs: QUIESCE_TIMEOUT_MS });
  logger.info(`re-license teardown: money-op drain ${drained}`);
  LicenseClient.stopHeartbeat();
  stopUpdateScheduler();
  stopMemHeartbeat();
  if (deps) {
    deps.csfloatWorker.stop();
    deps.paysafe.shutdown();   // W4_40: stop the credit-poll timer + drop run state before the server is discarded
    deps.trades.shutdown();
    deps.exchange.stop();
    deps.pricing.shutdown();
    deps.csfloat.stop(); // deterministically retire the cached CSFloat agents (else stranded until GC)
    deps.inventory.store.flush();
    deps.inventory.tf2Store.flush();
    deps.inventory.gcStore.flush();
    deps.history.shutdown();
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
  // A runtime re-gate (onLicenseLost) reaches here with the vault still unlocked — the sidecar env
  // var is long gone by then, so skip the unlock step entirely rather than route to the portal.
  if (!AccountVault.isEnabled()) {
    if (IS_SIDECAR_MODE && !process.env.SSIM_VAULT_PASSWORD) {
      await runUnlockPortal(activePort, HOST);
    } else {
      await unlockVault();
    }
  }
  // H-BOOT-001: firstBoot is false once the port has been bound before (a runtime re-license
  // re-bind) → a transient EADDRINUSE throws BindFailedError for onLicenseLost to recover from,
  // instead of hard-killing the process.
  // H-BOOT-002: a first-boot bind failure returns false (exit already scheduled) — stop here so the
  // heartbeat + update scheduler are NEVER armed against a server that never listened.
  if (!(await startFullApp({ firstBoot: !everBound }))) return;
  LicenseClient.startHeartbeat(licenseHwid);
  // Periodic (6h) update-availability check + the manual "check/install now" path (C5). CHECK-ONLY on
  // the timer; the only mid-session SWAP is a user-confirmed install, and only while no money op / refresh
  // is in flight (isBusy). Boot-time auto-update above is unchanged.
  startUpdateScheduler({
    currentVersion: pkg.version,
    // S14: gate the mid-session swap on EVERY interruptible real-item op (shared isBusy).
    isBusy,
  });
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
    try {
      await gateAndRun();
    } catch (err) {
      if (!(err instanceof BindFailedError)) throw err;
      // H-BOOT-001: the re-bind hit a transient port hold in the sub-second teardown→rebind gap
      // (OS not yet releasing the listen socket, an AV/EDR briefly holding it). Do NOT dead-end —
      // that would kill the operator's window on a recoverable re-license. Wait a beat and retry
      // the bind ONCE (classified failure, not a blind loop — owner no-band-aid rule). If the port
      // is still held after that, it is a genuine conflict → fall through to the terminal lockscreen.
      // First tear down the PARTIAL construction the failed startFullApp left armed (createDeps()
      // already started the exchange + CSFloat workers and built the session manager before the
      // bind threw) so the retry does not orphan those workers/sockets. teardownFullApp is idempotent.
      await teardownFullApp();
      logger.warn(`re-license re-bind failed (${err.code ?? err.message}) – retrying once in ${RELICENSE_REBIND_RETRY_MS}ms`);
      await new Promise<void>((r) => setTimeout(r, RELICENSE_REBIND_RETRY_MS));
      try {
        await gateAndRun();
      } catch (err2) {
        if (!(err2 instanceof BindFailedError)) throw err2;
        printLockScreen('The UI port is still in use.', 'SSIM could not rebind after re-licensing. Free the port (or close the app holding it) and relaunch.');
        logger.error(`re-license re-bind still failing after retry (${err2.code ?? err2.message}) – dead-ending`);
        setTimeout(() => process.exit(1), 250);
      }
    }
  } finally {
    relicensing = false;
  }
}

// ── License gatekeeper ────────────────────────────────────────────────────────
// HARD BLOCKER: nothing that touches Steam, credentials or items is constructed
// until the local HWID + license key validate against the remote backend.
// If unlicensed (or revoked at runtime), we don't dead-end – we run a friendly
// web portal so the user can paste a key. Once valid, the real app takes over.
/**
 * H-LIC-016: resolve the licensing HWID, WAITING OUT a transient factor failure rather than binding a
 * seat to a degraded fingerprint. getHwid() throws HwidUnavailableError on the pre-pin path when a live
 * factor read failed (machineId/MAC sentinel); that id would be recomputed on the next healthy boot →
 * HWID mismatch → re-activate → a SECOND seat consumed. So we retry on a short back-off until the
 * fingerprint is healthy enough to also be pinned — never proceeding into the license gate with a
 * degraded id, never exiting, never pinning. A pinned or healthy id returns on the first attempt.
 */
async function resolveHwid(): Promise<string> {
  for (;;) {
    try {
      return HwidService.getHwid();
    } catch (err) {
      if (!(err instanceof HwidUnavailableError)) throw err;
      // Honest signal: this is a TRANSIENT hardware-read wait, NOT a license failure — do not render the
      // "LICENSE DENIED" lockscreen (that would mislabel a self-healing condition). The warning below is
      // the operational trace; the loop recovers automatically the moment the factors read cleanly.
      logger.warn(`hardware fingerprint unavailable (${err.message}) – waiting ${HWID_RETRY_MS}ms then retrying (a seat is never bound to a degraded id)`);
      await new Promise<void>((r) => setTimeout(r, HWID_RETRY_MS));
    }
  }
}

async function bootstrap(): Promise<void> {
  // S6: bound steam-totp's getTimeOffset (no vendor timeout) + cache the offset, so a stalled QueryTime
  // can never wedge every confirmation/money path until restart. Process-wide, before any money op.
  installSteamTotpTimeout();
  // Learn the Steam time offset now (fire-and-forget, bounded by the S6 timer) so the login path
  // usually has it before the first credential login — codes survive a skewed local clock.
  primeSteamTotpOffset();
  // Single-instance guard: a 2nd SSIM would fight over the port + Steam sessions.
  if (!acquireInstanceLock()) {
    // Leave a trace: a second instance bailing on the lock otherwise exits with NO
    // crash-log entry, which reads as a "silent crash" when an operator relaunches
    // over a still-running copy. Recording it here lets the heartbeat/crash logs tell
    // the two apart (lock-abort = operational, not a real crash — Phenomenon A).
    // H-BOOT-008: a permanent filesystem/permission fault (data/ read-only or access-denied)
    // must NOT be reported as "another instance is running" — that sends the operator hunting a
    // phantom copy. lockRefusalDetail() is set only on that io fault; undefined = genuinely held.
    const lockIoDetail = lockRefusalDetail();
    if (lockIoDetail) {
      writeCrash('SINGLE-INSTANCE LOCK ABORT (lock file could not be created – filesystem/permission fault)', new Error('lock io'));
      printLockScreen('SSIM could not start.', lockIoDetail);
      logger.error(`single-instance lock could not be created – aborting start: ${lockIoDetail}`);
    } else {
      writeCrash('SINGLE-INSTANCE LOCK ABORT (another SSIM is already running – not a crash)', new Error('lock held'));
      printLockScreen('SSIM is already running!', 'Another SSIM instance is already running – close it first.');
      logger.error('another SSIM instance is already running (lockfile) – aborting second start');
    }
    setTimeout(() => process.exit(1), 250);
    return;
  }
  // One-time: move vault.enc + accounts.json into the portable Vault/ folder BEFORE anything
  // reads them (else an existing vault would be ignored and a fresh one created). Runs UNDER the
  // single-instance lock just acquired, so a refused 2nd instance never mutates the vault files
  // (H-BOOT-022): the credential-file rename is the one disk mutation the lock must cover.
  migrateVaultDir();
  // Remove a stale data/ssim.port from a prior run so it can never point the shell at a foreign
  // port before this process binds + announces the real one. (BUG 2.)
  clearStalePortFile();
  // Sidecar mode: accept the shell's graceful-quit signal. The port is NOT announced here anymore —
  // it is announced ONLY when a real server (activation portal / unlock portal / full app) actually
  // binds it, from inside listenAndAnnounce, with the actual bound port. (BUG 2.)
  if (IS_SIDECAR_MODE) listenForShellQuit();
  // Surface the PRIOR run's crash exactly once if the shell recorded one (B1): classify it for the
  // heartbeat telemetry (C4 lastExitClass) and hold it for the dashboard "crashed last run" banner.
  // Consumed here → fires once. VISIBILITY ONLY — nothing is respawned (owner directive).
  const priorCrash = consumeCrashMarker();
  if (priorCrash) {
    setLastExitClass(`backend-crash(code=${priorCrash.code ?? '?'}${priorCrash.signal ? `,sig=${priorCrash.signal}` : ''})`);
    setPriorCrash({ at: priorCrash.at, code: priorCrash.code, signal: priorCrash.signal });
    logger.warn(`SSIM crashed on the previous run at ${new Date(priorCrash.at).toISOString()} (code=${priorCrash.code ?? '?'}) – surfacing a banner; see logs/shell.log`);
  }
  // H-LIC-016: wait out a transient factor failure before we ever transact — a degraded, un-pinnable id
  // must not be bound to a seat (it would burn a second seat on the next healthy boot).
  licenseHwid = await resolveHwid();
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
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // idempotent — SIGINT/SIGTERM/stdin-quit/stdin-EOF (S51) can co-fire
  shuttingDown = true; // set BEFORE the first await so co-firing signals can't double-enter
  logger.info(`${signal} received – shutting down…`);
  releaseInstanceLock();
  clearOwnPortFile(); // S52: only remove OUR announced port file (never a refused-instance false-delete)
  // H-XCT-005: let an in-flight buy/sell/trade/craft/move settle (bounded) BEFORE logoutAll severs
  // its web session — the ambiguous-commit interruption S14 fixed for the update swap, on the exit path.
  const drained = await quiesceMoneyOps(isBusy, { timeoutMs: QUIESCE_TIMEOUT_MS });
  logger.info(`shutdown: money-op drain ${drained}`);
  LicenseClient.stopHeartbeat();
  stopUpdateScheduler();
  stopMemHeartbeat();
  if (deps) {
    deps.csfloatWorker.stop();
    deps.paysafe.shutdown();   // W4_40: stop the credit-poll timer + drop run state before the server is discarded
    deps.trades.shutdown();
    deps.exchange.stop();
    deps.pricing.shutdown();
    deps.csfloat.stop(); // deterministically retire the cached CSFloat agents (else stranded until GC)
    deps.inventory.store.flush();
    deps.inventory.tf2Store.flush();
    deps.inventory.gcStore.flush();
    deps.history.shutdown();
    AccountVault.flush();
    deps.sessions.shutdown(); // stop the idle-session reaper (B40) before discarding the manager
    await deps.sessions.logoutAll().catch(() => undefined);
  }
  if (server) server.close(() => process.exit(0));
  // Hard-exit fallback if connections linger — must strictly exceed the quiesce budget so the
  // bounded money-op drain above always has room to complete before this fires. (H-XCT-005)
  setTimeout(() => process.exit(0), QUIESCE_TIMEOUT_MS + 3000).unref();
}

process.on('SIGINT',  () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// ── External-termination breadcrumbs ──────────────────────────────────────────
// The packaged app is GUI-subsystem (no console), so the old console-close → SIGHUP →
// hard-kill crash CANNOT occur there. These handlers remain a safety net for the
// dev/headless console build and for logoff/shutdown: record a breadcrumb naming the
// EXTERNAL cause, then route through the SAME bounded graceful path as SIGINT/SIGTERM
// (H-XCT-006). `shutdown()` is idempotent, flushes the stores + vault, logs out sessions,
// and has its own 3s hard-exit fallback — so a console-close mid-fleet-op no longer
// severs sessions or discards a debounced inventory/history/vault write. (releaseInstanceLock
// runs inside shutdown(); no separate exit(130) — the breadcrumb still records the cause.)
for (const sig of ['SIGHUP', 'SIGBREAK'] as const) {
  process.on(sig, () => {
    writeCrash(`${sig} (console closed / parent terminated – EXTERNAL, not a crash)`, new Error(sig));
    void shutdown(sig);
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
  // S52: clear ONLY our own announced port file — a refused second instance (which never announced) must
  // not delete the LIVE instance's data/ssim.port on its way out.
  try { clearOwnPortFile(); } catch { /* best-effort */ }
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
