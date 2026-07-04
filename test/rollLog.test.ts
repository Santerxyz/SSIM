import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rollIfLarge, SINK_MAX_BYTES } from '../src/utils/rollLog';
import { writeCrash, CRASH_FILE } from '../src/utils/crashlog';

// ════════════════════════════════════════════════════════════════════════════
//  S47 — the raw synchronous last-words sinks (stderr-trace.log, crash-log.txt,
//  exit-trace.log) were append-only with no cap. They now roll to `.1` past a
//  bounded size, the same way memHeartbeat already caps its file.
// ════════════════════════════════════════════════════════════════════════════

const tmp = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-roll-')), 'sink.log');

test('S47: rollIfLarge rolls a file past the cap to .1', () => {
  const f = tmp();
  fs.writeFileSync(f, 'x'.repeat(100));
  rollIfLarge(f, 50);
  assert.equal(fs.existsSync(f), false, 'the over-cap file was renamed away');
  assert.equal(fs.readFileSync(`${f}.1`, 'utf8').length, 100, 'its contents moved to .1');
});

test('S47: rollIfLarge leaves a within-cap file alone', () => {
  const f = tmp();
  fs.writeFileSync(f, 'x'.repeat(10));
  rollIfLarge(f, 50);
  assert.equal(fs.existsSync(f), true, 'a within-cap file is not rolled');
  assert.equal(fs.existsSync(`${f}.1`), false);
});

test('S47: rollIfLarge is a no-op (never throws) when the file is absent', () => {
  const f = tmp();
  assert.doesNotThrow(() => rollIfLarge(f, 50));
  assert.equal(fs.existsSync(`${f}.1`), false);
});

test('S47: writeCrash rolls the crash sink once it passes the cap (bounded, not append-forever)', () => {
  fs.writeFileSync(CRASH_FILE, Buffer.alloc(SINK_MAX_BYTES + 1)); // seed the real sink over the cap
  try {
    writeCrash('S47-TEST', new Error('boom'));
    assert.ok(fs.existsSync(`${CRASH_FILE}.1`), 'the over-cap crash log rolled to .1');
    assert.ok(fs.statSync(CRASH_FILE).size < SINK_MAX_BYTES, 'the new crash log restarted small');
    assert.match(fs.readFileSync(CRASH_FILE, 'utf8'), /S47-TEST/, 'the new record landed in the fresh file');
  } finally {
    try { fs.rmSync(`${CRASH_FILE}.1`); } catch { /* best-effort cleanup */ }
  }
});
