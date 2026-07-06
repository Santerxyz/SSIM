import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CasketService } from '../src/trading/CasketService';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-082 — the progress/cancel closures must bind to THIS job, not to instance
//  state. If the S16 backstop rejects mid-move, `finally` reopens the gate; a user
//  re-run then starts a NEW job while the OLD loop is still detached (withTimeout
//  can't cancel fn(go)). The old loop's final onProgress call and its shouldCancel
//  read must land on the OLD (orphaned) job — never cross-wire into the new one.
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

type ProgressCb = (p: { done: number; total: number; current: string; moved: number; failed: number }) => void;
type CancelCb = () => boolean;

/** A gc stub that captures each call's onProgress/shouldCancel and hands back a controllable promise. */
function capturingGcStub(): {
  gc: Any;
  captures: Array<{ onProgress?: ProgressCb; shouldCancel?: CancelCb; resolve: (r: Any) => void; reject: (e: Any) => void }>;
} {
  const captures: Array<{ onProgress?: ProgressCb; shouldCancel?: CancelCb; resolve: (r: Any) => void; reject: (e: Any) => void }> = [];
  const gc = {
    moveCasketItems(_u: string, _c: string, _ids: string[], _d: string, onProgress?: ProgressCb, shouldCancel?: CancelCb) {
      return new Promise((resolve, reject) => { captures.push({ onProgress, shouldCancel, resolve, reject }); });
    },
  };
  return { gc, captures };
}

/** An inert inventory stub (this suite does not exercise the reconcile). */
function invStub(): Any {
  return { refreshOne: () => Promise.resolve({}) };
}

/** Flush enough microtasks for the finally (and its `void refreshOne(...)`) to settle. */
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

test('H-TRD-082: a backstop-detached loop\'s stale onProgress lands on its OWN orphaned job, not the next one', async () => {
  const { gc, captures } = capturingGcStub();
  const svc = new CasketService(gc, invStub());

  // Job 1 starts; capture its onProgress before it ends.
  svc.startMove('bot', 'c1', ['a', 'b', 'c'], 'deposit');
  assert.equal(captures.length, 1, 'job 1 reached the gc');
  const oldProgress = captures[0].onProgress!;

  // Backstop rejects job 1 mid-move → finally runs, running:false, gate reopens.
  captures[0].reject(new Error('GC op for bot timed out'));
  await flush();
  assert.equal(svc.moveStatus().running, false, 'job 1 finalized');

  // User immediately re-runs → job 2 starts and is now the published job.
  svc.startMove('bot', 'c1', ['x', 'y'], 'deposit');
  assert.equal(captures.length, 2, 'job 2 reached the gc');
  const j2Before = svc.moveStatus();

  // The detached OLD loop fires one final progress write with the old job's counts.
  oldProgress({ done: 150, total: 200, current: 'stale', moved: 99, failed: 7 });

  const j2After = svc.moveStatus();
  assert.equal(j2After.done, j2Before.done, 'stale write did NOT touch the new job\'s done');
  assert.equal(j2After.moved, j2Before.moved, 'stale write did NOT touch the new job\'s moved');
  assert.equal(j2After.current, j2Before.current, 'stale write did NOT touch the new job\'s current');
  assert.equal(j2After.failed, j2Before.failed, 'stale write did NOT touch the new job\'s failed');

  captures[1].resolve({ moved: ['x', 'y'], unconfirmed: [], failed: [] });
  await flush();
});

test('H-TRD-082: cancelMove() during job 2 does not flip job 1\'s captured shouldCancel', async () => {
  const { gc, captures } = capturingGcStub();
  const svc = new CasketService(gc, invStub());

  // Job 1: capture its shouldCancel, then reject (backstop) so the gate reopens.
  svc.startMove('bot', 'c1', ['a', 'b'], 'deposit');
  const oldShouldCancel = captures[0].shouldCancel!;
  assert.equal(oldShouldCancel(), false, 'job 1 not cancelled yet');
  captures[0].reject(new Error('backstop'));
  await flush();

  // Job 2 starts; cancelling IT must not address the detached job-1 loop.
  svc.startMove('bot', 'c1', ['x', 'y'], 'deposit');
  svc.cancelMove();

  assert.equal(oldShouldCancel(), false, 'job 1\'s shouldCancel is NOT flipped by a cancel aimed at job 2');
  assert.equal(captures[1].shouldCancel!(), true, 'job 2\'s own shouldCancel IS set');

  captures[1].resolve({ moved: [], unconfirmed: [], failed: [] });
  await flush();
});
