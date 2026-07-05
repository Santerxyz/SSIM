import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDelivery, isValidDeliveryTarget } from '../src/csfloat/CsFloatAutoAcceptWorker';

// ════════════════════════════════════════════════════════════════════════════
//  H-FLT-002 — a steamID64 (~7.66e16) is far above Number.MAX_SAFE_INTEGER
//  (9.0e15). If CSFloat ever emits buyer_id/steam_id as a bare JSON NUMBER,
//  JSON.parse has already rounded it before pickString runs; String(v) then
//  stringifies a wrong-but-still-17-digit `7656…` value that slips past
//  STEAMID64_RE and mis-delivers the asset to a DIFFERENT Steam account.
//
//  Fix: pickString accepts a numeric id ONLY when Number.isSafeInteger(v), so an
//  unsafe-magnitude numeric steamID is discarded (→ undefined → the row is
//  skipped, never sent) rather than trusted as a valid destination.
// ════════════════════════════════════════════════════════════════════════════

test('H-FLT-002: a numeric buyer_id past 2^53 yields partnerSteamId === undefined (never a valid target)', () => {
  // 76561199012345678 > Number.MAX_SAFE_INTEGER — already rounded by JSON.parse.
  const d = extractDelivery({ buyer_id: 76561199012345678, item: { asset_id: '123456789' } });
  assert.notEqual(d, null, 'a numeric asset_id string is present, so extractDelivery still returns a record');
  assert.equal(d?.partnerSteamId, undefined, 'the unsafe-magnitude numeric steamID is discarded, not stringified');
  // The validator must NOT green-light a numerically-sourced steamID: with no valid destination
  // (no tradeUrl either), isValidDeliveryTarget is false → the row is skipped, never sent.
  assert.equal(isValidDeliveryTarget(d!), false, 'no valid destination → not deliverable');
});

test('H-FLT-002: a string steamID64 (the normal case) is untouched', () => {
  const d = extractDelivery({ buyer_id: '76561199012345678', item: { asset_id: '123456789' } });
  assert.equal(d?.partnerSteamId, '76561199012345678', 'string ids pass through unchanged');
  assert.equal(isValidDeliveryTarget(d!), true, 'a valid string steamID + numeric asset is deliverable');
});
