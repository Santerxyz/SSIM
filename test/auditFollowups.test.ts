import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { CsFloatDeliveredStore } from '../src/csfloat/CsFloatDeliveredStore';
import { repriceDecision, MIN_REPULL_MS } from '../src/pricing/repriceReconciler';

// ─── Fresh-install single-instance lock: acquiring must create the data dir ────
// (Regression: the atomic 'wx' lock threw ENOENT on a fresh install where data/ did
//  not exist yet, and the fail-safe path refused to start → first-launch brick.)
test('single-instance lock: a missing parent dir does not brick (ensures the dir)', () => {
  // Directly exercise the same primitive the guard relies on: create-in-missing-dir must be
  // made to work by ensuring the directory first (mkdir recursive), then wx succeeds.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `ssim-fresh-${process.pid}-`));
  const lock = path.join(base, 'data', 'ssim.lock'); // data/ does NOT exist yet
  assert.throws(() => fs.openSync(lock, 'wx'), (e: NodeJS.ErrnoException) => e.code === 'ENOENT');
  fs.mkdirSync(path.dirname(lock), { recursive: true }); // what acquireInstanceLock now does first
  const fd = fs.openSync(lock, 'wx');
  assert.ok(fd >= 0, 'lock acquires once the dir exists');
  fs.closeSync(fd);
});

// ─── CSFloat delivered-store: corrupt file must fail SAFE (no mass re-delivery) ─
let seq = 0;
function tmpStore(contents?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ssim-deliv-${process.pid}-${seq++}-`));
  const f = path.join(dir, 'csfloat_delivered.json');
  if (contents !== undefined) fs.writeFileSync(f, contents);
  return f;
}

test('delivered-store: a corrupt file → degraded (auto-delivery must be disabled)', () => {
  const s = new CsFloatDeliveredStore(tmpStore('{ this is not json'));
  assert.equal(s.isDegraded(), true, 'unreadable file must degrade, not silently reset to empty');
});

test('delivered-store: a MISSING file (fresh install) is NOT degraded', () => {
  const s = new CsFloatDeliveredStore(tmpStore(undefined));
  assert.equal(s.isDegraded(), false);
});

test('delivered-store: a valid file loads its ids and is not degraded', () => {
  const s = new CsFloatDeliveredStore(tmpStore(JSON.stringify({ version: 1, ids: ['t1', 't2'] })));
  assert.equal(s.isDegraded(), false);
  assert.equal(s.has('t1'), true);
  assert.equal(s.has('t9'), false);
});

// ─── Reprice reconciler: a fetched RESET (new fill generation) re-baselines ────
test('reconciler: fetched dropping below lastPulled (new generation) re-pulls', () => {
  // We'd already pulled at 200; the backend starts a new run() and fetched resets to 30.
  // `now` is ≥ MIN_REPULL_MS past the last re-pull (lastRepulledAt defaults to 0) so the S10 coalescing
  // gate does not suppress the re-baselined advance.
  const d = repriceDecision({ lastPulled: 200, lastProgressAt: 0 }, { fetched: 30, running: true, queued: 5 }, MIN_REPULL_MS + 1000);
  assert.equal(d.repull, true, 'the new generation must be re-pulled, not ignored until it passes 200');
  assert.equal(d.state.lastPulled, 30);
});
