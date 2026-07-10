import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMyListings, mergeParsed, emptyParsed, listingsForApp, listedAssetIdsForApp,
  bucketOf, isSellable, assertSellable,
} from '../src/core/MarketModel';
import { InventoryManager } from '../src/core/InventoryManager';
import type { CS2Item } from '../src/types/inventory';

// A market/mylistings/render page with TWO sell listings:
//   - asset "111" HAS a description in the assets map (normal case)
//   - asset "222" has a listing object but NO entry in the assets map (the bug case:
//     the old strict parser in MarketListings.ts:62-64 DROPPED this, so it became
//     "Listed=0" while the lenient Active-Orders parser still showed it → contradiction)
const PAGE = {
  total_count: 2,
  listings: [
    { listingid: 'L111', asset: { appid: 730, contextid: '2', id: '111', amount: '1' }, price: 1000, fee: 150, currencyid: 2003 },
    { listingid: 'L222', asset: { appid: 730, contextid: '2', id: '222', amount: '1' }, price: 2000, fee: 300, currencyid: 2003 },
  ],
  assets: {
    '730': { '2': {
      '111': { market_hash_name: 'AK-47 | Redline (FT)', name: 'AK-47 | Redline (FT)', icon_url: 'abc' },
      // NOTE: no '222' here — the listing has no usable description.
    } },
  },
};

// ── INV-B3 / C1+C2: one inclusive parser, membership independent of metadata ──

test('parseMyListings KEEPS a listing whose asset has no description (inclusive)', () => {
  const p = parseMyListings(PAGE);
  const ids = listingsForApp(p, 730).map(l => l.assetId).sort();
  assert.deepEqual(ids, ['111', '222'], 'both listings kept, even the description-less one');
  const l222 = listingsForApp(p, 730).find(l => l.assetId === '222')!;
  assert.equal(l222.name, 'Unknown', 'missing description degrades the name, never drops the listing');
  assert.equal(l222.pricePerItemMinor, 2300, 'price+fee still parsed');
});

test('the listed-bucket asset-id set EQUALS the active-orders asset-id set (INV-B3/B6)', () => {
  const p = parseMyListings(PAGE);
  // The inventory "Listed" bucket dedup set:
  const bucketIds = listedAssetIdsForApp(p, 730);
  // The Active Orders sell list (same canonical listings):
  const orderIds = new Set(listingsForApp(p, 730).map(l => l.assetId));
  assert.deepEqual([...bucketIds].sort(), [...orderIds].sort(),
    'the two views derive from one model and can no longer disagree');
});

// ── H-TRD-112: assetIdsByApp is a TRUE superset — an appId-0 listing is not dropped ──

test('a listing whose asset has no appid stays in listings AND its id enters the superset (key 0)', () => {
  const p = parseMyListings({
    total_count: 1,
    listings: [
      { listingid: 'L333', asset: { contextid: '2', id: '333', amount: '1' }, price: 1000, fee: 0 },
    ],
    assets: {},
  });
  assert.ok(p.listings.some(l => l.assetId === '333'), 'appId-0 listing kept in listings');
  assert.ok(p.assetIdsByApp.get(0)?.has('333'), 'its asset id is in the dedup superset under key 0');
});

// Demonstrates WHY the old code diverged — the two historical acceptance rules,
// replicated locally, disagree on asset "222". This guards against ever
// reintroducing a second, stricter parser.
test('the historical strict vs lenient rules DIVERGED on the metadata-less listing', () => {
  const assetMap: any = PAGE.assets['730']['2'];
  const strictKept = PAGE.listings.filter(l => {                 // old MarketListings.ts:62-64
    const desc = assetMap[l.asset.id];
    if (!desc) return false;
    if (!desc.market_hash_name && !desc.name) return false;
    return true;
  }).map(l => l.asset.id);
  const lenientKept = PAGE.listings.filter(l =>                  // old AccountTrader.ts:1126
    l.listingid && l.asset.id && l.asset.appid).map(l => l.asset.id);
  assert.notDeepEqual(strictKept, lenientKept, 'proof the old parsers disagreed (the field bug)');
  // …and the unified parser matches the inclusive side, eliminating the gap.
  const unified = listingsForApp(parseMyListings(PAGE), 730).map(l => l.assetId);
  assert.deepEqual(unified.sort(), lenientKept.sort());
});

