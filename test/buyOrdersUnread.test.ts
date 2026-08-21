import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { AccountTrader } from '../src/trading/AccountTrader';
import { SessionState } from '../src/types/session';

// ════════════════════════════════════════════════════════════════════════════════════════════════
//  1.5.1 — owner report: a buy order that Steam accepted (`success=1`, placed, confirmed) showed as
//  "0 buy" in Active Orders. It works on most accounts and not on donaldjohnston02, which rules out
//  a blanket parser failure and points at how a PER-ACCOUNT payload difference is handled.
//
//  The defect is a fail-open. collectBuyOrders did:
//
//      const orders = Array.isArray(d?.buy_orders) ? d.buy_orders : [];
//
//  so a response that never mentions `buy_orders` produced zero orders and left `partial` false —
//  SSIM asserting "this account has no buy orders" on evidence that cannot support it. The sell side
//  has always refused exactly this coercion: parseMyListings THROWS on a non-listings body rather
//  than call it "no listings". These tests hold the buy side to the same rule.
//
//  Absent ≠ empty. `buy_orders: []` is Steam answering the question; no key at all is Steam not
//  answering it, and the two must never render as the same zero.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const STEAMID = '76561198663764461';

function trader(): AccountTrader {
  const session: any = {
    account: { username: 'donaldjohnston02', network: { type: 'localip' } },
    state: SessionState.LOGGED_IN,
    steamId: STEAMID,
    webSession: { cookies: ['steamLoginSecure=abc', 'sessionid=xyz'], sessionId: 'xyz', obtainedAt: new Date() },
    httpsAgent: undefined,
    wallet: undefined,
  };
  const t: any = Object.create(AccountTrader.prototype);
  t.session = session;
  t.username = 'donaldjohnston02';
  return t as AccountTrader;
}

/** A listings page with no sell listings — donaldjohnston02's actual shape (`0 listed item(s)`). */
const emptyListings = { success: 1, total_count: 0, listings: [], assets: {} };

const buyOrder = (id: string, appid: number | undefined) => ({
  buy_orderid: id,
  appid,
  hash_name: 'Mann Co. Supply Crate Key',
  wallet_currency: 3,
  price: '198',
  quantity: '1',
  quantity_remaining: '1',
  description: { appid, market_hash_name: 'Mann Co. Supply Crate Key', name: 'Mann Co. Supply Crate Key' },
});

async function withAxios(handler: (url: string) => Promise<{ status: number; data: unknown }>, fn: () => Promise<void>): Promise<void> {
  const orig = axios.get;
  (axios as { get: unknown }).get = handler;
  try { await fn(); } finally { (axios as { get: unknown }).get = orig; }
}

// ── The reported case ────────────────────────────────────────────────────────────────────────────

test('H-BUY-080: a payload that never mentions buy_orders is UNREAD, not "no buy orders"', async () => {
  // Neither the render page nor the landing page carries the key. Before the fix this returned a
  // clean `0 buy` with partial:false — a confident zero SSIM had no basis for.
  await withAxios(async () => ({ status: 200, data: emptyListings }), async () => {
    const res = await trader().getMarketOrders();
    assert.deepEqual(res.buyOrders, [], 'nothing is fabricated');
    assert.equal(res.partial, true, 'the snapshot must declare itself incomplete — buy orders were never read');
  });
});

test('H-BUY-081: buy_orders: [] IS an answer — a genuinely empty account is not flagged partial', async () => {
  // The other half of the contract. If every account read as "unknown", the flag would mean nothing.
  await withAxios(async (url) => (url.includes('start=')
    ? { status: 200, data: emptyListings }
    : { status: 200, data: { ...emptyListings, buy_orders: [] } }), async () => {
    const res = await trader().getMarketOrders();
    assert.deepEqual(res.buyOrders, []);
    assert.ok(!res.partial, 'Steam said "none" explicitly, so the snapshot is complete');
  });
});

test('H-BUY-082: a real resting order is parsed off the landing page with its appid intact', async () => {
  await withAxios(async (url) => (url.includes('start=')
    ? { status: 200, data: emptyListings }
    : { status: 200, data: { ...emptyListings, buy_orders: [buyOrder('BO-1', 440)] } }), async () => {
    const res = await trader().getMarketOrders();
    assert.equal(res.buyOrders.length, 1);
    assert.equal(res.buyOrders[0].buyOrderId, 'BO-1');
    assert.equal(res.buyOrders[0].appId, 440, 'the appid must survive — the view filters on it');
    assert.equal(res.buyOrders[0].pricePerItemMinor, 198);
    assert.ok(!res.partial);
  });
});

test('H-BUY-083: an order with NO appid is still returned, not silently dropped', async () => {
  // appId 0 is filtered out of a game-scoped view downstream. Keeping the row (and warning) is what
  // lets that be noticed; dropping it here would make the order invisible with no trace at all.
  await withAxios(async (url) => (url.includes('start=')
    ? { status: 200, data: emptyListings }
    : { status: 200, data: { ...emptyListings, buy_orders: [buyOrder('BO-2', undefined)] } }), async () => {
    const res = await trader().getMarketOrders();
    assert.equal(res.buyOrders.length, 1, 'the row survives the parse');
    assert.equal(res.buyOrders[0].appId, 0, 'and reports the unknown app honestly rather than guessing 730');
  });
});

test('H-BUY-084: buy orders on the RENDER page are picked up without needing the landing fetch', async () => {
  let landingFetches = 0;
  await withAxios(async (url) => {
    if (url.includes('start=')) return { status: 200, data: { ...emptyListings, buy_orders: [buyOrder('BO-3', 730)] } };
    landingFetches++;
    return { status: 200, data: emptyListings };
  }, async () => {
    const res = await trader().getMarketOrders();
    assert.equal(res.buyOrders.length, 1);
    assert.equal(landingFetches, 0, 'no second request when the first payload already answered');
    assert.ok(!res.partial);
  });
});

test('H-BUY-085: a failed landing fetch stays partial and fabricates nothing', async () => {
  await withAxios(async (url) => {
    if (url.includes('start=')) return { status: 200, data: emptyListings };
    throw new Error('ECONNRESET');
  }, async () => {
    const res = await trader().getMarketOrders();
    assert.deepEqual(res.buyOrders, []);
    assert.equal(res.partial, true);
  });
});
