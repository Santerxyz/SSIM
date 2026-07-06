import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/core/AccountManager';
import { AccountVault } from '../src/core/AccountVault';
import * as maFiles from '../src/core/maFiles';
import * as atomicJson from '../src/utils/atomicJson';

// ════════════════════════════════════════════════════════════════════════════
//  H-ACC-017 — addMany's vault branch must blank the in-memory plaintext password
//  after a SUCCESSFUL AccountVault.upsertAccount(). If it doesn't, the vaulted
//  record keeps its plaintext in db.accounts, which latches `secretFree` (save(),
//  AccountManager.ts) to false for the rest of the process → every later save
//  passes backup:false, freezing the B34 accounts.json.bak. An item whose maFile
//  can't be vaulted must KEEP its plaintext (non-destructive guarantee).
//  (SSIM_HOME is sandboxed to a throwaway temp dir by test/_setup.cjs.)
// ════════════════════════════════════════════════════════════════════════════

// Drives the singleton vault into "enabled"; hasAccount()/upsertAccount() are
// keyed off an explicit set so `secretFree` and save()'s blank-map read correctly.
function stubVault(vaulted: Set<string>): () => void {
  const v = AccountVault as unknown as {
    isEnabled: () => boolean;
    hasAccount: (u: string) => boolean;
    upsertAccount: (a: { username: string }) => void;
  };
  const orig = { isEnabled: v.isEnabled, hasAccount: v.hasAccount, upsertAccount: v.upsertAccount };
  v.isEnabled = () => true;
  v.hasAccount = (u: string) => vaulted.has(u.toLowerCase());
  v.upsertAccount = (a: { username: string }) => { vaulted.add(a.username.toLowerCase()); };
  return () => Object.assign(v, orig);
}

test('H-ACC-017: addMany blanks the vaulted item in memory and keeps the un-vaultable one plaintext; a later save still backs up', () => {
  const mgr = new AccountManager();
  const vaulted = new Set<string>();
  const restoreVault = stubVault(vaulted);

  // The good item's maFile loads; the bad item's throws → its plaintext must survive.
  const origLoad = maFiles.loadMaFileFromDisk;
  (maFiles as { loadMaFileFromDisk: typeof origLoad }).loadMaFileFromDisk = ((p: string) => {
    if (p === 'badbot.maFile') throw new Error('ENOENT: maFile missing');
    return { shared_secret: 's', identity_secret: 'i' } as ReturnType<typeof origLoad>;
  }) as typeof origLoad;

  const origWrite = atomicJson.writeJsonAtomic;
  const backups: (boolean | undefined)[] = [];
  (atomicJson as { writeJsonAtomic: typeof origWrite }).writeJsonAtomic = (file, data, opts) => {
    backups.push(opts?.backup);
    return origWrite(file, data, opts);
  };

  const env = mgr.defaultEnvironmentId();
  try {
    const res = mgr.addMany([
      { username: 'goodbot', password: 'good-pw', maFilePath: 'goodbot.maFile', environmentId: env },
      { username: 'badbot',  password: 'bad-pw',  maFilePath: 'badbot.maFile',  environmentId: env },
    ]);
    assert.equal(res.added.length, 2, 'both records are added (vaulting is best-effort per item)');

    const raw = mgr.getAllRaw();
    const good = raw.find((a) => a.username === 'goodbot');
    const bad  = raw.find((a) => a.username === 'badbot');
    assert.equal(good?.password, '', 'the vaulted item is blanked in memory (vault now owns the secret)');
    assert.equal(bad?.password, 'bad-pw', 'the un-vaultable item KEEPS its plaintext (non-destructive guarantee)');

    // Subsequent save: goodbot is vaulted+blank, badbot is plaintext but NOT vaulted, so
    // `secretFree` is true → vault-mode backup defaults to true (B34 backup keeps running).
    backups.length = 0;
    mgr.update('goodbot', { enabled: false });
    assert.equal(backups.at(-1), true, 'a later save still passes backup:true — B34 backups not frozen');
  } finally {
    (atomicJson as { writeJsonAtomic: typeof origWrite }).writeJsonAtomic = origWrite;
    (maFiles as { loadMaFileFromDisk: typeof origLoad }).loadMaFileFromDisk = origLoad;
    restoreVault();
  }
});
