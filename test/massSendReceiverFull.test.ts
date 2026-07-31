import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TradeService, type MassSendGroup } from '../src/trading/TradeService';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-126 — every group in a mass-send targets the SAME receiver, so a
//  full-inventory rejection dooms every remaining bot (each pays a login + the
//  pacing gap + a refused offer). The run must STOP at the first inventoryFull
//  rejection, exactly as an operator "End Task" does: the cooperative-cancel
//  checks drain the queue and the epilogue marks cancelled:true + stopReason.
//  A non-flagged (ordinary) failure must NOT stop the run — every bot is tried.
//
//  runMassSend only reads this.massJob / this.massCancel and delegates to the
//  private sendTrade + the session helpers, so Object.create + stubs exercise
//  the exact shipped worker/epilogue logic without a real Steam session.
// ─────────────────────────────────────────────────────────────────────────────

// The stub must honour `hooks.beforeDispatch` exactly as the real sendTrade does (v1.4.4): that hook is
// where the global throttle paces the offer AND where a cancel that landed during the gap aborts the send.
// A stub that skips it would fire every worker's offer instantly and misrepresent the shipped behaviour.
function svc(sendTrade: (username: string) => Promise<any>): any {
  const s: any = Object.create(TradeService.prototype);
  s.massJob = { running: true, cancelling: false, cancelled: false, total: 0, done: 0, sent: 0, confirmed: 0, unconfirmed: 0, failed: [], results: [] };
  s.massCancel = false;
  s.sendTrade = async (username: string, _params: any, hooks?: any) => {
    if (hooks?.beforeDispatch) await hooks.beforeDispatch();
    return sendTrade(username);
  };
  s.snapshotLive = () => new Set<string>();
  s.releaseCreatedSessions = async () => 0;
  return s;
}

const groups: MassSendGroup[] = [
  { username: 'botA', assetIds: ['a1'] },
  { username: 'botB', assetIds: ['b1'] },
  { username: 'botC', assetIds: ['c1'] },
];

test('H-TRD-126: an inventoryFull rejection stops the run immediately', async () => {
  let calls = 0;
  const s = svc(async () => {
    calls++;
    throw Object.assign(
      new Error("The recipient's inventory is full — there is no free space for these items."),
      { inventoryFull: true },
    );
  });
  // 12 bots, so "stopped early" is unambiguous rather than an artefact of a 3-item queue.
  const many: MassSendGroup[] = Array.from({ length: 12 }, (_, i) => ({ username: `bot${i}`, assetIds: [`a${i}`] }));
  await s.runMassSend(many, 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=x');
  const job = s.massStatus();
  // The first refusal sets massCancel; every other worker is still parked in its (≥1s) pacing slot, so it
  // aborts in beforeDispatch without dispatching. The refusal is far faster than one slot, so in practice
  // exactly one offer goes out — but the guarantee we depend on is "stops at once", not a magic number.
  assert.ok(calls <= 2, `the run stopped at the first full-inventory refusal (dispatched ${calls}/12)`);
  assert.equal(job.cancelled, true, 'the run marks itself cancelled (self-stop drains the queue)');
  assert.equal(job.stopReason, 'Receiver inventory full — remaining bots skipped', 'stopReason carries WHY it ended');
  assert.equal(job.failed.length, calls, 'only the refused offers are recorded as failed');
});

test('H-TRD-126: a non-flagged failure does NOT stop the run — every bot is attempted', async () => {
  let calls = 0;
  const s = svc(async () => {
    calls++;
    throw new Error('Steam Error 15: Access Denied'); // no inventoryFull flag
  });
  await s.runMassSend(groups, 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=x');
  const job = s.massStatus();
  assert.equal(calls, 3, 'all three groups were attempted');
  assert.equal(job.cancelled, false, 'the run was not cancelled');
  assert.equal(job.stopReason, undefined, 'no stopReason on an ordinary failure');
  assert.equal(job.failed.length, 3, 'all three failures are recorded');
});
