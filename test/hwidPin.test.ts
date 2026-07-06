import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getHwid, readPinnedHwid, writePinnedHwid, _resetHwidCache, HwidUnavailableError, type HwidFactors } from '../src/licensing/HwidService';
import { dataDir } from '../src/utils/paths';

// ─────────────────────────────────────────────────────────────────────────────
//  S27 — the hwid drifted whenever firstMac()/machineIdSync changed (a VPN/hotspot/
//  virtual adapter, a NIC re-order, or a transient machineId failure) → the seat
//  re-bound → a seat_limit 409 needing owner intervention. The hwid is now PINNED
//  to disk on first computation (identical to the legacy value → deployed seats are
//  unaffected), then held stable across any later factor churn.
//  (Test env sandboxes SSIM_HOME, so the pin lives in a throwaway data dir.)
// ─────────────────────────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;
const pinFile = () => dataDir('hwid.pin');

test('S27: getHwid returns a 64-hex id and PINS it to disk on first computation', () => {
  fs.rmSync(pinFile(), { force: true });
  _resetHwidCache();
  const id = getHwid();
  assert.match(id, HEX64);
  assert.equal(readPinnedHwid(), id, 'the computed id is pinned so it never drifts');
});

test('S27: a PINNED id wins — getHwid returns it even if the live factors would differ (drift-proof)', () => {
  const fixed = 'a'.repeat(64);
  writePinnedHwid(fixed);
  _resetHwidCache();
  assert.equal(getHwid(), fixed, 'the pin is authoritative → a MAC/machineId change cannot re-bind the seat');
});

test('S27: readPinnedHwid rejects a missing or malformed pin (never a false id)', () => {
  fs.rmSync(pinFile(), { force: true });
  assert.equal(readPinnedHwid(), undefined, 'missing → undefined');
  writePinnedHwid('not-a-valid-hwid');
  assert.equal(readPinnedHwid(), undefined, 'malformed → undefined (recompute rather than trust garbage)');
  fs.rmSync(pinFile(), { force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  H-LIC-016 — the un-pinned, degraded-first-boot window: if a live factor read
//  fails (machineId/MAC sentinel) and no pin exists yet, getHwid() must NOT hand
//  back the degraded HMAC as the licensing identity (binding it would burn a second
//  seat on the next healthy boot). It signals unavailable and writes no pin, so the
//  caller can wait for the fingerprint to recover before ever transacting.
// ─────────────────────────────────────────────────────────────────────────────

const healthy = (): HwidFactors => ({
  machineId: 'real-machine-id', hostname: 'host', mac: 'aa:bb:cc:dd:ee:ff',
  cpu: 'cpu', platform: 'win32', arch: 'x64',
});

test('S27-residue: a degraded fingerprint (no-machine-id) is NOT bound as the seat identity, no pin written', () => {
  fs.rmSync(pinFile(), { force: true });
  _resetHwidCache();
  assert.throws(() => getHwid(() => ({ ...healthy(), machineId: 'no-machine-id' })), HwidUnavailableError,
    'a degraded id must signal unavailable, never return a 64-hex id');
  assert.equal(readPinnedHwid(), undefined, 'a degraded fingerprint is never pinned');
  assert.equal(fs.existsSync(pinFile()), false, 'writePinnedHwid was not called on the degraded path');
});

test('S27-residue: a degraded MAC (no-mac) also signals unavailable, no pin written', () => {
  fs.rmSync(pinFile(), { force: true });
  _resetHwidCache();
  assert.throws(() => getHwid(() => ({ ...healthy(), mac: 'no-mac' })), HwidUnavailableError);
  assert.equal(fs.existsSync(pinFile()), false, 'no pin on the degraded-MAC path');
});

test('S27-residue: a HEALTHY fingerprint returns a 64-hex id and pins it (the recovered boot)', () => {
  fs.rmSync(pinFile(), { force: true });
  _resetHwidCache();
  const id = getHwid(healthy);
  assert.match(id, HEX64, 'a healthy fingerprint yields a real id');
  assert.equal(readPinnedHwid(), id, 'a healthy id is pinned so it never drifts');
  fs.rmSync(pinFile(), { force: true });
});
