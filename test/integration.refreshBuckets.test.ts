import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { InventoryService } from '../src/core/InventoryService';
import { AccountTrader } from '../src/trading/AccountTrader';
import { isSellable } from '../src/core/MarketModel';
import { SessionState } from '../src/types/session';

// ════════════════════════════════════════════════════════════════════════════
//  INTEGRATION proof of the Critical fix — drives the REAL app wiring end to end
//  (InventoryService.refreshOneViaGc → fetchListedItems/parseMyListings → bucket
//  derivation, and AccountTrader.getMarketOrders → parseMyListings), with only the
//  HTTP boundary (axios.get) mocked. It is NOT parseMyListings in isolation.
//
//  The synthetic payload reproduces the field bug exactly:
//    • A3 — a live SELL listing whose asset has NO description in the listings `assets`
//      map (the metadata-less case the old strict parser DROPPED), AND that still
//      appears in the inventory contexts (Steam eventual-consistency / pending).
//    • A2 — a trade-locked item ("Tradable After 2099"), NOT listed.
//    • A1 — a normal owned tradable item.  A4 — a normal (described) listing.
//
//  PRE-FIX (run by reverting the 3 core files to 0cf374d~1): A3 is dropped from the
//  Listed bucket but kept in Active Orders → Listed≠Orders, A3 shows Owned → DIVERGED.
//  ON THE BRANCH: A3 is Listed, absent from Owned, and Listed-set == Orders-set.
// ════════════════════════════════════════════════════════════════════════════

const STEAMID = '76561190000000001';

const CTX2 = {
  success: 1, total_inventory_count: 1,
  assets: [{ appid: 730, contextid: '2', assetid: 'A1', classid: 'C1', instanceid: '0', amount: '1' }],
  descriptions: [{
    appid: 730, classid: 'C1', instanceid: '0',
    market_hash_name: 'AK-47 | Redline (Field-Tested)', market_name: 'AK-47 | Redline (Field-Tested)',
    name: 'AK-47 | Redline (Field-Tested)', type: 'Rifle', tradable: 1, marketable: 1, commodity: 0,
    icon_url: 'icon1', tags: [],
  }],
};

const CTX16 = {
  success: 1, total_inventory_count: 2,
  assets: [
    { appid: 730, contextid: '16', assetid: 'A2', classid: 'C2', instanceid: '0', amount: '1' },
    { appid: 730, contextid: '16', assetid: 'A3', classid: 'C3', instanceid: '0', amount: '1' },
  ],
  descriptions: [
    { appid: 730, classid: 'C2', instanceid: '0',
      market_hash_name: 'AWP | Asiimov (Field-Tested)', name: 'AWP | Asiimov (Field-Tested)', type: 'Sniper Rifle',
      tradable: 0, marketable: 1, commodity: 0, icon_url: 'icon2', tags: [],
      owner_descriptions: [{ type: 'html', value: 'Tradable After Jan 1, 2099 (07:00:00) GMT' }] },
    { appid: 730, classid: 'C3', instanceid: '0',
      market_hash_name: 'M4A4 | Howl (Field-Tested)', name: 'M4A4 | Howl (Field-Tested)', type: 'Rifle',
      tradable: 1, marketable: 1, commodity: 0, icon_url: 'icon3', tags: [] },
  ],
};

const MYLISTINGS = {
  total_count: 2,
  listings: [
    { listingid: 'L_A3', asset: { appid: 730, contextid: '2', id: 'A3', amount: '1' }, price: 1000, fee: 150, currencyid: 2003 },
    { listingid: 'L_A4', asset: { appid: 730, contextid: '2', id: 'A4', amount: '1' }, price: 2000, fee: 300, currencyid: 2003 },
  ],
  // NOTE: A3 is deliberately ABSENT from this map → a description-less listing.
  assets: { '730': { '2': {
    A4: { market_hash_name: 'Glock-18 | Fade (Factory New)', name: 'Glock-18 | Fade (Factory New)', classid: 'C4', instanceid: '0', icon_url: 'icon4' },
  } } },
  buy_orders: [],
};