// ── H-TRD-114: honest name fallbacks + classid-disambiguated 'Unknown' sentinel ─

test('parseMyListings: an empty-string name falls back to the sentinel, never a blank row', () => {
  const p = parseMyListings({
    total_count: 1,
    listings: [{ listingid: 'E1', asset: { appid: 730, contextid: '2', id: '900', amount: '1' }, price: 100, fee: 0 }],
    assets: { '730': { '2': { '900': { market_hash_name: '', name: '' } } } },
  });
  const l = p.listings.find(x => x.assetId === '900')!;
  assert.notEqual(l.name, '', 'an empty-string name must never survive as a blank-named row');
  assert.equal(l.name, 'Unknown');
  assert.equal(l.marketHashName, 'Unknown');
});

test('parseMyListings: two unnamed listings with DISTINCT classids do not collapse into one Unknown stack', () => {
  const p = parseMyListings({
    total_count: 2,
    listings: [
      { listingid: 'U1', asset: { appid: 730, contextid: '2', id: '901', amount: '1' }, price: 100, fee: 0 },
      { listingid: 'U2', asset: { appid: 730, contextid: '2', id: '902', amount: '1' }, price: 100, fee: 0 },
    ],
    assets: { '730': { '2': {
      '901': { classid: '77' },   // no name → sentinel, disambiguated by classid
      '902': { classid: '88' },
    } } },
  });
  const a = p.listings.find(x => x.assetId === '901')!;
  const b = p.listings.find(x => x.assetId === '902')!;
  assert.equal(a.marketHashName, 'Unknown (77)');
  assert.equal(b.marketHashName, 'Unknown (88)');
  // The stack keys on marketHashName, so distinct sentinels keep the two assets apart.
  const toItem = (l: typeof a): CS2Item => ({
    assetId: l.assetId, classId: l.classId, instanceId: l.instanceId,
    marketHashName: l.marketHashName, name: l.name, type: '', rarity: 'Unknown',
    rarityColor: '#6b7280', exterior: null, tradable: false, marketable: true,
    tradeLockExpiry: null, quantity: 1, assetIds: [l.assetId], iconUrl: l.iconUrl,
    category: 'listed', listingConfirmed: l.confirmed,
  });
  const stacks = InventoryManager.stack([toItem(a), toItem(b)]);
  assert.equal(stacks.length, 2, 'two different unidentified listings stay as two rows');
});

// ── INV-B4 / C4: bucket reads BOTH tradeLockExpiry AND tradable ──────────────

test('bucketOf: a non-tradable item with no lock is NOT in the tradable bucket', () => {
  const past = Date.now() - 1000;
  // 2026-07-10: it is 'untradable', not 'tradelocked'. Still fail-closed (≠ tradable), but now NAMED: a
  // Storage Unit / Veteran Coin has no unlock date and never will, so calling it "Locked" promised a
  // countdown that never arrives. 262 items in the live cache were mislabelled this way.
  assert.equal(bucketOf({ tradable: false, tradeLockExpiry: null }), 'untradable');
  assert.equal(bucketOf({ tradable: true,  tradeLockExpiry: null }), 'tradable');
  assert.equal(bucketOf({ tradable: true,  tradeLockExpiry: new Date(Date.now() + 1e7) }), 'tradelocked');
  assert.equal(bucketOf({ tradable: true,  tradeLockExpiry: new Date(past) }), 'tradable');
  assert.equal(bucketOf({ category: 'listed', tradable: false }), 'listed');
});

// ── 2026-07-10: four distinct states, and the BRANCH ORDER is load-bearing ────────────────────────

test('bucketOf: four distinct states — listed / tradelocked / untradable / tradable', () => {
  const soon = new Date(Date.now() + 1e7);
  assert.equal(bucketOf({ category: 'listed', tradable: false, tradeLockExpiry: null }), 'listed');
  assert.equal(bucketOf({ tradable: false, tradeLockExpiry: soon }), 'tradelocked', 'a HELD item has a date');
  assert.equal(bucketOf({ tradable: false, tradeLockExpiry: null }), 'untradable', 'an INERT item has none');
  assert.equal(bucketOf({ tradable: true,  tradeLockExpiry: null }), 'tradable');
});

