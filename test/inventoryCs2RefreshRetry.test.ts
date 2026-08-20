import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { InventoryService } from '../src/core/InventoryService';
import { InventoryManager } from '../src/core/InventoryManager';
import { SessionState } from '../src/types/session';
import type { AccountInventory } from '../src/types/inventory';

// ════════════════════════════════════════════════════════════════════════════
//  S50 — the CS2 full-refresh fetchRaw pair (context 2 + 16) had NO transient/429
//  retry layer, while the TF2/quick path did. One 429 or proxy blip on either
//  context threw straight out and failed the whole account for the pass → inflated
//  `failed` counts at fleet scale. Now each context fetch runs under the same
//  bounded REFRESH_RETRIES loop; a non-transient error still fails fast.
// ════════════════════════════════════════════════════════════════════════════

function bareSvc(): InventoryService {
  const sessions = { getSession: () => undefined };
  const accounts = { get: (u: string) => ({ username: u, network: { type: 'proxy' } }) };
  const svc = new InventoryService(sessions as never, accounts as never);
  (svc as unknown as { pause: (ms: number) => Promise<void> }).pause = async () => {}; // no real backoff wait
  return svc;
}

test('S50: a transient fetchRaw error is RETRIED (not propagated as a failed account)', async () => {
  const svc = bareSvc();
  const orig = InventoryManager.fetchRaw;
  let calls = 0;
  (InventoryManager as unknown as { fetchRaw: unknown }).fetchRaw = async () => {
    calls++;
    if (calls === 1) throw new Error('Request failed with status code 429 (rate limit)');
    return { success: 1, assets: [], descriptions: [], truncated: false };
  };
  try {
    const raw = await (svc as unknown as { fetchRawRetrying: (s: unknown, c: number, u: string) => Promise<{ success: number }> })
      .fetchRawRetrying({ steamId: '1' }, 2, 'bot');
    assert.equal(calls, 2, 'the transient 429 was retried once, then succeeded');
    assert.equal(raw.success, 1);
  } finally { (InventoryManager as unknown as { fetchRaw: unknown }).fetchRaw = orig; }
});

test('S50: a NON-transient fetchRaw error fails fast (auth/private inventory is not retried)', async () => {
  const svc = bareSvc();
  const orig = InventoryManager.fetchRaw;
  let calls = 0;
  (InventoryManager as unknown as { fetchRaw: unknown }).fetchRaw = async () => { calls++; throw new Error('This profile is private.'); };
  try {
    await assert.rejects(
      () => (svc as unknown as { fetchRawRetrying: (s: unknown, c: number, u: string) => Promise<unknown> }).fetchRawRetrying({ steamId: '1' }, 2, 'bot'),
      /private/,
    );
    assert.equal(calls, 1, 'a non-transient error is thrown on the first attempt (no wasted retries)');
  } finally { (InventoryManager as unknown as { fetchRaw: unknown }).fetchRaw = orig; }
});

// ════════════════════════════════════════════════════════════════════════════
//  H-INV-004 — the suspicious-empty CONFIRMATION re-read used bare `fetchRaw`, so
//  one transient blip during that read (the block runs precisely when a 429 storm
//  is already likely) failed the whole account for the pass. It now runs under the
//  same bounded transient/429 retry (fetchRawRetrying) as the primary fetches, so a
//  single ECONNRESET on the confirmation read no longer fails the account.
// ════════════════════════════════════════════════════════════════════════════

const CS2_STEAMID = '76561190000000009';

// One valid asset + description so parse() yields a real item on the confirmation read.
const OK_ASSET = { assetid: 'A9', classid: 'C9', instanceid: '0', amount: '1' };
const OK_DESC = {
  classid: 'C9', instanceid: '0', market_hash_name: 'AWP | Asiimov (Field-Tested)',
  name: 'AWP | Asiimov (Field-Tested)', type: 'Sniper Rifle', tradable: 1, marketable: 1, tags: [],
};

