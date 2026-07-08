import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { CsFloatAutoAcceptWorker } from '../src/csfloat/CsFloatAutoAcceptWorker';
import { CsFloatDeliveredStore } from '../src/csfloat/CsFloatDeliveredStore';

// ════════════════════════════════════════════════════════════════════════════
//  H-FLT-003 — runOnce() filters the batch on a.enabled at pass start, but a pass
//  over many accounts at 45s cadence spans seconds. deliverFor re-fetches the live
//  account; it must re-check .enabled (not just null) so an operator disabling an
//  account MID-PASS stops its queued delivery this pass instead of after restart.
// ════════════════════════════════════════════════════════════════════════════

function freshDeliveredPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-flt003-')), 'csfloat_delivered.json');
}

const PENDING_TRADE = { id: 'trade-A', buyer_id: '76561199012345678', item: { asset_id: '123456789' } };

const deliverFor = (w: CsFloatAutoAcceptWorker, u: string): Promise<void> =>
  (w as unknown as { deliverFor: (u: string) => Promise<void> }).deliverFor(u);

test('H-FLT-003: an account disabled between the filter and deliverFor is not delivered', async () => {
  let sendCalls = 0;
  const acc = { username: 'bot', enabled: true, tier: 'full' };
  const accounts = { get: (_u: string) => acc };
  const trades = { sendTrade: async () => { sendCalls++; return { status: 'sent', offerId: 'x' }; } };
  const csfloat = { hasKey: () => true, trades: async () => ({ trades: [PENDING_TRADE] }) };
  const worker = new CsFloatAutoAcceptWorker(accounts as never, trades as never, csfloat as never);
  (worker as unknown as { delivered: CsFloatDeliveredStore }).delivered =
    new CsFloatDeliveredStore(freshDeliveredPath());

  // Operator disables the account after the pass-start filter admitted it.
  acc.enabled = false;

  await deliverFor(worker, 'bot');
  assert.equal(sendCalls, 0, 'a mid-pass disable stops the queued delivery — no Steam offer is sent');
});

test('H-FLT-003: a still-enabled account is delivered as before', async () => {
  let sendCalls = 0;
  const acc = { username: 'bot', enabled: true, tier: 'full' };
  const accounts = { get: (_u: string) => acc };
  const trades = { sendTrade: async () => { sendCalls++; return { status: 'sent', offerId: 'x' }; } };
  const csfloat = { hasKey: () => true, trades: async () => ({ trades: [PENDING_TRADE] }) };
  const worker = new CsFloatAutoAcceptWorker(accounts as never, trades as never, csfloat as never);
  (worker as unknown as { delivered: CsFloatDeliveredStore }).delivered =
    new CsFloatDeliveredStore(freshDeliveredPath());

  await deliverFor(worker, 'bot');
  assert.equal(sendCalls, 1, 'the enabled happy path is unchanged — the sale is delivered');
});
