import { test } from 'node:test';
import assert from 'node:assert/strict';
import { achievableWears } from '../src/trading/tradeupMath';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-075 — warmOutputPrices must not queue wears a skin's float range can't
//  roll. A trade-up output float spans [minFloat, maxFloat]; achievableWears is
//  the shared helper that keeps warmOutputPrices from naming market items that
//  don't exist (each impossible name burns a ~3.5s single-IP fill slot).
// ─────────────────────────────────────────────────────────────────────────────

test('warm skips impossible wears', () => {
  // A 0.40–1.00 skin can never be Factory New / Minimal Wear / Field-Tested.
  const wears = achievableWears(0.40, 1.0);
  assert.deepEqual(wears, ['Well-Worn', 'Battle-Scarred']);
});

test('full 0..1 range keeps every wear', () => {
  const wears = achievableWears(0, 1);
  assert.deepEqual(wears, ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred']);
});

test('a capped-low range drops Battle-Scarred', () => {
  // maxFloat 0.38 → the Battle-Scarred band [0.45, 1.01) never intersects.
  const wears = achievableWears(0, 0.38);
  assert.deepEqual(wears, ['Factory New', 'Minimal Wear', 'Field-Tested']);
});
