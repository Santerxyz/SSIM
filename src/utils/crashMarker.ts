import fs from 'fs';
import { logsDir } from './paths';
import { logger } from './logger';

// ════════════════════════════════════════════════════════════════════════════
// crashMarker.ts — the shell→backend "prior run crashed" handoff.
//
//  On an UNEXPECTED backend death (not a clean window-close, not an update swap),
//  the Tauri shell writes logs/last-crash.json with the exit code/signal + a tail
//  of shell.log (see src-tauri/src/lib.rs). The backend reads + CONSUMES it once on
// the next boot to classify the prior exit for telemetry and to raise a
// dismissible "SSIM crashed last run" banner in the dashboard.
//
//  VISIBILITY ONLY — reading this NEVER respawns anything (owner directive: a crash
//  must be fixed, not hidden by an auto-restart band-aid). Keep this shape in sync
//  with the shell writer.
// ════════════════════════════════════════════════════════════════════════════

export interface CrashMarker {
  at: number;                 // epoch ms of the death (the shell has no date crate; JS renders it)
  code?: number | null;       // process exit code, if the shell captured one
  signal?: number | null;     // termination signal, if any (usually null on Windows)
  version?: string;           // the crashed build's version (best-effort)
  logTail?: string;           // last lines of shell.log (for the banner + webhook)
}

export const crashMarkerFile = (): string => logsDir('last-crash.json');

/**
 * Read + CONSUME (delete) the crash marker if present, so it surfaces exactly once. A parse/IO error
 * (or a partially-written file from a shell that died mid-write) returns undefined and is swallowed —
 * a marker must never block boot. Best-effort delete: a stale marker would at worst re-fire next boot.
 */
export function consumeCrashMarker(file: string = crashMarkerFile()): CrashMarker | undefined {
  const dropCorrupt = (): undefined => {
    // Corrupt/half-written marker → drop it so it can't wedge every boot.
    try { fs.unlinkSync(file); } catch { /* best-effort */ }
    return undefined;
  };
  if (!fs.existsSync(file)) return undefined;
  // A transient read failure (EBUSY/EPERM/EACCES from an AV lock, EMFILE at boot) must not
  // destroy a real crash banner — leave the file in place so it re-fires next boot.
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    logger.warn('last-crash.json unreadable this boot (' + ((err as NodeJS.ErrnoException)?.code ?? 'IO error') + ') — leaving in place');
    return undefined;
  }
  let raw: CrashMarker;
  try {
    raw = JSON.parse(text) as CrashMarker;
  } catch {
    return dropCorrupt();
  }
  // `at <= 0` is the shell writer's clock-lookup failure sentinel (lib.rs `.unwrap_or(0)`),
  // not a real death time — drop it rather than stamp the banner/log with a false 1970 date.
  if (!Number.isFinite(raw?.at) || raw.at <= 0) return dropCorrupt();
  try { fs.unlinkSync(file); } catch { /* best-effort */ }
  return raw;
}
