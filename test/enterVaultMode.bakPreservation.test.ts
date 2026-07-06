import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsExtra from 'fs-extra';
import { AccountManager } from '../src/core/AccountManager';
import { AccountVault } from '../src/core/AccountVault';
import { vaultDir } from '../src/utils/paths';
import { logger } from '../src/utils/logger';
import * as atomicJson from '../src/utils/atomicJson';

// ════════════════════════════════════════════════════════════════════════════
//  H-ACC-015 — the vault TRANSITION save must never copy the pre-blank plaintext
//  main into accounts.json.bak. enterVaultMode() blanks in-memory passwords, so
//  the `secretFree` heuristic (which reads MEMORY) would read true and let save()
//  back up the still-plaintext DISK. The fix: purge the .bak FIRST, then save with
//  an explicit backup:false; a failed purge is warned about, never silently
//  swallowed. (SSIM_HOME is sandboxed to a throwaway temp dir by test/_setup.cjs.)
// ════════════════════════════════════════════════════════════════════════════

const BAK = `${vaultDir('accounts.json')}.bak`;

// Drives the singleton vault into "enabled, everything vaulted" without real crypto.
function stubVault(): () => void {
  const v = AccountVault as unknown as { isEnabled: () => boolean; hasAccount: (u: string) => boolean };
  const origEnabled = v.isEnabled;
  const origHas = v.hasAccount;
  v.isEnabled = () => true;
  v.hasAccount = () => true; // every account is treated as vaulted
  return () => { v.isEnabled = origEnabled; v.hasAccount = origHas; };
}

test('H-ACC-015: the enterVaultMode save passes backup:false (never backs up pre-blank plaintext)', () => {
  const mgr = new AccountManager();
  mgr.add({ username: 'vaultbot1', password: 'plaintext-pw', maFilePath: 'vaultbot1.maFile', environmentId: mgr.defaultEnvironmentId() });

  const restoreVault = stubVault();
  const origWrite = atomicJson.writeJsonAtomic;
  const backups: (boolean | undefined)[] = [];
  (atomicJson as { writeJsonAtomic: typeof origWrite }).writeJsonAtomic = (file, data, opts) => {
    backups.push(opts?.backup);
    return origWrite(file, data, opts);
  };
  try {
    mgr.enterVaultMode();
  } finally {
    (atomicJson as { writeJsonAtomic: typeof origWrite }).writeJsonAtomic = origWrite;
    restoreVault();
  }

  assert.equal(backups.at(-1), false, 'the transition save must pass backup:false so no pre-blank plaintext .bak is written');
});

test('H-ACC-015: a failed .bak purge is warned about, not silently swallowed, and does not throw', () => {
  const mgr = new AccountManager();
  mgr.add({ username: 'vaultbot2', password: 'plaintext-pw', maFilePath: 'vaultbot2.maFile', environmentId: mgr.defaultEnvironmentId() });

  // A .bak must exist so the purge is attempted.
  fs.writeFileSync(BAK, '{"stale":"plaintext"}');
  assert.ok(fs.existsSync(BAK), 'a .bak exists before the transition');

  const restoreVault = stubVault();
  const origRemove = fsExtra.removeSync;
  (fsExtra as { removeSync: typeof origRemove }).removeSync = () => { throw new Error('EBUSY: resource busy or locked'); };
  const origWarn = logger.warn;
  let warned = '';
  (logger as unknown as { warn: (m: string) => void }).warn = (m: string) => { warned += m; };
  try {
    assert.doesNotThrow(() => mgr.enterVaultMode(), 'a locked .bak must not abort the transition');
    assert.match(warned, /accounts\.json\.bak/, 'the swallowed catch is replaced by a loud warn');
    assert.match(warned, /EBUSY/, 'the warn carries the underlying error');
  } finally {
    (fsExtra as { removeSync: typeof origRemove }).removeSync = origRemove;
    (logger as unknown as { warn: typeof origWarn }).warn = origWarn;
    restoreVault();
  }
  try { if (fs.existsSync(BAK)) fs.unlinkSync(BAK); } catch { /* cleanup */ }
});

