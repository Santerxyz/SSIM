import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../src/utils/atomicJson';

// ════════════════════════════════════════════════════════════════════════════
//  H-BOOT-026 — the .bak backup used to be a single copyFileSync that truncated
//  then streamed (torn on a mid-copy crash) and ignored the caller's mode (a
//  0o600 secret's backup came out world-readable). It is now written through a
//  fsync'd temp + rename with the same mode, so a rename failure leaves the
//  previous good .bak intact and a secret's backup inherits owner-only perms.
// ════════════════════════════════════════════════════════════════════════════

const mk = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-atomic-backup-'));
  return path.join(dir, 'vault.enc');
};

test('H-BOOT-026: .bak holds the first-generation content after a second backed-up write', () => {
  const file = mk();
  writeJsonAtomic(file, { gen: 1 }, { spaces: 0, mode: 0o600, backup: true });
  writeJsonAtomic(file, { gen: 2 }, { spaces: 0, mode: 0o600, backup: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { gen: 2 }, 'main file has the latest data');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')),
    { gen: 1 },
    '.bak holds the previous good generation',
  );
  const leftover = fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftover, [], 'no .tmp left behind after the backup rename');
});

test('H-BOOT-026: a backup with mode:0o600 produces an owner-only .bak (POSIX)', { skip: process.platform === 'win32' }, () => {
  const file = mk();
  writeJsonAtomic(file, { gen: 1 }, { spaces: 0, mode: 0o600, backup: true });
  writeJsonAtomic(file, { gen: 2 }, { spaces: 0, mode: 0o600, backup: true });
  assert.equal(fs.statSync(`${file}.bak`).mode & 0o777, 0o600, '.bak inherits the secret mode');
});

test('H-BOOT-026: a bak-temp rename failure leaves the pre-existing .bak intact', () => {
  const file = mk();
  // First backed-up write: no prior file, so no .bak yet.
  writeJsonAtomic(file, { gen: 1 }, { spaces: 0, mode: 0o600, backup: true });
  // Second: creates .bak(gen:1) from the gen:1 file, main becomes gen:2.
  writeJsonAtomic(file, { gen: 2 }, { spaces: 0, mode: 0o600, backup: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { gen: 1 }, 'baseline .bak is gen:1');

  // Third write: fail the backup's rename so the good .bak(gen:1) must survive.
  const bak = `${file}.bak`;
  const realRename = fs.renameSync;
  (fs as { renameSync: typeof realRename }).renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === bak) { const e = new Error('locked') as NodeJS.ErrnoException; e.code = 'EBUSY'; throw e; }
    return realRename(from, to);
  }) as typeof realRename;
  try {
    writeJsonAtomic(file, { gen: 3 }, { spaces: 0, mode: 0o600, backup: true });
  } finally {
    (fs as { renameSync: typeof realRename }).renameSync = realRename;
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { gen: 3 }, 'main write still lands despite backup failure');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(bak, 'utf8')),
    { gen: 1 },
    'pre-existing .bak is left intact (not truncated) when the backup rename fails',
  );
  const leftover = fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftover, [], 'the bak-temp is cleaned up after the failed backup rename');
});
