import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GcActionLayer } from '../src/trading/GcActionLayer';
import { TradeUpService } from '../src/trading/TradeUpService';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-052 — a GC-REFUSED craft must be classified `rejected`, never counted
//  as crafted. The lib answers a refused craft with recipe -1 and an EMPTY id
//  list (a successful trade-up ALWAYS yields exactly one item); the layer maps
//  that to {submitted:true, confirmed:false, rejected:true} and TradeUpService
//  books it as a failure, not a craft.
//  (withSession is overridden per-instance so fn(go) runs against a stub `go`
//  without the real GC session/connect machinery — same seam as casketMoveBudget.)
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGc = any;

/** A stub GC handle: an EventEmitter whose craft() emits craftingComplete with scripted args. */
function stubGo(inputIds: string[], craftArgs: [unknown, unknown]): AnyGc {
  const go: AnyGc = new EventEmitter();
  go.haveGCSession = true;
  go.inventory = inputIds.map((id) => ({ id }));
  go.craft = (): void => { go.emit('craftingComplete', craftArgs[0], craftArgs[1]); };
  return go;
}

const TEN = Array.from({ length: 10 }, (_, i) => String(i));

async function runCraft(craftArgs: [unknown, unknown]): Promise<{ submitted: boolean; confirmed: boolean; rejected?: boolean; outputItemId?: string }> {
  const gc: AnyGc = Object.create(GcActionLayer.prototype);
  const go = stubGo(TEN, craftArgs);
  gc.withSession = async (_u: string, fn: (g: unknown) => Promise<unknown>) => fn(go);
  const prev = process.env.SSIM_GC_VERIFIED;
  process.env.SSIM_GC_VERIFIED = '1'; // force the irreversible-craft gate ON for the test
  try {
    return await gc.craftTradeUp('bot', { inputAssetIds: TEN, inputRarityId: 'rarity_common_weapon', stattrak: false });
  } finally {
    if (prev === undefined) delete process.env.SSIM_GC_VERIFIED; else process.env.SSIM_GC_VERIFIED = prev;
  }
}

test('H-TRD-052: craftTradeUp classifies a GC craft rejection (recipe -1, empty id list)', async () => {
  const r = await runCraft([-1, []]);
  assert.deepEqual(r, { submitted: true, confirmed: false, rejected: true }, 'a refused craft is rejected, never confirmed');
});

test('H-TRD-052: a successful craft keeps the 64-bit output id as a string', async () => {
  const r = await runCraft([0 /* echoed recipe */, ['9876543210123456789']]);
  assert.equal(r.submitted, true);
  assert.equal(r.confirmed, true);
  assert.equal(r.rejected, undefined);
  assert.strictEqual(r.outputItemId, '9876543210123456789'); // exact string — no Number() precision loss
});

test('H-TRD-052: TradeUpService books a GC rejection as failed:1, crafted:0', async () => {
  const gc: AnyGc = { craftTradeUp: async () => ({ submitted: true, confirmed: false, rejected: true }) };
  const svc: AnyGc = new TradeUpService({} as never, {} as never, {} as never, gc);
  svc.execJob = { running: true, enabled: true, statusReason: '', total: 1, done: 0, crafted: 0, failed: 0, results: [] };
  await svc.runExecute('bot', [{ inputAssetIds: TEN, rarityId: 'rarity_common_weapon', stattrak: false }]);
  assert.equal(svc.execJob.failed, 1, 'a refused craft is a failure');
  assert.equal(svc.execJob.crafted, 0, 'nothing was crafted');
  // The wording carries what the operator can act on (the refusal is about THIS contract's inputs);
  // it must also reach the run-level tally, because `results` is wiped at every auto round.
  assert.match(svc.execJob.results[0].error, /refused the contract .*no items were consumed/i);
  assert.deepEqual(
    svc.execJob.failureReasons.map((r: { count: number }) => r.count), [1],
    'the failure must be tallied where the UI can still find it after a round reset',
  );
});

test('H-TRD-052: TradeUpService counts a confirmed craft as crafted:1', async () => {
  const gc: AnyGc = { craftTradeUp: async () => ({ submitted: true, confirmed: true, outputItemId: '42' }) };
  const svc: AnyGc = new TradeUpService({} as never, {} as never, {} as never, gc);
  svc.execJob = { running: true, enabled: true, statusReason: '', total: 1, done: 0, crafted: 0, failed: 0, results: [] };
  await svc.runExecute('bot', [{ inputAssetIds: TEN, rarityId: 'rarity_common_weapon', stattrak: false }]);
  assert.equal(svc.execJob.crafted, 1);
  assert.equal(svc.execJob.failed, 0);
});
