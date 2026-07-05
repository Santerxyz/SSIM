import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { AccountTrader } from '../src/trading/AccountTrader';
import { isAmbiguousCommitFailure } from '../src/trading/commitAmbiguity';

// ─── H-TRD-103: a RETURNED Steam-edge HTTP 5xx on the initial createbuyorder POST ──────
// validateStatus:() => true means a 504 does NOT throw — it returns a status. The create
// may have executed before the upstream answer was lost (same response-leg-lost case as an
// ECONNRESET), so it must NOT fall through to the definite-rejection throw. It probes for a
// matching resting order; if none, it throws the EXPLICIT verify-before-retry signal so
// BuyService retains the MoneyOpJournal entry (isAmbiguousCommitFailure → true) and the
// operator's immediate retry is refused-once instead of placing a SECOND real-money order.

function fakeTrader(overrides: Partial<Record<string, unknown>> = {}): AccountTrader {
  const t = Object.create(AccountTrader.prototype) as AccountTrader;
  Object.assign(t, {
    username: 'moneybot',
    session: { webSession: { cookies: ['sessionid=abc', 'steamLoginSecure=xyz'] }, httpsAgent: {} },
    ...overrides,
  });
  return t;
}

const REQ = { marketHashName: 'AK-47 | Redline', appId: 730, currency: 3, pricePerItemMinor: 1000, quantity: 1 };

test('H-TRD-103: a RETURNED HTTP 504 on POST 0 with a matching resting order → placed (no rethrow)', async () => {
  const origPost = axios.post;
  (axios as { post: unknown }).post = async () => ({ status: 504, data: '<html>' });
  try {
    const trader = fakeTrader({
      // the create actually landed; the probe finds the resting order.
      getMarketOrders: async () => ({
        sellOrders: [],
        buyOrders: [{ buyOrderId: 'RESTING_5', appId: 730, marketHashName: REQ.marketHashName, pricePerItemMinor: 1000, name: '', iconUrl: '', currency: 3, quantity: 1, quantityRemaining: 1 }],
      }),
    });
    const res = await trader.createBuyOrder(REQ);
    assert.equal(res.placed, true, 'a matching resting order proves the create landed despite the 504');
    assert.equal(res.buyOrderId, 'RESTING_5');
  } finally {
    (axios as { post: unknown }).post = origPost;
  }
});

test('H-TRD-103: a RETURNED HTTP 504 on POST 0 with NO matching order → throws verifyBeforeRetry (ambiguous)', async () => {
  const origPost = axios.post;
  (axios as { post: unknown }).post = async () => ({ status: 504, data: '<html>' });
  try {
    const trader = fakeTrader({
      getMarketOrders: async () => ({ sellOrders: [], buyOrders: [] }), // probe succeeds, finds nothing
    });
    await assert.rejects(
      () => trader.createBuyOrder(REQ),
      (err: Error & { verifyBeforeRetry?: boolean }) => {
        assert.equal(err.verifyBeforeRetry, true, 'must carry the verify-before-retry signal');
        // the same error, classified: BuyService keeps the journal entry → refuse-once on retry.
        assert.equal(isAmbiguousCommitFailure(err), true, 'a returned 5xx must classify as ambiguous, not a definite rejection');
        return true;
      },
    );
  } finally {
    (axios as { post: unknown }).post = origPost;
  }
});
