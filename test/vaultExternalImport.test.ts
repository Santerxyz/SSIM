import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { AccountVaultImpl, VAULT_NEWER_VERSION_ERROR, type VaultAccount } from '../src/core/AccountVault';

// Each test uses an isolated temp vault file so the singleton's state can't leak across tests.
let seq = 0;
function tmpVault(): { file: string; bak: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ssim-extvault-${process.pid}-${seq++}-`));
  return { file: path.join(dir, 'vault.enc'), bak: path.join(dir, 'vault.enc.bak') };
}

const MAFILE = { account_name: 'src1', shared_secret: 'SS', identity_secret: 'IS' } as never;
const SRC_ACCT: VaultAccount = { username: 'Src1', password: 'srcpw123', maFile: MAFILE, proxy: 'http://u:p@1.2.3.4:8080' };

// Build a real source vault on disk with the given password, return its raw file bytes.
function buildSourceVaultBytes(password: string): string {
  const { file, bak } = tmpVault();
  const v = new AccountVaultImpl(file, bak);
  v.unlockOrCreate(password);
  v.upsertAccount(SRC_ACCT);
  v.flush();
  return fs.readFileSync(file, 'utf8');
}

// Build a source vault carrying a full account (with proxy) + a token-only entry, and set a
// per-account CSFloat key + dedicated proxy for BOTH — the B35/B42 shape H-ACC-044 must surface.
function buildSourceVaultWithKeysAndProxies(password: string): string {
  const { file, bak } = tmpVault();
  const v = new AccountVaultImpl(file, bak);
  v.unlockOrCreate(password);
  v.upsertAccount(SRC_ACCT);            // full account 'src1'
  v.setToken('tokonly', 'JWT-REFRESH'); // token-only account 'tokonly'
  v.setCsFloatKey('src1', 'CSKEY-FULL');
  v.setCsFloatKey('tokonly', 'CSKEY-TOK');
  v.setAccountProxy('src1', 'http://full@9.9.9.9:1');
  v.setAccountProxy('tokonly', 'http://tok@8.8.8.8:2');
  v.flush();
  return fs.readFileSync(file, 'utf8');
}

// ─── H-ACC-043: a NEWER-version source vault throws the distinct error (not the wrong-password null)
test('H-ACC-043: decryptExternalVault throws VAULT_NEWER_VERSION on a newer-version source (correct pw)', () => {
  const srcBytes = buildSourceVaultBytes('src-master-pw');
  const raw = JSON.parse(srcBytes) as Record<string, unknown>;
  raw.v = 2; // one past this binary's VAULT_VERSION (1) → "written by a newer SSIM"

  const { file, bak } = tmpVault();
  const target = new AccountVaultImpl(file, bak); // a SEPARATE unlocked target vault
  target.unlockOrCreate('target-master-pw');

  assert.throws(
    () => target.decryptExternalVault(JSON.stringify(raw), 'src-master-pw'),
    (e: Error) => e.message === VAULT_NEWER_VERSION_ERROR,
    'a newer-version vault must surface the distinct update-me error, not collapse into null',
  );
});

// ─── A normal (same-version) source vault with the WRONG password still returns null (unchanged)
test('H-ACC-043: decryptExternalVault returns null on a same-version vault with the wrong password', () => {
  const srcBytes = buildSourceVaultBytes('src-master-pw');

  const { file, bak } = tmpVault();
  const target = new AccountVaultImpl(file, bak);
  target.unlockOrCreate('target-master-pw');

  assert.equal(target.decryptExternalVault(srcBytes, 'wrong'), null, 'wrong password is still an ambiguous null');
});

// ─── The correct password on a same-version source still decrypts to accounts + tokens (no regression)
test('H-ACC-043: decryptExternalVault still decrypts a same-version source with the correct password', () => {
  const srcBytes = buildSourceVaultBytes('src-master-pw');

  const { file, bak } = tmpVault();
  const target = new AccountVaultImpl(file, bak);
  target.unlockOrCreate('target-master-pw');

  const ext = target.decryptExternalVault(srcBytes, 'src-master-pw');
  assert.ok(ext, 'correct password decrypts');
  assert.equal(ext!.accounts['src1']?.password, 'srcpw123', 'source account survives the decrypt');
});

// ─── H-ACC-044: decryptExternalVault now surfaces the source's csfloatKeys + accountProxies too
// (previously decrypted, normalized, then silently discarded — the B35 merge was still incomplete).
test('H-ACC-044: decryptExternalVault surfaces the source csfloatKeys and accountProxies maps', () => {
  const srcBytes = buildSourceVaultWithKeysAndProxies('src-master-pw');

  const { file, bak } = tmpVault();
  const target = new AccountVaultImpl(file, bak);
  target.unlockOrCreate('target-master-pw');

  const ext = target.decryptExternalVault(srcBytes, 'src-master-pw');
  assert.ok(ext, 'correct password decrypts');
  assert.equal(ext!.csfloatKeys['src1'], 'CSKEY-FULL', 'full account CSFloat key surfaced');
  assert.equal(ext!.csfloatKeys['tokonly'], 'CSKEY-TOK', 'token-only CSFloat key surfaced');
  assert.equal(ext!.accountProxies['src1'], 'http://full@9.9.9.9:1', 'full account dedicated proxy surfaced');
  assert.equal(ext!.accountProxies['tokonly'], 'http://tok@8.8.8.8:2', 'token-only dedicated proxy surfaced');
  // envProxies is deliberately NOT part of the returned shape (source env ids are meaningless here).
  assert.equal((ext as unknown as { envProxies?: unknown }).envProxies, undefined, 'envProxies excluded by design');
});
