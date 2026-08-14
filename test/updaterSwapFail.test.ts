import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSwapScript, consumeSwapFailureMarker, swapFailureMarkerPath, clearSwapFailState } from '../src/update/Updater';

// ─────────────────────────────────────────────────────────────────────────────
//  S9 — a persistent SWAP failure (move /Y blocked by AV/EDR or Controlled Folder
//  Access) used to loop boot→self-test→swap→relaunch forever with NOTHING recorded,
//  and the splash even claimed "Update installed". The bat now records a per-sha
//  swap-failure marker on a failed move (and does NOT claim success); the next boot
//  counts it and blocks after N.
// ─────────────────────────────────────────────────────────────────────────────

test('S9: buildSwapScript records the marker on a FAILED move and does not claim success there', () => {
  const s = buildSwapScript({
    tmp: 'N.exe', target: 'S.exe', relaunch: 'S.exe', relaunchUpdatedFlag: true,
    backendPid: 1, vbsPath: 'u.vbs', markerPath: 'M.marker', markerSha: 'abc123',
  });
  const swapped = s.indexOf(':swapped');
  const swapfail = s.indexOf(':swapfail');
  const done = s.indexOf(':done');
  assert.ok(swapped >= 0 && swapfail > swapped && done > swapfail, 'the bat has distinct success/fail/done sections');

  const successSection = s.slice(swapped, swapfail);
  assert.ok(successSection.includes('--ssim-updated'), 'the SUCCESS relaunch carries the updated flag (honest "installed")');

  const failSection = s.slice(swapfail, done);
  assert.ok(failSection.includes('echo abc123>"M.marker"'), 'a failed move writes the per-sha swap-failure marker');
  assert.ok(!failSection.includes('--ssim-updated'), 'a FAILED swap must NOT relaunch claiming "Update installed"');
});

test('S9: buildSwapScript omits the marker echo when no markerPath is given (back-compat)', () => {
  const s = buildSwapScript({ tmp: 'N.exe', target: 'S.exe', relaunch: 'S.exe', backendPid: 1, vbsPath: 'u.vbs' });
  assert.ok(!/echo\s+\S*>"/.test(s), 'no marker-write redirect when markerPath is absent (only @echo off)');
});

test('S9: consumeSwapFailureMarker counts per-sha, resets on a new sha, survives a no-marker boot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-swapfail-'));
  try {
    // Boot 1: the bat wrote a marker for sha-A → count 1, marker consumed.
    fs.writeFileSync(swapFailureMarkerPath(dir), 'sha-A\r\n');
    let st = consumeSwapFailureMarker(dir);
    assert.deepEqual(st, { sha256: 'sha-A', count: 1 });
    assert.ok(!fs.existsSync(swapFailureMarkerPath(dir)), 'the marker is consumed (deleted)');

    // A boot with NO new marker returns the existing streak (so the block check still sees it).
    assert.deepEqual(consumeSwapFailureMarker(dir), { sha256: 'sha-A', count: 1 });

    // Same sha fails again → count climbs to the block threshold.
    fs.writeFileSync(swapFailureMarkerPath(dir), 'sha-A');
    assert.equal(consumeSwapFailureMarker(dir)!.count, 2);
    fs.writeFileSync(swapFailureMarkerPath(dir), 'sha-A');
    assert.equal(consumeSwapFailureMarker(dir)!.count, 3, 'three identical-sha move failures → block threshold');

    // A NEW published sha starts a fresh streak (a good release is never suppressed by an old one).
    fs.writeFileSync(swapFailureMarkerPath(dir), 'sha-B');
    assert.deepEqual(consumeSwapFailureMarker(dir), { sha256: 'sha-B', count: 1 });

    clearSwapFailState(dir);
    assert.equal(consumeSwapFailureMarker(dir), undefined, 'cleared → no streak');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
