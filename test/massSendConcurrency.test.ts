import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TradeService, createDispatchThrottle, type MassSendGroup } from '../src/trading/TradeService';

// ─────────────────────────────────────────────────────────────────────────────
//  v1.4.4 issue 7 — "allow multi threading at sending items… I think 5 is good.
//  one is just waay too slow."
//
//  The pre-v1.4.4 ceiling was 1, justified as the Steam Error 15 (per-recipient
//  spam) guard. But the thing the receiver actually feels is the OFFER CADENCE,
//  which is owned by the global dispatch throttle — not by the worker count. What
//  concurrency 1 really serialised was the expensive per-sender preamble (login,
//  web-session pre-flight, inventory load, 2FA ≈ 10–20s each).
//
//  So: 5 workers, and the throttle moved to a `beforeDispatch` hook that fires
//  AFTER each sender's login and immediately BEFORE its offer goes to Steam. These
//  tests pin both halves — the parallelism AND the preserved cadence.
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function svc(sendTrade: (username: string, params: any, hooks?: any) => Promise<any>): any {
  const s: any = Object.create(TradeService.prototype);
  s.massJob = { running: true, cancelling: false, cancelled: false, total: 0, done: 0, sent: 0, confirmed: 0, unconfirmed: 0, failed: [], results: [] };
  s.massCancel = false;
  s.sendTrade = sendTrade;
  s.snapshotLive = () => new Set<string>();
  s.releaseCreatedSessions = async () => 0;
  return s;
}

const TRADE_URL = 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=x';
const groups = (n: number): MassSendGroup[] =>
  Array.from({ length: n }, (_, i) => ({ username: `bot${i}`, assetIds: [`a${i}`] }));

test('mass-send runs senders CONCURRENTLY (the slow login preamble overlaps)', async () => {
  let inFlight = 0, peak = 0;
  const s = svc(async (_u, _p, hooks) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 40));   // stands in for the login/pre-flight
    if (hooks?.beforeDispatch) await hooks.beforeDispatch();
    inFlight--;
    return { offerId: '1', status: 'confirmed' };
  });

  // delayMs:0 → the throttle floor still applies (1s), so keep the batch small.
  await s.runMassSend(groups(5), TRADE_URL);

  assert.ok(peak > 1, `senders must overlap; peak in-flight was ${peak}`);
  assert.ok(peak <= 5, `never exceed the hard ceiling of 5; peak was ${peak}`);
  assert.equal(s.massStatus().sent, 5, 'every bot still sent exactly once');
  assert.equal(s.massStatus().done, 5, 'done counts every attempted bot');
});

test('the offer CADENCE at the receiver is unchanged — dispatches stay ≥1 slot apart (Error 15 guard)', async () => {
  const dispatchedAt: number[] = [];
  const s = svc(async (_u, _p, hooks) => {
    // Logins finish at wildly different times; the guard must not depend on that.
    await new Promise((r) => setTimeout(r, Math.random() * 30));
    if (hooks?.beforeDispatch) await hooks.beforeDispatch();
    dispatchedAt.push(Date.now());                 // the moment the offer reaches Steam
    return { offerId: '1', status: 'confirmed' };
  });

  await s.runMassSend(groups(3), TRADE_URL);

  assert.equal(dispatchedAt.length, 3);
  dispatchedAt.sort((a, b) => a - b);
  for (let i = 1; i < dispatchedAt.length; i++) {
    const gap = dispatchedAt[i] - dispatchedAt[i - 1];
    // TRADE_MIN_DELAY_MS is 1000; allow a small scheduler slack.
    assert.ok(gap >= 900, `offers ${i - 1}→${i} were only ${gap}ms apart — the receiver would see a burst`);
  }
});

test('an operator cancel DURING the pacing gap dispatches nothing and does not count the bot as failed', async () => {
  let sends = 0;
  const s = svc(async (_u, _p, hooks) => {
    if (hooks?.beforeDispatch) await hooks.beforeDispatch();  // throws once massCancel is set
    sends++;
    return { offerId: '1', status: 'confirmed' };
  });
  // Cancel as soon as the run starts, so the first paced offer is aborted in its gap.
  setTimeout(() => { s.massCancel = true; }, 5);

  await s.runMassSend(groups(3), TRADE_URL);
  const job = s.massStatus();

  assert.ok(sends <= 1, `no offer may be dispatched after the cancel (sent ${sends})`);
  assert.equal(job.failed.length, 0, 'a cancel-in-the-gap bot is NOT a failure');
  assert.equal(job.done, sends, 'done counts only bots that were actually attempted');
  assert.equal(job.cancelled, true, 'the run reports itself cancelled');
});

test('the dispatch throttle reserves distinct increasing slots across concurrent workers', () => {
  // The reservation is what makes a raised ceiling safe, so pin it directly (no timers).
  let t = 0;
  const th = createDispatchThrottle(1_000, 1_000, () => t, () => 0);
  // Five workers reserve "simultaneously" at t=0.
  const waits = [th.reserveWaitMs(), th.reserveWaitMs(), th.reserveWaitMs(), th.reserveWaitMs(), th.reserveWaitMs()];
  assert.deepEqual(waits, [0, 1000, 2000, 3000, 4000], 'each concurrent reservation gets its own later slot');
});
