import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactProxyCredentials } from '../src/api/server';
import { redactSecrets } from '../src/utils/logger';

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
