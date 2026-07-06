import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { AccountVaultImpl } from '../src/core/AccountVault';
import { normalizeMasterPassword, unlockExistingVault } from '../src/core/vaultBoot';

// H-ACC-024: master-password normalization must be UNIFORM across every input path, plus a
// one-time compatibility bridge that opens a legacy vault created (by the old windowed portal)
// off the RAW padded password. Each test uses an isolated temp vault file.
let seq = 0;
function tmpVault(): { file: string; bak: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ssim-vaultpw-${process.pid}-${seq++}-`));
  return { file: path.join(dir, 'vault.enc'), bak: path.join(dir, 'vault.enc.bak') };
}

test('normalizeMasterPassword trims leading/trailing whitespace only', () => {
  assert.equal(normalizeMasterPassword('  pw  '), 'pw');
  assert.equal(normalizeMasterPassword('pw'), 'pw');
  assert.equal(normalizeMasterPassword('p w'), 'p w'); // interior whitespace preserved
});

// (1) A vault CREATED off the raw padded password (legacy portal behavior) opens via the
//     verbatim retry — the trimmed form fails, the raw form succeeds.
test('H-ACC-024: legacy vault created with a padded password opens via the raw retry', () => {
  const { file, bak } = tmpVault();
  const legacy = new AccountVaultImpl(file, bak);
  legacy.unlockOrCreate(' pw '); // OLD portal keyed the vault off the RAW string
  legacy.flush();

  const v2 = new AccountVaultImpl(file, bak); // fresh instance (simulate a restart)
  const r = unlockExistingVault(' pw ', undefined, v2);
  assert.equal(r.created, false, 'opened the existing legacy vault, not recreated');
  assert.equal(v2.isEnabled(), true);
});

// (2) A vault CREATED off the normalized password opens when the operator later types a padded
//     form — the trim on the way in matches the vault's key on the first try.
test('H-ACC-024: normalized vault opens when unlocked with a padded password (trim)', () => {
  const { file, bak } = tmpVault();
  const created = new AccountVaultImpl(file, bak);
  created.unlockOrCreate(normalizeMasterPassword(' pw ')); // CREATE path normalizes → keyed off "pw"
  created.flush();

  const v2 = new AccountVaultImpl(file, bak);
  const r = unlockExistingVault('pw ', undefined, v2); // padded entry → trimmed → "pw"
  assert.equal(r.created, false, 'opened via the trimmed form');
  assert.equal(v2.isEnabled(), true);
});

// (3) A genuinely wrong password still fails as WRONG_PASSWORD (no whitespace → no retry).
test('H-ACC-024: a genuinely wrong password throws WRONG_PASSWORD', () => {
  const { file, bak } = tmpVault();
  const created = new AccountVaultImpl(file, bak);
  created.unlockOrCreate(normalizeMasterPassword('pw'));
  created.flush();

  const v2 = new AccountVaultImpl(file, bak);
  assert.throws(() => unlockExistingVault('other', undefined, v2), /WRONG_PASSWORD/);
});

// (4) A wrong password that CARRIES whitespace fails BOTH forms → still WRONG_PASSWORD (the
//     bridge's extra scrypt does not mask a real mismatch).
test('H-ACC-024: a wrong padded password fails both forms → WRONG_PASSWORD', () => {
  const { file, bak } = tmpVault();
  const created = new AccountVaultImpl(file, bak);
  created.unlockOrCreate(normalizeMasterPassword('pw'));
  created.flush();

  const v2 = new AccountVaultImpl(file, bak);
  assert.throws(() => unlockExistingVault('other ', undefined, v2), /WRONG_PASSWORD/);
});