test('H-ACC-015: a steady-state plaintext CRUD save still writes a .bak (B34 unbroken)', () => {
  try { if (fs.existsSync(BAK)) fs.unlinkSync(BAK); } catch { /* start clean */ }
  const mgr = new AccountManager();
  mgr.add({ username: 'plainbot', password: 'pw', maFilePath: 'plainbot.maFile', environmentId: mgr.defaultEnvironmentId() });
  // A second CRUD save in plaintext mode → backup defaults to true → a .bak of the prior state.
  mgr.update('plainbot', { enabled: false });
  assert.ok(fs.existsSync(BAK), 'plaintext-mode saves must still produce the B34 org-structure backup');
  try { if (fs.existsSync(BAK)) fs.unlinkSync(BAK); } catch { /* cleanup */ }
});

// ════════════════════════════════════════════════════════════════════════════
//  H-ACC-020 — enterVaultMode() must be TRANSITION-AWARE. It runs on EVERY
//  vault-mode boot, but only a boot that actually blanks a plaintext secret is a
//  transition. A steady-state boot must perform ZERO writes and must NOT destroy
//  a .bak whose secrets are not provably in the vault (a recoverable rollback
//  copy). Only a STALE .bak — every plaintext secret byte-equal to the vault — is
//  purged, preserving -15's "failed purge retried next boot" property.
// ════════════════════════════════════════════════════════════════════════════

// A richer stub than stubVault(): backs the vault with an explicit account/env-proxy
// map so getAccount().password / getEnvProxy() can be compared byte-for-byte.
function stubVaultWith(accts: Record<string, string>, envProxies: Record<string, string> = {}): () => void {
  const v = AccountVault as unknown as {
    isEnabled: () => boolean;
    hasAccount: (u: string) => boolean;
    getAccount: (u: string) => { password: string } | undefined;
    getEnvProxy: (id: string) => string | undefined;
    importEnvProxy: (id: string, p: string) => boolean;
    save: () => void;
  };
  const orig = {
    isEnabled: v.isEnabled, hasAccount: v.hasAccount, getAccount: v.getAccount,
    getEnvProxy: v.getEnvProxy, importEnvProxy: v.importEnvProxy, save: v.save,
  };
  v.isEnabled = () => true;
  v.hasAccount = (u: string) => u.toLowerCase() in accts;
  v.getAccount = (u: string) => (u.toLowerCase() in accts ? { password: accts[u.toLowerCase()] } : undefined);
  v.getEnvProxy = (id: string) => envProxies[id];
  v.importEnvProxy = () => false; // everything already migrated → no transition via env proxy
  v.save = () => { /* no-op */ };
  return () => Object.assign(v, orig);
}

function spyWrites(): { backups: (boolean | undefined)[]; removed: string[]; restore: () => void } {
  const origWrite = atomicJson.writeJsonAtomic;
  const origRemove = fsExtra.removeSync;
  const backups: (boolean | undefined)[] = [];
  const removed: string[] = [];
  (atomicJson as { writeJsonAtomic: typeof origWrite }).writeJsonAtomic = (file, data, opts) => {
    backups.push(opts?.backup);
    return origWrite(file, data, opts);
  };
  (fsExtra as { removeSync: typeof origRemove }).removeSync = ((p: string) => {
    removed.push(String(p));
    return origRemove(p as string);
  }) as typeof origRemove;
  return {
    backups, removed,
    restore: () => {
      (atomicJson as { writeJsonAtomic: typeof origWrite }).writeJsonAtomic = origWrite;
      (fsExtra as { removeSync: typeof origRemove }).removeSync = origRemove;
    },
  };
}

test('H-ACC-020 (a): a steady-state boot performs zero writes and leaves a secret-free .bak intact', () => {
  const mgr = new AccountManager();
  // On disk the account is already blanked (steady state): its password is '' in memory.
  mgr.add({ username: 'steadybot', password: '', maFilePath: 'steadybot.maFile', environmentId: mgr.defaultEnvironmentId() });
  // A secret-free org-structure .bak (no plaintext) — a legitimate B34 backup that must survive.
  fs.writeFileSync(BAK, JSON.stringify({ accounts: [{ username: 'steadybot', password: '' }], environments: [] }));

  const restoreVault = stubVaultWith({ steadybot: 'vaulted-pw' });
  const spy = spyWrites();
  try {
    mgr.enterVaultMode();
  } finally {
    spy.restore();
    restoreVault();
  }
  assert.equal(spy.backups.length, 0, 'a steady-state boot must not save accounts.json');
  assert.deepEqual(spy.removed, [], 'a secret-free .bak must never be purged');
  assert.ok(fs.existsSync(BAK), 'the .bak survives a steady-state boot');
  try { if (fs.existsSync(BAK)) fs.unlinkSync(BAK); } catch { /* cleanup */ }
});

