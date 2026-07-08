import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { lockHolderDisposition, sleepSync, acquireInstanceLock, lockRefusalDetail } from '../src/core/singleInstance';
import { logger } from '../src/utils/logger';

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

test('S59: an UNDETERMINABLE live holder RETRIES (not an immediate residual lockout)', () => {
  // tasklist blocked/timeout → '' image. Old behaviour refused outright (a recycled-PID false lockout);
  // now we retry the check first, and only fail safe after all attempts still can't determine it.
  assert.equal(lockHolderDisposition(true, '', 'ssim-backend.exe'), 'retry');
});

test('S59: a live SSIM whose image we CAN read is still REFUSED (false-reclaim prevention intact)', () => {
  assert.equal(lockHolderDisposition(true, 'ssim-backend.exe', 'ssim-backend.exe'), 'refuse');
});

// ─── S59: sleepSync must keep a real retry window even if SharedArrayBuffer construction throws ──
test('sleepSync preserves a real delay when SharedArrayBuffer construction throws', () => {
  const OrigSAB = globalThis.SharedArrayBuffer;
  // Monkeypatch SAB to a constructor that throws → forces sleepSync onto the fallback spin path.
  (globalThis as { SharedArrayBuffer: unknown }).SharedArrayBuffer = function () {
    throw new Error('SAB blocked');
  };
  try {
    const start = Date.now();
    sleepSync(200);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 150, `fallback spin should hold ~200ms, waited ${elapsed}ms`);
  } finally {
    (globalThis as { SharedArrayBuffer: unknown }).SharedArrayBuffer = OrigSAB;
  }
});

// ─── H-BOOT-008: a PERMANENT lock IO error refuses immediately, names the cause, burns no retries ──
test('a permanent lock IO error refuses immediately without burning retries', () => {
  // A read-only / access-denied data/ is a permanent fault: acquireInstanceLock must NOT spin the 5
  // S59 retries (each logs a warn) nor end on a generic "already running" lie — it must fail fast with
  // exactly one error naming the code, and expose the cause via lockRefusalDetail() for the lockscreen.
  const origOpen = fs.openSync;
  const origWarn = logger.warn.bind(logger);
  const origError = logger.error.bind(logger);
  const warns: unknown[] = [];
  const errors: unknown[] = [];
  (fs as unknown as { openSync: unknown }).openSync = () => {
    const e: NodeJS.ErrnoException = new Error('EROFS: read-only file system, open');
    e.code = 'EROFS';
    throw e;
  };
  (logger as unknown as { warn: unknown }).warn = (m: unknown) => { warns.push(m); return logger; };
  (logger as unknown as { error: unknown }).error = (m: unknown) => { errors.push(m); return logger; };
  try {
    const ok = acquireInstanceLock();
    assert.equal(ok, false, 'a permanent lock IO error must refuse to start');
    assert.equal(warns.length, 0, 'the permanent branch must log NO per-attempt retry warnings');
    assert.equal(errors.length, 1, 'exactly one error line for the permanent cause');
    assert.match(String(errors[0]), /EROFS/, 'the error must name the permanent error code');
    assert.match(String(lockRefusalDetail() ?? ''), /EROFS/, 'the refusal detail must carry the cause for the lockscreen');
  } finally {
    (fs as unknown as { openSync: unknown }).openSync = origOpen;
    (logger as unknown as { warn: unknown }).warn = origWarn;
    (logger as unknown as { error: unknown }).error = origError;
  }
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
