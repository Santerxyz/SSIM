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

// H-PRC-015 — a real persisted rate with a lost/garbage timestamp is "real, age unknown", NOT the 0.92 fallback.
test('ExchangeRateService: real rate with no timestamp → fallback:false, ageMs:null', () => {
  const file = path.join(os.tmpdir(), `ssim-fx-nots-${process.pid}-${Date.now()}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify({ usdToEur: 0.87 }));
    const fx = new ExchangeRateService(file);
    assert.equal(fx.getUsdToEur(), 0.87, 'loads the persisted rate');
    assert.equal(fx.getInfo().fallback, false, 'a loaded real rate is not the hardcoded fallback');
    assert.equal(fx.getInfo().ageMs, null, 'a lost timestamp reads as age unknown (null)');
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
  }
});

// H-PRC-016 — a future/skewed persisted timestamp must clamp ageMs at 0, never report a negative age.
test('ExchangeRateService: future timestamp → ageMs clamped to 0 (no negative age)', () => {
  const file = path.join(os.tmpdir(), `ssim-fx-future-${process.pid}-${Date.now()}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify({ usdToEur: 0.9, updatedAt: Date.now() + 3_600_000 }));
    const fx = new ExchangeRateService(file);
    assert.equal(fx.getInfo().ageMs, 0, 'a future timestamp reads as age 0, not negative');
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
