import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TradeUpService } from '../src/trading/TradeUpService';
import { GcBusyError } from '../src/trading/GcActionLayer';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-069 — a GC-slot collision (a storage move / float read holding the
//  per-account single-op slot) makes craftTradeUp REJECT before the craft is
//  ever sent (GcActionLayer's inFlight guard rejects pre-connect). That rejection
//  ⇔ nothing was sent, so it is 100% safe to wait the slot out and re-attempt the
//  SAME contract — never a masking retry of a submitted craft. The exec loop now
//  waits (bounded, cancel-aware) instead of burning the contract as a real failure.
//  (runExecute is driven directly with a stub `gc` — same seam as craftRejectionClassify.)
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGc = any;

const TEN = Array.from({ length: 10 }, (_, i) => String(i));

test('tradeup exec waits out a busy GC slot', async () => {
  let calls = 0;
  const gc: AnyGc = {
    craftTradeUp: async () => {
      calls++;
      if (calls <= 2) throw new GcBusyError('bot'); // slot held twice, then it frees
      return { submitted: true, confirmed: true, outputItemId: '42' };
    },
  };
  const svc: AnyGc = new TradeUpService({} as never, {} as never, {} as never, gc);
  svc.busyRetryWaitMs = 0; // no real sleeping in the unit test
  svc.execJob = { running: true, enabled: true, statusReason: '', total: 1, done: 0, crafted: 0, failed: 0, results: [] };
  await svc.runExecute('bot', [{ inputAssetIds: TEN, rarityId: 'rarity_common_weapon', stattrak: false }]);
  const s = svc.executeStatus();
  assert.equal(calls, 3, 'the same contract was re-attempted until the slot freed');
  assert.equal(s.crafted, 1, 'the eventual confirmed craft is counted');
  assert.equal(s.failed, 0, 'a busy slot is never booked as a real failure');
  assert.equal(s.done, 1, 'done increments exactly once per contract');
  assert.equal(s.results.length, 1, 'exactly one result for the one contract');
  assert.equal(s.results[0].confirmed, true);
});

test('tradeup exec: a busy slot that never frees exhausts the window honestly', async () => {
  const gc: AnyGc = { craftTradeUp: async () => { throw new GcBusyError('bot'); } };
  const svc: AnyGc = new TradeUpService({} as never, {} as never, {} as never, gc);
  svc.busyRetryWaitMs = 0;
  svc.busyRetryMaxAttempts = 3; // keep the test fast; behaviour is identical to the 24-attempt default
  svc.execJob = { running: true, enabled: true, statusReason: '', total: 1, done: 0, crafted: 0, failed: 0, results: [] };
  await svc.runExecute('bot', [{ inputAssetIds: TEN, rarityId: 'rarity_common_weapon', stattrak: false }]);
  const s = svc.executeStatus();
  assert.equal(s.failed, 1, 'an exhausted wait window IS a failure (nothing sent)');
  assert.equal(s.crafted, 0);
  assert.equal(s.done, 1, 'done increments exactly once even after retries');
  assert.match(s.results[0].error, /nothing was sent; re-run when it finishes/, 'honest exhaustion message, not the raw sentinel');
});

test('tradeup exec: cancel during a busy wait stops the contract, records nothing-sent', async () => {
  const svc: AnyGc = new TradeUpService({} as never, {} as never, {} as never, null);
  svc.busyRetryWaitMs = 0;
  // Flip cancel ON right after the first busy rejection, so the loop cancels during the wait.
  const gc: AnyGc = { craftTradeUp: async () => { svc.execCancel = true; throw new GcBusyError('bot'); } };
  svc.gc = gc;
  svc.execJob = { running: true, enabled: true, statusReason: '', total: 1, done: 0, crafted: 0, failed: 0, results: [] };
  await svc.runExecute('bot', [{ inputAssetIds: TEN, rarityId: 'rarity_common_weapon', stattrak: false }]);
  const s = svc.executeStatus();
  assert.equal(s.failed, 1, 'the cancelled-mid-wait contract is booked failed once');
  assert.equal(s.done, 1, 'done increments exactly once');
  assert.match(s.results[0].error, /cancelled while waiting/, 'the cancel reason is recorded');
});

test('tradeup exec: a real (non-busy) failure is still booked immediately, no retry', async () => {
  let calls = 0;
  const gc: AnyGc = { craftTradeUp: async () => { calls++; throw new Error('inputs no longer present: 5 — refresh & recompute'); } };
  const svc: AnyGc = new TradeUpService({} as never, {} as never, {} as never, gc);
  svc.busyRetryWaitMs = 0;
  svc.execJob = { running: true, enabled: true, statusReason: '', total: 1, done: 0, crafted: 0, failed: 0, results: [] };
  await svc.runExecute('bot', [{ inputAssetIds: TEN, rarityId: 'rarity_common_weapon', stattrak: false }]);
  assert.equal(calls, 1, 'a non-busy error is NOT retried');
  assert.equal(svc.executeStatus().failed, 1);
  assert.match(svc.executeStatus().results[0].error, /inputs no longer present/);
});

test('startExecute refuses upfront when the account already holds the GC slot', () => {
  const gc: AnyGc = { opInFlight: () => true, status: () => ({ craftEnabled: true, reason: '' }) };
  const svc: AnyGc = new TradeUpService({} as never, {} as never, {} as never, gc);
  assert.throws(
    () => svc.startExecute('bot', [{ inputAssetIds: TEN, rarityId: 'rarity_common_weapon', stattrak: false }]),
    /a GC operation \(storage\/float read\) is running for bot/,
    'a held slot refuses the job before it starts',
  );
  assert.equal(svc.executeStatus().running, false, 'no job was created');
});
