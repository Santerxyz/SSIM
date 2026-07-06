import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { InventoryStore } from '../src/core/InventoryStore';
import { InventoryManager } from '../src/core/InventoryManager';
import type { AccountInventory } from '../src/types/inventory';

// ════════════════════════════════════════════════════════════════════════════
//  H-INV-042 — `AccountInventory.fetchedAt` and `CS2Item.tradeLockExpiry` are typed
//  Date, but load() returned readJsonSync output where both are ISO strings post-
//  restart. InventoryManager.stack() calls `tradeLockExpiry.toISOString()`, which
//  throws on a string. load() now revives the Date fields so the declared types hold
//  and the stack() trap is defused; an unparseable stamp becomes null (fetchedAt is
//  left as-is), never an Invalid Date whose toISOString() throws.
// ════════════════════════════════════════════════════════════════════════════

function tmpStorePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-invstore-revive-'));
  return path.join(dir, 'inventories.json');
}

const lockedRecord = (username: string): AccountInventory => ({
  username, steamId: '1', game: 'cs2', source: 'gc', fromCache: false, fetchedAt: new Date(),
  totalItems: 1,
  items: [{
    marketHashName: 'AK-47 | Redline', category: 'tradelocked', tradable: false,
    tradeLockExpiry: new Date('2099-01-01T00:00:00.000Z'), quantity: 1, assetIds: ['a'],
  } as never],
});

test('H-INV-042: InventoryStore revives dates on load', () => {
  const p = tmpStorePath();
  const first = new InventoryStore(p);
  first.set('user', lockedRecord('user'));
  first.flush();

  // On disk the Date fields are now ISO strings (JSON round-trip).
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as { records: Record<string, { fetchedAt: unknown; items: { tradeLockExpiry: unknown }[] }> };
  assert.equal(typeof raw.records.user.fetchedAt, 'string', 'fetchedAt is a string on disk');
  assert.equal(typeof raw.records.user.items[0].tradeLockExpiry, 'string', 'tradeLockExpiry is a string on disk');

  // A fresh store loading the same file revives them back to Date objects.
  const second = new InventoryStore(p);
  const rec = second.get('user');
  assert.ok(rec, 'record loaded');
  assert.ok(rec!.fetchedAt instanceof Date, 'fetchedAt revived to a Date');
  assert.ok(rec!.items[0].tradeLockExpiry instanceof Date, 'tradeLockExpiry revived to a Date');

  // The revived items must not trip stack()'s tradeLockExpiry.toISOString().
  assert.doesNotThrow(() => InventoryManager.stack(rec!.items), 'stack() does not throw on revived items');
});

test('H-INV-042: an unparseable fetchedAt is left as-is and a bad tradeLockExpiry becomes null', () => {
  const p = tmpStorePath();
  fs.writeFileSync(p, JSON.stringify({
    version: 1,
    records: {
      user: {
        username: 'user', steamId: '1', game: 'cs2', source: 'gc', fromCache: false,
        fetchedAt: 'garbage', totalItems: 1,
        items: [{
          marketHashName: 'Key', category: 'tradable', tradable: true,
          tradeLockExpiry: 'garbage', quantity: 1, assetIds: ['a'],
        }],
      },
    },
  }));

  const store = new InventoryStore(p);
  const rec = store.get('user');
  assert.ok(rec, 'record loaded');
  assert.equal(rec!.fetchedAt as unknown as string, 'garbage', 'unparseable fetchedAt left as-is (no Invalid Date)');
  assert.equal(rec!.items[0].tradeLockExpiry, null, 'unparseable tradeLockExpiry coerced to null');
  assert.doesNotThrow(() => InventoryManager.stack(rec!.items), 'stack() does not throw with a null lock');
});