test('bucketOf: a HELD item is never mislabelled inert — expiry is tested before tradability', () => {
  // Every hold that reaches bucketOf carries a future expiry: parseTradeLock routes an undatable hold to
  // the far-future TRADE_LOCK_DATE_UNKNOWN sentinel, and applyManualLock stamps a real Date before
  // tagCategories runs. If the untradable branch ever moved above the expiry branch, all of these would
  // silently become "Not tradable" and the operator would lose every countdown.
  const sentinel = new Date('2099-01-01T00:00:00.000Z');
  assert.equal(bucketOf({ tradable: false, tradeLockExpiry: sentinel }), 'tradelocked', 'date-unknown sentinel ⇒ held');
  assert.equal(bucketOf({ tradable: false, tradeLockExpiry: new Date(Date.now() + 864e5) }), 'tradelocked', 'manual protection ⇒ held');
  assert.equal(bucketOf({ tradable: true,  tradeLockExpiry: 'not-a-date' }), 'tradelocked', 'unparseable ⇒ fail closed, still held');
});

test('bucketOf: `listed` wins over every other signal (it is market-sourced truth)', () => {
  assert.equal(bucketOf({ category: 'listed', tradable: true }), 'listed');
  assert.equal(bucketOf({ category: 'listed', tradable: false, tradeLockExpiry: new Date(Date.now() + 1e7) }), 'listed');
});

test('bucketOf: `untradable` is still fail-closed — it is never the tradable bucket', () => {
  for (const inert of [{ tradable: false }, {}, { tradable: undefined }]) {
    assert.notEqual(bucketOf(inert), 'tradable', 'an item Steam does not call tradable is never "tradable"');
  }
  // …and isSellable, which every money path actually gates on, is untouched by the rename.
  assert.equal(isSellable({ tradable: false, tradeLockExpiry: null }), false);
});

// ── INV-B2 / INV-D1 / C3: locked/untradable items are not sellable/sendable ──

test('isSellable / assertSellable refuse trade-locked and non-tradable items', () => {
  assert.equal(isSellable({ tradable: true, tradeLockExpiry: null }), true);
  assert.equal(isSellable({ tradable: true, tradeLockExpiry: new Date(Date.now() + 1e7) }), false);
  assert.equal(isSellable({ tradable: false, tradeLockExpiry: null }), false);
  assert.throws(() => assertSellable({ assetId: '999', tradable: false }), /trade-locked or not tradable/);
  assert.doesNotThrow(() => assertSellable({ assetId: '1', tradable: true, tradeLockExpiry: null }));
});

// ── H-TRD-117: the gate fails CLOSED on a missing flag or an unparseable date ──

test('isSellable fails closed on a missing tradable flag and an unparseable lock date', () => {
  assert.equal(isSellable({}), false, 'undefined tradable ⇒ not sellable');
  assert.equal(isSellable({ tradable: true, tradeLockExpiry: 'not-a-date' }), false, 'NaN lock date ⇒ not sellable');
});

test('bucketOf fails closed on a missing tradable flag and an unparseable lock date', () => {
  // The GUARANTEE is "never classified tradable". A missing flag means Steam never affirmed tradability,
  // so the item is inert-until-proven-otherwise; an unparseable DATE means a hold we could not read, which
  // stays 'tradelocked'. Both remain fail-closed; only the name of the first one changed (2026-07-10).
  assert.equal(bucketOf({}), 'untradable', 'undefined tradable ⇒ not classified tradable');
  assert.equal(bucketOf({ tradable: true, tradeLockExpiry: 'not-a-date' }), 'tradelocked', 'NaN lock date ⇒ tradelocked');
});

// ── H-TRD-111: a non-listings payload must NOT coerce to "successfully empty" ──

test('parseMyListings THROWS on {success:false} (Steam error body, HTTP 200)', () => {
  assert.throws(() => parseMyListings({ success: false }), /not a listings payload/);
});

test('parseMyListings THROWS on a structureless object ({})', () => {
  assert.throws(() => parseMyListings({}), /not a listings payload/);
});

test('parseMyListings returns empty (no throw) for a legit empty account', () => {
  const p = parseMyListings({ success: true, total_count: 0, listings: [], assets: {} });
  assert.equal(listingsForApp(p, 730).length, 0);
  assert.equal(listedAssetIdsForApp(p, 730).size, 0);
});

// ── H-TRD-116: mergeParsed dedups a listing re-fetched across a page boundary ──

