import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { storeToken, readToken } from '../src/licensing/LicenseClient';
import { dataDir } from '../src/utils/paths';

// ─────────────────────────────────────────────────────────────────────────────
//  S38 — the MAIN license.token was written non-atomically; a power-cut during a
//  heartbeat token refresh left a torn file → the next OFFLINE boot was locked
//  out. Now it's written temp→rename (atomic), and readToken falls back to the
//  atomic .json sidecar for any pre-existing torn file. (Test env sandboxes
//  SSIM_HOME, so tokens live in a throwaway data dir.)
// ─────────────────────────────────────────────────────────────────────────────

const main = () => dataDir('license.token');

test('S38: storeToken round-trips and writes BOTH the main file and the atomic sidecar', () => {
  storeToken('signed.token.ABC');
  assert.equal(readToken(), 'signed.token.ABC');
  assert.equal(fs.readFileSync(main(), 'utf8').trim(), 'signed.token.ABC', 'main file written');
  assert.equal(JSON.parse(fs.readFileSync(`${main()}.json`, 'utf8')).token, 'signed.token.ABC', 'atomic sidecar written');
});

test('S38: readToken RECOVERS from the sidecar when the main file is torn (empty)', () => {
  storeToken('recover.me.XYZ');
  fs.writeFileSync(main(), ''); // simulate a power-cut torn/zero-length main file (pre-fix)
  assert.equal(readToken(), 'recover.me.XYZ', 'the atomic .json sidecar recovers the token — no offline lockout');
});
