import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CasketService } from '../src/trading/CasketService';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-085 — a throw out of runMove must be labeled by what ACTUALLY happened.
//  The withTimeout backstop (GcActionLayer) fires MID-move: onProgress has already
//  recorded real counts on the job, so the catch must set stoppedReason:'aborted'
//  and KEEP those counters — never present a 150-items-deep move as "nothing moved".
//  A throw before any send (pre-flight: gated off, not logged in, cap) is 'preflight'.
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

type ProgressCb = (p: { done: number; total: number; current: string; moved: number; failed: number }) => void;
type CancelCb = () => boolean;

/** A gc stub that captures each call's onProgress and hands back a controllable promise. */
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

/** An inert inventory stub (labeling is what this suite checks; the reconcile only warns). */
function invStub(): Any {
  return { refreshOne: () => Promise.resolve({}) };
}

/** Flush enough microtasks for the finally (and its `void refreshOne(...)`) to settle. */
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

test('H-TRD-085: a mid-move backstop throw keeps the partial counters and labels the job aborted', async () => {
  const { gc, captures } = capturingGcStub();
  const svc = new CasketService(gc, invStub());

  svc.startMove('u', 'c1', ['a', 'b', 'c'], 'deposit');
  assert.equal(captures.length, 1, 'job reached the gc');

  // Real partial progress recorded before the backstop fires.
  captures[0].onProgress!({ done: 3, total: 3, current: 'c', moved: 2, failed: 0 });
  captures[0].reject(new Error('GC op for u timed out after 80s'));
  await flush();

  const j = svc.moveStatus();
  assert.equal(j.running, false, 'job finalized');
  assert.equal(j.moved, 2, 'partial counters are KEPT, not reset');
  assert.equal(j.error, 'GC op for u timed out after 80s', 'error set to the throw message');
  assert.equal(j.stoppedReason, 'aborted', 'a throw after real progress is aborted (done>0)');
});

test('H-TRD-085: a pre-flight throw (no progress) is labeled preflight', async () => {
  const { gc, captures } = capturingGcStub();
  const svc = new CasketService(gc, invStub());

  svc.startMove('u', 'c1', ['a', 'b'], 'deposit');
  captures[0].reject(new Error('GC execution is gated off'));
  await flush();

  const j = svc.moveStatus();
  assert.equal(j.error, 'GC execution is gated off', 'error set to the throw message');
  assert.equal(j.stoppedReason, 'preflight', 'a throw before any send is preflight (done===0)');
  assert.equal(j.moved, 0, 'nothing moved');
});

test('H-TRD-085: a non-Error throw is stringified, not silently undefined', async () => {
  const { gc, captures } = capturingGcStub();
  const svc = new CasketService(gc, invStub());

  svc.startMove('u', 'c1', ['a'], 'deposit');
  captures[0].reject('raw string failure');
  await flush();

  const j = svc.moveStatus();
  assert.equal(j.error, 'raw string failure', 'a non-Error throw is coerced to a string (never undefined)');
  assert.equal(j.stoppedReason, 'preflight', 'no progress → preflight');
});
