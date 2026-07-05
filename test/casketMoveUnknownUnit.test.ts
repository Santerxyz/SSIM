import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GcActionLayer } from '../src/trading/GcActionLayer';
import { CasketService } from '../src/trading/CasketService';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-050 — moveCasketItems must fail fast on a stale/wrong casketId. A unit
//  deleted in-game since listCaskets is missing from the SO cache; deposits used
//  to empty-coerce that to `current = 0` and pass the cap, and withdraws never
//  looked it up at all → each item burned its verify window against a unit that
//  does not exist, ending as misleading "unconfirmed". The unit lookup is now
//  hoisted and required for BOTH directions: a missing unit throws pre-send.
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

test('H-TRD-050: moveCasketItems rejects an unknown casket before sending (both directions)', async () => {
  for (const direction of ['deposit', 'withdraw'] as const) {
    const gc: Any = Object.create(GcActionLayer.prototype);
    let addCalls = 0;
    let removeCalls = 0;
    const go = {
      haveGCSession: true,
      inventory: ['x', 'y'].map((id) => ({ id })), // the requested casket 'c1' is NOT here
      addToCasket: () => { addCalls++; },
      removeFromCasket: () => { removeCalls++; },
    };
    gc.withSession = async (_u: string, fn: (g: unknown) => Promise<unknown>) => fn(go);

    await assert.rejects(
      () => gc.moveCasketItems('bot', 'c1', ['a', 'b', 'c'], direction),
      /storage unit c1 not found in the live GC inventory/,
      `${direction}: an unknown casket rejects with the not-found message`,
    );
    assert.equal(addCalls, 0, `${direction}: nothing was deposited`);
    assert.equal(removeCalls, 0, `${direction}: nothing was withdrawn`);
  }
});

test('H-TRD-050: a present unit still passes the guard (no false-reject)', async () => {
  const gc: Any = Object.create(GcActionLayer.prototype);
  const go = {
    haveGCSession: true,
    inventory: [{ id: 'c1', casket_contained_item_count: 0 }, { id: 'a' }],
    removeFromCasket: () => { /* verify path stubbed below */ },
    getCasketContents: (_c: string, cb: (e: Error | null, items: unknown[]) => void) => cb(null, []),
  };
  gc.withSession = async (_u: string, fn: (g: unknown) => Promise<unknown>) => fn(go);
  gc.verifyMove = async () => true; // isolate the guard from the verify machinery

  const res = await gc.moveCasketItems('bot', 'c1', ['a'], 'withdraw');
  assert.equal(res.moved.length, 1, 'the present unit is not rejected — the move proceeds');
});

/** An inert inventory stub (the reconcile only warns; not under test here). */
function invStub(): Any {
  return { refreshOne: () => Promise.resolve({}) };
}

/** Flush enough microtasks for runMove's finally to settle. */
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

test('H-TRD-050: CasketService reports the unknown-unit throw as a pre-flight error with moved===0', async () => {
  const gc: Any = Object.create(GcActionLayer.prototype);
  gc.withSession = async (_u: string, fn: (g: unknown) => Promise<unknown>) =>
    fn({ haveGCSession: true, inventory: [{ id: 'other' }], addToCasket: () => { throw new Error('must not send'); } });
  const svc = new CasketService(gc, invStub());

  svc.startMove('bot', 'c1', ['a', 'b'], 'deposit');
  await flush();

  const j = svc.moveStatus();
  assert.match(j.error ?? '', /storage unit c1 not found in the live GC inventory/, 'the job error carries the not-found message');
  assert.equal(j.moved, 0, 'nothing moved');
  assert.equal(j.stoppedReason, 'preflight', 'a throw before any send is preflight (done===0)');
});
