import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { InventoryService } from '../src/core/InventoryService';
import { fetchListedItems } from '../src/core/MarketListings';
import { SessionState } from '../src/types/session';

// ════════════════════════════════════════════════════════════════════════════
//  H-TRD-111 INTEGRATION — a transient {"success":false} on mylistings page 0
//  (HTTP 200 error body served during a market-subsystem hiccup) must be classed
//  as a HARD read failure, NOT "successfully empty". Before the fix the parser
//  coerced it to zero listings, fetchListedItems RESOLVED empty, listingsOk stayed
//  true, and the Listed bucket was wiped while ctx16-listed assets re-surfaced as
//  tradelocked. After the fix: fetchListedItems REJECTS, and the InventoryService
//  carry-forward guard keeps the previously-cached Listed stack (no wipe).
// ════════════════════════════════════════════════════════════════════════════

const STEAMID = '76561190000000002';

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

// The market error body: HTTP 200 with {"success":false} and no listings-shaped key.
function installAxiosMock(): () => void {
  const ax = require('axios');
  const orig = ax.get;
  const mock = async (url: string): Promise<{ status: number; data: unknown }> => {
    if (/\/inventory\/\d+\/730\/16(\?|$)/.test(url)) return { status: 200, data: CTX16 };
    if (/\/inventory\/\d+\/730\/2(\?|$)/.test(url))  return { status: 200, data: CTX2 };
    if (/market\/mylistings\/render/.test(url))       return { status: 200, data: { success: false } };
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
    account: { username: 'mateo', network: { type: 'localip' } },
    client,
    state: SessionState.LOGGED_IN,
    steamId: STEAMID,
    webSession: { cookies: ['steamLoginSecure=abc', 'sessionid=xyz'], sessionId: 'xyz', obtainedAt: new Date() },
    httpsAgent: undefined,
    wallet: undefined,
  };
}

test('H-TRD-111: fetchListedItems REJECTS on a page-0 {success:false} error body', async () => {
  const restore = installAxiosMock();
  try {
    await assert.rejects(fetchListedItems(fakeSession()), /not a listings payload/);
  } finally {
    restore();
  }
});

test('H-TRD-111: refresh carries the cached Listed stack forward (no wipe) on a {success:false} page 0', async () => {
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
    inv.gcStore.set('mateo', {
      username: 'mateo', steamId: STEAMID, game: 'cs2', source: 'gc',
      items: [{
        assetId: 'LISTED9', classId: 'C9', instanceId: '0',
        marketHashName: 'Desert Eagle | Blaze (Factory New)', name: 'Desert Eagle | Blaze (Factory New)',
        type: '', rarity: 'Unknown', rarityColor: '#6b7280', exterior: null,
        tradable: false, marketable: true, tradeLockExpiry: null,
        quantity: 1, assetIds: ['LISTED9'], iconUrl: 'iconL', category: 'listed',
      }] as any,
      totalItems: 1, fetchedAt: new Date(), fromCache: false, partial: false,
    } as any);

    const result = await inv.refreshOneViaGc('mateo');

    // The cached listed stack survives — the transient error did NOT wipe it.
    const listed = result.items.filter((i) => i.category === 'listed').flatMap((i) => i.assetIds.map(String));
    assert.ok(listed.includes('LISTED9'), 'previously-cached listed asset carried forward (no wipe)');
    // And the owned item still parsed normally.
    const owned = result.items.filter((i) => i.category === 'tradable').flatMap((i) => i.assetIds.map(String));
    assert.ok(owned.includes('A1'), 'owned item still parsed on the same pass');
  } finally {
    restore();
  }
});
