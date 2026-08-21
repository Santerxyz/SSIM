import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { AccountTrader, matchRestingBuyOrder } from '../src/trading/AccountTrader';
import { BuyService } from '../src/trading/BuyService';
import { MoneyOpJournal } from '../src/core/MoneyOpJournal';

// ─── Buy-order money-safety (B10/B12) ──────────────────────────────────────────
// createbuyorder is a non-idempotent CREATE. A NETWORK error must never surface as a
// clean retryable failure once the order might exist, or an operator retry places a
// SECOND real-money order. The owner-protected mechanism (one POST '0', at most one
// re-POST carrying confirmation=<creator>) is unchanged — only the error handling is
// made money-safe.

function fakeTrader(overrides: Partial<Record<string, unknown>> = {}): AccountTrader {
  const t = Object.create(AccountTrader.prototype) as AccountTrader;
  Object.assign(t, {
    username: 'moneybot',
    // walletCountry is pre-cached exactly as a live session carries it after the first read, so
    // createBuyOrder does not go to Steam for it here — these tests are about commit ambiguity, not
    // country resolution (which marketAccessProbe.test.ts covers).
    session: { webSession: { cookies: ['sessionid=abc', 'steamLoginSecure=xyz'] }, httpsAgent: {}, walletCountry: 'DE' },
    ...overrides,
  });
  return t;
}

const REQ = { marketHashName: 'AK-47 | Redline', appId: 730, currency: 3, pricePerItemMinor: 1000, quantity: 1 };

test('matchRestingBuyOrder: matches only on exact game+item+price', () => {
  const orders = [
    { buyOrderId: '1', appId: 730, marketHashName: 'AK-47 | Redline', pricePerItemMinor: 1000, name: '', iconUrl: '', currency: 3, quantity: 1, quantityRemaining: 1 },
    { buyOrderId: '2', appId: 730, marketHashName: 'AK-47 | Redline', pricePerItemMinor: 999, name: '', iconUrl: '', currency: 3, quantity: 1, quantityRemaining: 1 },
  ];
  assert.equal(matchRestingBuyOrder(orders as never, { appId: 730, marketHashName: 'AK-47 | Redline', perItemMinor: 1000 })?.buyOrderId, '1');
  assert.equal(matchRestingBuyOrder(orders as never, { appId: 730, marketHashName: 'AK-47 | Redline', perItemMinor: 500 }), undefined);
  assert.equal(matchRestingBuyOrder(orders as never, { appId: 440, marketHashName: 'AK-47 | Redline', perItemMinor: 1000 }), undefined);
});

test('B10: a NETWORK error on the finalize re-POST reports placed+confirmed, never rethrows', async () => {
  const origPost = axios.post;
  let posts = 0;
  // POST '0' → success:22 (needs confirmation); re-POST → network throw.
  (axios as { post: unknown }).post = async () => {
    posts++;
    if (posts === 1) return { status: 200, data: { success: 22, confirmation: { confirmation_id: 'C1' } } };
    throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  };
  try {
    const trader = fakeTrader({
      acceptBuyConfirmation: async () => 'BUYORDER_CREATOR_123', // confirmation accepted → order is confirmed
    });
    const res = await trader.createBuyOrder({ ...REQ, retryAfterConfirm: true });
    assert.equal(res.placed, true, 'the order was created by POST 0 → placed');
    assert.equal(res.confirmed, true, 'its mobile confirmation was accepted → confirmed');
    assert.equal(res.needsConfirmation, false);
    assert.equal(res.buyOrderId, 'BUYORDER_CREATOR_123');
    assert.equal(posts, 2, 'exactly one create + one re-POST — never a fresh third create');
  } finally {
    (axios as { post: unknown }).post = origPost;
  }
});

test('B12: a NETWORK error on POST 0 with a matching resting order → placed (no rethrow, no retry)', async () => {
  const origPost = axios.post;
  (axios as { post: unknown }).post = async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); };
  try {
    const trader = fakeTrader({
      // The create actually landed; the probe finds the resting order.
      getMarketOrders: async () => ({
        sellOrders: [],
        buyOrders: [{ buyOrderId: 'RESTING_9', appId: 730, marketHashName: REQ.marketHashName, pricePerItemMinor: 1000, name: '', iconUrl: '', currency: 3, quantity: 1, quantityRemaining: 1 }],
      }),
    });
    const res = await trader.createBuyOrder(REQ);
    assert.equal(res.placed, true, 'a matching resting order proves the create landed');
    assert.equal(res.buyOrderId, 'RESTING_9');
  } finally {
    (axios as { post: unknown }).post = origPost;
  }
});

