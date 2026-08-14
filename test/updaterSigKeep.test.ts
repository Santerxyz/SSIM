import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verify } from '../src/update/Updater';

// ─────────────────────────────────────────────────────────────────────────────
//  S21 — verify() conflated a sha MISMATCH (corrupt bytes → delete + re-fetch is
//  right) with a SIGNATURE failure on sha-intact bytes (a key-divergent/unsigned
//  manifest → a re-download yields the identical failure → a 185 MB re-download
//  every boot forever). verify now reports shaOk separately so the caller deletes
//  ONLY on a sha mismatch and KEEPS a sha-intact artifact.
// ─────────────────────────────────────────────────────────────────────────────

function mkFile(): { dir: string; file: string; sha: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-sig-'));
  const file = path.join(dir, 'a.exe');
  const bytes = Buffer.from('MZ fake artifact bytes for the verify test');
  fs.writeFileSync(file, bytes);
  return { dir, file, sha: crypto.createHash('sha256').update(bytes).digest('hex') };
}

test('S21: a sha MISMATCH → shaOk:false (caller deletes + re-downloads)', async () => {
  const { dir, file } = mkFile();
  try {
    const v = await verify(file, { latest: '1.0.0', url: '', sha256: 'de'.repeat(32), sig: '', sigKind: '' } as never);
    assert.equal(v.ok, false);
    assert.equal(v.shaOk, false, 'corrupt bytes → worth re-fetching');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S21: sha INTACT but NO sigKind → shaOk:true (caller KEEPS — re-download would not help)', async () => {
  const { dir, file, sha } = mkFile();
  try {
    const v = await verify(file, { latest: '1.0.0', url: '', sha256: sha, sig: 'x', sigKind: '' } as never);
    assert.equal(v.ok, false, 'still refused (no kind-inclusive signature)');
    assert.equal(v.shaOk, true, 'the artifact is KEPT so the next boot re-verifies network-free');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S21: sha INTACT but an INVALID signature → shaOk:true (caller KEEPS)', async () => {
  const { dir, file, sha } = mkFile();
  try {
    const v = await verify(file, { latest: '1.0.0', url: '', sha256: sha, sig: 'x', sigKind: 'AAAA' } as never);
    assert.equal(v.ok, false, 'a bad signature is refused');
    assert.equal(v.shaOk, true, 'but the sha-intact artifact is KEPT (key-divergent manifest → re-download loops)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
