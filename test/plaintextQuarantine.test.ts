import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { quarantinePlaintextFile, quarantineMigratedPlaintext } from '../src/core/vaultBoot';
import { AccountVault } from '../src/core/AccountVault';
import { dataDir } from '../src/utils/paths';

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

// ─── H-ACC-035: the partial-keep path must scrub the .bak too (it holds the just-quarantined secrets) ──
// The .bak is a one-generation copy of the LAST full write, so it still carries every token —
// including the ones the main-file rewrite just removed. A partial keep must reconcile the .bak
// or the quarantined secret survives in plaintext at rest indefinitely.
test('H-ACC-035: a partial keep scrubs the quarantined secret from the .bak sibling', () => {
  const f = tmpFile({ version: 1, tokens: { a: 'TA', b: 'TB' } });
  const vault = new Map([['a', 'TA']]); // b never vaulted → partial keep
  quarantinePlaintextFile(f, 'tokens', 'refresh token', (u) => vault.get(u));
  const after = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(after.tokens, { b: 'TB' }, 'main file keeps only the not-yet-vaulted entry');
  assert.equal(fs.existsSync(`${f}.bak`), true, '.bak preserved (still holds the recoverable entry)');
  const bakText = fs.readFileSync(`${f}.bak`, 'utf8');
  assert.ok(!bakText.includes('TA'), 'the quarantined secret is gone from the .bak');
  assert.deepEqual(JSON.parse(bakText).tokens, { b: 'TB' }, '.bak mirrors the kept-only map');
});

// ─── H-ACC-041: a FAILED flush() must abort the quarantine (never delete the only durable copy) ──
// verifyDiskRoundTrip only proves *a* payload decrypts, not that disk == memory. Quarantining after
// a failed flush could delete plaintext that is the sole copy of an in-memory-only token (B21's
// never-delete-last-copy contract). The gate now short-circuits on a false flush().
test('H-ACC-041: a failed flush() leaves refresh_tokens.json + csfloat_keys.json byte-identical', () => {
  // The singleton points at SSIM_HOME/Vault (a throwaway per _setup.cjs). Unlock it so the
  // quarantine gate is reached (it returns early unless isEnabled()).
  AccountVault.unlockOrCreate('gate-pw');
  AccountVault.setToken('alice', 'TA');       // vaulted → would be quarantined if the gate passed
  AccountVault.setCsFloatKey('alice', 'KA');

  // Byte-equal plaintext copies: these WOULD be drained if quarantine ran.
  const tokFile = dataDir('refresh_tokens.json');
  const keyFile = dataDir('csfloat_keys.json');
  fs.mkdirSync(path.dirname(tokFile), { recursive: true });
  fs.writeFileSync(tokFile, JSON.stringify({ version: 1, tokens: { alice: 'TA' } }));
  fs.writeFileSync(keyFile, JSON.stringify({ version: 1, keys: { alice: 'KA' } }));
  const tokBefore = fs.readFileSync(tokFile, 'utf8');
  const keyBefore = fs.readFileSync(keyFile, 'utf8');

  const av = AccountVault as unknown as { flush: () => boolean };
  const origFlush = av.flush.bind(AccountVault);
  av.flush = () => false; // simulate a locked/read-only vault dir at persist time
  try {
    quarantineMigratedPlaintext();
    assert.equal(fs.readFileSync(tokFile, 'utf8'), tokBefore, 'tokens plaintext untouched after a failed flush');
    assert.equal(fs.readFileSync(keyFile, 'utf8'), keyBefore, 'keys plaintext untouched after a failed flush');
  } finally {
    av.flush = origFlush;
    try { fs.rmSync(tokFile, { force: true }); fs.rmSync(keyFile, { force: true }); } catch { /* ignore */ }
  }
});
