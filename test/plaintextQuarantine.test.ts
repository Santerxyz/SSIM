import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { quarantinePlaintextFile } from '../src/core/vaultBoot';

// ─── B21: quarantine plaintext token/key files once safely in the vault ────────
// In vault mode the token/key stores read ONLY the vault, so a vaulted entry left in
// the plaintext file is a pure at-rest leak. Remove ONLY entries provably in the vault
// (byte-equal); keep the rest (recoverable); delete the file + .bak when fully drained.

let seq = 0;
function tmpFile(contents: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ssim-quar-${process.pid}-${seq++}-`));
  const f = path.join(dir, 'refresh_tokens.json');
  fs.writeFileSync(f, JSON.stringify(contents));
  fs.writeFileSync(`${f}.bak`, JSON.stringify(contents)); // simulate the .bak sibling
  return f;
}

test('B21: a fully-vaulted file is deleted along with its .bak', () => {
  const f = tmpFile({ version: 1, tokens: { alice: 'TA', bob: 'TB' } });
  const vault = new Map([['alice', 'TA'], ['bob', 'TB']]);
  quarantinePlaintextFile(f, 'tokens', 'refresh token', (u) => vault.get(u));
  assert.equal(fs.existsSync(f), false, 'the drained plaintext file is deleted');
  assert.equal(fs.existsSync(`${f}.bak`), false, 'the .bak is deleted too');
});

test('B21: an entry NOT byte-equal to the vault is KEPT (recoverable), file rewritten', () => {
  const f = tmpFile({ version: 1, tokens: { alice: 'TA', carol: 'DIFFERENT' } });
  const vault = new Map([['alice', 'TA'], ['carol', 'VAULT_HAS_OTHER']]);
  quarantinePlaintextFile(f, 'tokens', 'refresh token', (u) => vault.get(u));
  assert.equal(fs.existsSync(f), true, 'file kept because carol is not safely vaulted');
  const after = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(after.tokens, { carol: 'DIFFERENT' }, 'alice removed (vaulted), carol kept');
});

test('B21: an entry the vault does not have is KEPT', () => {
  const f = tmpFile({ version: 1, tokens: { alice: 'TA', dave: 'TD' } });
  const vault = new Map([['alice', 'TA']]); // dave never migrated
  quarantinePlaintextFile(f, 'tokens', 'refresh token', (u) => vault.get(u));
  const after = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(after.tokens, { dave: 'TD' });
});

test('B21: nothing vaulted → the file is left completely untouched', () => {
  const f = tmpFile({ version: 1, tokens: { alice: 'TA' } });
  const before = fs.readFileSync(f, 'utf8');
  quarantinePlaintextFile(f, 'tokens', 'refresh token', () => undefined);
  assert.equal(fs.readFileSync(f, 'utf8'), before, 'untouched when nothing is safely vaulted');
  assert.equal(fs.existsSync(`${f}.bak`), true, '.bak untouched');
});
