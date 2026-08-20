import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { InventoryService } from '../src/core/InventoryService';
import { InventoryManager } from '../src/core/InventoryManager';
import { SessionState } from '../src/types/session';
import type { AccountInventory } from '../src/types/inventory';

// ─── B31: doRefreshOne (TF2 / forceRefresh) must not wipe a non-empty cache on a
//         transient empty or page-cap-truncated read (parity with the CS2 path). ──

function svcWithCachedTf2(cached: AccountInventory): { svc: InventoryService; setFetch: (inv: AccountInventory) => void } {
  const sessions = { getSession: () => undefined, loginAccountOwned: async () => ({ session: { steamId: '1', wallet: undefined }, createdByCall: true }) };
  const accounts = { get: (u: string) => ({ username: u, network: { type: 'proxy' } }) };
  const svc = new InventoryService(sessions as never, accounts as never);
  svc.tf2Store.set(cached.username, cached);
  const setFetch = (inv: AccountInventory) => {
    (InventoryManager as unknown as { fetchInventoryOnly: unknown }).fetchInventoryOnly = async () => inv;
  };
  // ensureSession reuses the (fake) session path via loginAccountOwned; short-circuit it:
  (svc as unknown as { ensureSession: (u: string) => Promise<unknown> }).ensureSession = async () => ({ steamId: '1', wallet: undefined });
  return { svc, setFetch };
}

const cached: AccountInventory = {
  username: 'tf2bot', steamId: '1', game: 'tf2', source: 'web', fromCache: false, fetchedAt: new Date(),
  totalItems: 3, items: [{ marketHashName: 'Key', category: 'tradable', tradable: true, tradeLockExpiry: null, quantity: 3, assetIds: ['a', 'b', 'c'] } as never],
};

test('B31: a transient EMPTY read keeps the fuller cache (no wipe)', async () => {
  const { svc, setFetch } = svcWithCachedTf2({ ...cached });
  setFetch({ username: 'tf2bot', steamId: '1', game: 'tf2', source: 'web', fromCache: false, fetchedAt: new Date(), totalItems: 0, items: [] });
  const out = await svc.refreshOne('tf2bot', 'tf2');
  assert.equal(out.totalItems, 3, 'the non-empty cache is preserved on a suspicious empty read');
  assert.equal(svc.tf2Store.get('tf2bot')?.totalItems, 3, 'cache not wiped on disk-store either');
});

test('B31: a page-cap TRUNCATED smaller read keeps the fuller cache', async () => {
  const { svc, setFetch } = svcWithCachedTf2({ ...cached });
  setFetch({ username: 'tf2bot', steamId: '1', game: 'tf2', source: 'web', fromCache: false, fetchedAt: new Date(), totalItems: 1, partial: true, items: [{ marketHashName: 'Key', category: 'tradable', tradable: true, tradeLockExpiry: null, quantity: 1, assetIds: ['a'] } as never] });
  const out = await svc.refreshOne('tf2bot', 'tf2');
  assert.equal(out.totalItems, 3, 'a truncated smaller read must not clobber the fuller cache');
});

// ─── H-TRD-041: the suspect-read substitution stamps the RETURNED clone (not the cache) so
//     buy verification treats it as a failed fresh read; the cache stays unflagged. ──────────
test('H-TRD-041: a suspect (empty) read returns staleReadFallback:true; the cache is not flagged', async () => {
  const { svc, setFetch } = svcWithCachedTf2({ ...cached });
  setFetch({ username: 'tf2bot', steamId: '1', game: 'tf2', source: 'web', fromCache: false, fetchedAt: new Date(), totalItems: 0, items: [] });
  const out = await svc.refreshOne('tf2bot', 'tf2');
  assert.equal(out.staleReadFallback, true, 'the substituted clone is stamped for the buy verifier');
  // The stamp lives on the returned clone only — a follow-up cached read must NOT carry it.
  const cachedRead = svc.tf2Store.get('tf2bot');
  assert.equal(cachedRead?.staleReadFallback, undefined, 'the cache record itself is never stamped');
});

test('B31: a GENUINE non-empty read still overwrites the cache', async () => {
  const { svc, setFetch } = svcWithCachedTf2({ ...cached });
  setFetch({ username: 'tf2bot', steamId: '1', game: 'tf2', source: 'web', fromCache: false, fetchedAt: new Date(), totalItems: 5, items: [{ marketHashName: 'Key', category: 'tradable', tradable: true, tradeLockExpiry: null, quantity: 5, assetIds: ['a', 'b', 'c', 'd', 'e'] } as never] });
  const out = await svc.refreshOne('tf2bot', 'tf2');
  assert.equal(out.totalItems, 5, 'a real update is applied');
});

