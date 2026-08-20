import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { InventoryService } from '../src/core/InventoryService';
import { InventoryManager } from '../src/core/InventoryManager';
import { SessionState } from '../src/types/session';
import type { AccountInventory } from '../src/types/inventory';

// ════════════════════════════════════════════════════════════════════════════
//  S41 — a refresh that commits BEFORE the 'wallet' event fires used to write a
//  record with no wallet, flipping a previously-funded account back to the "—"
//  tri-state on every such pass. The refresh now carries the last-known wallet
//  forward (a real balance is only ever replaced by a newer real balance).
//  Driven through the quick/TF2 refresh path (getCached → tf2Store).
// ════════════════════════════════════════════════════════════════════════════

function bareSvc(): InventoryService {
  const sessions = { getSession: () => undefined };
  const accounts = { get: (u: string) => ({ username: u, network: { type: 'proxy' } }) };
  return new InventoryService(sessions as never, accounts as never);
}

const cachedWithWallet: AccountInventory = {
  username: 'walletbot', steamId: '1', game: 'tf2', source: 'web', fromCache: false, fetchedAt: new Date(),
  totalItems: 1, wallet: { currency: 1, balance: 12345 },
  items: [{ marketHashName: 'Key', category: 'tradable', tradable: true, tradeLockExpiry: null, quantity: 1, assetIds: ['a'] } as never],
};
const genuineUpdate = (): AccountInventory => ({
  username: 'walletbot', steamId: '1', game: 'tf2', source: 'web', fromCache: false, fetchedAt: new Date(),
  totalItems: 5, // a genuine non-empty read → applied (not caught by the empty-read guard)
  items: [{ marketHashName: 'Key', category: 'tradable', tradable: true, tradeLockExpiry: null, quantity: 5, assetIds: ['a', 'b', 'c', 'd', 'e'] } as never],
});

function svcForWallet(sessionWallet: { hasWallet: boolean; currency: number; balance: number } | undefined): InventoryService {
  const svc = bareSvc();
  svc.tf2Store.set('walletbot', { ...cachedWithWallet });
  (InventoryManager as unknown as { fetchInventoryOnly: unknown }).fetchInventoryOnly = async () => genuineUpdate();
  (svc as unknown as { ensureSession: (u: string) => Promise<unknown> }).ensureSession = async () => ({ steamId: '1', wallet: sessionWallet });
  return svc;
}

test('S41: a refresh with NO wallet event carries the last-known wallet forward (no funded→"—")', async () => {
  const svc = svcForWallet(undefined); // the 'wallet' event has not fired this pass
  const out = await svc.refreshOne('walletbot', 'tf2');
  assert.equal(out.totalItems, 5, 'the genuine inventory update is applied (control: not the empty-read path)');
  assert.deepEqual(out.wallet, { currency: 1, balance: 12345 }, 'the previously-known wallet is preserved');
});

test('S41: a fresh wallet event still wins (a newer real balance replaces the old one)', async () => {
  const svc = svcForWallet({ hasWallet: true, currency: 1, balance: 99999 });
  const out = await svc.refreshOne('walletbot', 'tf2');
  assert.deepEqual(out.wallet, { currency: 1, balance: 99999 }, 'the live wallet event takes precedence');
});

test('S41: a never-funded account with no cache + no event stays walletless (still "—", correctly)', async () => {
  const svc = bareSvc(); // no cached record at all
  (InventoryManager as unknown as { fetchInventoryOnly: unknown }).fetchInventoryOnly = async () => genuineUpdate();
  (svc as unknown as { ensureSession: (u: string) => Promise<unknown> }).ensureSession = async () => ({ steamId: '1', wallet: undefined });
  const out = await svc.refreshOne('walletbot', 'tf2');
  assert.equal(out.wallet, undefined, 'nothing to carry forward → wallet stays undefined (not a fake 0)');
});

// ════════════════════════════════════════════════════════════════════════════
//  H-INV-006 — both partial-read protection paths USED TO discard the freshly-
//  captured wallet, returning (and persisting) the stale cached balance stamped
//  as fresh. A protected pass must now commit the newer wallet while keeping the
//  fuller item set. (Directive 2 tri-state: propagate the wallet object when
//  present, never fabricate one.)
// ════════════════════════════════════════════════════════════════════════════

// A suspect-EMPTY read: 0 items, reportedTotal absent → caught by the quick-path guard.
const emptyRead = (): AccountInventory => ({
  username: 'walletbot', steamId: '1', game: 'tf2', source: 'web', fromCache: false, fetchedAt: new Date(),
  totalItems: 0, items: [],
});

