import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { lockHolderDisposition } from '../src/core/singleInstance';

// ─── P4 / INV-G5: single-instance reclaim decision must never steal a live lock ─
test('lockHolderDisposition: a live SSIM holder is REFUSED (never stolen)', () => {
  assert.equal(lockHolderDisposition(true, 'ssim-backend.exe', 'ssim-backend.exe'), 'refuse');
});

test('lockHolderDisposition: a dead holder is reclaimed', () => {
  assert.equal(lockHolderDisposition(false, '', 'ssim-backend.exe'), 'reclaim');
});

test('lockHolderDisposition: a recycled PID (different binary) is reclaimed', () => {
  assert.equal(lockHolderDisposition(true, 'chrome.exe', 'ssim-backend.exe'), 'reclaim');
});

test('lockHolderDisposition: an UNDETERMINABLE live holder fails SAFE (refuse)', () => {
  assert.equal(lockHolderDisposition(true, '', 'ssim-backend.exe'), 'refuse');
});

// ─── Atomic exclusive create: two racers can't both win (the TOCTOU the old guard had) ──
test('fs.open wx is atomic: a second exclusive-create on the same path fails EEXIST', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ssim-lock-${process.pid}-`));
  const lock = path.join(dir, 'ssim.lock');
  const fd1 = fs.openSync(lock, 'wx');
  fs.writeSync(fd1, '111');
  assert.throws(() => fs.openSync(lock, 'wx'), (e: NodeJS.ErrnoException) => e.code === 'EEXIST',
    'the second racer must fail rather than also acquire');
  fs.closeSync(fd1);
  // After the holder releases (unlink), a fresh exclusive create succeeds.
  fs.unlinkSync(lock);
  const fd2 = fs.openSync(lock, 'wx');
  assert.ok(fd2 >= 0);
  fs.closeSync(fd2);
});
