import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { AccountTrader } from '../src/trading/AccountTrader';

// ─── H-TRD-004: getMarketOrders must not present a truncated snapshot as complete ──────
// A non-200 / malformed body at page ≥ 1, or a failed buy-order landing fallback, keeps the
// rows accumulated so far but flags `partial: true` — the Active Orders tab labels the list
// as incomplete instead of lying that listings vanished (sibling getListedAssetIds throws on
// the same condition, but here partial-labeled beats fail-all AND beats today's unlabeled).

function fakeTrader(): AccountTrader {
  const t = Object.create(AccountTrader.prototype) as AccountTrader;
  Object.assign(t, {
    username: 'orderbot',
    session: { webSession: { cookies: ['sessionid=abc', 'steamLoginSecure=xyz'] }, httpsAgent: {} },
  });
  return t;
}

/** A market/mylistings/render page carrying `n` well-formed sell listings (assetids 1..n
 *  offset by `base` so pages don't collide), with `total_count` so pagination continues. */
function listingsPage(n: number, base: number, total: number): { total_count: number; listings: unknown[]; assets: unknown } {
  const listings = Array.from({ length: n }, (_, i) => {
    const id = String(base + i + 1);
    return { listingid: `L${id}`, asset: { id, appid: 730, contextid: '2', amount: 1 }, price: 1000, fee: 150, currencyid: 2003 };
  });
  return { total_count: total, listings, assets: {} };
}

test('H-TRD-004: page 0 OK (100 rows) + page 1 → 429 ⇒ 100 sell rows and partial === true', async () => {
  const origGet = axios.get;
  (axios as { get: unknown }).get = async (url: string) => {
    if (url.includes('start=0'))   return { status: 200, data: listingsPage(100, 0, 250) };
    if (url.includes('start=100')) return { status: 429, data: '<html>Too Many Requests</html>' };
    // landing fallback (no start=) — succeed with no buy orders so it doesn't muddy `partial`.
    return { status: 200, data: { total_count: 0, listings: [], assets: {}, buy_orders: [] } };
  };
  try {
    const res = await fakeTrader().getMarketOrders();
    assert.equal(res.sellOrders.length, 100, 'the 100 page-0 rows are kept, not discarded');
    assert.equal(res.partial, true, 'the mid-pagination 429 must flag the snapshot as partial');
  } finally {
    (axios as { get: unknown }).get = origGet;
  }
});

test('H-TRD-004: buy-order landing fallback rejection ⇒ buyOrders: [] and partial === true', async () => {
  const origGet = axios.get;
  (axios as { get: unknown }).get = async (url: string) => {
    if (url.includes('start=0')) return { status: 200, data: listingsPage(3, 0, 3) }; // < PAGE → last page, no buy_orders
    throw new Error('ECONNRESET'); // the landing fallback GET rejects
  };
  try {
    const res = await fakeTrader().getMarketOrders();
    assert.deepEqual(res.buyOrders, [], 'a failed fallback yields no buy orders (not fabricated)');
    assert.equal(res.partial, true, 'buy orders are UNKNOWN, not "none" — the snapshot is partial');
  } finally {
    (axios as { get: unknown }).get = origGet;
  }
});

test('H-TRD-004: clean full fetch ⇒ partial is falsy', async () => {
  const origGet = axios.get;
  (axios as { get: unknown }).get = async (url: string) => {
    if (url.includes('start=0')) return { status: 200, data: listingsPage(2, 0, 2) }; // last page
    return { status: 200, data: { total_count: 0, listings: [], assets: {}, buy_orders: [] } }; // landing: no buys
  };
  try {
    const res = await fakeTrader().getMarketOrders();
    assert.equal(res.sellOrders.length, 2);
    assert.ok(!res.partial, 'a complete fetch must not be labeled partial');
  } finally {
    (axios as { get: unknown }).get = origGet;
  }
});
