import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InventoryService } from '../src/core/InventoryService';
import { InventoryManager } from '../src/core/InventoryManager';
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