test('H-INV-006 (TF2): a protected suspect-empty pass carries the FRESH wallet while preserving items', async () => {
  const svc = svcForWallet({ hasWallet: true, currency: 1, balance: 99999 }); // live event, higher balance
  (InventoryManager as unknown as { fetchInventoryOnly: unknown }).fetchInventoryOnly = async () => emptyRead();
  const out = await svc.refreshOne('walletbot', 'tf2');
  assert.equal(out.totalItems, 1, 'the fuller cache item set is preserved (protected read, not wiped)');
  assert.deepEqual(out.wallet, { currency: 1, balance: 99999 }, 'the returned record carries the fresh balance');
  assert.deepEqual(svc.tf2Store.get('walletbot')?.wallet, { currency: 1, balance: 99999 }, 'the store record carries it too');
  assert.equal(svc.tf2Store.get('walletbot')?.totalItems, 1, 'the cache item set is untouched (not re-stamped as empty)');
});

test('H-INV-006 (TF2): a protected pass with NO wallet event keeps the cached wallet (never wiped to "—")', async () => {
  const svc = svcForWallet(undefined); // no 'wallet' event this pass
  (InventoryManager as unknown as { fetchInventoryOnly: unknown }).fetchInventoryOnly = async () => emptyRead();
  const out = await svc.refreshOne('walletbot', 'tf2');
  assert.deepEqual(out.wallet, { currency: 1, balance: 12345 }, 'the carried-forward wallet survives the protected read');
});

// ─── CS2 reconcile path parity: total_inventory_count:5 with 0 assets → reconcilePartialRead.
const CS2_STEAMID = '76561190000000009';

function installCs2AxiosMock(ctxTotal: number): () => void {
  const ax = require('axios');
  const orig = ax.get;
  const body = (): Record<string, unknown> => ({ success: 1, assets: [], descriptions: [], total_inventory_count: ctxTotal });
  const mock = async (url: string): Promise<{ status: number; data: unknown }> => {
    if (/\/inventory\/\d+\/730\/16(\?|$)/.test(url)) return { status: 200, data: body() };
    if (/\/inventory\/\d+\/730\/2(\?|$)/.test(url))  return { status: 200, data: body() };
    if (/market\/mylistings\//.test(url))            return { status: 200, data: { listings: [], buy_orders: [] } };
    return { status: 404, data: {} };
  };
  ax.get = mock;
  if (ax.default) ax.default.get = mock;
  return () => { ax.get = orig; if (ax.default) ax.default.get = orig; };
}

function svcForCs2(sessionWallet: { hasWallet: boolean; currency: number; balance: number } | undefined): InventoryService {
  const client: any = new EventEmitter();
  client.steamID = { getSteamID64: () => CS2_STEAMID };
  const session: any = {
    account: { username: 'consol', network: { type: 'localip' } },
    client, state: SessionState.LOGGED_IN, steamId: CS2_STEAMID,
    webSession: { cookies: ['steamLoginSecure=abc', 'sessionid=xyz'], sessionId: 'xyz', obtainedAt: new Date() },
    httpsAgent: undefined, wallet: sessionWallet,
  };
  const sessions: any = {
    getSession: () => session, isLive: () => true,
    loginAccount: async () => session, loginAccountOwned: async () => ({ session, createdByCall: false }),
    logoutAccount: async () => undefined, markUsed: () => undefined,
    isEgressStale: () => false,   // 1.5.1 reuse guard: this stub session logged in over the CURRENT egress
  };
  const accounts: any = { get: (u: string) => ({ username: u, network: { type: 'localip' } }) };
  const svc = new InventoryService(sessions, accounts);
  (svc as unknown as { pause: (ms: number) => Promise<void> }).pause = async () => undefined; // no real waits
  return svc;
}

const cs2Cached: AccountInventory = {
  username: 'consol', steamId: CS2_STEAMID, game: 'cs2', source: 'gc', fromCache: false, fetchedAt: new Date(),
  totalItems: 2, wallet: { currency: 1, balance: 12345 },
  items: [{ marketHashName: 'AK-47 | Redline (Field-Tested)', category: 'tradable', tradable: true, tradeLockExpiry: null, quantity: 2, assetIds: ['A1', 'A2'] } as never],
};

test('H-INV-006 (CS2 reconcile): the reconciled record carries the FRESH wallet while preserving items', async () => {
  const restore = installCs2AxiosMock(5); // Steam total 5, 0 assets → suspected partial read → reconcile
  try {
    const svc = svcForCs2({ hasWallet: true, currency: 1, balance: 99999 });
    svc.gcStore.set('consol', { ...cs2Cached });
    const out = await svc.refreshOneViaGc('consol');
    assert.equal(out.items.filter(i => i.category !== 'listed').reduce((n, i) => n + i.quantity, 0), 2, 'the fuller owned/locked cache is preserved (reconcile)');
    assert.deepEqual(out.wallet, { currency: 1, balance: 99999 }, 'the reconciled record carries the fresh balance');
    assert.deepEqual(svc.gcStore.get('consol')?.wallet, { currency: 1, balance: 99999 }, 'the gcStore record carries it too');
  } finally {
    restore();
  }
});
