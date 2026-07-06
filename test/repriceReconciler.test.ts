import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repriceDecision, NO_PROGRESS_TIMEOUT_MS, MIN_REPULL_MS, type RepriceState } from '../src/pricing/repriceReconciler';

// ─── P6 / INV-E1: the reprice reconciler re-pulls on progress and stops on drain,
//     with NO fixed deadline (a long fill still reaches the UI). ────────────────

const fresh = (now = 0): RepriceState => ({ lastPulled: 0, lastProgressAt: now });

test('re-pulls when fetched advances, records progress, keeps watching while busy', () => {
  // `now` is ≥ MIN_REPULL_MS past the last re-pull (lastRepulledAt defaults to 0), so the S10
  // coalescing gate lets this advance re-pull.
  const d = repriceDecision(fresh(1000), { fetched: 5, running: true, queued: 3 }, MIN_REPULL_MS + 2000);
  assert.equal(d.repull, true, 'new prices landed (past the coalesce window) → re-pull');
  assert.equal(d.stop, false, 'still busy → keep watching');
  assert.equal(d.state.lastPulled, 5);
  assert.equal(d.state.lastProgressAt, MIN_REPULL_MS + 2000);
  assert.equal(d.state.lastRepulledAt, MIN_REPULL_MS + 2000, 'the re-pull timestamp advanced');
});

test('S10: a second fetched advance within MIN_REPULL_MS is coalesced (no re-pull), no stop', () => {
  // First advance re-pulls (far past the window); carry its state forward.
  const first = repriceDecision(fresh(0), { fetched: 5, running: true, queued: 3 }, 100_000);
  assert.equal(first.repull, true, 'first advance re-pulls');
  assert.equal(first.state.lastRepulledAt, 100_000);
  // A second advance only 500ms later — still busy — must NOT re-pull (S10 whole-fleet coalescing),
  // and must NOT stop (progress is still being made).
  const second = repriceDecision(first.state, { fetched: 8, running: true, queued: 1 }, 100_500);
  assert.equal(second.repull, false, 'advance within MIN_REPULL_MS → coalesced, no re-pull');
  assert.equal(second.stop, false, 'still progressing → keep watching');
  assert.equal(second.state.lastPulled, 8, 'the new fetched count is still recorded');
  assert.equal(second.state.lastRepulledAt, 100_000, 'the re-pull timestamp is unchanged (no re-pull happened)');
  // Once MIN_REPULL_MS has elapsed since the last re-pull, the next advance re-pulls again.
  const third = repriceDecision(second.state, { fetched: 9, running: true, queued: 0 }, 100_000 + MIN_REPULL_MS);
  assert.equal(third.repull, true, 'past the coalesce window again → re-pull resumes');
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

test('S19: a 429/error storm advances `processed` (not `fetched`) → progress, no false wedge-stop', () => {
  // fetched stuck at 100 (no successes), but processed climbs as names resolve via the error path.
  const state: RepriceState = { lastPulled: 100, lastProgressAt: 0, lastProcessed: 50 };
  const d1 = repriceDecision(state, { fetched: 100, processed: 60, running: true, queued: 5 }, NO_PROGRESS_TIMEOUT_MS - 1);
  assert.equal(d1.stop, false, 'processed advanced → still alive');
  assert.equal(d1.repull, false, 'no NEW prices (fetched flat) → no needless re-pull');
  assert.equal(d1.state.lastProgressAt, NO_PROGRESS_TIMEOUT_MS - 1, 'the liveness clock advanced on processed');
  // Even long past the old budget, continued processed-progress keeps the watch alive.
  const d2 = repriceDecision(d1.state, { fetched: 100, processed: 70, running: true, queued: 5 }, 30 * 60_000);
  assert.equal(d2.stop, false, 'still alive minutes later while processing continues');
});

test('S19: a TRUE wedge (neither fetched NOR processed advances) still stops after the timeout', () => {
  const stuck: RepriceState = { lastPulled: 100, lastProgressAt: 0, lastProcessed: 50 };
  const d = repriceDecision(stuck, { fetched: 100, processed: 50, running: true, queued: 5 }, NO_PROGRESS_TIMEOUT_MS + 1);
  assert.equal(d.stop, true, 'no progress on EITHER signal → the safety stop still protects against a real wedge');
});
