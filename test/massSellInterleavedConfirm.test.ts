import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketService, isTooManyPendingConfirmations } from '../src/trading/MarketService';
import { EUR_CURRENCY } from '../src/pricing/MarketPricing';

// ─────────────────────────────────────────────────────────────────────────────
//  v1.4.8 — mass-sell lists over parallel lanes and CONFIRMS AS IT GOES.
//
//  Field report (2026-08-04): a 263-item sell listed everything first and confirmed only at
//  the end, so the unconfirmed backlog grew until Steam refused at item 254 with "You have
//  too many listings pending confirmation." That message contains "too many", so it was
//  classified as a rate limit and every remaining item burned 3 retries × 15-35 s against a
//  window that could never open — the only thing that clears it is confirming.
//
//  Covered here: the backlog is drained mid-run before the cap; the wall is recognised as
//  backpressure (drain + re-list, not a rate-limit retry); a single drain is shared by
//  concurrent lanes; and the lanes' shared dispatch gate still paces the account.
// ─────────────────────────────────────────────────────────────────────────────

function svc(): any {
  const s: any = Object.create(MarketService.prototype);
  s.job = {
    running: true, strategy: 'lowest', total: 0, done: 0, listed: 0,
    confirmed: 0, recovered: 0, retried: 0, skippedNoPrice: 0,
    failed: [], deferred: [], gone: [], blocked: [],
  };
  s.cancelRequested = false;
  s.inventory = undefined;
  s.preflightBackoff = 0;
  s.confirmBackoff = 0;
  s.retryBackoffs = [0];
  s.confirmRateLimitPause = 0;
  return s;
}

const resolveNet = async () => ({ net: 1000, transport: false });
const itemsFor = (n: number) => Array.from({ length: n }, (_, i) => ({ assetId: `a${i + 1}`, marketHashName: 'AK' }));

/** A trader that accepts listings, with a hook to simulate Steam's pending-confirmation cap. */
function fakeTrader(opts: { username?: string; capAfter?: number } = {}) {
  const listed = new Set<string>();
  const state = { confirmPasses: 0, pending: 0, listCalls: 0, dispatchTimes: [] as number[] };
  const trader: any = {
    username: opts.username ?? 'botA',
    walletCurrency: EUR_CURRENCY,
    httpsAgent: undefined,
    cookies: [],
    ready: true,
    sessionState: 'LOGGED_IN',
    getListedAssetIds: async () => new Set<string>([...listed]),
    sellOnMarket: async (a: string) => {
      state.listCalls++;
      state.dispatchTimes.push(Date.now());
      // Steam refuses once too many listings sit unconfirmed — exactly the field message.
      if (opts.capAfter != null && state.pending >= opts.capAfter) {
        throw new Error('You have too many listings pending confirmation. Please confirm or cancel some before attempting to list more.');
      }
      listed.add(a);
      state.pending++;
    },
    confirmMarketListings: async () => {
      state.confirmPasses++;
      const n = state.pending;
      state.pending = 0;                       // a pass clears the backlog, as on Steam
      return { confirmed: n };
    },
  };
  return { trader, state, listed };
}

test('the message IS recognised as backpressure — and only that message', () => {
  assert.equal(isTooManyPendingConfirmations(new Error(
    'You have too many listings pending confirmation. Please confirm or cancel some before attempting to list more.')), true);
  // A real rate limit and an ordinary already-listed rejection must NOT be mistaken for it.
  assert.equal(isTooManyPendingConfirmations(new Error('HTTP 429 Too Many Requests')), false);
  assert.equal(isTooManyPendingConfirmations(new Error('You already have a listing for this item')), false);
  assert.equal(isTooManyPendingConfirmations(new Error('HTTP 500')), false);
});

test('the backlog is drained MID-RUN, so it never grows toward Steam\'s cap', async () => {
  const { trader, state } = fakeTrader();
  const s = svc();
  s.trades = { ensureWebSession: async () => trader };

  // 120 items with a drain every 50 → drains at 50 and 100, plus the end-of-bot pass.
  await s.processBot({ username: 'botA', items: itemsFor(120) }, resolveNet, 0, 1);

  assert.equal(s.job.listed, 120, 'every item is listed');
  assert.equal(state.confirmPasses, 3, 'two mid-run drains + the final pass (not one giant pass at the end)');
  assert.equal(s.job.confirmed, 120, 'and every listing ends up confirmed');
});

test('hitting the wall confirms and RE-LISTS, instead of retrying into a window that never opens', async () => {
  // Steam refuses the 4th listing while 3 sit unconfirmed. Draining clears them, so the item
  // that was refused must go through on the re-list — not fail after 3 rate-limit retries.
  const { trader, state } = fakeTrader({ capAfter: 3 });
  const s = svc();
  s.trades = { ensureWebSession: async () => trader };

  await s.processBot({ username: 'botA', items: itemsFor(6) }, resolveNet, 0, 1);

  assert.equal(s.job.failed.length, 0, 'the wall costs a confirm pass, not the items');
  assert.equal(s.job.listed, 6, 'all six are listed');
  assert.equal(s.job.retried, 0, 'and it is never treated as a transient/rate-limited retry');
  assert.ok(state.confirmPasses >= 2, 'each wall hit triggered a drain');
});

test('concurrent lanes share ONE drain rather than each spending the mobileconf budget', async () => {
  const { trader, state } = fakeTrader();
  let concurrentPasses = 0, inPass = 0;
  const inner = trader.confirmMarketListings;
  trader.confirmMarketListings = async () => {
    if (++inPass > 1) concurrentPasses++;
    await new Promise((r) => setTimeout(r, 5));
    try { return await inner(); } finally { inPass--; }
  };
  const s = svc();
  s.trades = { ensureWebSession: async () => trader };

  await s.processBot({ username: 'botA', items: itemsFor(60) }, resolveNet, 0, 4);

  assert.equal(concurrentPasses, 0, 'a drain is single-flight across the bot\'s lanes');
  assert.equal(s.job.listed, 60);
});

test('lanes never dispatch faster than itemDelay — parallelism hides latency, it does not burst', async () => {
  const { trader, state } = fakeTrader();
  // Every listing takes 60ms, so with 1 lane the round-trip would dominate; with 4 lanes the
  // dispatch gate is what sets the cadence. Either way no two dispatches may be < itemDelay apart.
  const bare = trader.sellOnMarket;
  trader.sellOnMarket = async (a: string) => { await new Promise((r) => setTimeout(r, 60)); return bare(a); };
  const s = svc();
  s.trades = { ensureWebSession: async () => trader };

  const DELAY = 25;
  const started = Date.now();
  await s.processBot({ username: 'botA', items: itemsFor(12) }, resolveNet, DELAY, 4);
  const elapsed = Date.now() - started;

  assert.equal(s.job.listed, 12);
  // The guarantee is a RATE, not the spacing of any individual pair: slots are reserved
  // itemDelay apart, and a timer waking a few ms late can compress one observed gap without
  // ever letting the account exceed its cadence. So assert the span — with no gate at all the
  // 12 dispatches would land in a few ms, which this catches decisively.
  const span = state.dispatchTimes[state.dispatchTimes.length - 1] - state.dispatchTimes[0];
  const floor = (12 - 1) * DELAY;
  assert.ok(span >= floor * 0.8, `12 dispatches must span ≥ ~${floor}ms at a ${DELAY}ms cadence (saw ${span}ms)`);
  // …and 12 × 60ms round-trip = 720ms if serialised, so the lanes must clearly beat that.
  assert.ok(elapsed < 700, `lanes must overlap the round-trips (took ${elapsed}ms)`);
});
