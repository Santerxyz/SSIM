import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { AccountVault } from '../src/core/AccountVault';
import { AccountManager } from '../src/core/AccountManager';
import { importDropZoneIntoVault, importCsvIntoVault, importExternalVault } from '../src/core/vaultBoot';
import { vaultDir } from '../src/utils/paths';

// ─── H-ACC-029: a locked vault / missing target env must FAIL LOUDLY ──────────────
// All three vault import funnels used to `return { imported: 0, skipped: 0, … }` when the
// vault was locked or targetEnvId was empty — a fabricated clean-zero success indistinguishable
// from "ran, source held nothing new". Unreachable via the routes today (each pre-validates), but
// a guard-bypassing caller (the planned Discord-bot service) would read fake success from a locked
// vault. The guards now throw; the routes map the throw to a 400 JSON (never an Express 500 HTML).

function cleanVaultDir(): void {
  for (const f of ['vault.enc', 'vault.enc.bak', 'accounts.json', 'accounts.json.bak']) {
    try { fs.rmSync(vaultDir(f), { force: true }); } catch { /* ignore */ }
  }
}

// The guard is the first statement in each function, so it throws before `accounts` is touched.
const stub = {} as unknown as AccountManager;

test('H-ACC-029: import funnels throw "vault not unlocked" when the vault is locked', () => {
  assert.equal(AccountVault.isEnabled(), false, 'precondition: the singleton starts locked');
  assert.throws(() => importDropZoneIntoVault(stub, 'env', null, ['a.maFile']), /vault not unlocked/);
  assert.throws(() => importCsvIntoVault(stub, 'u,p,s,i', 'env', null), /vault not unlocked/);
  assert.throws(() => importExternalVault(stub, 'raw', 'pw', undefined, 'env', null), /vault not unlocked/);
});

test('H-ACC-029: import funnels throw "targetEnvId is required" when the target env is empty', () => {
  cleanVaultDir();
  try {
    AccountVault.unlockOrCreate('local-pw');
    assert.throws(() => importDropZoneIntoVault(stub, '', null, ['a.maFile']), /targetEnvId is required/);
    assert.throws(() => importCsvIntoVault(stub, 'u,p,s,i', '', null), /targetEnvId is required/);
    assert.throws(() => importExternalVault(stub, 'raw', 'pw', undefined, '', null), /targetEnvId is required/);
  } finally {
    cleanVaultDir();
  }
});
