import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { CsFloatAutoAcceptWorker } from '../src/csfloat/CsFloatAutoAcceptWorker';
import { CsFloatDeliveredStore } from '../src/csfloat/CsFloatDeliveredStore';

// ════════════════════════════════════════════════════════════════════════════
//  H-FLT-001 — a TRANSPORT-AMBIGUOUS sendTrade failure (ECONNRESET/timeout on
//  offer.send's response leg) means the Steam offer MAY already exist. The worker
//  polls every 45s ≫ TradeService's 8s refuse-once min-age, so the refuse-once
//  gate is only a one-poll speed-bump — without this fix the SECOND poll after an
//  ambiguous send fires a duplicate real Steam offer for the same sale.
//
//  Fix: on an ambiguous send, record the id in the durable delivered store (like a
//  success) so it is never auto-resent; on a DEFINITE rejection, do NOT record it
//  (it truly did not land) so a later poll may safely retry.
// ════════════════════════════════════════════════════════════════════════════

function freshDeliveredPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-flt001-')), 'csfloat_delivered.json');
}

const PENDING_TRADE = { id: 'trade-A', buyer_id: '76561199012345678', item: { asset_id: '123456789' } };

/** AccountManager.withNetwork attaches a RESOLVED network to every account it hands out — a proxy, or
 *  this localip sentinel for a legitimate host-IP account. `undefined` ONLY ever means pool-lost, which
 *  deliverFor refuses (it would leak the host IP), so a mock must carry one to reach the delivery path. */
const RESOLVED_NETWORK = { type: 'localip', value: '0.0.0.0' };

/** Build a worker whose deps return a single pending trade with a valid delivery target,
 *  and whose delivered store lives on a fresh temp path (non-degraded, isolated). */
function makeWorker(sendTrade: () => Promise<never>): {
  worker: CsFloatAutoAcceptWorker;
  store: CsFloatDeliveredStore;
  sendCalls: () => number;
} {
  let sendCalls = 0;
  const accounts = { get: (u: string) => ({ username: u, enabled: true, tier: 'full', network: RESOLVED_NETWORK }) };
  const trades = {
    sendTrade: async () => { sendCalls++; return sendTrade(); },
  };
  const csfloat = {
    hasKey: () => true,
    trades: async () => ({ trades: [PENDING_TRADE] }),
  };
  const worker = new CsFloatAutoAcceptWorker(accounts as never, trades as never, csfloat as never);
  const store = new CsFloatDeliveredStore(freshDeliveredPath());
  (worker as unknown as { delivered: CsFloatDeliveredStore }).delivered = store;
  return { worker, store, sendCalls: () => sendCalls };
}

const deliverFor = (w: CsFloatAutoAcceptWorker, u: string): Promise<void> =>
  (w as unknown as { deliverFor: (u: string) => Promise<void> }).deliverFor(u);

test('H-FLT-001: an ambiguous send is recorded delivered and never re-attempted on the next poll', async () => {
  const ambiguous = Object.assign(new Error('interrupted (ECONNRESET) — may already exist'), { commitMayHaveLanded: true });
  const { worker, store, sendCalls } = makeWorker(async () => { throw ambiguous; });

  await deliverFor(worker, 'bot');
  assert.equal(sendCalls(), 1, 'first pass attempts the send once');
  assert.equal(store.has('trade-A'), true, 'the ambiguous send is recorded delivered (the offer MAY exist → never auto-resend)');

  // Second poll ~45s later: CSFloat still shows the trade pending, but the id is now in the
  // durable store, so the worker must NOT send a second real offer.
  await deliverFor(worker, 'bot');
  assert.equal(sendCalls(), 1, 'the ambiguous sale is not re-delivered on the following poll (no duplicate offer)');
});

test('H-FLT-001: a DEFINITE Steam rejection is not recorded delivered and is retried on a later poll', async () => {
  const rejection = Object.assign(new Error('Steam rejected the offer'), { eresult: 26, commitMayHaveLanded: false });
  const { worker, store, sendCalls } = makeWorker(async () => { throw rejection; });

  await deliverFor(worker, 'bot');
  assert.equal(sendCalls(), 1, 'first pass attempts the send once');
  assert.equal(store.has('trade-A'), false, 'a definite rejection did not land → not marked delivered');

  // A definite rejection is safe to retry: the trade is still pending and un-delivered.
  await deliverFor(worker, 'bot');
  assert.equal(sendCalls(), 2, 'the rejected sale is retried on the next poll (it truly did not land)');
});