function installAxiosMock(): () => void {
  // The under-test modules do `import axios from 'axios'` → `axios.default.get`, which (axios v1
  // is CJS, default === the instance) resolves to require('axios').get at call time. Patch it.
  const ax = require('axios');
  const orig = ax.get;
  const mock = async (url: string): Promise<{ status: number; data: unknown }> => {
    if (/\/inventory\/\d+\/730\/16(\?|$)/.test(url)) return { status: 200, data: CTX16 };
    if (/\/inventory\/\d+\/730\/2(\?|$)/.test(url))  return { status: 200, data: CTX2 };
    if (/market\/mylistings\/render/.test(url))       return { status: 200, data: MYLISTINGS };
    if (/market\/mylistings\//.test(url))             return { status: 200, data: { listings: [], buy_orders: [] } };
    return { status: 404, data: {} };
  };
  ax.get = mock;
  if (ax.default) ax.default.get = mock;
  return () => { ax.get = orig; if (ax.default) ax.default.get = orig; };
}

function fakeSession(): any {
  const client: any = new EventEmitter();
  client.steamID = { getSteamID64: () => STEAMID };
  return {
    account: { username: 'alejandro', network: { type: 'localip' } },
    client,
    state: SessionState.LOGGED_IN,
    steamId: STEAMID,
    webSession: { cookies: ['steamLoginSecure=abc', 'sessionid=xyz'], sessionId: 'xyz', obtainedAt: new Date() },
    httpsAgent: undefined,
    wallet: undefined,
  };
}

test('INTEGRATION: refresh→bucket and getMarketOrders agree; field bug cannot recur', async () => {
  const restore = installAxiosMock();
  try {
    const session = fakeSession();
    const mockSessions: any = {
      getSession: () => session,
      isLive: () => true,
      loginAccount: async () => session,
      loginAccountOwned: async () => ({ session, createdByCall: false }),
      logoutAccount: async () => undefined,
    };
    const mockAccounts: any = { get: (u: string) => ({ username: u, network: { type: 'localip' } }) };

    // ── REAL refresh path: login(mock) → fetchListedItems(parseMyListings) → bucket ──
    const inv = new InventoryService(mockSessions, mockAccounts);
    const result = await inv.refreshOneViaGc('alejandro');

    // ── REAL Active Orders path ──
    const trader = new AccountTrader(session);
    const orders = await trader.getMarketOrders();

    const idsOf = (cat: string): string[] =>
      result.items.filter((i) => i.category === cat).flatMap((i) => i.assetIds.map(String));
    const listedIds = new Set(idsOf('listed'));
    const ownedLockedIds = new Set([...idsOf('tradable'), ...idsOf('tradelocked')]);
    const sellOrderIds = new Set(orders.sellOrders.map((o) => String(o.assetId)));

    // INV-B1/B6: the description-less live listing A3 is LISTED and NOT owned/locked.
    assert.ok(listedIds.has('A3'), 'A3 (description-less live listing) is in the Listed bucket');
    assert.ok(!ownedLockedIds.has('A3'), 'A3 is ABSENT from owned/locked (no Owned+listed overlap)');

    // INV-B3: the Listed bucket and Active Orders describe the SAME set of live listings.
    assert.deepEqual([...listedIds].sort(), [...sellOrderIds].sort(),
      'Listed-bucket asset-ids == Active Orders sell asset-ids');

    // The two UI counts (Listed pill app.js:2407 sums quantity; Active Sell count app.js:1756
    // = sellOrders.length) therefore reconcile:
    const listedPill = result.items.filter((i) => i.category === 'listed').reduce((s, i) => s + (i.quantity || 1), 0);
    assert.equal(listedPill, orders.sellOrders.length, 'Listed pill count == Active Orders count');

    // INV-B2/D1: the trade-locked item is Locked, NOT an active order, and the guard refuses it.
    const lockedIds = new Set(idsOf('tradelocked'));
    assert.ok(lockedIds.has('A2'), 'A2 (trade-locked) is in the Locked bucket');
    assert.ok(!sellOrderIds.has('A2'), 'A2 is ABSENT from Active Orders (locked ⇒ no live sell listing)');
    const a2 = result.items.find((i) => i.assetIds.includes('A2'))!;
    assert.equal(isSellable(a2), false, 'assertSellable/isSellable refuses the trade-locked item on sell/send');

    // INV-B4: a normal owned item is correctly tradable.
    assert.ok(new Set(idsOf('tradable')).has('A1'), 'A1 (owned, tradable) is in the tradable bucket');
  } finally {
    restore();
  }
});
