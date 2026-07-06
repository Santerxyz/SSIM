import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { AccountVaultImpl, AccountVault } from '../src/core/AccountVault';
import { AccountManager } from '../src/core/AccountManager';
import { importExternalVault } from '../src/core/vaultBoot';
import { vaultDir } from '../src/utils/paths';

// ─── H-ACC-033: importExternalVault must not deref an unvalidated account entry ──
// decryptExternalVault CASTS payload.accounts verbatim, so a decryptable source vault whose
// payload was hand-edited / corrupted / crafted can carry a null / non-object / non-string-username
// entry. The old `const username = acc?.username || k` admitted them: a null entry threw on the
// `acc.password` deref, and a truthy NON-string username (e.g. 123) won the fallback and threw at
// `hasAccount(123).toLowerCase()`. Both aborted the whole merge mid-loop (Express 500) with the
// earlier iterations already committed. The shape guard now skips them as unusable rows and the
// well-formed entry still imports.

function cleanVaultDir(): void {
  for (const f of ['vault.enc', 'vault.enc.bak', 'accounts.json', 'accounts.json.bak']) {
    try { fs.rmSync(vaultDir(f), { force: true }); } catch { /* ignore */ }
  }
}

// Builds a SOURCE external vault.enc (its own isolated file + password) whose decrypted payload
// carries the given raw accounts map (and optional tokens map for token-only bots), and returns
// its on-disk content for the import path to read.
function buildExternalVault(accounts: Record<string, unknown>, password: string, tokens?: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ssim-extvault-${process.pid}-`));
  const file = path.join(dir, 'vault.enc');
  const src = new AccountVaultImpl(file, `${file}.bak`);
  src.unlockOrCreate(password);
  // Inject the malformed entries straight into the payload — upsertAccount would reject them, but a
  // corrupt/hand-edited source file has no such gate, which is exactly the shape under test.
  const payload = (src as unknown as { payload: { accounts: Record<string, unknown>; tokens: Record<string, string> } }).payload;
  payload.accounts = accounts;
  if (tokens) payload.tokens = tokens;
  src.flush(); // encrypt + persist so the raw file content decrypts on the import side
  return fs.readFileSync(file, 'utf8');
}

test('H-ACC-033: a source vault with null / non-string-username entries skips them, imports the good one, never throws', () => {
  cleanVaultDir();
  try {
    const raw = buildExternalVault({
      x:    null,                                                                          // non-object → unusable
      num:  { username: 123,     password: 'p', maFile: { account_name: 'n',    shared_secret: 's' } }, // non-string username → unusable
      good: { username: 'good',  password: 'p', maFile: { account_name: 'good', shared_secret: 's' } }, // well-formed → imported
    }, 'src-pw');

    // Unlock THIS process's singleton + a fresh empty AccountManager (one Standard env, 0 accounts).
    AccountVault.unlockOrCreate('local-pw');
    const accounts = new AccountManager();
    const env = accounts.defaultEnvironmentId();

    let r: { imported: number; skipped: number } | null = null;
    assert.doesNotThrow(() => { r = importExternalVault(accounts, raw, 'src-pw', undefined, env, null); },
      'a malformed entry must not TypeError mid-loop (the num entry would crash at hasAccount(123).toLowerCase())');
    assert.ok(r, 'the correct password decrypts the source vault (non-null)');
    assert.equal(r!.imported, 1, 'only the well-formed account is imported');
    assert.equal(r!.skipped, 2, 'the null entry and the non-string-username entry are both skipped');

    assert.equal(AccountVault.hasAccount('good'), true, 'the good account landed in the vault');
    assert.equal(accounts.existsRaw('good'), true, 'and got an org record');
    assert.equal(AccountVault.hasAccount('num'), false, 'the corrupt numeric-username row was NOT imported (never key-renamed)');
  } finally {
    cleanVaultDir();
  }
});

// ─── H-ACC-034: a token-only (QR-imported) source account carries the LIMITED tier ──
// A token-only bot exists in the source vault ONLY as a payload.tokens entry with no accounts
// record (B35 carryover). It has no maFile → no identity_secret → cannot confirm trades/sells, so
// its org record must be stamped tier:'limited'. Absent tier is treated as 'full' and the two
// tier-gated guards (auto-accept enable + delivery worker) key off tier==='limited', so an omitted
// tier lets an operator turn on auto-deliver for an account that can never confirm the offer.
test('H-ACC-034: a token-only source account is imported as tier "limited", not Full', () => {
  cleanVaultDir();
  try {
    // A source vault with NO accounts entries, only a token-only bot in payload.tokens.
    const raw = buildExternalVault({}, 'src-pw', { tokonly: 'JWT-REFRESH-TOKEN' });

    AccountVault.unlockOrCreate('local-pw');
    const accounts = new AccountManager();
    const env = accounts.defaultEnvironmentId();

    const r = importExternalVault(accounts, raw, 'src-pw', undefined, env, null);
    assert.ok(r, 'the correct password decrypts the source vault (non-null)');
    assert.equal(r!.imported, 1, 'the token-only bot is carried over');

    const rec = accounts.getAllRaw().find(a => a.username === 'tokonly');
    assert.ok(rec, 'the token-only bot got an org record');
    assert.equal(rec!.tier, 'limited', 'the token-only bot is labelled Limited, not Full (no maFile → cannot confirm)');
    assert.equal(rec!.maFilePath, '', 'and carries no maFile path');
  } finally {
    cleanVaultDir();
  }
});
