import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { looksLikeOrphanedVaultInstall } from '../src/core/vaultBoot';
import { shouldRefuseEmptyVaultCreate } from '../src/core/unlockPortal';
import { vaultDir } from '../src/utils/paths';

// ─── B36: detect a farm whose vault.enc is missing so headless boot won't create
//         a fresh empty vault over it (orphaning every account). ────────────────
const DB = vaultDir('accounts.json');

function writeDb(accounts: unknown): void {
  fs.mkdirSync(vaultDir(), { recursive: true });
  fs.writeFileSync(DB, JSON.stringify({ version: 4, accounts }));
}
function clean(): void { try { fs.unlinkSync(DB); } catch { /* ignore */ } }

test('B36: blank-password accounts (prior vault-mode) → orphaned install detected', () => {
  writeDb([{ username: 'a', password: '' }, { username: 'b', password: '' }]);
  try { assert.equal(looksLikeOrphanedVaultInstall(), true); } finally { clean(); }
});

test('B36: real passwords (plaintext/fresh install) → NOT flagged', () => {
  writeDb([{ username: 'a', password: 'realpw' }]);
  try { assert.equal(looksLikeOrphanedVaultInstall(), false); } finally { clean(); }
});

test('B36: no accounts.json / empty accounts → NOT flagged', () => {
  clean();
  assert.equal(looksLikeOrphanedVaultInstall(), false, 'no db');
  writeDb([]);
  try { assert.equal(looksLikeOrphanedVaultInstall(), false, 'empty accounts'); } finally { clean(); }
});

// ─── S18: the sidecar unlock PORTAL (primary windowed path) now respects the same
//         orphan guard the headless CLI has — no silent empty-vault-over-orphan. ──
test('S18: portal REFUSES to create an empty vault when vault.enc is missing over an orphaned accounts.json', () => {
  writeDb([{ username: 'a', password: '' }, { username: 'b', password: '' }]); // orphaned farm
  try {
    assert.equal(shouldRefuseEmptyVaultCreate(false, false), true, 'no vault.enc + orphan + not confirmed → refuse');
    assert.equal(shouldRefuseEmptyVaultCreate(false, true), false, 'explicit createEmptyAnyway → allowed');
    assert.equal(shouldRefuseEmptyVaultCreate(true, false), false, 'vault.enc present → a normal unlock, not a create');
  } finally { clean(); }
});

test('S18: portal allows creating a vault on a genuine fresh install (no orphan)', () => {
  writeDb([{ username: 'a', password: 'realpw' }]); // real passwords → not orphaned
  try { assert.equal(shouldRefuseEmptyVaultCreate(false, false), false, 'a fresh/plaintext install may create'); }
  finally { clean(); }
  clean();
  assert.equal(shouldRefuseEmptyVaultCreate(false, false), false, 'no accounts.json → first run, may create');
});
