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

function svc(sendTrade: (username: string) => Promise<any>): any {
  const s: any = Object.create(TradeService.prototype);
  s.massJob = { running: true, cancelling: false, cancelled: false, total: 0, done: 0, sent: 0, confirmed: 0, unconfirmed: 0, failed: [], results: [] };
  s.massCancel = false;
  s.sendTrade = (username: string) => sendTrade(username);
  s.snapshotLive = () => new Set<string>();
  s.releaseCreatedSessions = async () => 0;
  return s;
}

const groups: MassSendGroup[] = [
  { username: 'botA', assetIds: ['a1'] },
  { username: 'botB', assetIds: ['b1'] },
  { username: 'botC', assetIds: ['c1'] },
];

test('H-TRD-126: an inventoryFull rejection stops the run after ONE send', async () => {
  let calls = 0;
  const s = svc(async () => {
    calls++;
    throw Object.assign(
      new Error("The recipient's inventory is full — there is no free space for these items."),
      { inventoryFull: true },
    );
  });
  await s.runMassSend(groups, 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=x');
  const job = s.massStatus();
  assert.equal(calls, 1, 'sendTrade fired exactly once — the remaining bots were skipped');
  assert.equal(job.cancelled, true, 'the run marks itself cancelled (self-stop drains the queue)');
  assert.equal(job.stopReason, 'Receiver inventory full — remaining bots skipped', 'stopReason carries WHY it ended');
  assert.equal(job.failed.length, 1, 'only the one refused offer is recorded as failed');
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
