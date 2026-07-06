import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsExtra from 'fs-extra';
import { InventoryStore } from '../src/core/InventoryStore';
import { logger } from '../src/utils/logger';
import type { AccountInventory } from '../src/types/inventory';

// ════════════════════════════════════════════════════════════════════════════
//  H-INV-036 — a transient boot-time READ failure (AV lock / EBUSY on the multi-MB
//  cache this app rewrites during fills) used to be conflated with corruption:
//  load() started empty and the first set()+flush() atomically overwrote the intact
//  fleet cache with a near-empty file — every account reverting to never-refreshed.
//  load() now discriminates: parse/shape failure → start fresh; I/O failure → retry
//  a few times, and if still locked boot empty but preserve the last good file as
//  <path>.bak on the first write instead of destroying it.
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

/** Replace readJsonSync so it throws an EBUSY-style error `throws` times, then delegates. */
function withBusyReads(throws: number): () => void {
  const orig = fsExtra.readJsonSync;
  let n = 0;
  (fsExtra as { readJsonSync: unknown }).readJsonSync = (...args: unknown[]): unknown => {
    if (n++ < throws) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return (orig as (...a: unknown[]) => unknown)(...args);
  };
  return () => { (fsExtra as { readJsonSync: unknown }).readJsonSync = orig; };
}

test('H-INV-036: a transient EBUSY read is retried – the real records still load', () => {
  const p = tmpStorePath();
  // seed a healthy on-disk cache with one funded account
  fsExtra.writeJsonSync(p, { version: 1, records: { funded: record('funded') } }, { spaces: 0 });

  const restore = withBusyReads(2); // fail the first two attempts, succeed on the third
  try {
    const store = new InventoryStore(p);
    assert.equal(store.get('funded')?.totalItems, 1, 'the intact cache was loaded via the retry path');
  } finally {
    restore();
  }
});

test('H-INV-036: an unreadable file is preserved as .bak on the first write (never destroyed)', () => {
  const p = tmpStorePath();
  fsExtra.writeJsonSync(p, { version: 1, records: { funded: record('funded') } }, { spaces: 0 });
  const originalBytes = fs.readFileSync(p);

  const errors: string[] = [];
  const origError = logger.error;
  (logger as { error: unknown }).error = (msg: unknown): unknown => { errors.push(String(msg)); return logger; };

  const restore = withBusyReads(99); // stays locked across all 4 attempts
  try {
    // stub is only needed during construction (the boot-time read); restore it before our
    // own verification reads below so they hit the real file, not the busy stub.
    const store = new InventoryStore(p);
    restore();
    assert.equal(store.get('funded'), undefined, 'booted empty (still locked after retries)');
    assert.ok(errors.some(m => m.includes('.bak')), 'logged an error naming the .bak preservation');

    // the first write must keep the last good file as .bak, then write the new single record
    store.set('fresh', record('fresh'));
    store.flush();

    assert.deepEqual(fs.readFileSync(`${p}.bak`), originalBytes, 'the original cache survives at <path>.bak');
    const written = fsExtra.readJsonSync(p) as { records: Record<string, unknown> };
    assert.deepEqual(Object.keys(written.records), ['fresh'], 'the new file holds only the single fresh record');
  } finally {
    restore();
    (logger as { error: unknown }).error = origError;
  }
});

test('H-INV-036: a parse failure (no error code) still starts fresh without a .bak retry', () => {
  const p = tmpStorePath();
  fs.writeFileSync(p, '{ this is not json'); // SyntaxError on parse → no `code` property

  const store = new InventoryStore(p);
  assert.equal(store.get('anything'), undefined, 'malformed content → started fresh');

  // a normal write must NOT create a .bak (this is the parse path, not the I/O-degraded path)
  store.set('fresh', record('fresh'));
  store.flush();
  assert.equal(fs.existsSync(`${p}.bak`), false, 'no .bak taken for a parse failure');
});
