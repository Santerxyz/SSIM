import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environmentEgress, emptyEgress } from '../src/api/server';

// ─────────────────────────────────────────────────────────────────────────────
//  v1.4.4 issue 1 — "after changing an environment proxy from no proxy to a rule,
//  it doesn't show in the environment tab that the proxy changed, even though the
//  logs say it was implemented successfully."
//
//  ROOT CAUSE: egress is resolved PER ACCOUNT by the proxy-rule engine, while the
//  environment object only carries the legacy `env.proxy` string — which the POST
//  guard retires (permanently empty) once rules are authoritative. The tab rendered
//  `hasProxy`/`proxy`, so it reported "Local IP (no proxy)" forever. environmentEgress
//  reports what the accounts ACTUALLY resolve to.
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mgr = (rows: any[]): any => ({ resolutionPreview: () => rows });

const proxied = (username: string, environmentId: string, value: string, ruleName: string | null = 'EU pool') =>
  ({ username, environmentId, folderId: null, network: { type: 'proxy', value }, ruleId: 'r1', ruleName, scope: 'environment', conflicts: [], poolLost: false });
const local = (username: string, environmentId: string) =>
  ({ username, environmentId, folderId: null, network: { type: 'localip', value: '' }, ruleId: null, ruleName: null, scope: null, conflicts: [], poolLost: false });

test('an environment whose accounts all resolve to ONE proxy reports that proxy (the reported bug)', () => {
  const m = environmentEgress(mgr([
    proxied('a', 'env1', 'http://user:pass@1.2.3.4:8080'),
    proxied('b', 'env1', 'http://user:pass@1.2.3.4:8080'),
  ]));
  const e = m.get('env1')!;
  assert.equal(e.kind, 'proxy', 'the environment must NOT read as local while a rule is live');
  assert.equal(e.proxyCount, 2);
  assert.equal(e.localCount, 0);
  assert.ok(!e.label.includes('pass'), `credentials must be redacted, got: ${e.label}`);
  assert.ok(!e.label.includes('Local IP'), 'the label must not claim local IP');
});

test('credentials are redacted in the reported proxies', () => {
  const e = environmentEgress(mgr([proxied('a', 'env1', 'http://secretuser:secretpass@9.9.9.9:1080')])).get('env1')!;
  assert.equal(e.proxies.length, 1);
  assert.ok(!e.proxies[0].includes('secretpass'), 'the password must never reach the UI');
  assert.ok(!e.proxies[0].includes('secretuser'), 'the username must never reach the UI');
});

test('an environment with no rule coverage reports local IP', () => {
  const e = environmentEgress(mgr([local('a', 'env1'), local('b', 'env1')])).get('env1')!;
  assert.equal(e.kind, 'local');
  assert.equal(e.label, 'Local IP (no proxy)');
  assert.equal(e.proxyCount, 0);
});

test('a partially-covered environment reports MIXED and names the rule', () => {
  const e = environmentEgress(mgr([
    proxied('a', 'env1', 'http://1.2.3.4:8080', 'EU pool'),
    local('b', 'env1'),
  ])).get('env1')!;
  assert.equal(e.kind, 'mixed', 'a half-covered environment must not claim to be fully proxied');
  assert.ok(e.ruleNames.includes('EU pool'), 'the rule the operator just made is named back to them');
  assert.ok(e.label.includes('1 local'), `the label states the uncovered accounts, got: ${e.label}`);
});

test('a pool-lost account counts as LOCAL, never as proxied (host-IP-leak guard)', () => {
  // poolLost = the refused-login corruption state: the account has no usable proxy. Reporting it as
  // proxied would mask exactly the leak this state exists to surface.
  const rows = [{ username: 'a', environmentId: 'env1', folderId: null, network: { type: 'proxy', value: 'http://1.2.3.4:8080' }, ruleId: 'r1', ruleName: 'EU pool', scope: 'environment', conflicts: [], poolLost: true }];
  const e = environmentEgress(mgr(rows)).get('env1')!;
  assert.equal(e.kind, 'local', 'a pool-lost account must never be presented as proxied');
  assert.equal(e.proxyCount, 0);
});

test('environments are grouped independently, and an empty one falls back to the "no accounts" shape', () => {
  const m = environmentEgress(mgr([proxied('a', 'env1', 'http://1.2.3.4:8080'), local('b', 'env2')]));
  assert.equal(m.get('env1')!.kind, 'proxy');
  assert.equal(m.get('env2')!.kind, 'local');
  assert.equal(m.get('env3'), undefined, 'an environment with no accounts yields no row');
  assert.equal(emptyEgress().kind, 'none', 'the caller substitutes the none-shape for those');
});
