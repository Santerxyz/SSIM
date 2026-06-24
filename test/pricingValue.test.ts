import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { ExchangeRateService } from '../src/pricing/ExchangeRateService';
import { snapshotGames } from '../src/core/ValueHistoryService';

// C20 / INV-E5 — a persisted rate must survive a cold start (no revert to 0.92).
test('ExchangeRateService: a persisted rate loads on construction (no 0.92 cold start)', () => {
  const file = path.join(os.tmpdir(), `ssim-fx-${process.pid}-${Date.now()}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify({ usdToEur: 0.88, updatedAt: 123456 }));
    const fx = new ExchangeRateService(file);
    assert.equal(fx.getUsdToEur(), 0.88, 'loads the persisted rate, not the 0.92 fallback');
    assert.equal(fx.getInfo().fallback, false, 'a persisted real rate is not flagged as fallback');
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
  }
});

test('ExchangeRateService: missing file → honest 0.92 fallback (flagged)', () => {
  const fx = new ExchangeRateService(path.join(os.tmpdir(), `ssim-fx-missing-${process.pid}-${Date.now()}.json`));
  assert.equal(fx.getUsdToEur(), 0.92);
  assert.equal(fx.getInfo().fallback, true);
});

// C21 / INV-E6 — a snapshot must touch ONLY the refreshed game's series.
test('snapshotGames: scopes the snapshot to the refreshed game', () => {
  assert.deepEqual(snapshotGames('cs2'), { cs2: true, tf2: false });
  assert.deepEqual(snapshotGames('tf2'), { cs2: false, tf2: true });
  assert.deepEqual(snapshotGames(undefined), { cs2: true, tf2: true });
});
