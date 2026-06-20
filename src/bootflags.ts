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
    report?: { directory: string; reportOnFatalError: boolean; reportOnUncaughtException: boolean };
  }).report;
  if (report) {
    const dir = logsDir();
    fs.mkdirSync(dir, { recursive: true }); // else Node silently falls back to cwd
    report.directory = dir;
    report.reportOnFatalError = true;        // OOM + native fatals → JSON report
    report.reportOnUncaughtException = false; // keep index.ts's survive-and-log behaviour
  }
} catch { /* best-effort: diagnostics must never block boot */ }

export {};
