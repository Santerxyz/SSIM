import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuyService } from '../src/trading/BuyService';

// ─── H-TRD-041: a B31 stale-fallback substitution (InventoryService returns the pre-buy
// cache clone for a suspect fresh read) must mark the fill UNVERIFIED — otherwise buy()
// hands back the pre-buy snapshot as if it were a fresh verification and confidently reports
// filled=0 on an order that may have instantly filled. The substituted clone is stamped
// `staleReadFallback:true`; both the BEFORE and AFTER reads must treat it as a failed fresh read.

function makeBuyService(beforeInv: Record<string, unknown>, afterInv: Record<string, unknown>): BuyService {
  const svc = Object.create(BuyService.prototype) as BuyService;
  const trader = { walletCurrency: 3 };
  let call = 0;
  Object.assign(svc, {
    inFlight: new Set<string>(),
    journal: { findUnresolved: () => undefined, consultRefusal: () => undefined, begin: () => {}, record: () => {}, resolve: () => {} },
    trades: {
      ensureWebSession: async () => trader,
      snapshotLive: () => new Set<string>(),
      releaseCreatedSessions: async () => {},
    },
    inventory: {
      forceRefresh: async () => (call++ === 0 ? beforeInv : afterInv),
    },
  });
  (trader as Record<string, unknown>).createBuyOrder = async () => ({
    placed: true, confirmed: true, needsConfirmation: false, buyOrderId: 'B1', raw: {},
  });
  return svc;
}

const P = { username: 'buybot', marketHashName: 'AK-47 | Redline', appId: 730, pricePerItemMinor: 1000, quantity: 1 };

test('H-TRD-041 (a): a stale-fallback AFTER read → verifyFailed=true (no false "resting" claim)', async () => {
  const before = { partial: false, items: [], wallet: { balance: 100, currency: 3 } };
  // The suspect after-read hands back the pre-buy snapshot, stamped as a stale fallback.
  const after  = { partial: false, staleReadFallback: true, items: [], wallet: { balance: 100, currency: 3 } };
  const res = await makeBuyService(before, after).buy(P, { releaseSession: false });
  assert.equal(res.placed, true, 'the order still proceeds — money path unaffected');
  assert.equal(res.verifyFailed, true, 'a stale-fallback after-read is a failed fresh read');
  assert.match(res.message, /verification failed/, 'message flags the unverified outcome');
});

test('H-TRD-041 (b): a stale-fallback BASELINE read → verifyFailed=true', async () => {
  const before = { partial: false, staleReadFallback: true, items: [], wallet: { balance: 100, currency: 3 } };
  const after  = { partial: false, items: [{ marketHashName: P.marketHashName, category: 'tradable', quantity: 1, assetIds: ['x'] }], wallet: { balance: 90, currency: 3 } };
  const res = await makeBuyService(before, after).buy(P, { releaseSession: false });
  assert.equal(res.verifyFailed, true, 'a stale-fallback baseline mis-anchors ownedBefore → unverified');
  assert.match(res.message, /verification failed/, 'message flags the unverified outcome');
});
