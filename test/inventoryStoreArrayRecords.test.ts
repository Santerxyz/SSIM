import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { InventoryStore } from '../src/core/InventoryStore';
import { logger } from '../src/utils/logger';
import type { AccountInventory } from '../src/types/inventory';

// ════════════════════════════════════════════════════════════════════════════
//  H-INV-035 — the malformed-shape guard used `typeof parsed.records === 'object'`,
//  and `typeof [] === 'object'`, so a file containing `{"version":1,"records":[]}`
//  passed the guard that was written to reject exactly such files. set() then assigned
//  named properties onto the array (fine in RAM), but flush() → JSON.stringify drops
//  named properties on arrays, re-serialising records back to `[]` — a self-perpetuating
//  "empty every restart" store. The guard now also rejects arrays, so the file heals.
// ════════════════════════════════════════════════════════════════════════════

function tmpStorePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-invstore-'));
  return path.join(dir, 'inventories.json');
}

const record = (username: string): AccountInventory => ({
  username, steamId: '1', game: 'cs2', source: 'gc', fromCache: false, fetchedAt: new Date(),
  totalItems: 1,
  items: [{ marketHashName: 'Key', category: 'tradable', tradable: true, tradeLockExpiry: null, quantity: 1, assetIds: ['a'] } as never],
});

test('H-INV-035: an array `records` is rejected as an unexpected shape and heals on the next flush', () => {
  const p = tmpStorePath();
  // an array `records` used to slip past the guard (typeof [] === 'object')
  fs.writeFileSync(p, '{"version":1,"records":[]}');

  const warnings: string[] = [];
  const origWarn = logger.warn;
  (logger as { warn: unknown }).warn = (msg: unknown): unknown => { warnings.push(String(msg)); return logger; };

  try {
    const store = new InventoryStore(p);
    assert.ok(warnings.some(m => m.includes('unexpected shape')), 'the array shape was rejected with the starting-fresh warn');

    // a normal write must persist as a plain object keyed by username, not back to `[]`
    store.set('user', record('user'));
    store.flush();
  } finally {
    (logger as { warn: unknown }).warn = origWarn;
  }

  const written = JSON.parse(fs.readFileSync(p, 'utf8')) as { records: unknown };
  assert.ok(
    written.records && typeof written.records === 'object' && !Array.isArray(written.records),
    'records was healed to a plain object (not an array)',
  );
  assert.deepEqual(Object.keys(written.records as Record<string, unknown>), ['user'], 'the written record survived the flush');
});
