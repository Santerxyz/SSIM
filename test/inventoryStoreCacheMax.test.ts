import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseInvCacheMax } from '../src/core/InventoryStore';

// ════════════════════════════════════════════════════════════════════════════
//  H-INV-034 — SSIM_INV_CACHE_MAX parse used `Number(process.env.X)`, so a
//  set-but-empty var (`SSIM_INV_CACHE_MAX=`) coerced to 0 and silently DISABLED
//  the RAM safety net (Number('') === 0 → explicit-opt-out branch), and any
//  value 1–99 failed `raw >= 100` and silently became 2000 despite the
//  "floor 100" comment. `parseInvCacheMax` now opts out only on the literal
//  string '0', defaults empty/garbage/<1 to 2000, and clamps 1–99 to 100.
// ════════════════════════════════════════════════════════════════════════════

test('H-INV-034: MAX_RECORDS parsing', () => {
  assert.equal(parseInvCacheMax(''), 2000, 'set-but-empty must NOT disable the cap');
  assert.equal(parseInvCacheMax('   '), 2000, 'whitespace-only must NOT disable the cap');
  assert.equal(parseInvCacheMax('0'), Infinity, 'literal 0 is the only opt-out');
  assert.equal(parseInvCacheMax('50'), 100, 'values 1–99 clamp to the documented floor 100');
  assert.equal(parseInvCacheMax('5000'), 5000, 'a valid value >= 100 is used as-is');
  assert.equal(parseInvCacheMax('abc'), 2000, 'garbage falls back to the default');
  assert.equal(parseInvCacheMax('-5'), 2000, 'negative falls back to the default');
  assert.equal(parseInvCacheMax(undefined), 2000, 'unset falls back to the default');
});
