import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { InventoryService } from '../src/core/InventoryService';
import { fetchListedItems } from '../src/core/MarketListings';
import { SessionState } from '../src/types/session';

// ════════════════════════════════════════════════════════════════════════════
//  H-TRD-122 — the MAX_PAGES cap (30 pages × 100 = 3000 listings) must be
//  SIGNALLED. An account with >3000 listings previously exited the loop with no
//  marker: the listed bucket was cached as COMPLETE and every listing past 3000
//  vanished on every refresh. After the fix `fetchListedItems` returns
//  `truncated: true` on cap exhaustion, and the InventoryService folds it into
//  `inv.partial` (C12) so the cache is never claimed complete.
// ════════════════════════════════════════════════════════════════════════════

const STEAMID = '76561190000000004';

// A full page of exactly PAGE (100) listings so the loop always advances: with
// total_count kept above the pages read so far, neither break fires and the loop
// runs to the MAX_PAGES cap.
function fullListingsPage(start: number): { success: number; total_count: number; listings: unknown[]; assets: unknown } {
  const listings = [];
  for (let i = 0; i < 100; i++) {
    listings.push({
      listingid: `L${start}_${i}`,
      price: 100,
      fee: 15,
      currencyid: 2003,
      asset: { id: `P${start}_${i}`, appid: 730, contextid: '2', amount: '1' },
    });
  }
  return { success: 1, total_count: 3500, listings, assets: {} };
}

function onePageAccount(): { success: number; total_count: number; listings: unknown[]; assets: unknown } {
  const listings = [{
    listingid: 'ONLY1', price: 100, fee: 15, currencyid: 2003,
    asset: { id: 'ONLY_ASSET', appid: 730, contextid: '2', amount: '1' },
  }];
  return { success: 1, total_count: 1, listings, assets: {} };
}

function fetchListedSession(): any {
  return {
    account: { username: 'whale', network: { type: 'localip' } },
    state: SessionState.LOGGED_IN,
    steamId: STEAMID,
    webSession: { cookies: ['steamLoginSecure=abc', 'sessionid=xyz'], sessionId: 'xyz', obtainedAt: new Date() },
    httpsAgent: undefined,
    wallet: undefined,
  };
}

test('H-TRD-122: fetchListedItems flags truncated=true when the MAX_PAGES cap is exhausted', async () => {
  const ax = require('axios');
  const orig = ax.get;
  // Every mylistings page returns a FULL page of 100 with total_count still ahead,
  // so the loop never breaks early and runs to the cap.
  const mock = async (url: string): Promise<{ status: number; data: unknown }> => {
    const m = /start=(\d+)&/.exec(url);
    const start = m ? Number(m[1]) : 0;
    return { status: 200, data: fullListingsPage(start) };
  };
  ax.get = mock;
  if (ax.default) ax.default.get = mock;
  try {
    const result = await fetchListedItems(fetchListedSession());
    assert.equal(result.truncated, true, 'cap exhaustion sets truncated');
  } finally {
    ax.get = orig;
    if (ax.default) ax.default.get = orig;
  }
});

test('H-TRD-122: fetchListedItems flags truncated=false for a one-page account', async () => {
  const ax = require('axios');
  const orig = ax.get;
  const mock = async (): Promise<{ status: number; data: unknown }> => {
    return { status: 200, data: onePageAccount() };
  };
  ax.get = mock;
  if (ax.default) ax.default.get = mock;
  try {
    const result = await fetchListedItems(fetchListedSession());
    assert.equal(result.truncated, false, 'a single page is complete');
  } finally {
    ax.get = orig;
    if (ax.default) ax.default.get = orig;
  }
});

// ── Integration: cap exhaustion propagates to the cached AccountInventory.partial ──

const CTX2 = {
  success: 1, total_inventory_count: 1,
  assets: [{ appid: 730, contextid: '2', assetid: 'A1', classid: 'C1', instanceid: '0', amount: '1' }],
  descriptions: [{
    appid: 730, classid: 'C1', instanceid: '0',
    market_hash_name: 'AK-47 | Redline (Field-Tested)', name: 'AK-47 | Redline (Field-Tested)', type: 'Rifle',
    tradable: 1, marketable: 1, commodity: 0, icon_url: 'icon1', tags: [],
  }],
};
const CTX16 = { success: 1, total_inventory_count: 0, assets: [], descriptions: [] };

function installAxiosMock(): () => void {
  const ax = require('axios');
  const orig = ax.get;
  const mock = async (url: string): Promise<{ status: number; data: unknown }> => {
    if (/\/inventory\/\d+\/730\/16(\?|$)/.test(url)) return { status: 200, data: CTX16 };
    if (/\/inventory\/\d+\/730\/2(\?|$)/.test(url))  return { status: 200, data: CTX2 };
    if (/market\/mylistings\/render/.test(url)) {
      const m = /start=(\d+)&/.exec(url);
      const start = m ? Number(m[1]) : 0;
      return { status: 200, data: fullListingsPage(start) };  // every page full → cap exhausted
    }
    if (/market\/mylistings\//.test(url)) return { status: 200, data: { listings: [], buy_orders: [] } };
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
    account: { username: 'whale', network: { type: 'localip' } },
    client,
    state: SessionState.LOGGED_IN,
    steamId: STEAMID,
    webSession: { cookies: ['steamLoginSecure=abc', 'sessionid=xyz'], sessionId: 'xyz', obtainedAt: new Date() },
    httpsAgent: undefined,
    wallet: undefined,
  };
}

test('H-TRD-122: refresh marks AccountInventory.partial=true when listings hit the cap', async () => {
  const restore = installAxiosMock();
  try {
    const session = fakeSession();
    const mockSessions: any = {
      getSession: () => session,
      isLive: () => true,
      loginAccount: async () => session,
      loginAccountOwned: async () => ({ session, createdByCall: false }),
      logoutAccount: async () => undefined,
      markUsed: () => undefined,
      isEgressStale: () => false,   // 1.5.1 reuse guard: this stub session logged in over the CURRENT egress
    };
    const mockAccounts: any = { get: (u: string) => ({ username: u, network: { type: 'localip' } }) };
    const inv = new InventoryService(mockSessions, mockAccounts);

    const result = await inv.refreshOneViaGc('whale');

    assert.equal(result.partial, true, 'cap-exhausted listings mark the cached inventory INCOMPLETE');
  } finally {
    restore();
  }
});
