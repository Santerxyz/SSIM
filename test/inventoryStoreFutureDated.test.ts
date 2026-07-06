import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { InventoryStore } from '../src/core/InventoryStore';
import { logger } from '../src/utils/logger';
import type { AccountInventory } from '../src/types/inventory';

// ════════════════════════════════════════════════════════════════════════════
//  H-INV-038 — the #13 newest-wins guard trusts wall-clock ordering: after a
//  backwards clock step, an account refreshed within the last Δ has a future-dated
//  stored stamp, so its next genuine fetch was silently refused and the stale cache
//  returned as "refreshed". set() now detects a stored stamp beyond plausible skew
//  (>60s in the future) as a clock step and accepts the fresh write; the strict-newer
//  refusal is preserved under a steady clock.
// ════════════════════════════════════════════════════════════════════════════

function tmpStorePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-invstore-'));
  return path.join(dir, 'inventories.json');
}

const record = (username: string, fetchedAt: Date): AccountInventory => ({
  username, steamId: '1', game: 'cs2', source: 'gc', fromCache: false, fetchedAt,
  totalItems: 1,
  items: [{ marketHashName: 'Key', category: 'tradable', tradable: true, tradeLockExpiry: null, quantity: 1, assetIds: ['a'] } as never],
});

test('H-INV-038: a fresh write is accepted over a future-dated (clock-stepped) record, with a warn', () => {
  const p = tmpStorePath();
  const store = new InventoryStore(p);

  // seed a record 10 minutes in the future (as if this account was refreshed before a
  // backwards clock step of ~10 min)
  const future = new Date(Date.now() + 10 * 60_000);
  store.set('user', record('user', future));

  const warnings: string[] = [];
  const origWarn = logger.warn;
  (logger as { warn: unknown }).warn = (msg: unknown): unknown => { warnings.push(String(msg)); return logger; };

  const fresh = new Date(); // genuine fetch, correctly stamped, older than the future record
  try {
    store.set('user', record('user', fresh));
  } finally {
    (logger as { warn: unknown }).warn = origWarn;
  }

  assert.equal(store.get('user')?.fetchedAt?.getTime(), fresh.getTime(),
    'the fresh snapshot replaced the future-dated record');
  assert.ok(warnings.some(m => m.includes('future-dated') && m.includes('user')),
    'a clock-step warn was emitted');
});

test('H-INV-038: a strictly-newer stored record still refuses an older write (steady clock)', () => {
  const p = tmpStorePath();
  const store = new InventoryStore(p);

  const newer = new Date();               // stored: 5s ahead of the incoming (both in the past)
  const older = new Date(newer.getTime() - 5_000);
  store.set('user', record('user', newer));
  store.set('user', record('user', older)); // slower/older concurrent fetch → must be refused

  assert.equal(store.get('user')?.fetchedAt?.getTime(), newer.getTime(),
    'the older write was refused; the newer snapshot is preserved');
});
