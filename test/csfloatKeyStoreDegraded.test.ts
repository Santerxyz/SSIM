import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CsFloatKeyStore } from '../src/csfloat/CsFloatKeyStore';

// ════════════════════════════════════════════════════════════════════════════
//  S12 — a PRESENT-but-corrupt csfloat_keys.json must mark the store DEGRADED
//  (refuse writes, keep the file + its .bak untouched) instead of silently
//  resetting to empty and then persisting that empty state over the good file
//  and its .bak. Mirrors the B2 TokenStore / DeliveredStore pattern. Plaintext
//  mode only — vault mode reads keys from the vault, and AccountVault is disabled
//  by default in tests.
// ════════════════════════════════════════════════════════════════════════════

const mk = (contents?: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-cfk-'));
  const p = path.join(dir, 'csfloat_keys.json');
  if (contents !== undefined) fs.writeFileSync(p, contents);
  return p;
};

test('S12: a corrupt (unparseable) file → DEGRADED, not silently reset to empty', () => {
  const p = mk('{ this is not json');
  assert.equal(new CsFloatKeyStore(p).isDegraded(), true, 'an unreadable file must degrade, not reset');
});

test('S12: a present-but-wrong-shape file (no keys object) → DEGRADED', () => {
  assert.equal(new CsFloatKeyStore(mk(JSON.stringify({ version: 1, keys: 'nope' }))).isDegraded(), true);
  assert.equal(new CsFloatKeyStore(mk(JSON.stringify([1, 2, 3]))).isDegraded(), true);
});

test('S12: a MISSING file (fresh install) is NOT degraded', () => {
  assert.equal(new CsFloatKeyStore(mk(undefined)).isDegraded(), false);
});

test('S12: an empty-but-valid file ({keys:{}}) is NOT degraded', () => {
  assert.equal(new CsFloatKeyStore(mk(JSON.stringify({ version: 1, keys: {} }))).isDegraded(), false);
});

test('S12: a valid file loads its keys and is not degraded', () => {
  const s = new CsFloatKeyStore(mk(JSON.stringify({ version: 1, keys: { alice: 'key-a' } })));
  assert.equal(s.isDegraded(), false);
  assert.equal(s.get('Alice'), 'key-a', 'lookup is case-insensitive');
  assert.equal(s.has('alice'), true);
});

test('S12: while DEGRADED, a set() does NOT clobber the corrupt file or write a .bak', () => {
  const corrupt = '{ half-written keys file';
  const p = mk(corrupt);
  const s = new CsFloatKeyStore(p);
  assert.equal(s.isDegraded(), true);
  s.set('carol', 'key-c'); // must NOT persist
  assert.equal(fs.readFileSync(p, 'utf8'), corrupt, 'the corrupt file is left byte-for-byte untouched');
  assert.equal(fs.existsSync(`${p}.bak`), false, 'no .bak written (would clobber the last-good backup)');
  assert.equal(s.get('carol'), 'key-c', 'in-memory still works for THIS run');
});

test('S12: a healthy store persists a key to disk (baseline — degraded is the only no-write path)', () => {
  const p = mk(JSON.stringify({ version: 1, keys: {} }));
  new CsFloatKeyStore(p).set('dave', 'key-d');
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).keys.dave, 'key-d', 'a non-degraded store persists normally');
});
