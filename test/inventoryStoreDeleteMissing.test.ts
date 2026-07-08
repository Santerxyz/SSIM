// ════════════════════════════════════════════════════════════════════════════
//  H-INV-040 — delete() on a missing key no longer marks the store dirty. Account
//  removal calls delete() on all three per-game stores unconditionally; a store
//  that never held the account (typical: tf2Store for a CS2-only fleet) used to
//  set dirty and rewrite its entire multi-MB JSON file with byte-identical content.
//  delete() now returns early when the key is absent (still clearing any stray LRU
//  entry defensively), so no needless full-file write is scheduled. A present key
//  still persists as before.
// ════════════════════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { InventoryStore } from '../src/core/InventoryStore';
import * as atomicJson from '../src/utils/atomicJson';
import type { AccountInventory } from '../src/types/inventory';

function tmpStorePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-invstore-del-'));
  return path.join(dir, 'inventories.json');
}

const record = (username: string): AccountInventory => ({
  username, steamId: '1', game: 'cs2', source: 'gc', fromCache: false, fetchedAt: new Date(),
  totalItems: 1,
  items: [{ marketHashName: 'Key', category: 'tradable', tradable: true, tradeLockExpiry: null, quantity: 1, assetIds: ['a'] } as never],
});

test('H-INV-040: delete() on a missing key performs no write (dirty stays false)', () => {
  const p = tmpStorePath();
  const store = new InventoryStore(p);

  const orig = atomicJson.writeJsonAtomic;
  let writes = 0;
  (atomicJson as { writeJsonAtomic: typeof orig }).writeJsonAtomic = (...args: Parameters<typeof orig>) => { writes++; orig(...args); };
  try {
    store.delete('ghost');     // key never existed → must not mark dirty
    store.flush();             // dirty stayed false → flush is a no-op
    assert.equal(writes, 0, 'deleting a missing key must not trigger a full-file rewrite');
    assert.equal(fs.existsSync(p), false, 'no store file was written');
  } finally {
    (atomicJson as { writeJsonAtomic: typeof orig }).writeJsonAtomic = orig;
  }
});

test('H-INV-040: delete() on a present key still persists the removal (baseline)', () => {
  const p = tmpStorePath();
  const store = new InventoryStore(p);
  store.set('alice', record('alice'));
  store.flush();
  assert.ok(store.peek('alice'), 'record present before delete');

  const orig = atomicJson.writeJsonAtomic;
  let writes = 0;
  (atomicJson as { writeJsonAtomic: typeof orig }).writeJsonAtomic = (...args: Parameters<typeof orig>) => { writes++; orig(...args); };
  try {
    store.delete('alice');     // key exists → must persist the removal
    store.flush();
    assert.equal(writes, 1, 'deleting a present key must persist the removal');
  } finally {
    (atomicJson as { writeJsonAtomic: typeof orig }).writeJsonAtomic = orig;
  }
  assert.equal(store.peek('alice'), undefined, 'record gone after delete');
});
