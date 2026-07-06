import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketService } from '../src/trading/MarketService';
import { EUR_CURRENCY } from '../src/pricing/MarketPricing';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-027 — a partial 2FA confirm pass confirms some listings before failing.
//  confirmMarketListings now resolves { confirmed, error? } instead of rejecting,
//  so confirmWithRetry accumulates the count across attempts and processBot counts
//  whatever was confirmed even when the retry chain ultimately gives up. Without
//  the fix the pre-failure count was destroyed by the reject and job.confirmed
//  under-reported (operator hunts for "unconfirmed" listings that don't exist).
//  processBot is driven directly via Object.create so the shipped orchestration runs.
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

const items = [
  { assetId: 'a1', marketHashName: 'AK' },
  { assetId: 'a2', marketHashName: 'AWP' },
];

test('H-TRD-027: transient partial then success — confirmed accumulates across attempts', async () => {
  const listed = new Set<string>();
  // Attempt 1: confirms 7 then hits a transient (HTTP 500) mid-pass.
  // Attempt 2: confirms the remaining 1 cleanly.
  const passes: Array<{ confirmed: number; error?: Error }> = [
    { confirmed: 7, error: new Error('HTTP 500 from confirmation server') },
    { confirmed: 1 },
  ];
  let call = 0;
  const trader: any = {
    username: 'botA',
    walletCurrency: EUR_CURRENCY,
    httpsAgent: undefined,
    cookies: [],
    ready: true,
    sessionState: 'LOGGED_IN',
    getListedAssetIds: async () => new Set<string>([...listed]),
    sellOnMarket: async (a: string) => { listed.add(a); },
    confirmMarketListings: async () => passes[call++],
  };
  const s = svc();
  s.trades = { ensureWebSession: async () => trader };

  await s.processBot({ username: 'botA', items }, resolveNet, 0);

  assert.equal(call, 2, 'the transient partial pass is retried once');
  assert.equal(s.job.confirmed, 8, 'the 7 pre-failure confirms are not lost — total is 7 + 1');
});

test('H-TRD-027: hard partial failure — confirmed reflects what was confirmed before the give-up', async () => {
  const listed = new Set<string>();
  // A non-transient mid-pass failure (identity_secret rejected) confirms 2 then gives up.
  let call = 0;
  const trader: any = {
    username: 'botB',
    walletCurrency: EUR_CURRENCY,
    httpsAgent: undefined,
    cookies: [],
    ready: true,
    sessionState: 'LOGGED_IN',
    getListedAssetIds: async () => new Set<string>([...listed]),
    sellOnMarket: async (a: string) => { listed.add(a); },
    confirmMarketListings: async () => { call++; return { confirmed: 2, error: new Error('identity_secret rejected by Steam') }; },
  };
  const s = svc();
  s.trades = { ensureWebSession: async () => trader };

  await s.processBot({ username: 'botB', items }, resolveNet, 0);

  assert.equal(call, 1, 'a hard failure is not retried');
  assert.equal(s.job.confirmed, 2, 'the 2 confirmed before the hard failure are still counted');
});
