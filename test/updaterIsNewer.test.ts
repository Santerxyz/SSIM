import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer } from '../src/licensing/Updater';

// ════════════════════════════════════════════════════════════════════════════
//  H-LIC-004 — isNewer hardcoded a 3-segment compare, so any 4th version segment
//  was silently treated as equal (a 4-segment hotfix looked NOT-newer than its
//  3-segment base → stranded fleet). The loop now walks max(r.length, l.length).
// ════════════════════════════════════════════════════════════════════════════

test('H-LIC-004: a 4th segment makes it newer than the 3-segment base', () => {
  assert.equal(isNewer('1.3.5.1', '1.3.5'), true);
});

test('H-LIC-004: dropping the 4th segment is NOT newer than the 4-segment build', () => {
  assert.equal(isNewer('1.3.5', '1.3.5.1'), false);
});

test('H-LIC-004: existing 3-part cases unchanged', () => {
  assert.equal(isNewer('2.0.0', '1.0.0'), true);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('1.0.0', '2.0.0'), false);
  assert.equal(isNewer('1.3.6', '1.3.5'), true);
});

test('H-LIC-004: NaN-safe — a non-numeric latest is treated as not-newer', () => {
  assert.equal(isNewer('abc', '1.3.5'), false);
});