test('H-ACC-020 (b): a transition boot purges the .bak and saves exactly once with backup:false', () => {
  const mgr = new AccountManager();
  // A still-plaintext password in memory → this boot BLANKS it → transition.
  mgr.add({ username: 'transbot', password: 'still-plaintext', maFilePath: 'transbot.maFile', environmentId: mgr.defaultEnvironmentId() });
  fs.writeFileSync(BAK, JSON.stringify({ accounts: [{ username: 'transbot', password: 'still-plaintext' }], environments: [] }));

  const restoreVault = stubVaultWith({ transbot: 'still-plaintext' });
  const spy = spyWrites();
  try {
    mgr.enterVaultMode();
  } finally {
    spy.restore();
    restoreVault();
  }
  assert.equal(spy.backups.length, 1, 'the transition performs exactly one save');
  assert.equal(spy.backups[0], false, 'the transition save passes backup:false');
  assert.ok(spy.removed.some((p) => p === BAK), 'the transition purges the pre-blank plaintext .bak');
  assert.ok(!fs.existsSync(BAK), 'the .bak is gone after the transition');
  try { if (fs.existsSync(BAK)) fs.unlinkSync(BAK); } catch { /* cleanup */ }
});

test('H-ACC-020 (c): a stale plaintext .bak whose secrets byte-match the vault is purged with NO save', () => {
  const mgr = new AccountManager();
  mgr.add({ username: 'stalebot', password: '', maFilePath: 'stalebot.maFile', environmentId: mgr.defaultEnvironmentId() });
  // The .bak still holds the PRE-transition plaintext, and that exact byte-string is now vaulted.
  fs.writeFileSync(BAK, JSON.stringify({ accounts: [{ username: 'stalebot', password: 'was-plaintext' }], environments: [] }));

  const restoreVault = stubVaultWith({ stalebot: 'was-plaintext' });
  const spy = spyWrites();
  try {
    mgr.enterVaultMode();
  } finally {
    spy.restore();
    restoreVault();
  }
  assert.equal(spy.backups.length, 0, 'the sentinel path performs no save');
  assert.ok(spy.removed.some((p) => p === BAK), 'a provably-stale plaintext .bak is purged');
  assert.ok(!fs.existsSync(BAK), 'the stale .bak is gone');
  try { if (fs.existsSync(BAK)) fs.unlinkSync(BAK); } catch { /* cleanup */ }
});

test('H-ACC-020 (d): a .bak with a NOT-vaulted / mismatched secret is a recoverable orphan → kept', () => {
  const mgr = new AccountManager();
  mgr.add({ username: 'keepbot', password: '', maFilePath: 'keepbot.maFile', environmentId: mgr.defaultEnvironmentId() });
  // The .bak's plaintext password does NOT byte-match what the vault holds → recoverable → keep.
  fs.writeFileSync(BAK, JSON.stringify({ accounts: [{ username: 'keepbot', password: 'never-vaulted' }], environments: [] }));

  const restoreVault = stubVaultWith({ keepbot: 'a-different-value' });
  const spy = spyWrites();
  try {
    mgr.enterVaultMode();
  } finally {
    spy.restore();
    restoreVault();
  }
  assert.equal(spy.backups.length, 0, 'the sentinel path performs no save');
  assert.deepEqual(spy.removed, [], 'a .bak with a not-provably-vaulted secret must never be purged');
  assert.ok(fs.existsSync(BAK), 'the recoverable .bak survives');
  try { if (fs.existsSync(BAK)) fs.unlinkSync(BAK); } catch { /* cleanup */ }
});
