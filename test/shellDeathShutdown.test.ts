import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
//  S51 — the shell pipes to the backend's stdin; if the SHELL dies, that pipe hits
//  EOF. The backend handled only 'data'/'error', so it kept running ORPHANED —
//  holding every Steam session, the CSFloat worker, the UI port + the single-instance
//  lock → the NEXT launch lock-screened with "already running" and nothing visible
//  to close. It must treat EOF as a graceful shutdown. (Runtime/process-lifecycle
//  shaped — `shutdown()` schedules process.exit and index.ts self-bootstraps, so it
//  is untestable in-process; this locks the wiring, verified alongside `tsc`.)
// ─────────────────────────────────────────────────────────────────────────────

const SRC = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');

test('S51: the backend treats stdin EOF (shell death) as a graceful shutdown', () => {
  assert.match(SRC, /process\.stdin\.on\('end',\s*\(\)\s*=>\s*\{[^}]*void shutdown\(/,
    "stdin 'end' (EOF) must trigger shutdown, not leave the backend orphaned");
});

test('S51: shutdown is idempotent so co-firing triggers (SIGINT/SIGTERM/quit/EOF) do not double-teardown', () => {
  assert.match(SRC, /if \(shuttingDown\) return;/, 'a shuttingDown guard makes shutdown run once');
});

test('S51: the EOF handler shuts down (no respawn — owner directive)', () => {
  // Guard the no-band-aid constraint: the fix must NOT respawn the backend, only exit gracefully.
  const endHandler = /process\.stdin\.on\('end',[\s\S]{0,120}?\)/.exec(SRC)?.[0] ?? '';
  assert.ok(!/spawn|respawn|restart/i.test(endHandler), 'the EOF handler must not respawn/restart');
});
