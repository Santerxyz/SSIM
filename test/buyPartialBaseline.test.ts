import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuyService } from '../src/trading/BuyService';

// ─── B15: a PARTIAL (page-capped) baseline read must mark the fill unverified ───
// filled = ownedAfter - ownedBefore. If the BEFORE read was truncated, ownedBefore is
// under-counted → the fill diff over-reports. The AFTER read already guards this; the
// BEFORE read must too. The order still proceeds (money unaffected); only the reported
// fill is flagged unverified.

function makeBuyService(beforeInv: Record<string, unknown>, afterInv: Record<string, unknown>): BuyService {
  const svc = Object.create(BuyService.prototype) as BuyService;
  const trader = { walletCurrency: 3 };
  let call = 0;
  Object.assign(svc, {
    inFlight: new Set<string>(),
    // No-op money-op journal (B4): this fixture bypasses the constructor (Object.create), so it must
    // supply the journal dependency buy() now uses. A no-op keeps this test focused on the fill logic.
    journal: { findUnresolved: () => undefined, begin: () => {}, record: () => {}, resolve: () => {} },
    trades: {
      ensureWebSession: async () => trader,
      snapshotLive: () => new Set<string>(),
      releaseCreatedSessions: async () => {},
    },
    inventory: {
      forceRefresh: async () => (call++ === 0 ? beforeInv : afterInv),
    },
  });
  // Stub the placed order (createBuyOrder is on the trader returned by ensureWebSession).
  (trader as Record<string, unknown>).createBuyOrder = async () => ({
    placed: true, confirmed: true, needsConfirmation: false, buyOrderId: 'B1', raw: {},
  });
  return svc;
}

const P = { username: 'buybot', marketHashName: 'AK-47 | Redline', appId: 730, pricePerItemMinor: 1000, quantity: 1 };

test('B15: a truncated baseline read → verifyFailed=true (no wrong fill count claimed)', async () => {
  const before = { partial: true, items: [], wallet: { balance: 100, currency: 3 } };
  const after  = { partial: false, items: [{ marketHashName: P.marketHashName, category: 'tradable', quantity: 1, assetIds: ['x'] }], wallet: { balance: 90, currency: 3 } };
  const res = await makeBuyService(before, after).buy(P, { releaseSession: false });
  assert.equal(res.placed, true, 'the order still proceeds — money path unaffected');
  assert.equal(res.verifyFailed, true, 'a partial baseline makes the fill diff unverifiable');
});

test('B15: a complete baseline read still reports the real fill', async () => {
  const before = { partial: false, items: [], wallet: { balance: 100, currency: 3 } };
  const after  = { partial: false, items: [{ marketHashName: P.marketHashName, category: 'tradable', quantity: 1, assetIds: ['x'] }], wallet: { balance: 90, currency: 3 } };
  const res = await makeBuyService(before, after).buy(P, { releaseSession: false });
  assert.equal(res.verifyFailed, false, 'a full baseline is trustworthy');
  assert.equal(res.filled, 1, 'the real fill is reported');
});
