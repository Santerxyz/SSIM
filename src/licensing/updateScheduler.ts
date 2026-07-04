import { logger } from '../utils/logger';
import { IS_PACKAGED } from '../utils/paths';
import { ProcessHealth } from '../core/ProcessHealth';
import { Updater } from './Updater';
import {
  setAvailableUpdate, markChecked, getAvailableUpdate, getBlockedUpdate, getLastCheckedAt,
} from './updateStatus';

// ════════════════════════════════════════════════════════════════════════════
//  updateScheduler.ts — periodic + manual update checks (C5).
//
//  The stranded fleet only ever checked for an update ONCE per process launch
//  (UPDATE_RELIABILITY.md §6.10). A 24/7 operator machine that never restarts
//  therefore never learned a new version existed. This adds:
//    • a periodic (6h) CHECK — refreshes the "update available" surface + the
//      heartbeat telemetry, IS_PACKAGED-only, skipped while a money op is in
//      flight. It is CHECK-ONLY: it never downloads or swaps, so it can never
//      surprise-restart a running session.
//    • a manual "check / install now" path (the authenticated endpoint) — the
//      only way an update is APPLIED mid-session, and only on explicit user
//      confirmation AND when no trade/buy/refresh is in flight.
//
//  This is the "gate the swap on idle OR user confirmation" rule from C5: no
//  mid-session swap is ever automatic. Boot-time auto-update (index.ts) is
//  unchanged — swapping before the app is up is always safe.
// ════════════════════════════════════════════════════════════════════════════

export interface UpdateSchedulerDeps {
  currentVersion: string;
  /** True when a trade / buy / mass-job / refresh is in flight → do NOT touch the swap path. */
  isBusy: () => boolean;
}

export interface UpdateCheckView {
  available: boolean;
  current: string;
  latest?: string;
  notes?: string;
  publishedAt?: string;
  blocked: boolean;       // this exact version has failed its self-test ≥N times on this machine (C3)
  lastCheckedAt?: number;
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | undefined;
let deps: UpdateSchedulerDeps | undefined;
let inFlight = false; // single-flight guard across periodic/manual check + install

/** S34: true while a check/install is running. The dashboard resets its "installing…" state (and re-shows
 *  the update badge) once this is false, so a kept-current install no longer shows "installing…" forever. */
export function isUpdateOpInFlight(): boolean { return inFlight; }

/**
 * Start the periodic (6h) update-availability check. IS_PACKAGED-only (a dev run must never swap
 * node.exe). Unref'd so it never keeps the process alive on its own. Idempotent.
 */
export function startUpdateScheduler(d: UpdateSchedulerDeps, intervalMs: number = SIX_HOURS_MS): void {
  deps = d;
  stopUpdateScheduler();
  if (!IS_PACKAGED) return; // dev: no periodic checks (nothing to swap)
  timer = setInterval(() => { void periodicTick(); }, intervalMs);
  timer.unref();
  logger.info(`[update] periodic check scheduled every ${Math.round(intervalMs / 3_600_000)}h`);
}

export function stopUpdateScheduler(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

async function periodicTick(): Promise<void> {
  if (!deps || !IS_PACKAGED) return;
  // Owner directive: no update activity while a money op is in flight, and never on a quarantined
  // process. The 6h cadence catches a quiet window soon enough; the next tick retries.
  if (deps.isBusy() || ProcessHealth.moneyOpsBlocked()) {
    logger.info('[update] periodic check skipped – busy / money-ops quarantined');
    return;
  }
  await checkOnly('periodic');
}

/** The current available/blocked view without hitting the network (for the status route). */
export function currentView(current: string): UpdateCheckView {
  const avail = getAvailableUpdate();
  const blocked = getBlockedUpdate();
  return {
    available: !!avail,
    current,
    latest: avail?.version,
    notes: avail?.notes,
    publishedAt: avail?.publishedAt,
    blocked: !!(avail && blocked && blocked.version === avail.version),
    lastCheckedAt: getLastCheckedAt(),
  };
}

/**
 * CHECK-ONLY: refresh the available-update surface + telemetry WITHOUT downloading or swapping. Safe
 * mid-session. Returns the view for the manual endpoint. Single-flight (a periodic tick and a manual
 * check can't stack).
 */
export async function checkOnly(source: string): Promise<UpdateCheckView> {
  const current = deps?.currentVersion ?? '';
  if (inFlight) return currentView(current);
  inFlight = true;
  try {
    markChecked(Date.now());
    const info = await Updater.check(current);
    if (info) {
      setAvailableUpdate({ version: info.latest, notes: info.notes, publishedAt: info.publishedAt });
      logger.info(`[update] ${source} check: v${info.latest} available (current v${current})`);
    } else {
      setAvailableUpdate(undefined);
    }
  } catch (err) {
    logger.warn(`[update] ${source} check failed: ${(err as Error).message}`);
  } finally {
    inFlight = false;
  }
  return currentView(current);
}

/**
 * USER-CONFIRMED install (from the dashboard's "Install now"). Refuses while a money op is in flight
 * (a swap exits the process). Otherwise runs the FULL update (download → verify → self-test → swap),
 * which exits the process on success — so this is fire-and-forget from the endpoint's perspective.
 * `force:true` re-attempts an artifact previously marked blocked (C3), because the user explicitly asked.
 */
export function canInstallNow(): { ok: boolean; reason: string } {
  if (!deps) return { ok: false, reason: 'not-ready' };
  if (!IS_PACKAGED) return { ok: false, reason: 'Updates are only applied in the packaged build.' };
  if (deps.isBusy()) return { ok: false, reason: 'A trade, buy or refresh is in progress — finish it, then install.' };
  if (ProcessHealth.moneyOpsBlocked()) return { ok: false, reason: 'Money ops are quarantined — restart SSIM, then update.' };
  if (inFlight) return { ok: false, reason: 'An update check or install is already running.' };
  return { ok: true, reason: 'ok' };
}

/** Kick off the confirmed install. Caller must have checked canInstallNow() first. Does not resolve on
 *  success (the process swaps + exits); resolves only if the update did not apply (kept current). */
export async function installNow(): Promise<{ updated: boolean; reason: string }> {
  if (!deps) return { updated: false, reason: 'not-ready' };
  inFlight = true;
  try {
    logger.info('[update] user-confirmed install starting (force) – will restart on success');
    // S14: pass the live busy-check so runUpdate can RE-CHECK immediately before the swap (the endpoint's
    // canInstallNow ran minutes ago — the download/self-test window is long enough to start a mass op).
    return await Updater.runUpdate(deps.currentVersion, { force: true, isBusy: deps.isBusy });
  } catch (err) {
    // S33: runUpdate can still throw (verify / self-test spawn / swapAndRelaunch). Catch it here so it
    // never escapes the `void installNow()` call site as an unhandledRejection (which would writeCrash +
    // tick the money breaker). runUpdate already set the specific failure outcome for its known paths;
    // return a normal failure result rather than rejecting.
    logger.error(`[update] install failed unexpectedly: ${(err as Error).message}`);
    return { updated: false, reason: `install failed: ${(err as Error).message}` };
  } finally {
    inFlight = false;
  }
}
