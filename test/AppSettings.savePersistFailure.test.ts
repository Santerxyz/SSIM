import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { AppSettings } from '../src/core/AppSettings';
import * as atomicJson from '../src/utils/atomicJson';

// ════════════════════════════════════════════════════════════════════════════
//  H-BOOT-013 — a failed persist must NOT be reported to the caller as success.
//  save() now returns false when the write is refused (degraded) or throws
//  (disk full / EPERM / read-only volume), and the setters return that boolean.
//  The PUT auto-accept route surfaces a truthful 500 "not saved" message keyed
//  off the real write outcome instead of echoing the optimistic in-memory value.
// ════════════════════════════════════════════════════════════════════════════

// AppSettingsImpl is not exported (only the singleton is); grab its constructor
// off the singleton so we can build test instances against a temp file.
const AppSettingsImpl = (AppSettings as unknown as { constructor: new (filePath?: string) => {
  isDegraded(): boolean;
  setAutoAccept(username: string, on: boolean): boolean;
  setPriceSource(s: 'steam' | 'csfloat'): boolean;
  setCsfloatExperimental(on: boolean): boolean;
  getAutoAccept(username: string): boolean;
} }).constructor;

const mk = (contents?: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-appsettings-save-'));
  const p = path.join(dir, 'app_settings.json');
  if (contents !== undefined) fs.writeFileSync(p, contents);
  return p;
};

test('H-BOOT-013: setAutoAccept returns false when the atomic write throws', () => {
  const s = new AppSettingsImpl(mk(JSON.stringify({ version: 1, priceSource: 'steam', csfloatExperimental: false, csfloatAutoAccept: {} })));
  assert.equal(s.isDegraded(), false);
  const orig = atomicJson.writeJsonAtomic;
  (atomicJson as { writeJsonAtomic: typeof orig }).writeJsonAtomic = () => { throw new Error('EACCES'); };
  try {
    assert.equal(s.setAutoAccept('bot', true), false, 'a failed persist must be reported as false, not silent success');
  } finally {
    (atomicJson as { writeJsonAtomic: typeof orig }).writeJsonAtomic = orig;
  }
});

test('H-BOOT-013: setAutoAccept on a DEGRADED store returns false (refused write)', () => {
  const s = new AppSettingsImpl(mk('{ not json'));
  assert.equal(s.isDegraded(), true);
  assert.equal(s.setAutoAccept('bot', true), false, 'a degraded store must report the toggle as NOT persisted');
});

test('H-BOOT-013: setPriceSource / setCsfloatExperimental also return false when the write throws', () => {
  const s = new AppSettingsImpl(mk(JSON.stringify({ version: 1, priceSource: 'steam', csfloatExperimental: false, csfloatAutoAccept: {} })));
  const orig = atomicJson.writeJsonAtomic;
  (atomicJson as { writeJsonAtomic: typeof orig }).writeJsonAtomic = () => { throw new Error('disk full'); };
  try {
    assert.equal(s.setPriceSource('csfloat'), false);
    assert.equal(s.setCsfloatExperimental(true), false);
  } finally {
    (atomicJson as { writeJsonAtomic: typeof orig }).writeJsonAtomic = orig;
  }
});

test('H-BOOT-013: a healthy setAutoAccept returns true and persists to disk (baseline)', () => {
  const p = mk(JSON.stringify({ version: 1, priceSource: 'steam', csfloatExperimental: false, csfloatAutoAccept: {} }));
  const s = new AppSettingsImpl(p);
  assert.equal(s.setAutoAccept('alice', true), true, 'a successful persist must return true');
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).csfloatAutoAccept.alice, true);
});

test('H-BOOT-013: the PUT auto-accept route surfaces a 500 not-saved message keyed off the persist outcome', () => {
  // Source-level guard: the route must gate on the setAutoAccept return and respond 500 with the
  // truthful "not survive a restart" message instead of echoing the optimistic in-memory value.
  const src = readFileSync(path.join(__dirname, '..', 'src', 'api', 'server.ts'), 'utf8');
  assert.match(src, /if \(!csfloat\.setAutoAccept\(req\.params\.username, enabled\)\)/,
    'the route must branch on the setAutoAccept persist outcome');
  assert.match(src, /res\.status\(500\)\.json\(\{ error: 'Setting changed in memory but could not be saved to disk; it will not survive a restart\. Check disk space \/ file permissions on data\/app_settings\.json\.' \}\)/,
    'the route must respond 500 with the truthful not-saved message');
});
