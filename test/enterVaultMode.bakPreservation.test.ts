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