test('B31: a genuinely-empty account with an EMPTY cache is fine (0 stays 0)', async () => {
  const empty: AccountInventory = { ...cached, totalItems: 0, items: [] };
  const { svc, setFetch } = svcWithCachedTf2(empty);
  setFetch({ username: 'tf2bot', steamId: '1', game: 'tf2', source: 'web', fromCache: false, fetchedAt: new Date(), totalItems: 0, items: [] });
  const out = await svc.refreshOne('tf2bot', 'tf2');
  assert.equal(out.totalItems, 0);
});

// ─── H-INV-005: an AUTHORITATIVELY-empty read (Steam's own total_inventory_count===0)
//     must converge a phantom-holding cache instead of freezing it via the partial-read
//     guard forever. An ABSENT total (undefined) keeps the old protection. ──────────────

// TF2/quick-path parity (spec verification (c)): reportedTotal:0 commits empty; undefined protects.
test('H-INV-005: TF2 empty read with reportedTotal:0 COMMITS empty (cache converges)', async () => {
  const { svc, setFetch } = svcWithCachedTf2({ ...cached });
  setFetch({ username: 'tf2bot', steamId: '1', game: 'tf2', source: 'web', fromCache: false, fetchedAt: new Date(), totalItems: 0, items: [], reportedTotal: 0 });
  const out = await svc.refreshOne('tf2bot', 'tf2');
  assert.equal(out.totalItems, 0, 'Steam declared the account empty → the empty read is committed');
  assert.equal(svc.tf2Store.get('tf2bot')?.totalItems, 0, 'cache converged to empty on disk-store too');
});

test('H-INV-005: TF2 empty read with reportedTotal UNDEFINED still keeps the fuller cache', async () => {
  const { svc, setFetch } = svcWithCachedTf2({ ...cached });
  setFetch({ username: 'tf2bot', steamId: '1', game: 'tf2', source: 'web', fromCache: false, fetchedAt: new Date(), totalItems: 0, items: [] });
  const out = await svc.refreshOne('tf2bot', 'tf2');
  assert.equal(out.totalItems, 3, 'an unknown total (field absent) fails safe: the non-empty cache is preserved');
});

// CS2 gc-path (spec verification (a) & (b)): drives fetchRaw + mylistings at the axios boundary.
const CS2_STEAMID = '76561190000000009';

function installCs2AxiosMock(ctxTotal: number | undefined): () => void {
  const ax = require('axios');
  const orig = ax.get;
  const body = (): Record<string, unknown> => {
    const b: Record<string, unknown> = { success: 1, assets: [], descriptions: [] };
    if (ctxTotal !== undefined) b.total_inventory_count = ctxTotal; // omit → undefined, mimicking Steam
    return b;
  };
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

function svcForCs2(): InventoryService {
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
  (svc as unknown as { pause: (ms: number) => Promise<void> }).pause = async () => undefined; // no real waits
  return svc;
}

const cs2Cached: AccountInventory = {
  username: 'consol', steamId: CS2_STEAMID, game: 'cs2', source: 'gc', fromCache: false, fetchedAt: new Date(),
  totalItems: 2,
  items: [{ marketHashName: 'AK-47 | Redline (Field-Tested)', category: 'tradable', tradable: true, tradeLockExpiry: null, quantity: 2, assetIds: ['A1', 'A2'] } as never],
};

test('H-INV-005 (a): a genuinely-emptied CS2 account converges (total_inventory_count:0)', async () => {
  const restore = installCs2AxiosMock(0);
  try {
    const svc = svcForCs2();
    svc.gcStore.set('consol', { ...cs2Cached });
    const out = await svc.refreshOneViaGc('consol');
    const ownedLocked = out.items.filter(i => i.category !== 'listed');
    assert.equal(ownedLocked.length, 0, 'Steam declared the account empty → cache committed with zero owned/locked stacks');
    assert.equal(svc.gcStore.get('consol')?.items.filter(i => i.category !== 'listed').length, 0, 'gcStore converged to empty');
    // A second identical pass must NOT re-freeze phantom items (no reconcile).
    const out2 = await svc.refreshOneViaGc('consol');
    assert.equal(out2.items.filter(i => i.category !== 'listed').length, 0, 'second pass stays empty (no phantom re-freeze)');
  } finally {
    restore();
  }
});

test('H-INV-005 (b): total_inventory_count:5 with 0 assets PRESERVES the cache (reconcile)', async () => {
  const restore = installCs2AxiosMock(5);
  try {
    const svc = svcForCs2();
    svc.gcStore.set('consol', { ...cs2Cached });
    const out = await svc.refreshOneViaGc('consol');
    const ownedLocked = out.items.filter(i => i.category !== 'listed');
    assert.equal(ownedLocked.reduce((n, i) => n + i.quantity, 0), 2, 'a non-zero Steam total with 0 assets is a suspected partial read → cache preserved');
  } finally {
    restore();
  }
});
