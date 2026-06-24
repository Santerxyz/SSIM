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
