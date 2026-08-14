import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ════════════════════════════════════════════════════════════════════════════
//  H-TRD-061 — hookShutdownOnce once installed SIGINT/SIGTERM/SIGHUP handlers
//  that ran the teardowns then process.exit(0), truncating index.ts's graceful
//  shutdown() mid-logoutAll and forcing exit code 0. Teardown must ride only the
//  'exit' hook (every JS-capable termination path in index.ts funnels through
//  process.exit). This is a source-level regression guard: it fails if a signal
//  handler reappears in cleanBrowser.ts.
// ════════════════════════════════════════════════════════════════════════════

test('H-TRD-061: cleanBrowser installs no signal handlers (teardown rides the exit hook only)', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'trading', 'cleanBrowser.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(!/process\.once\(\s*sig/.test(src), 'cleanBrowser.ts must not register process.once(sig, …) signal handlers');
  assert.ok(!/SIGINT/.test(src), 'cleanBrowser.ts must not reference SIGINT');
  assert.ok(src.includes("process.once('exit'"), "cleanBrowser.ts must keep the process.once('exit', …) teardown hook");
});
