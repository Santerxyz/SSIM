import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactProxyCredentials } from '../src/api/server';
import { redactSecrets } from '../src/utils/logger';
import { SessionManager } from '../src/core/SessionManager';
import { SessionState, type ManagedSession } from '../src/types/session';

// ─── B24: proxy-credential redaction covers legacy non-URL formats too ─────────
test('redactProxyCredentials: URL form is masked', () => {
  assert.equal(redactProxyCredentials('http://user:pass@1.2.3.4:3128'), 'http://***:***@1.2.3.4:3128');
  assert.equal(redactProxyCredentials('socks5://u:p@9.9.9.9:1080'), 'socks5://***:***@9.9.9.9:1080');
});

test('redactProxyCredentials: legacy host:port:user:pass form is masked (B24)', () => {
  const out = redactProxyCredentials('1.2.3.4:3128:secretuser:secretpass');
  assert.ok(!out.includes('secretuser') && !out.includes('secretpass'), `creds leaked: ${out}`);
  assert.ok(out.includes('***:***@'), 'masked form');
});

test('redactProxyCredentials: a credential-less proxy is left intact', () => {
  assert.equal(redactProxyCredentials('http://1.2.3.4:3128'), 'http://1.2.3.4:3128');
  assert.equal(redactProxyCredentials('1.2.3.4:3128'), '1.2.3.4:3128');
});

// ─── B25: the logger redactor (used by the res.json error middleware) masks creds ──
test('B25: redactSecrets masks a proxy URL embedded in an error string', () => {
  const masked = redactSecrets('connect ECONNREFUSED via http://bob:hunter2@10.0.0.1:8080 while buying');
  assert.ok(!masked.includes('hunter2'), 'password must not survive in an error message');
});

// ─── H-ACC-006: the two B24-missed sites in SessionManager mask legacy-format creds ──
// The login log line and getStatus() both print `network.value` for proxy accounts; a
// legacy (schemeless) format bypasses the logger's URL-only redactFormat, so both sites
// now redact at the source. redactProxyCredentials is the exact call both sites make.
test('H-ACC-006: redactProxyCredentials masks a legacy host:port:user:pass value (the login-line call)', () => {
  const out = redactProxyCredentials('host:1080:user:secret');
  assert.ok(out.includes('***'), `masked form expected: ${out}`);
  assert.ok(!out.includes('secret'), `credential leaked: ${out}`);
});

test('H-ACC-006: getStatus() masks a proxy account whose value is a legacy schemeless format', () => {
  const sm = new SessionManager();
  const session = {
    account: { username: 'bot', network: { type: 'proxy', value: 'host:1080:user:secret' } },
    state: SessionState.LOGGED_IN,
  } as unknown as ManagedSession;
  (sm as unknown as { sessions: Map<string, ManagedSession> }).sessions.set('bot', session);

  const status = sm.getStatus();
  assert.ok(status[0].network.includes('***'), `masked form expected: ${status[0].network}`);
  assert.ok(!status[0].network.includes('secret'), `credential leaked: ${status[0].network}`);
});

test('H-ACC-006: getStatus() leaves a localip account untouched (only proxy is masked)', () => {
  const sm = new SessionManager();
  const session = {
    account: { username: 'bot', network: { type: 'localip', value: '192.168.1.10' } },
    state: SessionState.LOGGED_IN,
  } as unknown as ManagedSession;
  (sm as unknown as { sessions: Map<string, ManagedSession> }).sessions.set('bot', session);

  assert.equal(sm.getStatus()[0].network, 'localip:192.168.1.10');
});
