import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { CsFloatAutoAcceptWorker, terminalState, type CsFloatDeliverJob } from '../src/csfloat/CsFloatAutoAcceptWorker';
import { CsFloatDeliveredStore } from '../src/csfloat/CsFloatDeliveredStore';

// ════════════════════════════════════════════════════════════════════════════
//  Manual delivery (owner report 2026-08-12: "its useless if i started trades and
//  then realised i had to click it first").
//
//  The auto-accept toggle was the ONLY trigger, so a sale that landed before it was
//  flipped could not be delivered by hand at all. The operator can now send one sale,
//  a selection, or a whole buyer — through the SAME guards, dedup store and send path
//  the poller uses. These pin that "same": a manual press must never be able to ship
//  something the automated path would have refused.
// ════════════════════════════════════════════════════════════════════════════

function freshDeliveredPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-manual-deliver-')), 'csfloat_delivered.json');
}

/** withNetwork always attaches a resolved network; `undefined` means pool-lost, which is refused. */
const RESOLVED_NETWORK = { type: 'localip', value: '0.0.0.0' };

const trade = (id: string, asset: string) => ({
  id,
  buyer_id: '76561199012345678',
  contract: { price: 1999, item: { asset_id: asset, market_hash_name: `Skin ${id}` } },
});

interface Harness {
  worker: CsFloatAutoAcceptWorker;
  sends: Array<{ assetId: string }>;
}

function harness(opts: {
  trades?: unknown[];
  account?: Record<string, unknown> | null;
  hasKey?: boolean;
  send?: () => Promise<{ status: string; offerId: string }>;
  onFetch?: (params: { page?: number; limit?: number; state?: string }) => void;
} = {}): Harness {
  const sends: Array<{ assetId: string }> = [];
  const acc = opts.account === undefined
    ? { username: 'bot', enabled: true, tier: 'full', network: RESOLVED_NETWORK }
    : opts.account;
  const accounts = { get: () => acc };
  const tradesSvc = {
    sendTrade: async (_u: string, p: { myItems: Array<{ assetId: string }> }) => {
      sends.push({ assetId: p.myItems[0].assetId });
      return opts.send ? opts.send() : { status: 'sent', offerId: 'offer-1' };
    },
  };
  const csfloat = {
    hasKey: () => opts.hasKey !== false,
    trades: async (_u: string, params: { state?: string }) => {
      opts.onFetch?.(params);
      return { trades: opts.trades ?? [trade('t1', '111'), trade('t2', '222')] };
    },
  };
  const worker = new CsFloatAutoAcceptWorker(accounts as never, tradesSvc as never, csfloat as never);
  (worker as unknown as { delivered: CsFloatDeliveredStore }).delivered = new CsFloatDeliveredStore(freshDeliveredPath());
  return { worker, sends };
}

/** Runs a delivery to completion (startDeliver returns immediately; the run is detached). */
async function finish(worker: CsFloatAutoAcceptWorker): Promise<CsFloatDeliverJob> {
  const deadline = Date.now() + 10_000;
  while (worker.deliverStatus().running) {
    if (Date.now() > deadline) throw new Error('delivery job never finished');
    await new Promise((r) => setTimeout(r, 10));
  }
  return worker.deliverStatus();
}

test('a picked sale is delivered — and ONLY the picked one', async () => {
  const { worker, sends } = harness();
  worker.startDeliver('bot', ['t2']);
  const job = await finish(worker);
  assert.deepEqual(sends, [{ assetId: '222' }], 'exactly the selected sale leaves the account');
  assert.equal(job.sent, 1);
  assert.equal(job.total, 1);
});

test('an empty selection means every pending sale', async () => {
  const { worker, sends } = harness();
  worker.startDeliver('bot', []);
  const job = await finish(worker);
  assert.deepEqual(sends.map((s) => s.assetId), ['111', '222']);
  assert.equal(job.sent, 2);
});

test('a sale already delivered is skipped, never sent a second time', async () => {
  const { worker, sends } = harness();
  (worker as unknown as { delivered: CsFloatDeliveredStore }).delivered.add('t1');
  worker.startDeliver('bot', ['t1', 't2']);
  const job = await finish(worker);
  assert.deepEqual(sends.map((s) => s.assetId), ['222'], 'the delivered sale must not produce a second offer');
  assert.equal(job.skipped, 1);
  assert.match(job.results.find((r) => r.tradeId === 't1')!.error!, /already delivered/i);
});

test('a selected sale CSFloat no longer lists is reported, not silently dropped', async () => {
  const { worker } = harness();
  worker.startDeliver('bot', ['t1', 'gone']);
  const job = await finish(worker);
  assert.equal(job.total, 2, 'the vanished sale still counts — the operator asked for it');
  assert.equal(job.skipped, 1);
  assert.match(job.results.find((r) => r.tradeId === 'gone')!.error!, /no longer lists this sale/i);
});

