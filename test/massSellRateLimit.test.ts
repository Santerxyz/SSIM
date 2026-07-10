import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketService } from '../src/trading/MarketService';
import { EUR_CURRENCY } from '../src/pricing/MarketPricing';
import { parseMyListings, unconfirmedListedAssetIdsForApp, listedAssetIdsForApp } from '../src/core/MarketModel';

// ═════════════════════════════════════════════════════════════════════════════════════════════════
//  2026-07-10 — the mass-sell 2FA confirm hammered Steam's mobileconf endpoint with HTTP 429.
//  Two defects, both live-observed:
//    A) a 429 was classified only as `transient` and retried on the SHORT transport backoff (18s) up to
//       4 times — inside Steam's own rate-limit window, which cannot succeed and only re-arms it.
//    B) the confirm phase fired whenever ANY pre-existing listing was skipped, even when every one of
//       them was already ACTIVE — spending a mobileconf/getlist per bot for no possible effect.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

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
  s.confirmRateLimitPause = 0;   // the test asserts the BRANCH taken, not the wall-clock pause
  return s;
}
const resolveNet = async () => ({ net: 1000, transport: false });

const baseTrader = (over: Record<string, unknown>) => ({
  username: 'bot', walletCurrency: EUR_CURRENCY, httpsAgent: undefined, cookies: [],
  ready: true, sessionState: 'LOGGED_IN',
  sellOnMarket: async () => { throw new Error('should not list — everything is already listed'); },
  ...over,
});

// ── Defect A: a 429 is a rate-limit window, not a 500 ────────────────────────────────────────────

test('H-TRD-028: a 429 on the 2FA confirm is NOT retried like a 500 (bounded rate-limit retries)', async () => {
  let calls = 0;
  const trader: any = { username: 'bot', confirmMarketListings: async () => { calls++; throw new Error('HTTP error 429'); } };
  const s = svc();
  await assert.rejects(() => s.confirmWithRetry(trader, 'bot'), /429/);
  // 1 initial attempt + CONFIRM_RATELIMIT_RETRIES(2) — NOT the 4 attempts the transient path allowed.
  assert.equal(calls, 3, 'a rate-limited confirm must not be hammered 4× inside Steam\'s window');
});

test('H-TRD-028: a genuine 500 still gets the full transient retry budget', async () => {
  let calls = 0;
  const trader: any = { username: 'bot', confirmMarketListings: async () => { calls++; throw new Error('HTTP error 500'); } };
  const s = svc();
  await assert.rejects(() => s.confirmWithRetry(trader, 'bot'), /500/);
  assert.equal(calls, 4, 'Steam\'s confirm servers 500 a lot — that path is unchanged (1 + 3 retries)');
});

test('H-TRD-028: a 429 that clears on the retry still confirms, and banks the count', async () => {
  let calls = 0;
  const trader: any = {
    username: 'bot',
    confirmMarketListings: async () => {
      calls++;
      if (calls === 1) throw new Error('HTTP error 429');
      return { confirmed: 2 };
    },
  };
  const s = svc();
  assert.equal(await s.confirmWithRetry(trader, 'bot'), 2);
  assert.equal(calls, 2);
});

test('H-TRD-027 preserved: a partial pass banks confirmedSoFar even when the retries give up on a 429', async () => {
  const trader: any = {
    username: 'bot',
    confirmMarketListings: async () => ({ confirmed: 1, error: new Error('HTTP error 429') }),
  };
  const s = svc();
  await s.confirmWithRetry(trader, 'bot').then(
    () => assert.fail('should reject'),
    (e: any) => assert.equal(e.confirmedSoFar, 3, '1 confirmed per pass × 3 passes is still banked honestly'),
  );
});

// ── Defect B: only an UNCONFIRMED pre-existing listing justifies a getlist ───────────────────────

