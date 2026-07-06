import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ════════════════════════════════════════════════════════════════════════════
//  H-BOOT-012 — a present-but-unreadable app_settings.json must DEGRADE, not
//  silently reset to defaults + clobber the good file on the next toggle. The
//  degraded store refuses to write, so csfloatExperimental / the per-account
//  auto-accept map survive until the file is restored. A MISSING file (fresh
//  install) is NOT degraded and saves normally. Mirrors CsFloatKeyStore (S12).
// ════════════════════════════════════════════════════════════════════════════

// AppSettingsImpl is not exported (only the singleton is); pull it via a fresh
// require of the module's class through the injectable-path constructor. We
// re-import the module and reach the class by constructing a sibling instance.
// The class takes an injectable filePath — expose it for the test by importing
// the module and reading the constructor off the singleton's prototype.
import { AppSettings } from '../src/core/AppSettings';

// The singleton is an instance of AppSettingsImpl; grab its constructor so we can
// build test instances against a temp file without touching the real store.
const AppSettingsImpl = (AppSettings as unknown as { constructor: new (filePath?: string) => {
  isDegraded(): boolean;
  setAutoAccept(username: string, on: boolean): void;
  getAutoAccept(username: string): boolean;
} }).constructor;

const mk = (contents?: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-appsettings-'));
  const p = path.join(dir, 'app_settings.json');
  if (contents !== undefined) fs.writeFileSync(p, contents);
  return p;
};

test('H-BOOT-012: a corrupt app_settings.json degrades and setAutoAccept does NOT clobber the file', () => {
  const p = mk('{ not json');
  const s = new AppSettingsImpl(p);
  assert.equal(s.isDegraded(), true);
  s.setAutoAccept('acct', true);            // must be refused — no write
  assert.equal(fs.readFileSync(p, 'utf8'), '{ not json', 'a degraded store must not overwrite the corrupt file');
});

test('H-BOOT-012: a present-but-wrong-shape file (non-object) degrades', () => {
  const p = mk('42');
  const s = new AppSettingsImpl(p);
  assert.equal(s.isDegraded(), true);
});

test('H-BOOT-012: a present-but-wrong-shape csfloatAutoAccept degrades', () => {
  const p = mk(JSON.stringify({ priceSource: 'steam', csfloatAutoAccept: 5 }));
  const s = new AppSettingsImpl(p);
  assert.equal(s.isDegraded(), true);
});

test('H-BOOT-012: a MISSING file is NOT degraded and save() writes normally', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-appsettings-'));
  const p = path.join(dir, 'app_settings.json');          // does not exist yet
  const s = new AppSettingsImpl(p);
  assert.equal(s.isDegraded(), false);
  s.setAutoAccept('bot', true);
  assert.equal(s.getAutoAccept('bot'), true);
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).csfloatAutoAccept.bot, true, 'a fresh store must persist to disk');
});

test('H-BOOT-012: a VALID file loads its values and is NOT degraded', () => {
  const p = mk(JSON.stringify({ version: 1, priceSource: 'csfloat', csfloatExperimental: true, csfloatAutoAccept: { alice: true } }));
  const s = new AppSettingsImpl(p);
  assert.equal(s.isDegraded(), false);
  assert.equal(s.getAutoAccept('alice'), true);
});
