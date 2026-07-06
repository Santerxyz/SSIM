import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { CsFloatAutoAcceptWorker } from '../src/csfloat/CsFloatAutoAcceptWorker';
import { AppSettings } from '../src/core/AppSettings';

// ════════════════════════════════════════════════════════════════════════════
//  S46 — stop() used to leave the 5s boot tick armed (a pass could fire 5s into
//  teardown) and had no way to signal an in-flight pass. Now stop() cancels both
//  timers and sets a `stopped` flag the pass checks before each account.
// ════════════════════════════════════════════════════════════════════════════

// Capture the REAL statics ONCE (the whole glob runs in one process — never leak a stub across files).
const conc = require('../src/utils/concurrency') as { scaleConcurrency: (n: number) => number };
const REAL = {
  exp: AppSettings.isCsfloatExperimental,
  names: AppSettings.autoAcceptUsernames,
  conc: conc.scaleConcurrency,
};
after(() => {
  AppSettings.isCsfloatExperimental = REAL.exp;
  AppSettings.autoAcceptUsernames = REAL.names;
  conc.scaleConcurrency = REAL.conc;
});

function makeWorker(): CsFloatAutoAcceptWorker {
  const mgr = { get: (u: string) => ({ username: u, enabled: true, tier: 'full' }) };
  return new CsFloatAutoAcceptWorker(mgr as never, {} as never, {} as never);
}

test('S46: stop() cancels the 5s boot tick and the interval, and sets the stopped flag', () => {
  const w = makeWorker();
  w.start();
  assert.ok((w as unknown as { bootTimer?: unknown }).bootTimer, 'start() arms the boot tick');
  assert.ok((w as unknown as { timer?: unknown }).timer, 'start() arms the interval');
  w.stop();
  assert.equal((w as unknown as { bootTimer?: unknown }).bootTimer, undefined, 'stop() cancels the boot tick (no pass 5s into teardown)');
  assert.equal((w as unknown as { timer?: unknown }).timer, undefined, 'stop() cancels the interval');
  assert.equal((w as unknown as { stopped: boolean }).stopped, true);
});

test('S46: runOnce is a no-op once stopped (no delivery after teardown began)', async () => {
  AppSettings.isCsfloatExperimental = () => true;
  AppSettings.autoAcceptUsernames = () => ['a'];
  const w = makeWorker();
  let delivered = 0;
  (w as unknown as { deliverFor: (u: string) => Promise<void> }).deliverFor = async () => { delivered++; };
  w.start();
  w.stop();
  await (w as unknown as { runOnce: () => Promise<void> }).runOnce();
  assert.equal(delivered, 0, 'no deliveries run after stop()');
});

test('S46: an in-flight pass stops launching new deliveries when stop() is called mid-pass', async () => {
  AppSettings.isCsfloatExperimental = () => true;
  AppSettings.autoAcceptUsernames = () => ['a', 'b', 'c'];
  conc.scaleConcurrency = () => 1; // one worker → deterministic ordering
  const w = makeWorker();
  const delivered: string[] = [];
  (w as unknown as { deliverFor: (u: string) => Promise<void> }).deliverFor = async (u: string) => {
    delivered.push(u);
    if (delivered.length === 1) w.stop(); // teardown fires during the first delivery
  };
  await (w as unknown as { runOnce: () => Promise<void> }).runOnce();
  assert.deepEqual(delivered, ['a'], 'the stopped flag halted the pass after the first delivery (b, c not sent)');
});

// ════════════════════════════════════════════════════════════════════════════
//  H-FLT-011 — when the delivered-id store cannot make a record durable (add()
//  returns FALSE), deliverFor must STOP launching new deliveries for that account
//  this pass, so a crash before the store recovers can't re-send every sale whose
//  dedup was never saved. It must not send the SECOND pending trade in the batch.
// ════════════════════════════════════════════════════════════════════════════
test('H-FLT-011: deliverFor stops after the first non-persisted delivery (no second send)', async () => {
  // Two pending CSFloat trades for the account; both would be valid to deliver.
  const trades = [
    { id: 't1', buyer_id: '76561198000000001', contract: { item: { asset_id: '111' } } },
    { id: 't2', buyer_id: '76561198000000002', contract: { item: { asset_id: '222' } } },
  ];
  const csfloat = {
    hasKey: () => true,
    trades: async () => ({ trades }),
  };
  let sends = 0;
  const tradeSvc = {
    sendTrade: async () => { sends++; return { status: 'sent', offerId: `o${sends}` }; },
  };
  const mgr = { get: (u: string) => ({ username: u, enabled: true, tier: 'full' }) };
  const w = new CsFloatAutoAcceptWorker(mgr as never, tradeSvc as never, csfloat as never);
  // Stub the durable store: add() returns FALSE (record not durable) so the pass must stop after one send.
  (w as unknown as { delivered: unknown }).delivered = {
    isDegraded: () => false,
    has: () => false,
    add: () => false,
  };
  await (w as unknown as { deliverFor: (u: string) => Promise<void> }).deliverFor('a');
  assert.equal(sends, 1, 'deliverFor stopped after the first non-durable record — the second trade was NOT sent');
});
