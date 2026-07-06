import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { MoneyOps, assetKey } from '../src/trading/MoneyOps';
import { PriceCache } from '../src/pricing/PriceCache';

// D2 / INV-D2 — a shared concurrent-op guard blocks the same asset across services,
// but releases so legitimate SEQUENTIAL ops are unaffected.
test('MoneyOps: blocks a concurrent claim, allows a sequential one', () => {
  const k = assetKey('Bot1', '123');
  assert.equal(MoneyOps.held(k), false);
  assert.equal(MoneyOps.claim(k), true,  'first claim succeeds');
  assert.equal(MoneyOps.held(k), true);
  assert.equal(MoneyOps.claim(k), false, 'a CONCURRENT claim on the same asset is refused');
  MoneyOps.release(k);
  assert.equal(MoneyOps.held(k), false);
  assert.equal(MoneyOps.claim(k), true,  'after release a SEQUENTIAL op is allowed');
  MoneyOps.release(k);
  assert.equal(assetKey('BOT1', '123'), assetKey('bot1', '123'), 'key is case-insensitive on username');
});

// H-TRD-102 — claimAll/releaseAll give the caller an ATOMIC all-or-nothing guard over N keys,
// so the multi-asset invariant lives in the tested module (not a scan-then-forEach in the caller).
test('MoneyOps: claimAll is atomic all-or-nothing, releaseAll frees all', () => {
  // (a) claimAll over unheld keys claims every key.
  assert.equal(MoneyOps.claimAll(['k1', 'k2']), true, 'claimAll over unheld keys succeeds');
  assert.equal(MoneyOps.held('k1'), true);
  assert.equal(MoneyOps.held('k2'), true);
  MoneyOps.releaseAll(['k1', 'k2']);
  // (b) with one key already held, claimAll refuses AND claims NOTHING (no partial claim).
  assert.equal(MoneyOps.claim('k3'), true);
  assert.equal(MoneyOps.claimAll(['k4', 'k3']), false, 'claimAll refuses when any key is held');
  assert.equal(MoneyOps.held('k4'), false, 'the free key is NOT claimed on refusal');
  MoneyOps.release('k3');
  // (c) input duplicates do not self-collide (the has-scan runs before any add).
  assert.equal(MoneyOps.claimAll(['k5', 'k5']), true, 'duplicate keys within the batch do not self-collide');
  assert.equal(MoneyOps.held('k5'), true);
  // (d) releaseAll frees every key.
  MoneyOps.releaseAll(['k5', 'k5']);
  assert.equal(MoneyOps.held('k5'), false, 'releaseAll frees the key');
});

// E2 / INV-E2 — the price cache only ever stores USD cents (finite, ≥0, integer) or null.
test('PriceCache: rejects/normalizes non-cents values at the write boundary', () => {
  const file = path.join(os.tmpdir(), `ssim-prices-${process.pid}-${Date.now()}.json`);
  try {
    const pc = new PriceCache(file);
    pc.set('nan', Number.NaN);   assert.equal(pc.get('nan')?.cents, null, 'NaN → miss');
    pc.set('neg', -5);           assert.equal(pc.get('neg')?.cents, null, 'negative → miss');
    pc.set('inf', Infinity);     assert.equal(pc.get('inf')?.cents, null, 'non-finite → miss');
    pc.set('frac', 12.7);        assert.equal(pc.get('frac')?.cents, 13, 'fractional → rounded integer cents');
    pc.set('ok', 100);           assert.equal(pc.get('ok')?.cents, 100);
    pc.set('null', null);        assert.equal(pc.get('null')?.cents, null);
    pc.flush();
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
  }
});
