import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { AgentFactory, normalizeProxy } from '../src/network/AgentFactory';
import type { NetworkConfig } from '../src/types/account';

// ─── H-NET-001 · proxy credential double-encode ────────────────────────────────
// The store path (server.ts) already runs `normalizeProxy` on operator input, and
// `resolveNetwork` hands that encoded string back verbatim as `network.value`.
// `fromProxy` used to `normalizeProxy` a SECOND time, so any credential containing
// a char `encodeURIComponent` escapes was double-encoded and every consumer (web
// agent + steam-user CM tunnel) authenticated with the WRONG password. These tests
// simulate production by feeding the ALREADY-normalized (stored) string into
// AgentFactory.create, exactly as resolveNetwork does.

const proxy = (value: string): NetworkConfig => ({ type: 'proxy', value });

// (1) Idempotency (belt): normalizeProxy applied twice must equal once.
test('normalizeProxy is idempotent for special-char creds', () => {
  const http4 = 'http://user:p@ss:w0rd@1.2.3.4:3128';
  assert.equal(normalizeProxy(normalizeProxy(http4)), normalizeProxy(http4));
  const socks = 'socks5://user:p@ss:w0rd@1.2.3.4:1080';
  assert.equal(normalizeProxy(normalizeProxy(socks)), normalizeProxy(socks));
});

// (2) HTTP web-agent wire creds are the RAW password (one layer, not double).
test('HTTP proxy web agent carries the raw special-char password', () => {
  const { httpsAgent } = AgentFactory.create(proxy(normalizeProxy('user:p@ss:w0rd@1.2.3.4:3128')));
  assert.equal((httpsAgent as any).proxy.auth, 'user:p@ss:w0rd');
});

// (3) SOCKS web-agent creds come from raw parts (zero decode layers).
test('SOCKS proxy web agent carries the raw special-char password from parts', () => {
  const { httpsAgent } = AgentFactory.create(proxy(normalizeProxy('socks5://user:p@ss:w0rd@1.2.3.4:1080')));
  assert.equal((httpsAgent as any).proxy.password, 'p@ss:w0rd');
  assert.equal((httpsAgent as any).proxy.userId, 'user');
});

// (4) steam-user httpProxy is a SINGLE-encoded URL string that round-trips through
// https-proxy-agent's one-layer decode back to the raw password.
test('steam-user httpProxy string round-trips to the raw password', () => {
  const { steamUserOptions } = AgentFactory.create(proxy(normalizeProxy('user:p@ss:w0rd@1.2.3.4:3128')));
  assert.ok(steamUserOptions.httpProxy, 'httpProxy must be set for an HTTP proxy');
  assert.equal(new HttpsProxyAgent(steamUserOptions.httpProxy!).proxy.auth, 'user:p@ss:w0rd');
});

// (4b) steam-user socksProxy string is a KNOWN residual: it must be built from raw
// parts (not the double-normalized store value). We assert only the string shape —
// NOT that SocksProxyAgent decodes it, which is IMPOSSIBLE for special chars
// (WHATWG parse yields 'p%40ss%3Aw0rd' for both raw and encoded input); that is the
// flagged socks-proxy-agent@6 / steam-user string-API library limitation.
test('steam-user socksProxy string is the raw-creds form (known library residual)', () => {
  const { steamUserOptions } = AgentFactory.create(proxy(normalizeProxy('socks5://user:p@ss:w0rd@1.2.3.4:1080')));
  assert.equal(steamUserOptions.socksProxy, 'socks5://user:p@ss:w0rd@1.2.3.4:1080');
});

// (5) Alphanumeric regression guard — the case that works end-to-end today, incl.
// the SOCKS string path, must be byte-identical after the fix.
test('alphanumeric creds are byte-identical across all consumers', () => {
  const httpBundle = AgentFactory.create(proxy(normalizeProxy('user:pass@1.2.3.4:3128')));
  assert.equal((httpBundle.httpsAgent as any).proxy.auth, 'user:pass');
  assert.equal(new HttpsProxyAgent(httpBundle.steamUserOptions.httpProxy!).proxy.auth, 'user:pass');

  const socksBundle = AgentFactory.create(proxy(normalizeProxy('socks5://user:pass@1.2.3.4:1080')));
  assert.equal((socksBundle.httpsAgent as any).proxy.password, 'pass');
  assert.equal((socksBundle.httpsAgent as any).proxy.userId, 'user');
  assert.equal(socksBundle.steamUserOptions.socksProxy, 'socks5://user:pass@1.2.3.4:1080');
});

// No-creds / fallback path preserved: a credential-free proxy still normalizes to a
// plain scheme://host:port with no auth (no `undefined:undefined@`).
test('credential-free proxies keep today behaviour (no spurious auth)', () => {
  const httpBundle = AgentFactory.create(proxy(normalizeProxy('1.2.3.4:3128')));
  assert.equal(httpBundle.steamUserOptions.httpProxy, 'http://1.2.3.4:3128');
  const socksBundle = AgentFactory.create(proxy(normalizeProxy('socks5://1.2.3.4:1080')));
  assert.equal(socksBundle.steamUserOptions.socksProxy, 'socks5://1.2.3.4:1080');
});
