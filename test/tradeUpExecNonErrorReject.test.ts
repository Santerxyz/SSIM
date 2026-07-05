import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TradeUpService } from '../src/trading/TradeUpService';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-068 — S33 residue on the trade-up exec loop.
//  A non-Error rejection value (null/undefined) from the GC layer used to make the
//  per-contract catch's `(e as Error).message` a TypeError thrown FROM the catch,
//  escaping the loop and skipping finalization; and the `void this.runExecute(...)`
//  launch had no rejection finalizer, so a runExecute reject would latch
//  execJob.running=true until restart (409s every future start; S14 defers installs)
//  and surface as an unhandledRejection (money-breaker tick).
//  (Same seam as craftRejectionClassify: runExecute is driven with a stub `gc`.)
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGc = any;

const TEN = Array.from({ length: 10 }, (_, i) => String(i));

test('tradeup exec survives a non-Error rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    // GC layer rejects with a NON-Error value — the old `(e as Error).message` threw here.
    const gc: AnyGc = { craftTradeUp: async () => Promise.reject(null) };
    const svc: AnyGc = new TradeUpService({} as never, {} as never, {} as never, gc);
    svc.execJob = { running: true, enabled: true, statusReason: '', total: 2, done: 0, crafted: 0, failed: 0, results: [] };
    await svc.runExecute('bot', [
      { inputAssetIds: TEN, rarityId: 'rarity_common_weapon', stattrak: false },
      { inputAssetIds: TEN, rarityId: 'rarity_common_weapon', stattrak: false },
    ]);
    const s = svc.executeStatus();
    assert.equal(s.running, false, 'the job drained — running is reset');
    assert.equal(s.failed, s.total, 'every contract was recorded as failed');
    assert.equal(s.results.length, s.total, 'each contract produced a result (loop never escaped)');
    assert.equal(s.results[0].error, 'null', 'the non-Error rejection is stringified, not thrown');
    // let any stray rejection microtask surface
    await new Promise((r) => setImmediate(r));
    assert.equal(unhandled.length, 0, 'no unhandledRejection escaped the exec loop');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('tradeup exec: a rejected runExecute releases the job (void launch .catch)', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const gc: AnyGc = { status: () => ({ craftEnabled: true, reason: '' }), opInFlight: () => false };
    const svc: AnyGc = new TradeUpService({} as never, {} as never, {} as never, gc);
    // Force the orchestrator itself to reject (simulate an unexpected throw before the loop).
    svc.runExecute = () => Promise.reject(new Error('orchestrator boom'));
    const job = svc.startExecute('bot', [{ inputAssetIds: TEN, rarityId: 'rarity_common_weapon', stattrak: false }]);
    assert.equal(job.running, true, 'running is set immediately on start');
    await new Promise((r) => setImmediate(r)); // let the .catch microtask run
    assert.equal(svc.executeStatus().running, false, 'the crashed orchestrator released the job — not latched until restart');
    assert.equal(unhandled.length, 0, 'the void launch .catch swallowed the rejection (no money-breaker tick)');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
