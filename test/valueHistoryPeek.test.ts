import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fsExtra from 'fs-extra';
import { InventoryStore } from '../src/core/InventoryStore';
import { ValueHistoryService } from '../src/core/ValueHistoryService';
import type { AccountInventory } from '../src/types/inventory';

// ════════════════════════════════════════════════════════════════════════════
//  H-INV-023 — the snapshot used to structuredClone the ENTIRE fleet's records
//  (via store.get) just to sum two numbers per account. The clone-free read path
//  (InventoryStore.peek / InventoryService.peekCached) hands the LIVE record to a
//  READ-ONLY aggregator (PricingService.totalsOf), so the cache must be identical
//  before and after a snapshot — no price/totalValueUsd fields materialized.
// ════════════════════════════════════════════════════════════════════════════

const notFilling = () => ({ running: false, queued: 0, fetched: 0, processed: 0, cacheSize: 0, source: 'steam' as const });

function seededRecord(): AccountInventory {
  return {
    username: 'bot1',
    steamId: '7656',
    items: [
      { assetId: 'a1', classId: 'c', instanceId: 'i', marketHashName: 'AK-47 | Redline',
        name: 'AK', type: 't', rarity: 'Classified', rarityColor: '#fff', exterior: 'Field-Tested',
        tradable: true, marketable: true, tradeLockExpiry: null, quantity: 1, assetIds: ['a1'], iconUrl: 'x' },
    ],
    totalItems: 1,
    fetchedAt: new Date('2026-01-01T00:00:00Z'),
    fromCache: true,
    wallet: { currency: 1, balance: 100 },
  };
}

test('H-INV-023: InventoryStore.peek returns the LIVE record (no clone), unlike get', () => {
  const dir = fsExtra.mkdtempSync(path.join(os.tmpdir(), 'ssim-peek-'));
  const store = new InventoryStore(path.join(dir, 'inv.json'));
  const rec = seededRecord();
  store.set('bot1', rec);

  assert.equal(store.peek('bot1'), rec, 'peek hands back the very same object (clone-free)');
  assert.notEqual(store.get('bot1'), rec, 'get still returns a deep copy (unchanged for other callers)');
  assert.equal(store.peek('nope'), undefined, 'missing account → undefined');

  fsExtra.removeSync(dir);
});

test('H-INV-023: a snapshot over the peek path never mutates the cached record', () => {
  const dir = fsExtra.mkdtempSync(path.join(os.tmpdir(), 'ssim-peek-'));
  const store = new InventoryStore(path.join(dir, 'inv.json'));
  const tf2 = new InventoryStore(path.join(dir, 'inv_tf2.json'));
  store.set('bot1', seededRecord());

  // Snapshot before mutation-check: a deep clone captured straight from the live record.
  const before = structuredClone(store.peek('bot1'));

  const accounts = { getEnvironments: () => [{ id: 'e1' }], getByEnvironment: () => [{ username: 'bot1' }] };
  // totalsOf is READ-ONLY (never assigns item.price / inv.totalValueUsd) — mirrors the real service.
  const pricing = { totalsOf: () => ({ totalCents: 5000, missing: [], softNull: 0 }), status: notFilling };
  const exchange = { getUsdToEur: () => 0.9 };
  const svc = new ValueHistoryService(
    accounts as never,
    { get: (u: string) => store.peek(u) } as never, // the peekCached wiring (clone-free)
    { get: (u: string) => tf2.peek(u) } as never,
    pricing as never,
    exchange as never,
  );

  svc.snapshotAll('test', 'cs2');

  const after = store.peek('bot1')!;
  assert.deepEqual(after, before, 'the raw cache record is untouched by the snapshot');
  assert.equal(after.totalValueUsd, undefined, 'no totalValueUsd materialized on the record');
  assert.equal(after.items[0].price, undefined, 'no per-item price materialized on the record');

  fsExtra.removeSync(dir);
});