test('mergeParsed keeps a listing shared by two pages only once (listingId)', () => {
  const p1 = parseMyListings({
    total_count: 2,
    listings: [
      { listingid: 'L111', asset: { appid: 730, contextid: '2', id: '111', amount: '1' }, price: 1000, fee: 150, currencyid: 2003 },
    ],
    assets: {},
  });
  const p2 = parseMyListings({
    total_count: 2,
    listings: [
      { listingid: 'L111', asset: { appid: 730, contextid: '2', id: '111', amount: '1' }, price: 1000, fee: 150, currencyid: 2003 },
      { listingid: 'L222', asset: { appid: 730, contextid: '2', id: '222', amount: '1' }, price: 2000, fee: 300, currencyid: 2003 },
    ],
    assets: {},
  });
  const acc = emptyParsed();
  mergeParsed(acc, p1);
  mergeParsed(acc, p2);
  assert.equal(acc.listings.length, 2, 'the re-fetched L111 is merged once, not twice');
  assert.deepEqual(listingsForApp(acc, 730).map(l => l.listingId).sort(), ['L111', 'L222']);
});

test('mergeParsed dedups a PENDING listing (listingId empty) by asset composite', () => {
  const pending = (id: string) => ({
    listings: [],
    pending_listings: [{ asset: { appid: 730, contextid: '2', id, amount: '1' } }],
    assets: {},
  });
  const acc = emptyParsed();
  mergeParsed(acc, parseMyListings(pending('333')));
  mergeParsed(acc, parseMyListings(pending('333')));      // same pending asset re-appears
  assert.equal(acc.listings.length, 1, 'a pending listing with no listingId is deduped by assetId');
});

test('mergeParsed keeps TWO distinct pending listings (different assetIds)', () => {
  const pending = (id: string) => ({
    listings: [],
    pending_listings: [{ asset: { appid: 730, contextid: '2', id, amount: '1' } }],
    assets: {},
  });
  const acc = emptyParsed();
  mergeParsed(acc, parseMyListings(pending('333')));
  mergeParsed(acc, parseMyListings(pending('444')));
  assert.equal(acc.listings.length, 2, 'distinct pending assets are both kept');
});

test('parseMyListings folds pending listings into the dedup superset (confirmed=false)', () => {
  const page = {
    listings: [], pending_listings: [
      { listingid: 'P1', asset: { appid: 730, contextid: '2', id: '333', amount: '1' } },
    ],
    assets: {},
  };
  const p = parseMyListings(page);
  assert.ok(listedAssetIdsForApp(p, 730).has('333'), 'pending asset is in the no-leak superset');
  assert.equal(listingsForApp(p, 730)[0].confirmed, false);
});

// ── H-TRD-115: an on-hold listing appears in the Listed bucket as confirmed=true ──

test('parseMyListings scans listings_on_hold → row is confirmed=true and in the superset', () => {
  const page = {
    listings: [], listings_on_hold: [
      { listingid: 'H1', asset: { appid: 730, contextid: '2', id: '444', amount: '1' } },
    ],
    assets: {},
  };
  const p = parseMyListings(page);
  const rows = listingsForApp(p, 730);
  assert.equal(rows.length, 1, 'the on-hold listing is kept as a Listed row');
  assert.equal(rows[0].confirmed, true, 'a server-side hold is confirmed, not awaiting-2FA');
  assert.ok(listedAssetIdsForApp(p, 730).has('444'), 'on-hold asset is in the no-leak superset');
});

// ── H-TRD-113: non-numeric currencyid falls back to 0 (the "0 = unknown" contract) ──

test('parseMyListings: a non-numeric currencyid yields currency 0 (not NaN)', () => {
  const p = parseMyListings({
    listings: [
      { listingid: 'L1', asset: { appid: 730, contextid: '2', id: '111', amount: '1' }, price: 1000, fee: 150, currencyid: 'garbage' },
    ],
    assets: {},
  });
  assert.equal(listingsForApp(p, 730)[0].currency, 0, 'malformed currencyid degrades to the unknown sentinel');
});

test('parseMyListings: a numeric-string currencyid round-trips (2003 → 3)', () => {
  const p = parseMyListings({
    listings: [
      { listingid: 'L1', asset: { appid: 730, contextid: '2', id: '111', amount: '1' }, price: 1000, fee: 150, currencyid: '2003' },
    ],
    assets: {},
  });
  assert.equal(listingsForApp(p, 730)[0].currency, 3, 'string currencyid still parses correctly');
});