test('B12: a NETWORK error on POST 0 with NO matching order → throws verifyBeforeRetry (not a bare fault)', async () => {
  const origPost = axios.post;
  (axios as { post: unknown }).post = async () => { throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }); };
  try {
    const trader = fakeTrader({
      getMarketOrders: async () => ({ sellOrders: [], buyOrders: [] }), // probe succeeds, finds nothing
    });
    await assert.rejects(
      () => trader.createBuyOrder(REQ),
      (err: Error & { verifyBeforeRetry?: boolean }) => {
        assert.equal(err.verifyBeforeRetry, true, 'must carry the verify-before-retry signal');
        return true;
      },
    );
  } finally {
    (axios as { post: unknown }).post = origPost;
  }
});

// ─── H-TRD-039: buy()'s money ceilings fail OPEN on non-finite input, and a 0/negative ───
// quantity was up-coerced into a real 1-item purchase. buy() now fails CLOSED on non-finite /
// non-positive caller price/quantity BEFORE it can reach createBuyOrder. Both messages carry
// "invalid" so the /api/market/buy classifier buckets them as 400, not a retryable 502.

const BUY_P = { username: 'buybot', marketHashName: 'AK-47 | Redline', appId: 730, pricePerItemMinor: 1000, quantity: 1 };

/** A BuyService whose commit path is instrumented: `created` flips true iff createBuyOrder ran. The
 *  input guards reject BEFORE ensureWebSession/forceRefresh, so a rejection must leave `created` false. */
function makeBuyServiceTrackingCommit(): { svc: BuyService; state: { created: boolean } } {
  const state = { created: false };
  const trader = { walletCurrency: 3, createBuyOrder: async () => { state.created = true; return { placed: true, confirmed: true, needsConfirmation: false, buyOrderId: 'B1', raw: {} }; } };
  const svc = Object.create(BuyService.prototype) as BuyService;
  Object.assign(svc, {
    inFlight: new Set<string>(),
    journal: MoneyOpJournal.disabled(),
    trades: {
      ensureWebSession: async () => trader,
      snapshotLive: () => new Set<string>(),
      releaseCreatedSessions: async () => {},
    },
    inventory: { forceRefresh: async () => ({ partial: false, items: [], wallet: { balance: 100, currency: 3 } }) },
  });
  return { svc, state };
}

test('H-TRD-039: buy() with pricePerItemMinor NaN rejects /invalid pricePerItemMinor/ and never commits', async () => {
  const { svc, state } = makeBuyServiceTrackingCommit();
  await assert.rejects(
    svc.buy({ ...BUY_P, pricePerItemMinor: NaN }, { releaseSession: false }),
    /invalid pricePerItemMinor/,
    'a NaN price must fail closed, not flow into the (NaN-blinded) ceilings',
  );
  assert.equal(state.created, false, 'createBuyOrder must never run on invalid input');
});

test('H-TRD-039: buy() with quantity 0 rejects /invalid quantity/ (no silent up-coercion to a 1-item buy)', async () => {
  const { svc, state } = makeBuyServiceTrackingCommit();
  await assert.rejects(
    svc.buy({ ...BUY_P, quantity: 0 }, { releaseSession: false }),
    /invalid quantity/,
    'a zero request must reject, not buy one item',
  );
  assert.equal(state.created, false, 'createBuyOrder must never run on invalid input');
});

test('H-TRD-039: a valid buy() still reaches createBuyOrder and succeeds', async () => {
  const { svc, state } = makeBuyServiceTrackingCommit();
  const res = await svc.buy(BUY_P, { releaseSession: false });
  assert.equal(state.created, true, 'a well-formed call passes the input guards and commits');
  assert.equal(res.placed, true);
});

test('a clean Steam REJECTION (HTTP response, no confirmation) still throws — genuine failure, not placed', async () => {
  const origPost = axios.post;
  (axios as { post: unknown }).post = async () => ({ status: 200, data: { success: 8, message: 'There was a problem' } });
  try {
    const trader = fakeTrader();
    await assert.rejects(() => trader.createBuyOrder(REQ), /problem|rejected/i);
  } finally {
    (axios as { post: unknown }).post = origPost;
  }
});
