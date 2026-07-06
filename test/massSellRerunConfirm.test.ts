import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketService } from '../src/trading/MarketService';
import { EUR_CURRENCY } from '../src/pricing/MarketPricing';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-026 — a re-run after a process death (listings created but the confirm
//  phase never ran) must still arm the 2FA confirm phase for pre-existing
//  listings. The "already listed → skipped" branch used to increment listed/done
//  but NOT pendingForBot, so with pendingForBot === 0 the confirm phase was never
//  reached and the listings stayed pending forever. processBot is driven directly
//  via Object.create so the exact shipped orchestration runs; confirmMarketListings
//  is idempotent, so the extra call is safe (resolves 0 when nothing is pending).
// ─────────────────────────────────────────────────────────────────────────────

function svc(): any {
  const s: any = Object.create(MarketService.prototype);
  s.job = {
    running: true, strategy: 'lowest', total: 0, done: 0, listed: 0,
    confirmed: 0, recovered: 0, retried: 0, skippedNoPrice: 0,
    failed: [], deferred: [], gone: [], blocked: [],
  };
  s.cancelRequested = false;
  s.inventory = undefined;              // isAssetSellable → true (no cached inventory)
  s.preflightBackoff = 0;
  s.confirmBackoff = 0;
  return s;
}

// resolveNet always returns a real EUR net so pricing never defers/skips.
const resolveNet = async () => ({ net: 1000, transport: false });

test('H-TRD-026: crash-rerun — every item already listed still fires the 2FA confirm phase', async () => {
  let confirmCalls = 0;
  const trader: any = {
    username: 'botA',
    walletCurrency: EUR_CURRENCY,
    httpsAgent: undefined,
    cookies: [],
    ready: true,
    sessionState: 'LOGGED_IN',
    // getListedAssetIds includes the items behind pending-confirmation listings,
    // so a crash-rerun sees every item as already listed.
    getListedAssetIds: async () => new Set(['a1', 'a2']),
    sellOnMarket: async () => { throw new Error('should not list — everything is already listed'); },
    confirmMarketListings: async () => { confirmCalls++; return { confirmed: 2 }; },
  };
  const s = svc();
  s.trades = { ensureWebSession: async () => trader };

  await s.processBot(
    { username: 'botA', items: [{ assetId: 'a1', marketHashName: 'AK' }, { assetId: 'a2', marketHashName: 'AWP' }] },
    resolveNet,
    0,
  );

  assert.equal(confirmCalls, 1, 'the confirm phase must run once even though nothing new was listed');
  assert.equal(s.job.confirmed, 2, 'both pre-existing listings are confirmed');
  assert.equal(s.job.listed, 2, 'both items are counted as listed');
  assert.equal(s.job.failed.length, 0);
});

test('H-TRD-026: fresh listing (empty listedSet) still confirms exactly once — existing behavior preserved', async () => {
  let confirmCalls = 0;
  const listed = new Set<string>();
  const trader: any = {
    username: 'botB',
    walletCurrency: EUR_CURRENCY,
    httpsAgent: undefined,
    cookies: [],
    ready: true,
    sessionState: 'LOGGED_IN',
    getListedAssetIds: async () => new Set([...listed]),
    sellOnMarket: async (a: string) => { listed.add(a); },
    confirmMarketListings: async () => { confirmCalls++; return { confirmed: 1 }; },
  };
  const s = svc();
  s.trades = { ensureWebSession: async () => trader };

  await s.processBot(
    { username: 'botB', items: [{ assetId: 'b1', marketHashName: 'M4' }] },
    resolveNet,
    0,
  );

  assert.equal(confirmCalls, 1, 'a freshly listed item arms the confirm phase exactly once');
  assert.equal(s.job.confirmed, 1);
  assert.equal(s.job.listed, 1);
});
