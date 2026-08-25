import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { AccountManager } from '../src/core/AccountManager';
import { vaultDir } from '../src/utils/paths';

// ════════════════════════════════════════════════════════════════════════════
//  Environment delete WITH its accounts (owner 2026-08-25).
//
//  Previously an environment holding accounts could not be deleted at all. It can
//  now, behind a typed "DELETE" in the UI, and the API route tears the accounts
//  down (sessions, inventory caches, vault secrets) before calling into the
//  manager. What THIS file pins is the manager half of that contract:
//
//   • without `cascade` the refusal is unchanged — the old guard must not have
//     been weakened into "always allow";
//   • with `cascade` the environment, its folders and any straggler accounts go;
//   • proxy rules are not left pointing at deleted environments/folders/accounts,
//     which is how a single 200-account delete would otherwise accumulate 200
//     dead account-scoped rules;
//   • a `global` rule is never dropped — its empty target list means "everything",
//     not "dangling".
//
//  (SSIM_HOME is a throwaway temp dir per test/_setup.cjs.)
// ════════════════════════════════════════════════════════════════════════════

function freshManager(): AccountManager {
  try { fs.mkdirSync(vaultDir(), { recursive: true }); } catch { /* ignore */ }
  for (const f of fs.readdirSync(vaultDir())) {
    if (f.startsWith('accounts.json')) { try { fs.rmSync(vaultDir(f), { force: true }); } catch { /* ignore */ } }
  }
  return new AccountManager();
}

const addAccount = (mgr: AccountManager, username: string, environmentId: string, folderId: string | null = null) =>
  mgr.add({ username, password: 'pw', maFilePath: `${username}.maFile`, environmentId, folderId });

test('deleteEnvironment: WITHOUT cascade a non-empty environment is still refused', () => {
  const mgr = freshManager();
  const env = mgr.createEnvironment('Keepers');
  addAccount(mgr, 'bot_a', env.id);

  assert.throws(() => mgr.deleteEnvironment(env.id), /still holds 1 account/i,
    'the guard must survive — a plain delete may never take accounts with it');
  assert.equal(mgr.getEnvironment(env.id)?.id, env.id, 'the environment is untouched');
  assert.equal(mgr.count(), 1, 'and so is the account');
});

test('deleteEnvironment: an EMPTY environment still deletes without cascade', () => {
  const mgr = freshManager();
  const env = mgr.createEnvironment('Empty');
  mgr.deleteEnvironment(env.id);
  assert.equal(mgr.getEnvironment(env.id), undefined);
});

test('deleteEnvironment: cascade removes the environment, its folders and any straggler accounts', () => {
  const mgr = freshManager();
  const env = mgr.createEnvironment('Doomed');
  const keep = mgr.createEnvironment('Survivor');
  const folder = mgr.createFolder('Sub', env.id, null);
  addAccount(mgr, 'bot_a', env.id, folder.id);
  addAccount(mgr, 'bot_b', env.id);
  addAccount(mgr, 'bot_safe', keep.id);

  mgr.deleteEnvironment(env.id, { cascade: true });

  assert.equal(mgr.getEnvironment(env.id), undefined, 'environment gone');
  assert.equal(mgr.getFolder(folder.id), undefined, 'its folder gone');
  assert.equal(mgr.getByEnvironment(env.id).length, 0, 'no account left pointing at a deleted environment');
  assert.deepEqual(mgr.getAll().map((a) => a.username), ['bot_safe'], 'the other environment is untouched');
  assert.equal(mgr.getEnvironment(keep.id)?.id, keep.id, 'and still exists');
});

test('removeMany: takes the named accounts off the books and leaves the rest', () => {
  const mgr = freshManager();
  const env = mgr.createEnvironment('Bulk');
  addAccount(mgr, 'bot_a', env.id);
  addAccount(mgr, 'bot_b', env.id);
  addAccount(mgr, 'bot_c', env.id);

  const removed = mgr.removeMany(['BOT_A', 'bot_c', 'never_existed']);

  assert.deepEqual(removed.sort(), ['bot_a', 'bot_c'], 'case-insensitive, reports STORED casing, ignores unknowns');
  assert.deepEqual(mgr.getAll().map((a) => a.username), ['bot_b'], 'only the named accounts went');
});

