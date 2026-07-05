import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
//  H-XCT-006 — SIGHUP/SIGBREAK used to writeCrash + releaseInstanceLock + exit(130),
//  sharing NONE of shutdown()'s quiescence: no logoutAll, no store/vault flush, no
//  money-op drain — while the handler's own comment claimed it "exit[s] cleanly". A
//  console-close mid-fleet-op therefore severed every session and discarded any
//  debounced inventory/history/vault write. Route both signals through the SAME bounded
//  graceful path as SIGINT/SIGTERM. (Signal handlers call process.exit and index.ts
//  self-bootstraps, so an in-process emit-and-spy is untestable — same rationale as
//  shellDeathShutdown.test.ts; this locks the wiring, verified alongside `tsc`.)
// ─────────────────────────────────────────────────────────────────────────────

const SRC = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');

test('H-XCT-006: SIGHUP/SIGBREAK route through the graceful shutdown() path', () => {
  const loop = /for \(const sig of \['SIGHUP', 'SIGBREAK'\][\s\S]*?\n}/.exec(SRC)?.[0] ?? '';
  assert.ok(loop, 'the SIGHUP/SIGBREAK handler loop must exist');
  assert.match(loop, /void shutdown\(sig\)/,
    'SIGHUP/SIGBREAK must call shutdown(sig), not a bare exit — so stores/vault flush and sessions log out');
});

test('H-XCT-006: the handler no longer bypasses shutdown with a bare exit(130)', () => {
  const loop = /for \(const sig of \['SIGHUP', 'SIGBREAK'\][\s\S]*?\n}/.exec(SRC)?.[0] ?? '';
  assert.ok(!/process\.exit\(/.test(loop),
    'the handler must not process.exit() itself — shutdown() owns the (idempotent, fallback-guarded) exit');
});

test('H-XCT-006: the external cause is still recorded as a breadcrumb before shutdown', () => {
  const loop = /for \(const sig of \['SIGHUP', 'SIGBREAK'\][\s\S]*?\n}/.exec(SRC)?.[0] ?? '';
  const crashIdx = loop.indexOf('writeCrash');
  const shutdownIdx = loop.indexOf('void shutdown(');
  assert.ok(crashIdx >= 0, 'the breadcrumb (writeCrash) must still name the EXTERNAL cause');
  assert.ok(crashIdx < shutdownIdx, 'the breadcrumb must be written before the graceful teardown begins');
});
