import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CasketService } from '../src/trading/CasketService';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-083 — live progress must carry `unconfirmed`. The move-status footer
//  renders `job.unconfirmed` on every poll tick, but before this fix the progress
//  payload never included it, so it stayed 0 until the job ended and then popped
//  up out of nowhere. A stubbed progress with unconfirmed:3 must be visible on
//  moveStatus() WHILE the job is still running.
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

type ProgressCb = (p: { done: number; total: number; current: string; moved: number; unconfirmed: number; failed: number }) => void;

/** A gc stub that captures the live onProgress and hands back a controllable promise. */
function capturingGcStub(): {
  gc: Any;
  captures: Array<{ onProgress?: ProgressCb; resolve: (r: Any) => void; reject: (e: Any) => void }>;
} {
  const captures: Array<{ onProgress?: ProgressCb; resolve: (r: Any) => void; reject: (e: Any) => void }> = [];
  const gc = {
    moveCasketItems(_u: string, _c: string, _ids: string[], _d: string, onProgress?: ProgressCb) {
      return new Promise((resolve, reject) => { captures.push({ onProgress, resolve, reject }); });
    },
  };
  return { gc, captures };
}

/** An inert inventory stub (this suite does not exercise the reconcile). */
function invStub(): Any {
  return { refreshOne: () => Promise.resolve({}) };
}

test('H-TRD-083: live progress carrying unconfirmed:3 is reflected on moveStatus() while running:true', () => {
  const { gc, captures } = capturingGcStub();
  const svc = new CasketService(gc, invStub());

  svc.startMove('bot', 'c1', ['a', 'b', 'c'], 'deposit');
  assert.equal(captures.length, 1, 'the job reached the gc');

  // The gc reports live progress: 4 done, 1 confirmed moved, 3 sent-but-unconfirmed.
  captures[0].onProgress!({ done: 4, total: 5, current: 'c', moved: 1, unconfirmed: 3, failed: 0 });

  const j = svc.moveStatus();
  assert.equal(j.running, true, 'job still running (promise not resolved)');
  assert.equal(j.unconfirmed, 3, 'live unconfirmed count is visible mid-run, not only at completion');
  assert.equal(j.moved, 1, 'live moved count is visible mid-run');
});
