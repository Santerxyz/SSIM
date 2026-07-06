import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { AccountManager } from '../src/core/AccountManager';
import { vaultDir, maFilesDir } from '../src/utils/paths';
import { logger } from '../src/utils/logger';

// ════════════════════════════════════════════════════════════════════════════
//  H-ACC-089 / OQ-C8 — the v4 maFilePath migration must align the stored data
//  with what the loader (resolveMaFilePath) actually honors since B23: EVERY
//  absolute path is basenamed into ./mafiles, not just the legacy dirs. An
//  other-drive path whose basenamed file is absent is a broken account — the
//  migration surfaces a one-time "copy into ./mafiles" rescue message instead
//  of silently preserving a value that resolves to a wrong/missing file. B23
//  containment is NOT weakened: no absolute-path read branch is reintroduced.
//  (SSIM_HOME is a throwaway temp dir per test/_setup.cjs.)
// ════════════════════════════════════════════════════════════════════════════

const DB = vaultDir('accounts.json');

function cleanVaultDir(): void {
  try { fs.mkdirSync(vaultDir(), { recursive: true }); } catch { /* ignore */ }
  for (const f of fs.readdirSync(vaultDir())) {
    if (f.startsWith('accounts.json')) { try { fs.rmSync(vaultDir(f), { force: true }); } catch { /* ignore */ } }
  }
}

/** A v3 accounts.json (so only the v3→v4 maFilePath migration runs). */
function v3Db(accounts: Array<{ username: string; maFilePath: string }>): string {
  const env = { id: 'env-1', name: 'Standard', proxy: '', createdAt: new Date().toISOString() };
  return JSON.stringify({
    version: 3,
    environments: [env],
    folders: [],
    accounts: accounts.map((a, i) => ({
      id: `id-${i}`, username: a.username, password: 'pw', maFilePath: a.maFilePath,
      environmentId: env.id, folderId: null, enabled: true, addedAt: new Date().toISOString(),
    })),
    updatedAt: new Date().toISOString(),
  });
}

function captureWarns(fn: () => void): string {
  const origWarn = logger.warn;
  let warned = '';
  (logger as unknown as { warn: (m: string) => void }).warn = (m: string) => { warned += m + '\n'; };
  try { fn(); } finally { (logger as unknown as { warn: typeof origWarn }).warn = origWarn; }
  return warned;
}

test('H-ACC-089: an other-drive absolute maFilePath migrates to ./mafiles/<basename> and warns when the file is absent', () => {
  cleanVaultDir();
  try { fs.rmSync(maFilesDir('bot1.maFile'), { force: true }); } catch { /* ignore */ }
  fs.writeFileSync(DB, v3Db([{ username: 'AlphaBot', maFilePath: 'D:/keys/bot1.maFile' }]));

  let mgr!: AccountManager;
  const warned = captureWarns(() => { mgr = new AccountManager(); });

  const acc = mgr.getAllRaw().find(a => a.username === 'AlphaBot');
  assert.equal(acc?.maFilePath, 'bot1.maFile', 'the other-drive path is normalized to the bare filename the loader honors');
  assert.match(warned, /AlphaBot/, 'the rescue warn names the account');
  assert.match(warned, /copy bot1\.maFile there/, 'the rescue warn tells the operator to copy the file into ./mafiles');
  cleanVaultDir();
});

test('H-ACC-089: a legacy ./mafiles absolute path is basenamed WITHOUT a rescue warn', () => {
  cleanVaultDir();
  fs.writeFileSync(DB, v3Db([{ username: 'BravoBot', maFilePath: 'C:/old/mafiles/bot2.maFile' }]));

  let mgr!: AccountManager;
  const warned = captureWarns(() => { mgr = new AccountManager(); });

  const acc = mgr.getAllRaw().find(a => a.username === 'BravoBot');
  assert.equal(acc?.maFilePath, 'bot2.maFile', 'a legacy-dir absolute path becomes the portable filename');
  assert.doesNotMatch(warned, /BravoBot/, 'a legacy-dir path is expected and does not raise a rescue warn');
  cleanVaultDir();
});

test('H-ACC-089: an other-drive path whose basenamed file EXISTS in ./mafiles is normalized without a rescue warn', () => {
  cleanVaultDir();
  fs.mkdirSync(maFilesDir(), { recursive: true });
  fs.writeFileSync(maFilesDir('present.maFile'), '{}');
  fs.writeFileSync(DB, v3Db([{ username: 'CharlieBot', maFilePath: 'E:/store/present.maFile' }]));

  let mgr!: AccountManager;
  const warned = captureWarns(() => { mgr = new AccountManager(); });

  const acc = mgr.getAllRaw().find(a => a.username === 'CharlieBot');
  assert.equal(acc?.maFilePath, 'present.maFile', 'the path is basenamed to the file that already lives in ./mafiles');
  assert.doesNotMatch(warned, /CharlieBot/, 'the file resolves fine — no rescue message');
  try { fs.rmSync(maFilesDir('present.maFile'), { force: true }); } catch { /* ignore */ }
  cleanVaultDir();
});

test('H-ACC-089: a bare portable filename is left untouched (already ./mafiles-relative)', () => {
  cleanVaultDir();
  fs.writeFileSync(DB, v3Db([{ username: 'DeltaBot', maFilePath: 'bot4.maFile' }]));

  let mgr!: AccountManager;
  const warned = captureWarns(() => { mgr = new AccountManager(); });

  const acc = mgr.getAllRaw().find(a => a.username === 'DeltaBot');
  assert.equal(acc?.maFilePath, 'bot4.maFile', 'a non-absolute path is not touched by the migration');
  assert.doesNotMatch(warned, /DeltaBot/, 'no rescue warn for an already-portable reference');
  cleanVaultDir();
});
