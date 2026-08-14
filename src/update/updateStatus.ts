// ════════════════════════════════════════════════════════════════════════════
//  updateStatus.ts — tiny in-memory holder for the client's UPDATE + last-exit
//  runtime status.
//
//  WHY A SEPARATE MODULE (not fields on Updater.ts):
//   • The update path (Updater.ts) WRITES this; the license heartbeat
//     (LicenseClient.ts) and the dashboard status route (api/server.ts) READ it.
//     Keeping it here lets those readers import a leaf module instead of pulling
//     the whole updater graph (axios / child_process / fs-extra), and removes any
//     risk of an import cycle (Updater imports this; nothing here imports Updater).
//   • It is deliberately process-lifetime state (no persistence of its own). The
//     values that MUST survive a reboot (the per-sha self-test failure streak) are
//     persisted by Updater.ts in data\updates\selftest-state.json and re-projected
//     into here on every boot's update check, so the heartbeat/status always reflect
//     THIS run's freshly-derived view. (update-reliability telemetry rider.)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The coarse outcome of the last update attempt, sent verbatim on the license
 * heartbeat (C4) so the server can size the stranded fleet by failure class.
 * The value set is FIXED (the server stores it as an opaque string; keep it stable):
 *   ok               – an update was applied (rarely seen: the process then exits to swap)
 *   up-to-date       – checked, already newest
 *   download-fail    – the artifact never fully downloaded
 *   sig-fail         – sha256 / Ed25519 verification failed (tamper or corruption)
 *   selftest-eacces  – the new exe could not be spawned (lock/permission) after retries
 *   selftest-timeout – the self-test exceeded even the escalated budget
 *   selftest-no-marker – the new exe ran but did not confirm a healthy boot (crash / no marker)
 *   check-failed     – the version CHECK itself failed (network/server); distinct from up-to-date (S53)
 *   deferred-busy    – verified + self-tested, but a money/item op started → swap deferred (S14)
 *   swap-blocked     – the swap (move) failed ≥N times on this machine (AV/EDR / CFA) (S9)
 */
export type UpdateOutcome =
  | 'ok'
  | 'up-to-date'
  | 'check-failed'   // S53: the version CHECK itself failed (network/server) — distinct from up-to-date, so
                     // the stranded-fleet histogram counts this cohort instead of hiding it as "current"
  | 'download-fail'
  | 'sig-fail'
  | 'selftest-eacces'
  | 'selftest-timeout'
  | 'selftest-no-marker'
  | 'deferred-busy'  // S14: verified+self-tested, but a money/item op started during the window → swap deferred
  | 'swap-blocked';  // S9: the swap (move) itself failed ≥N times on this machine (AV/EDR / Controlled Folder Access)

/** A newer version exists but its self-test has failed enough times on THIS machine that we have
 *  surfaced it (C3). The swap is still refused (keep-current guard) — this only makes it visible. */
export interface BlockedUpdate {
  version: string;
  sha256: string;
  kind: string;      // the self-test failure classification: 'crash' | 'no-marker' | 'timeout' | 'lock'
  failures: number;  // consecutive self-test failures of THIS artifact on THIS machine
  since: number;     // epoch ms of the first failure in the streak
}

/** A newer version the last check found (whether or not it is blocked). Surfaced so the UI can show
 *  "update available" and offer a manual install / manual-reinstall link. */
export interface AvailableUpdate {
  version: string;
  notes?: string;
  publishedAt?: string;
}

let lastOutcome: UpdateOutcome | undefined;
let blocked: BlockedUpdate | undefined;
let available: AvailableUpdate | undefined;
let lastCheckedAt: number | undefined;
let lastExitClass: string | undefined; // set once on boot from the prior run's crash/exit markers (C4)

export function setUpdateOutcome(o: UpdateOutcome): void { lastOutcome = o; }
export function getUpdateOutcome(): UpdateOutcome | undefined { return lastOutcome; }

export function setBlockedUpdate(b: BlockedUpdate | undefined): void { blocked = b; }
export function getBlockedUpdate(): BlockedUpdate | undefined { return blocked; }

export function setAvailableUpdate(a: AvailableUpdate | undefined): void { available = a; }
export function getAvailableUpdate(): AvailableUpdate | undefined { return available; }

export function markChecked(at: number): void { lastCheckedAt = at; }
export function getLastCheckedAt(): number | undefined { return lastCheckedAt; }

export function setLastExitClass(c: string | undefined): void { lastExitClass = c; }
export function getLastExitClass(): string | undefined { return lastExitClass; }

/** A crash the shell recorded on the PRIOR run's UNEXPECTED backend death (B1). Read once on the next
 *  boot to (a) classify the prior exit for telemetry (C4 lastExitClass) and (b) surface a dismissible
 *  "SSIM crashed last run" banner in the dashboard. Notify-only — nothing is ever respawned. */
export interface PriorCrash {
  at: number;         // epoch ms of the death
  code?: number | null;
  signal?: number | null;
}
let priorCrash: PriorCrash | undefined;
export function setPriorCrash(c: PriorCrash | undefined): void { priorCrash = c; }
export function getPriorCrash(): PriorCrash | undefined { return priorCrash; }
