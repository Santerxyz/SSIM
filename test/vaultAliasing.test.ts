import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { AccountVaultImpl, type VaultAccount } from '../src/core/AccountVault';

// Each test uses an isolated temp vault file so the singleton's state can't leak across tests.
let seq = 0;
function tmpVault(): { file: string; bak: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ssim-vault-alias-${process.pid}-${seq++}-`));
  return { file: path.join(dir, 'vault.enc'), bak: path.join(dir, 'vault.enc.bak') };
}

const MAFILE = { account_name: 'bot1', shared_secret: 'SS', identity_secret: 'IS' } as never;
const ACCT: VaultAccount = { username: 'Bot1', password: 'pw123', maFile: MAFILE, proxy: 'http://u:p@1.2.3.4:8080' };

// ─── H-ACC-045: getAccount hands out a defensive copy, not a live payload reference ──
test('H-ACC-045: mutating a getAccount() result cannot edit the encrypted payload', () => {
  const { file, bak } = tmpVault();
  const v = new AccountVaultImpl(file, bak);
  v.unlockOrCreate('pw');
  v.upsertAccount(ACCT);

  v.getAccount('bot1')!.password = 'HACKED';
  assert.equal(v.getAccount('bot1')!.password, 'pw123', 'the store is unchanged — the returned record was a clone');
});

test('H-ACC-045: mutating an upsertAccount() argument after the call cannot edit the payload', () => {
  const { file, bak } = tmpVault();
  const v = new AccountVaultImpl(file, bak);
  v.unlockOrCreate('pw');

  const a: VaultAccount = { ...ACCT };
  v.upsertAccount(a);
  a.password = 'X';
  assert.equal(v.getAccount(a.username)!.password, 'pw123', 'the store holds a clone, immune to the caller mutating its argument');
});

// The route-level torn-state fix: PATCH mutates the getAccount ref, then a maFile failure returns
// 400 WITHOUT upserting. The clone means that un-upserted mutation never reached the store.
test('H-ACC-045: a getAccount() mutation that is never upserted leaves the store untorn', () => {
  const { file, bak } = tmpVault();
  const v = new AccountVaultImpl(file, bak);
  v.unlockOrCreate('pw');
  v.upsertAccount(ACCT);

  const rec = v.getAccount('bot1')!;
  rec.password = 'new'; // the PATCH route's line 963 mutation…
  // …then the maFile load throws → the route returns 400 and NEVER calls upsertAccount(rec).
  assert.equal(v.getAccount('bot1')!.password, 'pw123', 'password change is not applied without an explicit upsert');
});
