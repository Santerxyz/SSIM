import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InventoryService } from '../src/core/InventoryService';
import { InventoryManager } from '../src/core/InventoryManager';
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
