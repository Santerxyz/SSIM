import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AccountManager } from '../src/core/AccountManager';
import { vaultDir } from '../src/utils/paths';
import * as atomicJson from '../src/utils/atomicJson';

// ════════════════════════════════════════════════════════════════════════════
//  H-ACC-019 — rememberSteamId's save() must not escape into steam-user's
//  'loggedOn' emit chain. A throwing writeJsonAtomic (renameSync EPERM/EBUSY
//  under AV during a mass first-login) would become an uncaughtException and tick
//  the money-ops breaker. The steamId is a write-through cache: it stays in memory
//  and persists with the next successful save, so the throw is swallowed to a warn.
//  (SSIM_HOME is sandboxed to a throwaway temp dir by test/_setup.cjs.)
// ════════════════════════════════════════════════════════════════════════════

const STEAM_ID = '76561198000000001';

test('H-ACC-019: rememberSteamId does not throw when the atomic save throws, keeps the id in memory', () => {
  const mgr = new AccountManager();
  mgr.add({ username: 'bot1', password: 'pw', maFilePath: 'bot1.maFile', environmentId: mgr.defaultEnvironmentId() });

  const orig = atomicJson.writeJsonAtomic;
  (atomicJson as { writeJsonAtomic: typeof orig }).writeJsonAtomic = () => { throw new Error('EPERM'); };
  try {
    assert.doesNotThrow(() => mgr.rememberSteamId('bot1', STEAM_ID), 'a disk hiccup must not cross into the emit chain');
    assert.equal(mgr.get('bot1')?.steamId, STEAM_ID, 'the id is served from memory this session');
  } finally {
    (atomicJson as { writeJsonAtomic: typeof orig }).writeJsonAtomic = orig;
  }

  // A subsequent unrelated save (real writeJsonAtomic restored) persists the cached id.
  mgr.update('bot1', { enabled: false });
  const onDisk = JSON.parse(fs.readFileSync(vaultDir('accounts.json'), 'utf8')) as {
    accounts: { username: string; steamId?: string }[];
  };
  assert.equal(onDisk.accounts.find(a => a.username === 'bot1')?.steamId, STEAM_ID,
    'the write-through cache persists with the next successful save');
});

test('H-ACC-019: a healthy rememberSteamId still persists to disk (baseline)', () => {
  const mgr = new AccountManager();
  mgr.add({ username: 'bot2', password: 'pw', maFilePath: 'bot2.maFile', environmentId: mgr.defaultEnvironmentId() });
  mgr.rememberSteamId('bot2', STEAM_ID);
  const onDisk = JSON.parse(fs.readFileSync(vaultDir('accounts.json'), 'utf8')) as {
    accounts: { username: string; steamId?: string }[];
  };
  assert.equal(onDisk.accounts.find(a => a.username === 'bot2')?.steamId, STEAM_ID);
});
