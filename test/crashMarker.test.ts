import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { consumeCrashMarker } from '../src/utils/crashMarker';

// ════════════════════════════════════════════════════════════════════════════
//  B1 — the shell→backend crash marker read side. Consumed exactly once (a
//  crash surfaces one banner), tolerant of a corrupt/half-written file, and a
//  MISSING file is a clean no-op (no false banner). VISIBILITY ONLY.
// ════════════════════════════════════════════════════════════════════════════

const tmpFile = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-crash-')), 'last-crash.json');

test('B1: a valid crash marker is read AND consumed (surfaces exactly once)', () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ at: 1_720_000_000_000, code: -1073740791, signal: null, version: '1.3.4', logTail: 'boom' }));
  const first = consumeCrashMarker(f);
  assert.ok(first, 'the marker is read');
  assert.equal(first?.code, -1073740791, 'the exit code (here 0xC0000409 signed) is carried');
  assert.equal(first?.at, 1_720_000_000_000);
  assert.ok(!fs.existsSync(f), 'the marker is DELETED on read → it fires once, not every boot');
  assert.equal(consumeCrashMarker(f), undefined, 'a second consume returns nothing');
});

test('B1: a MISSING marker is a clean no-op (no false "crashed last run" banner)', () => {
  const f = tmpFile();
  fs.rmSync(f, { force: true });
  assert.equal(consumeCrashMarker(f), undefined);
});

test('B1: a corrupt/half-written marker returns undefined and is dropped (never wedges boot)', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{ half-written crash marke');
  assert.equal(consumeCrashMarker(f), undefined, 'a partial JSON marker never throws');
  assert.ok(!fs.existsSync(f), 'the corrupt marker is removed so it can’t re-fire every boot');
});

test('B1: a marker without a numeric `at` is rejected (shape guard)', () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ code: 1, version: '1.3.4' })); // no `at`
  assert.equal(consumeCrashMarker(f), undefined);
});

test('B1: the shell `at: 0` clock-failure sentinel is rejected (no false 1970 banner) and consumed', () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ at: 0, code: 1 })); // lib.rs `.unwrap_or(0)` sentinel
  assert.equal(consumeCrashMarker(f), undefined, 'at:0 must not surface a 1970-dated crash');
  assert.ok(!fs.existsSync(f), 'the sentinel marker is dropped so it can’t re-fire every boot');
});
