import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CasketService } from '../src/trading/CasketService';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-081 — moveCasketItems now returns a `stopped` discriminator so the job
//  can tell a natural completion from a cooperative budget-break (the rest were
//  NOT attempted) from a cancel-after-current. runMove maps it onto
//  job.stoppedReason and derives job.cancelled STRICTLY from it, so a cancel
//  clicked during the final item's verify window can't mislabel a full completion.
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** A gc stub whose moveCasketItems resolves the given `stopped` value immediately. */
function resolvingGcStub(stopped: 'completed' | 'budget' | 'cancelled', moved: string[] = ['a']): Any {
  return {
    moveCasketItems() {
      return Promise.resolve({ moved, unconfirmed: [], failed: [], stopped });
    },
  };
}

/** An inert inventory stub (the reconcile only warns; labeling is what this suite checks). */
function invStub(): Any {
  return { refreshOne: () => Promise.resolve({}) };
}

/** Flush enough microtasks for the finally (and its `void refreshOne(...)`) to settle. */
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

test('H-TRD-081: a natural completion is stoppedReason:completed, not cancelled', async () => {
  const svc = new CasketService(resolvingGcStub('completed'), invStub());
  svc.startMove('u', 'c1', ['a'], 'deposit');
  await flush();

  const j = svc.moveStatus();
  assert.equal(j.running, false, 'job finalized');
  assert.equal(j.stoppedReason, 'completed');
  assert.equal(j.cancelled, false, 'a completed job is never cancelled');
});

test('H-TRD-081: a budget-stop is stoppedReason:budget and NOT cancelled', async () => {
  const svc = new CasketService(resolvingGcStub('budget'), invStub());
  svc.startMove('u', 'c1', ['a', 'b'], 'deposit');
  await flush();

  const j = svc.moveStatus();
  assert.equal(j.stoppedReason, 'budget', 'the S16 cooperative break is labeled budget');
  assert.equal(j.cancelled, false, 'a budget-stop is a partial, not a cancel');
});

test('H-TRD-081: a cancel-after-current is stoppedReason:cancelled and cancelled:true', async () => {
  const svc = new CasketService(resolvingGcStub('cancelled'), invStub());
  svc.startMove('u', 'c1', ['a', 'b'], 'deposit');
  await flush();

  const j = svc.moveStatus();
  assert.equal(j.stoppedReason, 'cancelled');
  assert.equal(j.cancelled, true, 'cancelled is derived strictly from the stopped discriminator');
});
