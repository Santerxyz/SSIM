import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { migrateVaultDir, dataDir, vaultDir } from '../src/utils/paths';

// ─── H-BOOT-021: when BOTH data/<name> and Vault/<name> hold a primary file, the
//     one-time migration's `!existsSync(to)` guard skips the rename — the app then
//     adopts the Vault/ copy and the data/ copy is orphaned, unread, with no signal.
//     migrateVaultDir must NOT auto-pick a winner (never move/delete/overwrite), but
//     it MUST surface the ambiguity so a partial-restore can't silently lose accounts:
//     a boot-visible marker file that names both paths. (Sibling of the S18 orphan
//     guard, which covers the inverse state: accounts.json present, vault.enc absent.)
// ─────────────────────────────────────────────────────────────────────────────
const STRAY_BYTES = 'STALE-DATA-COPY';   // the leftover data/ generation
const KEPT_BYTES = 'MIGRATED-VAULT-COPY'; // the Vault/ generation the app uses
const MARKER = dataDir('VAULT_LOCATION_CONFLICT.txt');

function seedBothPresent(): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.mkdirSync(vaultDir(), { recursive: true });
  fs.writeFileSync(dataDir('vault.enc'), STRAY_BYTES);
  fs.writeFileSync(vaultDir('vault.enc'), KEPT_BYTES);
}
function clean(): void {
  for (const p of [dataDir('vault.enc'), vaultDir('vault.enc'), MARKER]) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
}

test('H-BOOT-021: both data/vault.enc and Vault/vault.enc present → neither is moved, and a conflict marker is written', () => {
  seedBothPresent();
  try {
    migrateVaultDir();

    // (1) neither file's bytes changed — no auto-pick, no move/overwrite.
    assert.equal(fs.readFileSync(dataDir('vault.enc'), 'utf8'), STRAY_BYTES, 'stale data/ copy is left byte-for-byte');
    assert.equal(fs.readFileSync(vaultDir('vault.enc'), 'utf8'), KEPT_BYTES, 'Vault/ copy the app uses is untouched');

    // (2) the stale data/ copy still exists (it must not vanish silently).
    assert.equal(fs.existsSync(dataDir('vault.enc')), true, 'data/vault.enc is preserved, not deleted');

    // (3) a boot-visible marker names BOTH absolute paths so the operator can see the conflict.
    assert.equal(fs.existsSync(MARKER), true, 'VAULT_LOCATION_CONFLICT.txt was written');
    const body = fs.readFileSync(MARKER, 'utf8');
    assert.ok(body.includes(dataDir('vault.enc')), 'marker names the ignored data/ path');
    assert.ok(body.includes(vaultDir('vault.enc')), 'marker names the adopted Vault/ path');
  } finally { clean(); }
});

test('H-BOOT-021: the normal single-copy migration (only data/ present) is unaffected and writes NO marker', () => {
  clean();
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.mkdirSync(vaultDir(), { recursive: true });
  fs.writeFileSync(dataDir('vault.enc'), STRAY_BYTES); // only the legacy copy exists
  try {
    migrateVaultDir();
    assert.equal(fs.existsSync(dataDir('vault.enc')), false, 'legacy copy was moved out of data/');
    assert.equal(fs.readFileSync(vaultDir('vault.enc'), 'utf8'), STRAY_BYTES, 'it now lives in Vault/ intact');
    assert.equal(fs.existsSync(MARKER), false, 'no conflict → no marker');
  } finally { clean(); }
});
