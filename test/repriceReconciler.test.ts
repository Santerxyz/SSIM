import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repriceDecision, NO_PROGRESS_TIMEOUT_MS, type RepriceState } from '../src/pricing/repriceReconciler';

// ─── P6 / INV-E1: the reprice reconciler re-pulls on progress and stops on drain,
//     with NO fixed deadline (a long fill still reaches the UI). ────────────────

const fresh = (now = 0): RepriceState => ({ lastPulled: 0, lastProgressAt: now });

test('re-pulls when fetched advances, records progress, keeps watching while busy', () => {
  const d = repriceDecision(fresh(1000), { fetched: 5, running: true, queued: 3 }, 2000);
  assert.equal(d.repull, true, 'new prices landed → re-pull');
  assert.equal(d.stop, false, 'still busy → keep watching');
  assert.equal(d.state.lastPulled, 5);
  assert.equal(d.state.lastProgressAt, 2000);
});

test('does NOT re-pull when fetched has not advanced (still busy)', () => {
  const d = repriceDecision({ lastPulled: 5, lastProgressAt: 1000 }, { fetched: 5, running: true }, 2000);
  assert.equal(d.repull, false, 'no advance → no needless re-pull');
  assert.equal(d.stop, false);
});

test('queue drained → one final re-pull, then stop', () => {
  const d = repriceDecision({ lastPulled: 5, lastProgressAt: 1000 }, { fetched: 5, running: false, queued: 0 }, 3000);
  assert.equal(d.repull, true, 'final re-pull to catch the last batch');
  assert.equal(d.stop, true, 'drained → stop');
});

test('a long fill (far past the old 90s cap) is still watched while it progresses', () => {
  // Simulate progress at t = 5 minutes; the old deadline-based watcher would have quit at 90s.
  const d = repriceDecision({ lastPulled: 100, lastProgressAt: 0 }, { fetched: 250, running: true, queued: 900 }, 5 * 60_000);
  assert.equal(d.repull, true, 'still re-pulling new prices minutes in');
  assert.equal(d.stop, false, 'no fixed deadline → keeps going');
});

test('no-progress safety stop fires when the backend is wedged (busy but never advances)', () => {
  const stuck = { lastPulled: 100, lastProgressAt: 0 };
  const before = repriceDecision(stuck, { fetched: 100, running: true, queued: 5 }, NO_PROGRESS_TIMEOUT_MS - 1);
  assert.equal(before.stop, false, 'not yet at the safety timeout');
  const after = repriceDecision(stuck, { fetched: 100, running: true, queued: 5 }, NO_PROGRESS_TIMEOUT_MS + 1);
  assert.equal(after.stop, true, 'wedged backend → stop after the no-progress timeout');
  assert.equal(after.repull, false, 'no phantom re-pull on the safety stop');
});
