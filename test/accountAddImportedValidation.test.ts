import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { AccountManager } from '../src/core/AccountManager';
import { vaultDir } from '../src/utils/paths';

// ════════════════════════════════════════════════════════════════════════════
//  H-ACC-016 — addImportedAccount must validate env/folder before the push, at
//  parity with its sibling add(). A dangling environmentId (or a folder that
//  belongs to another env) would create a record invisible in every env-scoped
//  tree yet still counted in fleet ops. The guards convert that silent
//  invisible-account state into an immediate, attributable throw.
//  (SSIM_HOME is a throwaway temp dir per test/_setup.cjs.)
// ════════════════════════════════════════════════════════════════════════════

const DB = vaultDir('accounts.json');

function cleanVaultDir(): void {
  try { fs.mkdirSync(vaultDir(), { recursive: true }); } catch { /* ignore */ }
  for (const f of fs.readdirSync(vaultDir())) {
    if (f.startsWith('accounts.json')) { try { fs.rmSync(vaultDir(f), { force: true }); } catch { /* ignore */ } }
  }
}

function seed(): AccountManager {
  cleanVaultDir();
  const env = { id: 'env-1', name: 'Standard', proxy: '', createdAt: new Date().toISOString() };
  fs.writeFileSync(DB, JSON.stringify({
    version: 4, environments: [env], folders: [], accounts: [], updatedAt: new Date().toISOString(),
  }));
  return new AccountManager();
}

test('H-ACC-016: addImportedAccount with a bogus environmentId throws and creates no record', () => {
  const accounts = seed();
  assert.throws(
    () => accounts.addImportedAccount({ username: 'GhostBot', maFilePath: 'GhostBot.maFile', environmentId: 'nope' }),
    /Environment "nope" not found/,
  );
  assert.equal(accounts.existsRaw('GhostBot'), false, 'the invalid import left no dangling record');
  cleanVaultDir();
});

test('H-ACC-016: addImportedAccount with a folder from a different environment throws', () => {
  const accounts = seed();
  const otherEnv = accounts.createEnvironment('Other');
  const foreignFolder = accounts.createFolder('Foreign', otherEnv.id);
  assert.throws(
    () => accounts.addImportedAccount({ username: 'CrossBot', maFilePath: 'CrossBot.maFile', environmentId: 'env-1', folderId: foreignFolder.id }),
    /different environment/,
  );
  assert.equal(accounts.existsRaw('CrossBot'), false);
  cleanVaultDir();
});

test('H-ACC-016: addImportedAccount still adds when env (and matching folder) validate', () => {
  const accounts = seed();
  const folder = accounts.createFolder('Imports', 'env-1');
  accounts.addImportedAccount({ username: 'GoodBot', maFilePath: 'GoodBot.maFile', environmentId: 'env-1', folderId: folder.id });
  const stored = accounts.get('GoodBot');
  assert.ok(stored, 'the valid import created the record');
  assert.equal(stored?.environmentId, 'env-1');
  assert.equal(stored?.folderId, folder.id);
  // Re-import of an existing username stays a no-op (idempotency preserved, guards never reached).
  accounts.addImportedAccount({ username: 'GoodBot', maFilePath: 'GoodBot.maFile', environmentId: 'env-1' });
  assert.equal(accounts.count(), 1);
  cleanVaultDir();
});
