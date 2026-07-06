import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { AccountVaultImpl, VAULT_NEWER_VERSION_ERROR, type VaultAccount } from '../src/core/AccountVault';
import { logger } from '../src/utils/logger';

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

// ─── S5: recovery must NOT clobber the good .bak with the corrupt main file ─────────
test('S5: after recovering from .bak, the .bak still holds the good backup (not clobbered)', () => {
  const { file, bak } = tmpVault();
  const v1 = new AccountVaultImpl(file, bak);
  v1.unlockOrCreate('pw');
  v1.upsertAccount(ACCT);
  v1.setToken('bot1', 'tok-1');   // .bak now holds the account
  v1.flush();
  assert.ok(fs.existsSync(bak), 'a .bak exists after multiple saves');

  // Corrupt the MAIN file, leave the .bak intact — the S5 window.
  const main = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ctBuf = Buffer.from(main.ct, 'base64'); ctBuf[0] ^= 0xff; main.ct = ctBuf.toString('base64');
  fs.writeFileSync(file, JSON.stringify(main));

  // Recover. The OLD code saved with backup:true → it copied the corrupt main OVER the good .bak
  // before the atomic write, destroying the only good copy in the crash window.
  const v2 = new AccountVaultImpl(file, bak);
  v2.unlockOrCreate('pw');
  assert.equal(v2.getAccount('bot1')?.password, 'pw123', 'recovered the account');

  // The .bak must STILL be the good backup — read it as a primary vault and confirm it decrypts.
  const bakCheck = new AccountVaultImpl(bak, bak + '.none');
  assert.doesNotThrow(() => bakCheck.unlockOrCreate('pw'), '.bak must not have been clobbered by the corrupt main');
  assert.equal(bakCheck.getAccount('bot1')?.password, 'pw123', '.bak still holds the good credentials');
});

// ─── H-ACC-041: a failed persist at flush() returns false, NEVER throws ─────────
// A locked/read-only vault dir at shutdown must not wedge the graceful-shutdown latch: flush()
// logs loudly and returns false instead of propagating the writeJsonAtomic throw into shutdown().
test('H-ACC-041: flush() returns false and does NOT throw when the save fails', () => {
  const { file, bak } = tmpVault();
  const v = new AccountVaultImpl(file, bak);
  v.unlockOrCreate('pw');
  v.setToken('bot1', 'tok'); // something pending
  (v as unknown as { save: () => void }).save = () => { throw new Error('EACCES: disk locked'); };

  const origError = logger.error;
  let logged = false;
  (logger as unknown as { error: (m: string) => void }).error = () => { logged = true; };
  try {
    assert.equal(v.flush(), false, 'a failed save returns false');
    assert.doesNotThrow(() => v.flush(), 'the throw is swallowed, never propagated to shutdown()');
    assert.equal(logged, true, 'the failure is logged loudly at error level');
  } finally {
    (logger as unknown as { error: typeof origError }).error = origError;
  }
});

test('H-ACC-041: flush() on a locked (never-unlocked) vault returns true (nothing to persist)', () => {
  const { file, bak } = tmpVault();
  const v = new AccountVaultImpl(file, bak); // never unlocked → isEnabled() false
  assert.equal(v.flush(), true, 'no payload → nothing to persist → true, no throw');
});

// ─── H-ACC-040: a failed DEBOUNCED save is swallowed, NEVER an uncaughtException ──
// A rotation (non-first-mint) token write takes scheduleSave() → a bare 1.5s setTimeout. If the
// deferred save() throws (AV-lock/disk-full during login churn) the throw becomes a global
// uncaughtException → 3-in-60s latches the money-ops breaker. The timer callback must catch it,
// warn, and leave the payload dirty-in-memory (recovered by the next mutation or the shutdown flush).
test('H-ACC-040: a throwing debounced save is caught (no uncaughtException), state recovers on next save', async () => {
  const { file, bak } = tmpVault();
  const v = new AccountVaultImpl(file, bak);
  v.unlockOrCreate('pw');
  v.setToken('bot1', 'a'); // first-mint → synchronous save, no debounce

  const uncaught: Error[] = [];
  const onUncaught = (e: Error) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  const origWarn = logger.warn;
  let warned = false;
  (logger as unknown as { warn: (m: string) => void }).warn = () => { warned = true; };
  try {
    // Override the persist to throw, then trigger a ROTATION (existing token) → scheduleSave debounce.
    (v as unknown as { save: () => void }).save = () => { throw new Error('EACCES: disk locked'); };
    v.setToken('bot1', 'b');
    await new Promise((r) => setTimeout(r, 1_700)); // let the 1.5s debounce fire
    assert.equal(uncaught.length, 0, 'the debounced throw must NOT escape as an uncaughtException');
    assert.equal(warned, true, 'the failure is logged loudly at warn level');
  } finally {
    process.removeListener('uncaughtException', onUncaught);
    (logger as unknown as { warn: typeof origWarn }).warn = origWarn;
  }

  // 'b' is dirty-in-memory only (the throw was swallowed). The stated contract: a subsequent
  // successful mutation + flush persists the latest value, recovered on reopen.
  delete (v as unknown as { save?: () => void }).save; // restore the real prototype save
  v.setToken('bot1', 'c');
  v.flush();
  const v2 = new AccountVaultImpl(file, bak);
  v2.unlockOrCreate('pw');
  assert.equal(v2.getToken('bot1'), 'c', 'the next successful save recovers the dirty in-memory state');
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