// ── THE REGRESSION (owner: "0 sent, 0 unconfirmed, 0 failed, 30 skipped") ─────────────────────
// The dashboard listed the account's trades UNFILTERED; the delivery job asked CSFloat for
// `state=pending` only. Every id the operator ticked was therefore absent from the set the job
// searched, so all 30 fell through to "no longer pending" and nothing was ever sent. The two sides
// must read the same list — pinned here on the request itself, because a mismatch is invisible in
// the counts (a fully-skipped run looks identical either way).
test('delivery reads the SAME unfiltered list the dashboard shows', async () => {
  const seen: Array<{ state?: string }> = [];
  const { worker, sends } = harness({ onFetch: (p) => seen.push(p) });
  worker.startDeliver('bot', ['t1']);
  await finish(worker);
  assert.deepEqual(seen.map((p) => p.state), [undefined], 'the job must not narrow the list by state');
  assert.deepEqual(sends.map((s) => s.assetId), ['111'], 'a ticked sale must actually be found and sent');
});

test('a sale CSFloat already calls finished is never re-delivered', async () => {
  const done = { ...trade('t5', '555'), state: 'verified' };
  const { worker, sends } = harness({ trades: [done] });
  worker.startDeliver('bot', ['t5']);   // hand-picked: the gate must still hold
  const job = await finish(worker);
  assert.deepEqual(sends, [], 'a finished sale must not produce a second offer');
  assert.equal(job.skipped, 1);
  assert.match(job.results[0].error!, /verified/i, 'and it must say which state stopped it');
});

test('terminalState only claims the states that unambiguously mean finished', () => {
  for (const s of ['verified', 'completed', 'cancelled', 'failed', 'expired', 'refunded', 'disputed']) {
    assert.equal(terminalState({ state: s }), s, `"${s}" is over`);
  }
  // Unknown / absent / in-progress states stay deliverable — a drifted word must never be able to
  // strand a sale that genuinely needs sending.
  for (const s of ['pending', 'queued', 'accepted', '', undefined, 'some_new_state']) {
    assert.equal(terminalState({ state: s }), '', `"${String(s)}" must remain deliverable`);
  }
});

test('a sale with no verified destination is refused, exactly as the poller refuses it', async () => {
  // No buyer steamID and no trade URL: the payload cannot say where the item goes.
  const { worker, sends } = harness({ trades: [{ id: 't9', contract: { item: { asset_id: '999' } } }] });
  worker.startDeliver('bot', ['t9']);
  const job = await finish(worker);
  assert.deepEqual(sends, [], 'nothing may be sent to an unverified destination');
  assert.equal(job.skipped, 1);
});

test('the same pre-flight that gates the poller gates the button', async () => {
  // Pool-lost: the account has no resolved network, so CSFloat egress would fall to the host IP.
  const { worker } = harness({ account: { username: 'bot', enabled: true, tier: 'full', network: undefined } });
  worker.startDeliver('bot', []);
  const job = await finish(worker);
  assert.match(job.error ?? '', /pool-lost|host IP/i);
  assert.equal(job.sent, 0);
});

test('a disabled account cannot be delivered by hand either', async () => {
  const { worker, sends } = harness({ account: { username: 'bot', enabled: false, tier: 'full', network: RESOLVED_NETWORK } });
  worker.startDeliver('bot', []);
  const job = await finish(worker);
  assert.deepEqual(sends, []);
  assert.match(job.error ?? '', /disabled/i);
});

test('an unconfirmed offer counts as unconfirmed and is still recorded as delivered', async () => {
  // The offer EXISTS on Steam; only the 2FA confirm did not land. Re-sending would create a second
  // real offer, so it must be marked delivered and surfaced for manual confirmation.
  const { worker } = harness({ trades: [trade('t1', '111')], send: async () => ({ status: 'unconfirmed', offerId: 'o7' }) });
  worker.startDeliver('bot', ['t1']);
  const job = await finish(worker);
  assert.equal(job.unconfirmed, 1);
  assert.equal(job.sent, 0);
  assert.deepEqual(worker.deliveredAmong(['t1']), ['t1'], 'it must never be auto-resent');
});

test('two delivery runs cannot overlap', async () => {
  const { worker } = harness();
  worker.startDeliver('bot', []);
  assert.throws(() => worker.startDeliver('bot', []), /already running/i);
  await finish(worker);
});

test('the poller stands down while a manual run owns the account', async () => {
  const { worker, sends } = harness();
  worker.startDeliver('bot', ['t1']);
  // runOnce is the poller's entry point; it must be a no-op while the manual job holds the account.
  await (worker as unknown as { runOnce: () => Promise<void> }).runOnce();
  await finish(worker);
  assert.deepEqual(sends.map((s) => s.assetId), ['111'], 'the poller must not race the operator into a duplicate send');
});