test('H-TRD-029: pre-existing listings that are already ACTIVE do not trigger a 2FA pass', async () => {
  let confirmCalls = 0;
  const trader: any = baseTrader({
    // Steam says: both assets are listed, and NEITHER awaits confirmation.
    getListedAssets: async () => ({ listed: new Set(['a1', 'a2']), unconfirmed: new Set<string>() }),
    getListedAssetIds: async () => new Set(['a1', 'a2']),
    confirmMarketListings: async () => { confirmCalls++; return { confirmed: 0 }; },
  });
  const s = svc();
  s.trades = { ensureWebSession: async () => trader };

  await s.processBot({ username: 'bot', items: [{ assetId: 'a1', marketHashName: 'AK' }, { assetId: 'a2', marketHashName: 'AWP' }] }, resolveNet, 0);

  assert.equal(confirmCalls, 0, 'nothing awaits 2FA → no mobileconf/getlist is spent');
  assert.equal(s.job.listed, 2, 'both are still counted as listed');
  assert.equal(s.job.failed.length, 0);
});

test('H-TRD-029: an UNCONFIRMED pre-existing listing still arms the confirm phase (H-TRD-026 intact)', async () => {
  let confirmCalls = 0;
  const trader: any = baseTrader({
    getListedAssets: async () => ({ listed: new Set(['a1', 'a2']), unconfirmed: new Set(['a2']) }),
    getListedAssetIds: async () => new Set(['a1', 'a2']),
    confirmMarketListings: async () => { confirmCalls++; return { confirmed: 1 }; },
  });
  const s = svc();
  s.trades = { ensureWebSession: async () => trader };

  await s.processBot({ username: 'bot', items: [{ assetId: 'a1', marketHashName: 'AK' }, { assetId: 'a2', marketHashName: 'AWP' }] }, resolveNet, 0);

  assert.equal(confirmCalls, 1, 'a crash-rerun with a pending listing must still confirm it');
  assert.equal(s.job.confirmed, 1);
});

test('H-TRD-029: a trader WITHOUT getListedAssets falls back fail-safe (confirms, never skips)', async () => {
  // Any collaborator that cannot report the unconfirmed subset must behave exactly as before.
  let confirmCalls = 0;
  const trader: any = baseTrader({
    getListedAssetIds: async () => new Set(['a1']),
    confirmMarketListings: async () => { confirmCalls++; return { confirmed: 1 }; },
  });
  const s = svc();
  s.trades = { ensureWebSession: async () => trader };

  await s.processBot({ username: 'bot', items: [{ assetId: 'a1', marketHashName: 'AK' }] }, resolveNet, 0);
  assert.equal(confirmCalls, 1, 'unknown confirmation state ⇒ assume unconfirmed ⇒ confirm');
});

// ── The parse that feeds it ──────────────────────────────────────────────────────────────────────

test('H-TRD-029: unconfirmedListedAssetIdsForApp picks out exactly the pending_listings', async () => {
  const page: any = {
    listings:          [{ listingid: '1', asset: { appid: 730, contextid: '2', id: 'active1', amount: 1 }, price: 100, fee: 15 }],
    pending_listings:  [{ listingid: '',  asset: { appid: 730, contextid: '2', id: 'pending1', amount: 1 }, price: 100, fee: 15 }],
    listings_on_hold:  [{ listingid: '3', asset: { appid: 730, contextid: '2', id: 'onhold1', amount: 1 }, price: 100, fee: 15 }],
    assets: {},
  };
  const p = parseMyListings(page);
  const unconfirmed = unconfirmedListedAssetIdsForApp(p, 730);
  const listed = listedAssetIdsForApp(p, 730);

  assert.deepEqual([...unconfirmed], ['pending1'], 'only the pending listing awaits 2FA');
  assert.ok(!unconfirmed.has('onhold1'), 'an ON-HOLD listing is a CONFIRMED sell, not an awaiting-2FA one');
  assert.ok(!unconfirmed.has('active1'));
  assert.equal(unconfirmedListedAssetIdsForApp(p, 440).size, 0, 'app-filtered: a TF2 asset id never leaks in');
  assert.ok(listed.size >= 1, 'the listed superset is unchanged');
});
