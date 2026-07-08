// ════════════════════════════════════════════════════════════════════════════
//  bootflags.ts – process-level flags that MUST be set before any dependency
//  module is loaded. This file is imported FIRST in index.ts (import order =
//  execution order), so it runs before './api/server' pulls in steam-user /
//  steamcommunity / the legacy `request` chain.
//
//  Suppresses Node deprecation warnings (e.g. DEP0040 'punycode is deprecated',
//  emitted by a transitive dependency we don't control). These are noise to the
//  end customer and look unprofessional in the console window.
// ════════════════════════════════════════════════════════════════════════════
import fs from 'fs';
import { logsDir } from './utils/paths';
import { SINK_MAX_BYTES } from './utils/rollLog';
import { redactSecrets } from './utils/redact';

process.noDeprecation = true;

// ── Heap ceiling note (the cap is applied at LAUNCH, not here) ─────────────────
// Why capping the heap matters: with no explicit limit V8's ceiling sits near ~4 GB,
// so a leaking fleet can exhaust the machine's commit and be reclaimed by Windows
// BEFORE V8 itself aborts — and an OS reclaim is not a V8 fatal, so reportOnFatalError
// never fires. That is exactly why the crashes leave NO diagnostic report. A cap below
// that point makes a JS-heap leak hit V8's own "JavaScript heap out of memory" first →
// the fatal-error report below fires → we finally get a stack + heap post-mortem.
//
// We do NOT call v8.setFlagsFromString('--max-old-space-size') here: that flag is read
// only when the V8 isolate is created (before this file runs), so setting it at runtime
// is a silent no-op (verified). The cap is therefore applied at launch instead:
//   • packaged ssim.exe → baked in at build time  (build/pack.js: pkg --options max_old_space_size)
//   • dev / node        → start.bat passes  node --max-old-space-size=%SSIM_HEAP_MB%
//   • override anywhere  → set NODE_OPTIONS=--max-old-space-size=<MB> before launch
// The live ceiling + headroom are recorded every tick in logs/mem-heartbeat.log.

// ── Diagnostic report: capture FATAL deaths that bypass JS error handlers ──────
// uncaughtException / unhandledRejection only see JS-level throws. The two most
// likely "silent crash during refresh" causes do NOT fire them and so cannot be
// try/catch'd or logged from JS at all:
//   • V8 out-of-memory  → "FATAL ERROR: … heap out of memory", then abort
//   • native crash in steam-user / steamcommunity → segfault/abort
// Node's diagnostic report dumps a JSON file (JS + native stacks, heap + libuv
// state, resource usage) the instant either happens, turning a vanished window
// into a readable post-mortem in logs/.
//
// CRITICAL: only reportOnFatalError is enabled. reportOnUncaughtException is left
// OFF on purpose — turning it on makes Node write a report AND THEN EXIT on every
// uncaught throw, which would undo index.ts's deliberate "survive a single stray
// vendor-callback throw" policy. JS throws stay handled by index.ts (+ crashlog).
try {
  const report = (process as unknown as {
    report?: { directory: string; reportOnFatalError: boolean; reportOnUncaughtException: boolean; excludeEnv: boolean };
  }).report;
  if (report) {
    const dir = logsDir();
    fs.mkdirSync(dir, { recursive: true }); // else Node silently falls back to cwd
    report.directory = dir;
    report.reportOnFatalError = true;        // OOM + native fatals → JSON report
    report.reportOnUncaughtException = false; // keep index.ts's survive-and-log behaviour
    report.excludeEnv = true;                // excludeEnv keeps SSIM_VAULT_PASSWORD (and any future secret env) out of the shipped report; the forensic payload is stacks+handles, not env
  }
} catch { /* best-effort: diagnostics must never block boot */ }

// ── Raw-stderr tee: capture dying last-words winston cannot ─────────────────────
// winston's File transport is async and only sees logger.* calls. If a native/V8 fatal
// prints "FATAL ERROR: …" or a vendor library writes to stderr (console.error /
// process.stderr.write) immediately before the process dies, NOTHING reaches ssim.log.
// Tee every stderr write into a SYNCHRONOUS file so those last-words survive a death.
// Best-effort; the original stderr write ALWAYS still runs, and a failure here is swallowed.
try {
  fs.mkdirSync(logsDir(), { recursive: true });
  const stderrTrace = logsDir('stderr-trace.log');
  const orig = process.stderr.write.bind(process.stderr) as (...a: unknown[]) => boolean;
  // The one canonical proxy-cred masker (redact.ts is dependency-free, so it's safe to pull
  // in this early — no winston/AgentFactory). Covers URL + legacy proxy forms; the same
  // superset the logger/crash sinks use, from a single source of truth.
  const mask = redactSecrets;
  // S47: cap this append-only sink. It's written on EVERY stderr write (a spewing vendor library could
  // flood it), so track bytes IN-PROCESS — no statSync per write — and roll to .1 once past the cap. The
  // counter is seeded from the current on-disk size so a pre-existing large file still rolls.
  let written = 0;
  try { written = fs.statSync(stderrTrace).size; } catch { /* no file yet */ }
  // TANK fix #9: write through a HELD open fd (fs.writeSync) instead of fs.appendFileSync. The tee stays
  // SYNCHRONOUS — that is the whole point, so a native fatal's dying last-words are on disk BEFORE the
  // process aborts (an async sink would lose exactly the 0xC0000409 last-words we need). But appendFileSync
  // does an open()+write()+close() syscall on EVERY stderr line; under the vendor "socket hang up" spew a
  // reset storm produces, that per-line syscall churn stalls the event loop and DELAYS the very socket-close
  // callbacks whose teardown race feeds the fast-fail. A persistent O_APPEND fd + writeSync keeps the
  // death-capture guarantee while removing the per-line open/close amplifier.
  let fd = -1;
  try { fd = fs.openSync(stderrTrace, 'a'); } catch { /* fall back to append-per-write below */ }
  (process.stderr as unknown as { write: (...a: unknown[]) => boolean }).write = (
    chunk: unknown,
    ...rest: unknown[]
  ): boolean => {
    try {
      const s = typeof chunk === 'string'
        ? chunk
        : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const out = mask(s);
      if (written > SINK_MAX_BYTES) {
        try {
          if (fd >= 0) { fs.closeSync(fd); fd = -1; }
          fs.renameSync(stderrTrace, stderrTrace + '.1');
          written = 0;
        } catch { /* file locked / rename raced — leave counter high so we retry next write */ }
        try { if (fd < 0) fd = fs.openSync(stderrTrace, 'a'); } catch { /* reopen deferred to next write */ }
      }
      if (fd >= 0) fs.writeSync(fd, out);           // held fd, O_APPEND — no per-line open/close
      else fs.appendFileSync(stderrTrace, out);     // fd unavailable → degrade to the original path
      written += Buffer.byteLength(out);
    } catch {
      try { if (fd < 0) fd = fs.openSync(stderrTrace, 'a'); } catch { /* never break stderr */ }
    }
    return orig(chunk, ...rest);
  };
} catch { /* best-effort: a diagnostic must never block boot */ }

export {};
