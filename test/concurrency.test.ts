import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scaleConcurrency } from '../src/utils/concurrency';

// ─── The ceiling invariant (DIRECTIVES.md #7 — fleet cap 25) ───────────────────
// scaleConcurrency is the single computation of the fleet-concurrency ceiling.
// Every return path — including the empty-batch early exit — must honour `max`,
// so a caller-supplied `min` above `max` can never leak a pool above the cap.

test('scaleConcurrency: empty batch obeys the ceiling when min > max', () => {
  assert.equal(scaleConcurrency(0, { min: 40, max: 25 }), 25);
});

test('scaleConcurrency: non-empty batch already honours the ceiling when min > max', () => {
  assert.equal(scaleConcurrency(2, { min: 40, max: 25 }), 25);
});

test('scaleConcurrency: no-opts fleet band is unchanged', () => {
  assert.equal(scaleConcurrency(500), 25);
  assert.equal(scaleConcurrency(10), 5);
  assert.equal(scaleConcurrency(1), 5);
  assert.equal(scaleConcurrency(0), 5);
});
