import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { consumeCrashMarker } from '../src/utils/crashMarker';

// ════════════════════════════════════════════════════════════════════════════
//  H-BOOT-028 — a TRANSIENT read failure (EBUSY/EPERM/EACCES from an AV lock)
//  must NOT destroy a real crash marker. Only a PARSE/shape failure drops it.
// ════════════════════════════════════════════════════════════════════════════

const tmpFile = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-crash-io-')), 'last-crash.json');

test('H-BOOT-028: a transient read I/O error leaves the marker in place (no unlink)', () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ at: 1_720_000_000_000, code: 1 }));
  const origRead = fs.readFileSync;
  const origUnlink = fs.unlinkSync;
  let unlinkCalled = false;
  (fs as { readFileSync: unknown }).readFileSync = (): string => {
    const err = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException;
    err.code = 'EBUSY';
    throw err;
  };
  (fs as { unlinkSync: unknown }).unlinkSync = (...args: unknown[]): void => {
    unlinkCalled = true;
    return (origUnlink as (...a: unknown[]) => void)(...args);
  };
  try {
    assert.equal(consumeCrashMarker(f), undefined, 'a locked read returns nothing this boot');
    assert.equal(unlinkCalled, false, 'the marker is NOT deleted on a transient read error');
  } finally {
    fs.readFileSync = origRead;
    fs.unlinkSync = origUnlink;
  }
  assert.ok(fs.existsSync(f), 'the marker survives to re-fire next boot');
});

test('H-BOOT-028: a corrupt (unparseable) marker IS dropped', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{ not json');
  assert.equal(consumeCrashMarker(f), undefined);
  assert.ok(!fs.existsSync(f), 'a proven-corrupt marker is deleted so it cannot wedge boot');
});

test('H-BOOT-028: a valid marker is read AND consumed (deleted once)', () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ at: 1_720_000_000_000, code: 1 }));
  const m = consumeCrashMarker(f);
  assert.ok(m, 'the valid marker is returned');
  assert.equal(m?.at, 1_720_000_000_000);
  assert.ok(!fs.existsSync(f), 'a consumed valid marker is deleted');
});
