import fs from 'fs';
import { logsDir } from './paths';
import { logger } from './logger';

// ════════════════════════════════════════════════════════════════════════════
//  crashMarker.ts — the shell→backend "prior run crashed" handoff (B1).
//
//  On an UNEXPECTED backend death (NOT a clean window-close, NOT an update swap),
//  the Tauri shell writes logs/last-crash.json with the exit code/signal + a tail
//  of shell.log (see src-tauri/src/lib.rs). The backend reads + CONSUMES it once on
//  the next boot to classify the prior exit for telemetry (C4) and to raise a
//  dismissible "SSIM crashed last run" banner in the dashboard (B1).
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
  const f = file;
  const dropCorrupt = (): undefined => {
    // Corrupt/half-written marker → drop it so it can't wedge every boot.
    try { fs.unlinkSync(f); } catch { /* best-effort */ }
    return undefined;
  };
  if (!fs.existsSync(f)) return undefined;
  // A transient read failure (EBUSY/EPERM/EACCES from an AV lock, EMFILE at boot) must NOT
  // destroy a real crash banner — leave the file in place so it re-fires next boot.
  let text: string;
  try {
    text = fs.readFileSync(f, 'utf8');
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
  if (!Number.isFinite(raw?.at)) return dropCorrupt();
  try { fs.unlinkSync(f); } catch { /* best-effort */ }
  return raw;
}
