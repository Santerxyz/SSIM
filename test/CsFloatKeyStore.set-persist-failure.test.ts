import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CsFloatKeyStore } from '../src/csfloat/CsFloatKeyStore';
import * as atomicJson from '../src/utils/atomicJson';

// ════════════════════════════════════════════════════════════════════════════
//  H-FLT-009 — set()/delete() must NOT claim success the disk cannot back.
//  In plaintext mode a degraded store or a thrown atomic write leaves the key in
//  memory only; the next boot re-reads an absent key and the operator is never
//  told. set()/delete() now roll back the optimistic in-memory mutation and throw
//  so keyInfo()/has() never report a phantom key. Vault mode is out of scope.
// ════════════════════════════════════════════════════════════════════════════

const mk = (contents?: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-cfk-persist-'));
  const p = path.join(dir, 'csfloat_keys.json');
  if (contents !== undefined) fs.writeFileSync(p, contents);
  return p;
};

test('H-FLT-009: set() on a DEGRADED store throws and leaves NO phantom in-memory key', () => {
  // {"keys":42} → present but wrong shape → degraded.
  const s = new CsFloatKeyStore(mk(JSON.stringify({ keys: 42 })));
  assert.equal(s.isDegraded(), true);
  assert.throws(() => s.set('bot', 'K'), /NOT saved/);
  assert.equal(s.get('bot'), undefined, 'a refused write must not leave the key in memory');
  assert.equal(s.has('bot'), false);
});

test('H-FLT-009: set() rolls back and throws when the atomic write throws', () => {
  const s = new CsFloatKeyStore(mk(JSON.stringify({ version: 1, keys: {} })));
  const orig = atomicJson.writeJsonAtomic;
  (atomicJson as { writeJsonAtomic: typeof orig }).writeJsonAtomic = () => { throw new Error('EACCES'); };
  try {
    assert.throws(() => s.set('bot', 'K'), /NOT saved/);
    assert.equal(s.get('bot'), undefined, 'a thrown write must not leave the key in memory');
  } finally {
    (atomicJson as { writeJsonAtomic: typeof orig }).writeJsonAtomic = orig;
  }
});

test('H-FLT-009: set() overwrite that fails to persist restores the PREVIOUS key, not undefined', () => {
  const p = mk(JSON.stringify({ version: 1, keys: { bot: 'old' } }));
  const s = new CsFloatKeyStore(p);
  assert.equal(s.get('bot'), 'old');
  const orig = atomicJson.writeJsonAtomic;
  (atomicJson as { writeJsonAtomic: typeof orig }).writeJsonAtomic = () => { throw new Error('disk full'); };
  try {
    assert.throws(() => s.set('bot', 'new'), /NOT saved/);
    assert.equal(s.get('bot'), 'old', 'a failed overwrite must restore the prior key, not drop it');
  } finally {
    (atomicJson as { writeJsonAtomic: typeof orig }).writeJsonAtomic = orig;
  }
});

test('H-FLT-009: delete() that fails to persist restores the entry and throws', () => {
  const p = mk(JSON.stringify({ version: 1, keys: { bot: 'K' } }));
  const s = new CsFloatKeyStore(p);
  const orig = atomicJson.writeJsonAtomic;
  (atomicJson as { writeJsonAtomic: typeof orig }).writeJsonAtomic = () => { throw new Error('EACCES'); };
  try {
    assert.throws(() => s.delete('bot'), /NOT cleared/);
    assert.equal(s.get('bot'), 'K', 'a failed delete must not report the key as cleared');
  } finally {
    (atomicJson as { writeJsonAtomic: typeof orig }).writeJsonAtomic = orig;
  }
});

test('H-FLT-009: a healthy set() still persists to disk and does not throw (baseline)', () => {
  const p = mk(JSON.stringify({ version: 1, keys: {} }));
  const s = new CsFloatKeyStore(p);
  s.set('dave', 'key-d');
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).keys.dave, 'key-d');
  assert.equal(s.get('dave'), 'key-d');
});