// Mocks the axios boundary so fetchRaw / fetchListedItems / parse all run naturally.
// The confirmation ctx2 read (2nd hit on the ctx2 URL) throws ECONNRESET once, then
// its retry succeeds — exercising the fetchRawRetrying wrapper the fix installs.
function installConfirmRetryAxiosMock(): () => void {
  const ax = require('axios');
  const orig = ax.get;
  let ctx2Hits = 0;
  const emptyBody = { success: 1, assets: [], descriptions: [], total_inventory_count: 5 }; // >0 → NOT authoritative-empty
  const itemsBody = { success: 1, assets: [OK_ASSET], descriptions: [OK_DESC], total_inventory_count: 5 };
  const mock = async (url: string): Promise<{ status: number; data: unknown }> => {
    if (/\/inventory\/\d+\/730\/2(\?|$)/.test(url)) {
      ctx2Hits++;
      if (ctx2Hits === 1) return { status: 200, data: emptyBody };  // primary read: empty
      if (ctx2Hits === 2) throw new Error('read ECONNRESET');        // confirmation read: transient blip
      return { status: 200, data: itemsBody };                       // confirmation retry: items present
    }
    if (/\/inventory\/\d+\/730\/16(\?|$)/.test(url)) return { status: 200, data: emptyBody };
    if (/market\/mylistings\//.test(url))            return { status: 200, data: { listings: [], buy_orders: [] } };
    return { status: 404, data: {} };
  };
  ax.get = mock;
  if (ax.default) ax.default.get = mock;
  return () => { ax.get = orig; if (ax.default) ax.default.get = orig; };
}

function svcForCs2Confirm(): InventoryService {
  const client: any = new EventEmitter();
  client.steamID = { getSteamID64: () => CS2_STEAMID };
  const session: any = {
    account: { username: 'consol', network: { type: 'localip' } },
    client, state: SessionState.LOGGED_IN, steamId: CS2_STEAMID,
    webSession: { cookies: ['steamLoginSecure=abc', 'sessionid=xyz'], sessionId: 'xyz', obtainedAt: new Date() },
    httpsAgent: undefined, wallet: undefined,
  };
  const sessions: any = {
    getSession: () => session, isLive: () => true,
    loginAccount: async () => session, loginAccountOwned: async () => ({ session, createdByCall: false }),
    logoutAccount: async () => undefined, markUsed: () => undefined,
    isEgressStale: () => false,   // 1.5.1 reuse guard: this stub session logged in over the CURRENT egress
  };
  const accounts: any = { get: (u: string) => ({ username: u, network: { type: 'localip' } }) };
  const svc = new InventoryService(sessions, accounts);
  (svc as unknown as { pause: (ms: number) => Promise<void> }).pause = async () => undefined; // no real retry backoff
  return svc;
}

const cs2CachedConfirm: AccountInventory = {
  username: 'consol', steamId: CS2_STEAMID, game: 'cs2', source: 'gc', fromCache: false, fetchedAt: new Date(),
  totalItems: 2,
  items: [{ marketHashName: 'AK-47 | Redline (Field-Tested)', category: 'tradable', tradable: true, tradeLockExpiry: null, quantity: 2, assetIds: ['A1', 'A2'] } as never],
};

test('H-INV-004: a transient blip on the suspicious-empty CONFIRMATION re-read is retried (account not failed)', async () => {
  const restore = installConfirmRetryAxiosMock();
  try {
    const svc = svcForCs2Confirm();
    svc.gcStore.set('consol', { ...cs2CachedConfirm }); // cache holds owned items → confirmation block runs
    // Before the fix the confirmation ctx2 read used bare fetchRaw, so the ECONNRESET threw
    // straight out and refreshOneViaGc REJECTED (the account lands in job.failed). With the
    // retry wrapper it resolves and commits the recovered item.
    const out = await svc.refreshOneViaGc('consol');
    const ownedLocked = out.items.filter(i => i.category !== 'listed');
    assert.equal(ownedLocked.length, 1, 'the confirmation read recovered after one ECONNRESET → the item committed');
  } finally {
    restore();
  }
});
