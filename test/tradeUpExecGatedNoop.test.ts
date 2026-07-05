import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TradeUpService } from '../src/trading/TradeUpService';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-066 — gated-off execution must be an immediate SAFE NO-OP.
//  When craft is gated off (SSIM_GC_VERIFIED=0 / dev), startExecute used to launch
//  runExecute unconditionally, iterating every contract to a guaranteed throw
//  (~1.5s each) with busy()===true the whole time (deferring the S14 update install)
//  and reporting failed:N for an execution that never could run. It must now
//  short-circuit to a no-op terminal state without ever calling runExecute.
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGc = any;

const TEN = Array.from({ length: 10 }, (_, i) => String(i));
// H-TRD-067: contracts consume their inputs, so startExecute now rejects overlapping
// asset ids. Give each contract its own disjoint 10-id block; the gate/no-op assertions
// below are unchanged — only the fixtures are made non-overlapping so they reach the gate.
const block = (n: number) => Array.from({ length: 10 }, (_, i) => String(n * 10 + i));

test('tradeup exec gated off completes immediately as a safe no-op', () => {
  let crafted = 0;
  const gc: AnyGc = {
    status: () => ({ craftEnabled: false, reason: 'craft disabled (SSIM_GC_VERIFIED not set)' }),
    craftTradeUp: async () => { crafted++; return { submitted: true, confirmed: true }; },
  };
  const svc: AnyGc = new TradeUpService({} as never, {} as never, {} as never, gc);
  const job = svc.startExecute('bot', [
    { inputAssetIds: block(0), rarityId: 'rarity_common_weapon', stattrak: false },
    { inputAssetIds: block(1), rarityId: 'rarity_common_weapon', stattrak: false },
    { inputAssetIds: block(2), rarityId: 'rarity_common_weapon', stattrak: false },
  ]);
  assert.equal(job.running, false, 'the no-op returns a non-running (already-finished) job');
  assert.equal(job.enabled, false, 'enabled is false — the UI keys its disabled footer off this');
  assert.equal(job.failed, 0, 'nothing failed — it was never attempted');
  assert.equal(job.crafted, 0, 'nothing crafted');
  assert.deepEqual(job.results, [], 'no per-contract results were produced');
  assert.equal(job.statusReason, 'craft disabled (SSIM_GC_VERIFIED not set)', 'carries the gate reason');
  assert.ok(job.finishedAt, 'the terminal state carries a finishedAt');
  assert.equal(svc.busy(), false, 'busy() never latches true (no install deferral)');
  assert.equal(crafted, 0, 'craftTradeUp was never called — runExecute never ran');
});

test('tradeup exec still validates malformed payloads before the gate', () => {
  const gc: AnyGc = { status: () => ({ craftEnabled: false, reason: 'off' }) };
  const svc: AnyGc = new TradeUpService({} as never, {} as never, {} as never, gc);
  // 9 asset ids — malformed; must throw (→409) even though craft is gated off.
  assert.throws(
    () => svc.startExecute('bot', [{ inputAssetIds: TEN.slice(0, 9), rarityId: 'rarity_common_weapon', stattrak: false }]),
    /exactly 10 input asset ids/,
  );
});
