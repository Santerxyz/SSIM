import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CasketService } from '../src/trading/CasketService';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-084 — a casket move MUST reconcile the moved account's inventory (parity
//  with every other mutating service): deposited/withdrawn assets leave Steam's web
//  inventory, so the cached inventory is stale and the deposit panel would keep
//  showing moved items as owned/tradable (duplicate deposits, doomed sells). The
//  reconcile fires refreshOne(username,'cs2') iff moved>0 || unconfirmed>0, and a
//  rejected refresh only warns (the job state is already finalized).
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** A gc stub whose moveCasketItems returns the given counts (as id arrays / failures). */
function gcStub(res: { moved: string[]; unconfirmed: string[]; failed: Array<{ itemId: string; error: string }> }): Any {
  return { moveCasketItems: async () => res };
}

/** An inventory stub recording refreshOne calls; rejects when `reject` is set. */
function invStub(reject = false): Any & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    refreshOne(username: string, game: string) {
      calls.push([username, game]);
      return reject ? Promise.reject(new Error('boom')) : Promise.resolve({});
    },
  };
}

/** Runs a move to completion and flushes the microtasks the finally's `void refreshOne(...)` needs. */
async function runToDone(svc: CasketService): Promise<void> {
  while (svc.moveStatus().running) await new Promise((r) => setImmediate(r));
  // The reconcile fires inside the finally as `void refreshOne(...).catch(...)`; let those settle.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

test('H-TRD-084: a move with moved>0 reconciles the account inventory exactly once via refreshOne(username, cs2)', async () => {
  const inv = invStub();
  const svc = new CasketService(gcStub({ moved: ['a', 'b'], unconfirmed: [], failed: [] }), inv);
  svc.startMove('bot', 'c1', ['a', 'b'], 'deposit');
  await runToDone(svc);
  assert.deepEqual(inv.calls, [['bot', 'cs2']], 'refreshOne called once with (username, cs2)');
});

test('H-TRD-084: unconfirmed>0 (moved=0) still reconciles — an unconfirmed item may well have moved', async () => {
  const inv = invStub();
  const svc = new CasketService(gcStub({ moved: [], unconfirmed: ['a'], failed: [] }), inv);
  svc.startMove('bot', 'c1', ['a'], 'withdraw');
  await runToDone(svc);
  assert.deepEqual(inv.calls, [['bot', 'cs2']], 'unconfirmed sends trigger the reconcile');
});

test('H-TRD-084: a failed-only move does NOT reconcile (nothing changed on Steam)', async () => {
  const inv = invStub();
  const svc = new CasketService(gcStub({ moved: [], unconfirmed: [], failed: [{ itemId: 'a', error: 'nope' }] }), inv);
  svc.startMove('bot', 'c1', ['a'], 'deposit');
  await runToDone(svc);
  assert.equal(inv.calls.length, 0, 'no reconcile when only failures');
});

test('H-TRD-084: a rejected refreshOne only warns — the job state stays finalized', async () => {
  const inv = invStub(true); // refreshOne rejects
  const svc = new CasketService(gcStub({ moved: ['a'], unconfirmed: [], failed: [] }), inv);
  svc.startMove('bot', 'c1', ['a'], 'deposit');
  await runToDone(svc);
  assert.equal(inv.calls.length, 1, 'the reconcile was still attempted');
  const j = svc.moveStatus();
  assert.equal(j.running, false, 'job finalized despite the rejected reconcile');
  assert.equal(j.moved, 1, 'counters intact');
  assert.equal(j.error, undefined, 'a reconcile rejection is NOT surfaced as a job error');
});
