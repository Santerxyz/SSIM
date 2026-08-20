import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { InventoryService } from '../src/core/InventoryService';
import { fetchListedItems } from '../src/core/MarketListings';
import { SessionState } from '../src/types/session';

// ════════════════════════════════════════════════════════════════════════════
//  H-TRD-121 — a later-page failure (HTTP 429 on page ≥ 1) must be a HARD read
//  failure, NOT a silent "commit the pages read so far as the complete listed
//  set". Before the fix, page 0 threw but a non-200 on page 1+ just `break`ed:
//  fetchListedItems RESOLVED with a truncated bucket, listingsOk stayed true,
//  and the fresh-but-partial listed set OVERWROTE the fuller cached one. After
//  the fix it unifies on throw-at-any-page (matching AccountTrader.getListedAssetIds),
//  so the InventoryService carry-forward guard keeps the cached Listed stack.
// ════════════════════════════════════════════════════════════════════════════

const STEAMID = '76561190000000003';

// A full page-0 payload of exactly PAGE (100) listings so the loop advances to
// page 1 (listings.length === PAGE and total_count says there is more).
function fullListingsPage(): { success: number; total_count: number; listings: unknown[]; assets: unknown } {
  const listings = [];
  for (let i = 0; i < 100; i++) {
    listings.push({
      listingid: `L${i}`,
      price: 100,
      fee: 15,
      currencyid: 2003,
      asset: { id: `P0_${i}`, appid: 730, contextid: '2', amount: '1' },
    });
  }
  return { success: 1, total_count: 250, listings, assets: {} };
}

function fetchListedSession(): any {
  return {
    account: { username: 'diego', network: { type: 'localip' } },
    state: SessionState.LOGGED_IN,
    steamId: STEAMID,
    webSession: { cookies: ['steamLoginSecure=abc', 'sessionid=xyz'], sessionId: 'xyz', obtainedAt: new Date() },
    httpsAgent: undefined,
    wallet: undefined,
  };
}

test('H-TRD-121: fetchListedItems REJECTS when a later page (page 1) fails HTTP 429', async () => {
  const ax = require('axios');
  const orig = ax.get;
  const mock = async (url: string): Promise<{ status: number; data: unknown }> => {
    if (/start=0&/.test(url))   return { status: 200, data: fullListingsPage() };
    if (/start=100&/.test(url)) return { status: 429, data: {} };
    return { status: 404, data: {} };
  };
  ax.get = mock;
  if (ax.default) ax.default.get = mock;
  try {
    await assert.rejects(fetchListedItems(fetchListedSession()), /HTTP 429 \(page 1\)/);
  } finally {
    ax.get = orig;
    if (ax.default) ax.default.get = orig;
  }
});

// ── Integration: a cache with listed stacks is intact after a later-page failure ──

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
      if (/start=0&/.test(url))   return { status: 200, data: fullListingsPage() };
      return { status: 429, data: {} };                 // later page → hard failure
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
    account: { username: 'diego', network: { type: 'localip' } },
    client,
    state: SessionState.LOGGED_IN,
    steamId: STEAMID,
    webSession: { cookies: ['steamLoginSecure=abc', 'sessionid=xyz'], sessionId: 'xyz', obtainedAt: new Date() },
    httpsAgent: undefined,
    wallet: undefined,
  };
}

test('H-TRD-121: refresh carries the cached Listed stack forward (no wipe) on a later-page failure', async () => {
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

    // Prime the cache with a previously-known listed stack for this account.
    inv.gcStore.set('diego', {
      username: 'diego', steamId: STEAMID, game: 'cs2', source: 'gc',
      items: [{
        assetId: 'LISTED9', classId: 'C9', instanceId: '0',
        marketHashName: 'Desert Eagle | Blaze (Factory New)', name: 'Desert Eagle | Blaze (Factory New)',
        type: '', rarity: 'Unknown', rarityColor: '#6b7280', exterior: null,
        tradable: false, marketable: true, tradeLockExpiry: null,
        quantity: 1, assetIds: ['LISTED9'], iconUrl: 'iconL', category: 'listed',
      }] as any,
      totalItems: 1, fetchedAt: new Date(), fromCache: false, partial: false,
    } as any);

    const result = await inv.refreshOneViaGc('diego');

    // The cached listed stack survives — the truncated fetch did NOT wipe it.
    const listed = result.items.filter((i) => i.category === 'listed').flatMap((i) => i.assetIds.map(String));
    assert.ok(listed.includes('LISTED9'), 'previously-cached listed asset carried forward (no wipe)');
    // And the owned item still parsed normally.
    const owned = result.items.filter((i) => i.category === 'tradable').flatMap((i) => i.assetIds.map(String));
    assert.ok(owned.includes('A1'), 'owned item still parsed on the same pass');
  } finally {
    restore();
  }
});
