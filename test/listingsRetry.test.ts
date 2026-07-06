import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { InventoryService } from '../src/core/InventoryService';
import { logger } from '../src/utils/logger';
import { SessionState } from '../src/types/session';

// ════════════════════════════════════════════════════════════════════════════
//  H-TRD-123 — the mylistings (listed) leg of the CS2 refresh had NO transient/429
//  retry, while the S50-hardened ctx2/ctx16 legs did. One 429/proxy blip on the
//  listings fetch threw → listingsOk=false → the listed bucket was left unread for
//  the pass (carry-forward + warn). Now the listings leg runs under the SAME bounded
//  REFRESH_RETRIES loop (via the generalised `retrying` helper): a transient 429 on
//  the first attempt is retried and the fresh listed bucket is committed — no warn.
// ════════════════════════════════════════════════════════════════════════════

const STEAMID = '76561190000000123';

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

// A valid single-page mylistings body carrying exactly one listed asset.
function onePageListings(): { success: number; total_count: number; listings: unknown[]; assets: unknown } {
  return {
    success: 1, total_count: 1,
    listings: [{ listingid: 'ONLY1', price: 100, fee: 15, currencyid: 2003,
      asset: { id: 'LISTED_ASSET', appid: 730, contextid: '2', amount: '1' } }],
    assets: {},
  };
}

// First mylistings render GET returns HTTP 429 (transient, rate-limit-classified);
// the retry returns the valid listings body. Inventory contexts always succeed.
function installAxiosMock(): () => void {
  const ax = require('axios');
  const orig = ax.get;
  let listingsCalls = 0;
  const mock = async (url: string): Promise<{ status: number; data: unknown }> => {
    if (/\/inventory\/\d+\/730\/16(\?|$)/.test(url)) return { status: 200, data: CTX16 };
    if (/\/inventory\/\d+\/730\/2(\?|$)/.test(url))  return { status: 200, data: CTX2 };
    if (/market\/mylistings\/render/.test(url)) {
      listingsCalls++;
      if (listingsCalls === 1) return { status: 429, data: {} }; // one rate-limit blip → transient throw
      return { status: 200, data: onePageListings() };
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
    account: { username: 'nora', network: { type: 'localip' } },
    client,
    state: SessionState.LOGGED_IN,
    steamId: STEAMID,
    webSession: { cookies: ['steamLoginSecure=abc', 'sessionid=xyz'], sessionId: 'xyz', obtainedAt: new Date() },
    httpsAgent: undefined,
    wallet: undefined,
  };
}

test('H-TRD-123: a 429 on the listings leg is RETRIED — fresh listed bucket committed, no "unread this pass" warn', async () => {
  const restore = installAxiosMock();
  const origWarn = logger.warn.bind(logger);
  const warns: string[] = [];
  (logger as unknown as { warn: (m: unknown) => void }).warn = (m: unknown) => { warns.push(String(m)); };
  try {
    const session = fakeSession();
    const mockSessions: any = {
      getSession: () => session,
      isLive: () => true,
      loginAccount: async () => session,
      loginAccountOwned: async () => ({ session, createdByCall: false }),
      logoutAccount: async () => undefined,
      markUsed: () => undefined,
    };
    const mockAccounts: any = { get: (u: string) => ({ username: u, network: { type: 'localip' } }) };
    const inv = new InventoryService(mockSessions, mockAccounts);
    (inv as unknown as { pause: (ms: number) => Promise<void> }).pause = async () => {}; // no real backoff wait

    const result = await inv.refreshOneViaGc('nora');

    // The retried listings fetch produced a fresh listed bucket (not a carry-forward).
    const listed = result.items.filter((i) => i.category === 'listed').flatMap((i) => i.assetIds.map(String));
    assert.ok(listed.includes('LISTED_ASSET'), 'the retry committed the freshly-fetched listed asset');
    // The carry-forward guard did NOT fire — the listed bucket was read this pass.
    assert.ok(!warns.some((w) => /market listings unread this pass/.test(w)), 'no carry-forward warn was logged');
  } finally {
    (logger as unknown as { warn: typeof origWarn }).warn = origWarn;
    restore();
  }
});
