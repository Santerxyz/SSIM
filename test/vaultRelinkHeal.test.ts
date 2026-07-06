import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { migrateAccountsIntoVault } from '../src/core/vaultBoot';
import { AccountVault, type VaultAccount } from '../src/core/AccountVault';
import { AccountManager } from '../src/core/AccountManager';
import { vaultDir } from '../src/utils/paths';

// ─── H-ACC-011: accounts.json lost while vault.enc survives ─────────────────────
// load() boots a fresh EMPTY database, and every import path refuses an already-vaulted
// username (hasAccount → skipped), so the surviving credentials would be unreachable from the
// UI forever. migrateAccountsIntoVault now self-heals the vault→org direction: it re-registers
// an org record for every vault account (full + token-only) that has no accounts.json entry.

const MAFILE = { account_name: 'bot', shared_secret: 'SS', identity_secret: 'IS' } as never;
function mk(username: string): VaultAccount {
  return { username, password: 'pw123', maFile: MAFILE };
}

function cleanVaultDir(): void {
  for (const f of ['vault.enc', 'vault.enc.bak', 'accounts.json', 'accounts.json.bak']) {
    try { fs.rmSync(vaultDir(f), { force: true }); } catch { /* ignore */ }
  }
}

test('H-ACC-011: vault accounts with no accounts.json record are re-linked at boot', () => {
  // Start from a CLEAN throwaway Vault/ (SSIM_HOME is a temp dir per _setup.cjs) so the singleton
  // vault + the fresh AccountManager begin empty and the count is deterministic.
  cleanVaultDir();
  try {
    // A fresh vault with 2 full accounts + 1 token-only (QR/LIMITED) entry.
    AccountVault.unlockOrCreate('heal-pw');
    assert.equal(AccountVault.importAccount(mk('AlphaBot')), true);
    assert.equal(AccountVault.importAccount(mk('BravoBot')), true);
    AccountVault.setToken('CharlieBot', 'refresh-token-xyz'); // token-only, no full record

    // An empty AccountManager (fresh accounts.json → one Standard env, zero accounts).
    const accounts = new AccountManager();
    assert.equal(accounts.count(), 0, 'starts with no org records');

    migrateAccountsIntoVault(accounts);

    assert.equal(accounts.count(), 3, 'all 2 full + 1 token-only vault accounts re-linked');
    assert.equal(accounts.existsRaw('AlphaBot'), true);
    assert.equal(accounts.existsRaw('BravoBot'), true);
    assert.equal(accounts.existsRaw('CharlieBot'), true);
  } finally {
    cleanVaultDir();
  }
});
