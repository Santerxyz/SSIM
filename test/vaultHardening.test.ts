import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { AccountVaultImpl, VAULT_NEWER_VERSION_ERROR, type VaultAccount } from '../src/core/AccountVault';

// Each test uses an isolated temp vault file so the singleton's state can't leak across tests.
let seq = 0;
function tmpVault(): { file: string; bak: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ssim-vault-${process.pid}-${seq++}-`));
  return { file: path.join(dir, 'vault.enc'), bak: path.join(dir, 'vault.enc.bak') };
}

const MAFILE = { account_name: 'bot1', shared_secret: 'SS', identity_secret: 'IS' } as never;
const ACCT: VaultAccount = { username: 'Bot1', password: 'pw123', maFile: MAFILE, proxy: 'http://u:p@1.2.3.4:8080' };

// ─── Crypto round-trip (previously ZERO coverage) ──────────────────────────────
test('vault: create → save → reopen round-trips accounts, tokens, env proxies', () => {
  const { file, bak } = tmpVault();
  const v1 = new AccountVaultImpl(file, bak);
  v1.unlockOrCreate('master-pw');
  v1.upsertAccount(ACCT);
  v1.setToken('bot1', 'refresh-token-xyz');
  v1.setEnvProxy('env-1', 'http://eu:ep@9.9.9.9:3128');
  v1.flush();

  const v2 = new AccountVaultImpl(file, bak); // simulate a restart
  const r = v2.unlockOrCreate('master-pw');
  assert.equal(r.created, false, 'reopened, not recreated');
  assert.equal(v2.getAccount('bot1')?.password, 'pw123');
  assert.equal(v2.getToken('bot1'), 'refresh-token-xyz');
  assert.equal(v2.getEnvProxy('env-1'), 'http://eu:ep@9.9.9.9:3128');
});

// ─── B32: a FIRST token mint is persisted synchronously (survives a kill) ──────
test('B32: setToken persists a first-mint token immediately (no flush needed)', () => {
  const { file, bak } = tmpVault();
  const v1 = new AccountVaultImpl(file, bak);
  v1.unlockOrCreate('pw');
  v1.setToken('limited', 'sole-credential-token'); // first mint → synchronous save, NO flush
  const v2 = new AccountVaultImpl(file, bak);       // simulate a kill + restart
  v2.unlockOrCreate('pw');
  assert.equal(v2.getToken('limited'), 'sole-credential-token', 'a first token survives without an explicit flush');
});

// ─── B42: a token-only account's per-account proxy round-trips in the vault ─────
test('B42: setAccountProxy/getAccountProxy persist for an account with no full record', () => {
  const { file, bak } = tmpVault();
  const v1 = new AccountVaultImpl(file, bak);
  v1.unlockOrCreate('pw');
  assert.equal(v1.getAccountProxy('limitedbot'), undefined, 'none initially');
  v1.setAccountProxy('LimitedBot', 'http://u:p@5.5.5.5:9000');
  v1.flush();
  const v2 = new AccountVaultImpl(file, bak);
  v2.unlockOrCreate('pw');
  assert.equal(v2.getAccountProxy('limitedbot'), 'http://u:p@5.5.5.5:9000', 'survives reopen, case-insensitive');
  v2.setAccountProxy('limitedbot', undefined); // clear
  assert.equal(v2.getAccountProxy('limitedbot'), undefined);
});

test('vault: wrong master password is rejected (GCM auth), right one works', () => {
  const { file, bak } = tmpVault();
  new AccountVaultImpl(file, bak).unlockOrCreate('correct-horse');
  assert.throws(() => new AccountVaultImpl(file, bak).unlockOrCreate('wrong'), /WRONG_PASSWORD/);
  assert.doesNotThrow(() => new AccountVaultImpl(file, bak).unlockOrCreate('correct-horse'));
});

// ─── B30: version validation + preserve unknown sections ───────────────────────
test('B30: a vault whose envelope version is NEWER is refused with a distinct error (not WRONG_PASSWORD)', () => {
  const { file, bak } = tmpVault();
  new AccountVaultImpl(file, bak).unlockOrCreate('pw');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.v = 2; // pretend a newer SSIM wrote it
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.throws(
    () => new AccountVaultImpl(file, bak).unlockOrCreate('pw'),
    (e: Error) => e.message === VAULT_NEWER_VERSION_ERROR,
    'must NOT be reported as a wrong password',
  );
});

test('B30: an unknown/newer payload section survives an older-binary save (never stripped)', () => {
  const { file, bak } = tmpVault();
  const v1 = new AccountVaultImpl(file, bak);
  v1.unlockOrCreate('pw');
  // Inject a section a future SSIM might add, directly into the in-memory payload.
  (v1 as unknown as { payload: Record<string, unknown> }).payload.futureFeature = { a: 1 };
  v1.setEnvProxy('e1', 'http://x:y@1.1.1.1:80'); // triggers a save (re-encrypt)
  v1.flush();

  const v2 = new AccountVaultImpl(file, bak);
  v2.unlockOrCreate('pw');
  // Force another save from the older binary's perspective, then reopen once more.
  v2.setToken('bot1', 'tok');
  v2.flush();
  const v3 = new AccountVaultImpl(file, bak);
  v3.unlockOrCreate('pw');
  const payload = (v3 as unknown as { payload: Record<string, unknown> }).payload;
  assert.deepEqual(payload.futureFeature, { a: 1 }, 'unknown section must be preserved across saves');
});

// ─── B33: corrupt vault.enc recovers from vault.enc.bak (not a wrong-password lie) ──
test('B33: a corrupt vault.enc with a healthy .bak recovers using the correct password', () => {
  const { file, bak } = tmpVault();
  const v1 = new AccountVaultImpl(file, bak);
  v1.unlockOrCreate('pw');
  v1.upsertAccount(ACCT);          // save() writes vault.enc AND a .bak of the previous state
  v1.setToken('bot1', 'tok-1');    // another save → .bak now holds the account
  v1.flush();
  assert.ok(fs.existsSync(bak), 'a .bak exists after multiple saves');

  // Corrupt the MAIN file's ciphertext (bit-rot / disk trouble), leave .bak intact.
  const main = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ctBuf = Buffer.from(main.ct, 'base64'); ctBuf[0] ^= 0xff;
  main.ct = ctBuf.toString('base64');
  fs.writeFileSync(file, JSON.stringify(main));

  const v2 = new AccountVaultImpl(file, bak);
  assert.doesNotThrow(() => v2.unlockOrCreate('pw'), 'the correct password recovers from .bak, not WRONG_PASSWORD');
  assert.equal(v2.getAccount('bot1')?.password, 'pw123', 'recovered the account from the backup');
});

test('B33: a WRONG password still fails even if the .bak is healthy', () => {
  const { file, bak } = tmpVault();
  const v1 = new AccountVaultImpl(file, bak);
  v1.unlockOrCreate('right');
  v1.upsertAccount(ACCT);
  v1.setToken('bot1', 't');
  v1.flush();
  // corrupt the main so the wrong-password path reaches the .bak fallback too
  const main = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ctBuf = Buffer.from(main.ct, 'base64'); ctBuf[0] ^= 0xff; main.ct = ctBuf.toString('base64');
  fs.writeFileSync(file, JSON.stringify(main));
  assert.throws(() => new AccountVaultImpl(file, bak).unlockOrCreate('WRONG'), /WRONG_PASSWORD/);
});
