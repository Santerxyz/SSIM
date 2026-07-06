import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../src/utils/atomicJson';

// ════════════════════════════════════════════════════════════════════════════
//  H-BOOT-025 — a transient Windows rename lock (EPERM/EBUSY from an AV/indexer
//  holding the target open) used to throw on the FIRST attempt and discard the
//  already-fsync'd temp, permanently degrading TokenStore/CsFloatKeyStore/vault
//  persistence for the whole session. The final rename is now retried for a
//  bounded transient-code set; permanent codes still throw at once with no wait.
// ════════════════════════════════════════════════════════════════════════════

const mk = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-atomic-rename-'));
  return path.join(dir, 'accounts.json');
};

test('H-BOOT-025: a transient EPERM on rename is retried and the write lands', () => {
  const file = mk();
  const realRename = fs.renameSync;
  let calls = 0;
  (fs as { renameSync: typeof realRename }).renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    calls++;
    if (calls < 3) { const e = new Error('locked') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e; }
    return realRename(from, to);
  }) as typeof realRename;
  try {
    writeJsonAtomic(file, { ok: true });
  } finally {
    (fs as { renameSync: typeof realRename }).renameSync = realRename;
  }
  assert.equal(calls, 3, 'rename retried until it succeeded');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: true }, 'target holds the new data');
  const leftover = fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftover, [], 'no .tmp left behind after a successful retried rename');
});

test('H-BOOT-025: a permanent ENOSPC throws immediately with no retry and cleans the temp', () => {
  const file = mk();
  const realRename = fs.renameSync;
  let calls = 0;
  (fs as { renameSync: typeof realRename }).renameSync = (() => {
    calls++;
    const e = new Error('disk full') as NodeJS.ErrnoException; e.code = 'ENOSPC'; throw e;
  }) as typeof realRename;
  try {
    assert.throws(() => writeJsonAtomic(file, { ok: true }), /disk full/);
  } finally {
    (fs as { renameSync: typeof realRename }).renameSync = realRename;
  }
  assert.equal(calls, 1, 'a permanent code is not retried');
  const leftover = fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftover, [], 'the temp is unlinked when the write gives up');
});

test('H-BOOT-025: a persistent transient lock gives up after the attempt cap and cleans the temp', () => {
  const file = mk();
  const realRename = fs.renameSync;
  let calls = 0;
  (fs as { renameSync: typeof realRename }).renameSync = (() => {
    calls++;
    const e = new Error('busy') as NodeJS.ErrnoException; e.code = 'EBUSY'; throw e;
  }) as typeof realRename;
  try {
    assert.throws(() => writeJsonAtomic(file, { ok: true }), /busy/);
  } finally {
    (fs as { renameSync: typeof realRename }).renameSync = realRename;
  }
  assert.equal(calls, 5, 'retries are bounded by the attempt cap');
  const leftover = fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftover, [], 'the temp is unlinked on final give-up');
});
