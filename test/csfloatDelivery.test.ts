import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { CsFloatDeliveredStore } from '../src/csfloat/CsFloatDeliveredStore';
import { isValidDeliveryTarget } from '../src/csfloat/CsFloatAutoAcceptWorker';

// C6 / INV-F1 — delivered ids must survive a restart, or a sale re-delivers (double send).
test('CsFloatDeliveredStore: delivered ids survive a "restart"', () => {
  const file = path.join(os.tmpdir(), `ssim-delivered-${process.pid}-${Date.now()}.json`);
  try {
    const a = new CsFloatDeliveredStore(file);
    assert.equal(a.has('trade-1'), false);
    a.add('trade-1');
    // Simulate a process bounce: a brand-new instance reads the SAME file.
    const b = new CsFloatDeliveredStore(file);
    assert.equal(b.has('trade-1'), true, 'a new process sees the prior delivery and will not re-send');
    assert.equal(b.has('trade-2'), false);
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* best-effort cleanup */ }
  }
});

// F-2 / INV-F1 — never send to an unverified destination (undocumented CSFloat payload).
test('isValidDeliveryTarget: accepts valid steamID/trade-URL, rejects malformed', () => {
  assert.equal(isValidDeliveryTarget({ assetId: '123', partnerSteamId: '76561198000000000' }), true);
  assert.equal(isValidDeliveryTarget({ assetId: '123', tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=12345&token=AbC-dE1' }), true);
  assert.equal(isValidDeliveryTarget({ assetId: '123', partnerSteamId: 'not-a-steamid' }), false);
  assert.equal(isValidDeliveryTarget({ assetId: 'abc', partnerSteamId: '76561198000000000' }), false); // non-numeric asset
  assert.equal(isValidDeliveryTarget({ assetId: '123' }), false);                                     // no destination
  assert.equal(isValidDeliveryTarget({ assetId: '123', tradeUrl: 'https://evil.example/steal' }), false);
});
