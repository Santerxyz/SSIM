import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { AccountVaultImpl } from '../src/core/AccountVault';

// Each test uses an isolated temp vault file so the singleton's state can't leak across tests.
let seq = 0;
function tmpVault(): { file: string; bak: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ssim-vault-csk-${process.pid}-${seq++}-`));
  return { file: path.join(dir, 'vault.enc'), bak: path.join(dir, 'vault.enc.bak') };
}

// ─── H-XCT-007: a FIRST CSFloat key is persisted synchronously (survives a kill) ──────
test('H-XCT-007: setCsFloatKey persists a first key immediately (no flush needed)', () => {
  const { file, bak } = tmpVault();
  const v1 = new AccountVaultImpl(file, bak);
  v1.unlockOrCreate('pw');
  v1.setCsFloatKey('bot', 'K1'); // first set → synchronous save, NO flush
  const v2 = new AccountVaultImpl(file, bak); // simulate a kill + restart
  v2.unlockOrCreate('pw');
  assert.equal(v2.getCsFloatKey('bot'), 'K1', 'a first CSFloat key survives without an explicit flush');
});

// ─── H-XCT-007: a key ROTATION stays debounced (prior key on disk = no sole-credential loss) ──
test('H-XCT-007: setCsFloatKey rotation is debounced (not written until flush)', () => {
  const { file, bak } = tmpVault();
  const v1 = new AccountVaultImpl(file, bak);
  v1.unlockOrCreate('pw');
  v1.setCsFloatKey('bot', 'K1'); // first set → synchronous
  v1.setCsFloatKey('bot', 'K2'); // rotation → debounced, NOT written yet

  const v2 = new AccountVaultImpl(file, bak); // fresh instance still sees K1 until v1 flushes
  v2.unlockOrCreate('pw');
  assert.equal(v2.getCsFloatKey('bot'), 'K1', 'rotation stays debounced — disk still holds the prior key');

  v1.flush(); // now the debounced write lands
  const v3 = new AccountVaultImpl(file, bak);
  v3.unlockOrCreate('pw');
  assert.equal(v3.getCsFloatKey('bot'), 'K2', 'rotation persists after an explicit flush');
});
