import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { AccountManager } from '../src/core/AccountManager';
import { vaultDir } from '../src/utils/paths';

// ════════════════════════════════════════════════════════════════════════════
//  H-ACC-013 — a corrupt accounts.json must recover from its sibling .bak (the
//  backup save() writes for exactly this case) instead of bricking boot, and
//  must NEVER fabricate an empty fleet from a failed read (the S4/S7 class).
//    • .bak valid  → recover, quarantine the corrupt main as accounts.json.corrupt-*
//    • .bak absent/corrupt → throw a named error, leave the corrupt file in place,
//      create NO fresh accounts.json.
//  (SSIM_HOME is a throwaway temp dir per test/_setup.cjs, so DB_PATH resolves to
//   a sandboxed Vault/accounts.json.)
// ════════════════════════════════════════════════════════════════════════════

const DB  = vaultDir('accounts.json');
const BAK = `${DB}.bak`;

function cleanVaultDir(): void {
  try { fs.mkdirSync(vaultDir(), { recursive: true }); } catch { /* ignore */ }
  for (const f of fs.readdirSync(vaultDir())) {
    if (f.startsWith('accounts.json')) { try { fs.rmSync(vaultDir(f), { force: true }); } catch { /* ignore */ } }
  }
}

function validDb(...usernames: string[]): string {
  const env = { id: 'env-1', name: 'Standard', proxy: '', createdAt: new Date().toISOString() };
  return JSON.stringify({
    version: 4,
    environments: [env],
    folders: [],
    accounts: usernames.map((u, i) => ({
      id: `id-${i}`, username: u, password: 'pw', maFilePath: `${u}.maFile`,
      environmentId: env.id, folderId: null, enabled: true, addedAt: new Date().toISOString(),
    })),
    updatedAt: new Date().toISOString(),
  });
}

test('H-ACC-013: a corrupt accounts.json with a valid .bak recovers the fleet and quarantines the corrupt original', () => {
  cleanVaultDir();
  const corrupt = '{ "version": 4, "accounts": [ this is not json';
  fs.writeFileSync(DB, corrupt);
  fs.writeFileSync(BAK, validDb('AlphaBot', 'BravoBot'));

  const accounts = new AccountManager();

  assert.equal(accounts.count(), 2, 'the fleet is recovered from the .bak, not fabricated empty');
  assert.equal(accounts.existsRaw('AlphaBot'), true);
  assert.equal(accounts.existsRaw('BravoBot'), true);

  // The corrupt original is quarantined (kept for forensics), never deleted; a fresh save must
  // NOT have clobbered the good .bak with the corrupt main (renamed away before any save).
  const quarantined = fs.readdirSync(vaultDir()).filter(f => f.startsWith('accounts.json.corrupt-'));
  assert.equal(quarantined.length, 1, 'the corrupt original is quarantined as accounts.json.corrupt-*');
  assert.equal(fs.readFileSync(vaultDir(quarantined[0]), 'utf8'), corrupt, 'the quarantined copy is the untouched corrupt bytes');
  assert.equal(JSON.parse(fs.readFileSync(BAK, 'utf8')).accounts.length, 2, 'the good .bak was not clobbered by the corrupt main');
  cleanVaultDir();
});

test('H-ACC-013: a corrupt accounts.json with NO .bak fails loud and creates no fresh database', () => {
  cleanVaultDir();
  const corrupt = '{ half-written accounts file';
  fs.writeFileSync(DB, corrupt);
  assert.equal(fs.existsSync(BAK), false, 'precondition: no backup present');

  assert.throws(() => new AccountManager(), /corrupt/i, 'boot must fail loud, not silently reset to empty');

  assert.equal(fs.readFileSync(DB, 'utf8'), corrupt, 'the corrupt file is left in place for the operator to recover');
  const quarantined = fs.readdirSync(vaultDir()).filter(f => f.startsWith('accounts.json.corrupt-'));
  assert.equal(quarantined.length, 0, 'nothing is quarantined when recovery is impossible');
  cleanVaultDir();
});

test('H-ACC-013: a corrupt accounts.json AND a corrupt .bak fails loud (no recovery source)', () => {
  cleanVaultDir();
  fs.writeFileSync(DB, '{ corrupt main');
  fs.writeFileSync(BAK, '{ also corrupt');
  assert.throws(() => new AccountManager(), /\.bak/i, 'names the .bak that could not recover the file');
  cleanVaultDir();
});

test('H-ACC-013: a valid accounts.json boots normally (baseline — recovery is the only new path)', () => {
  cleanVaultDir();
  fs.writeFileSync(DB, validDb('SoloBot'));
  const accounts = new AccountManager();
  assert.equal(accounts.count(), 1);
  assert.equal(accounts.existsRaw('SoloBot'), true);
  const quarantined = fs.readdirSync(vaultDir()).filter(f => f.startsWith('accounts.json.corrupt-'));
  assert.equal(quarantined.length, 0, 'a healthy load quarantines nothing');
  cleanVaultDir();
});
