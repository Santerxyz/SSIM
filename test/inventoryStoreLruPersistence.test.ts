// ════════════════════════════════════════════════════════════════════════════
//  H-INV-041 — the LRU cap's recency was never persisted: get()'s touch and the
//  `lru` Set order died with the process, and flush() wrote records in first-insertion
//  order, so the first evictions after any restart targeted first-ever-inserted keys
//  (which may be the operator's most-active accounts). flush() now rebuilds the records
//  object in LRU order before writing, so a store reconstructed from disk seeds true
//  oldest→newest recency, and the eviction pass logs at info (permanent disk deletion
//  the operator must see), not debug.
//
//  Must set the cap BEFORE the module is required: MAX_RECORDS is captured once at
//  module load. commonjs `import` compiles to an in-order `require`, so this env
//  assignment runs first; each test file runs in its own subprocess (node --test).
// ════════════════════════════════════════════════════════════════════════════
process.env.SSIM_INV_CACHE_MAX = '100';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { InventoryStore } from '../src/core/InventoryStore';
import { logger } from '../src/utils/logger';
import type { AccountInventory } from '../src/types/inventory';

function tmpStorePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-invstore-lru-'));
  return path.join(dir, 'inventories.json');
}

const record = (username: string, fetchedAt: Date): AccountInventory => ({
  username, steamId: '1', game: 'cs2', source: 'gc', fromCache: false, fetchedAt,
  totalItems: 1,
  items: [{ marketHashName: 'Key', category: 'tradable', tradable: true, tradeLockExpiry: null, quantity: 1, assetIds: ['a'] } as never],
});

test('H-INV-041: eviction drops the least-recently-used (not first-inserted) record, and flush() persists LRU order for a restart', () => {
  const p = tmpStorePath();
  const store = new InventoryStore(p);

  const now = Date.now();
  // Insert 100 records (u1..u100) — exactly at the cap, no eviction yet.
  for (let i = 1; i <= 100; i++) store.set(`u${i}`, record(`u${i}`, new Date(now + i)));

  // Touch u1..u10 (read-recency) → they become most-recently-used, ahead of u11..u100.
  for (let i = 1; i <= 10; i++) assert.ok(store.get(`u${i}`), `u${i} present before eviction`);

  // Capture the eviction log (must be at info, not debug).
  const infos: string[] = [];
  const origInfo = logger.info;
  (logger as { info: unknown }).info = (msg: unknown): unknown => { infos.push(String(msg)); return logger; };

  // Insert #101 → one over the cap → evicts exactly one: the least-recently-used, which is
  // u11 (u1..u10 were just touched), NOT u1 (first-inserted).
  try {
    store.set('u101', record('u101', new Date(now + 101)));
  } finally {
    (logger as { info: unknown }).info = origInfo;
  }

  // peek (not get) for these checks so they don't perturb the LRU order we're about to assert.
  assert.ok(store.peek('u11') === undefined, 'the least-recently-used record (u11) was evicted');
  assert.ok(store.peek('u1'), 'the first-inserted record (u1) survived because it was recently touched');
  assert.ok(infos.some(m => m.includes('[inv-cache] evicted') && m.includes('1')),
    'the eviction pass logged at info');

  // Persist, then reconstruct the store from the same file → the seeded lru order must match
  // the recency at flush time (oldest→newest), so the next restart evicts the right key.
  store.flush();
  const onDisk = JSON.parse(fs.readFileSync(p, 'utf8')) as { records: Record<string, unknown> };
  const persistedOrder = Object.keys(onDisk.records);

  // Expected recency, oldest→newest: u12..u100 (untouched, still insertion order), then the
  // touched u1..u10, then u101 (newest). u11 is gone.
  const expected: string[] = [];
  for (let i = 12; i <= 100; i++) expected.push(`u${i}`);
  for (let i = 1; i <= 10; i++) expected.push(`u${i}`);
  expected.push('u101');
  assert.deepEqual(persistedOrder, expected, 'flush() persisted records in true LRU order');

  // Reconstruct the store from disk (a "restart"). Its lru is seeded from the persisted
  // order, so the oldest key is u12. A single over-cap write must therefore evict u12 —
  // proving the restart inherited true recency rather than a first-insertion-order guess.
  const revived = new InventoryStore(p);
  revived.set('u102', record('u102', new Date(now + 102)));
  assert.ok(revived.get('u12') === undefined,
    'post-restart eviction targeted the persisted LRU-oldest key (u12), not an insertion-order guess');
  assert.ok(revived.get('u101'), 'the most-recently-used pre-restart key (u101) survived the restart eviction');
});
