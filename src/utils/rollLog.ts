import fs from 'fs';

// ════════════════════════════════════════════════════════════════════════════
//  rollLog — a bounded, dependency-free cap for the SYNCHRONOUS last-words sinks
//  (stderr-trace.log, crash-log.txt, exit-trace.log). winston's own files are
//  already size-capped by winston; these raw fs.appendFileSync sinks were not, so
//  a spewing vendor library or a long-lived install could grow them without bound
//  (S47). Rolls the file to `.1` (overwriting any prior roll — one generation of
//  history is enough for a diagnostic) once it passes the cap. Best-effort: never
//  throws, so a crash/exit sink can't be broken by a rotation failure.
// ════════════════════════════════════════════════════════════════════════════

/** Default cap for a diagnostic sink. 5 MB keeps plenty of last-words while bounding disk. */
export const SINK_MAX_BYTES = 5_000_000;

/** Roll `file` → `file.1` once it grows past `maxBytes`. Uses a statSync, so it suits LOW-frequency
 *  sinks (crash/exit — written rarely). For a hot per-write sink, prefer an in-process byte counter. */
export function rollIfLarge(file: string, maxBytes: number = SINK_MAX_BYTES): void {
  try {
    const st = fs.statSync(file);
    if (st.size > maxBytes) fs.renameSync(file, file + '.1');
  } catch { /* no file yet, or rename raced — ignore */ }
}