test('removeMany: an empty list is a no-op', () => {
  const mgr = freshManager();
  const env = mgr.createEnvironment('Bulk');
  addAccount(mgr, 'bot_a', env.id);
  assert.deepEqual(mgr.removeMany([]), []);
  assert.equal(mgr.count(), 1);
});

test('deleteEnvironment: proxy rules are not left targeting the deleted environment or its folders', () => {
  const mgr = freshManager();
  const env = mgr.createEnvironment('Doomed');
  const keep = mgr.createEnvironment('Survivor');
  const folder = mgr.createFolder('Sub', env.id, null);
  addAccount(mgr, 'bot_a', env.id, folder.id);

  const { rule: envRule } = mgr.addProxyRule({ name: 'env rule', scope: 'environment', targets: [env.id], kind: 'pool', proxies: ['http://1.1.1.1:8000'] });
  const { rule: folderRule } = mgr.addProxyRule({ name: 'folder rule', scope: 'folder', targets: [folder.id], kind: 'pool', proxies: ['http://2.2.2.2:8000'] });
  const { rule: mixedRule } = mgr.addProxyRule({ name: 'mixed env rule', scope: 'environment', targets: [env.id, keep.id], kind: 'pool', proxies: ['http://3.3.3.3:8000'] });
  const { rule: globalRule } = mgr.addProxyRule({ name: 'global', scope: 'global', targets: [], kind: 'pool', proxies: ['http://4.4.4.4:8000'] });

  mgr.deleteEnvironment(env.id, { cascade: true, removedUsernames: ['bot_a'] });

  const rules = mgr.getProxyRules();
  const byId = new Map(rules.map((r) => [r.id, r]));

  assert.equal(byId.has(envRule.id), false, 'a rule that targeted ONLY the dead environment is dropped');
  assert.equal(byId.has(folderRule.id), false, 'a rule that targeted ONLY a dead folder is dropped');
  assert.deepEqual(byId.get(mixedRule.id)?.targets, [keep.id],
    'a rule targeting both keeps the surviving target and loses the dead one');
  assert.equal(byId.has(globalRule.id), true, 'a GLOBAL rule is never dropped — its empty target list means "everything"');

  assert.deepEqual(rules.map((r) => r.priority), rules.map((_, i) => i),
    'priority is a dense rank — it must be reseated after a prune, not left with holes');
});

test('deleteEnvironment: account-scoped rules for cascade-deleted accounts are pruned', () => {
  const mgr = freshManager();
  const env = mgr.createEnvironment('Doomed');
  const keep = mgr.createEnvironment('Survivor');
  addAccount(mgr, 'bot_a', env.id);
  addAccount(mgr, 'bot_safe', keep.id);

  const { rule: acctRule } = mgr.addProxyRule({ name: 'bot_a pin', scope: 'account', targets: ['bot_a'], kind: 'pool', proxies: ['http://1.1.1.1:8000'] });
  const { rule: sharedRule } = mgr.addProxyRule({ name: 'both', scope: 'account', targets: ['bot_a', 'bot_safe'], kind: 'pool', proxies: ['http://2.2.2.2:8000'] });

  // The route removes the accounts FIRST, so the manager can no longer discover them —
  // the usernames have to travel with the call. This is the regression this asserts.
  mgr.removeMany(['bot_a']);
  mgr.deleteEnvironment(env.id, { cascade: true, removedUsernames: ['bot_a'] });

  const byId = new Map(mgr.getProxyRules().map((r) => [r.id, r]));
  assert.equal(byId.has(acctRule.id), false, 'the dead account\'s own rule is dropped');
  assert.deepEqual(byId.get(sharedRule.id)?.targets, ['bot_safe'], 'a shared rule keeps only the live account');
});

test('deleteEnvironment: cascade on an environment with no rules and no accounts is harmless', () => {
  const mgr = freshManager();
  const env = mgr.createEnvironment('Empty');
  mgr.deleteEnvironment(env.id, { cascade: true });
  assert.equal(mgr.getEnvironment(env.id), undefined);
  assert.deepEqual(mgr.getProxyRules(), []);
});
