import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { generateTotpCode, msUntilNextTotp } from '../src/core/LoginFlow';
import { shapeConfirmations } from '../src/trading/confirmations';
import { buildIsolatedSession, parseCookieStrings, startProxyRelay } from '../src/trading/cleanBrowser';

// ── OTP: known-answer against an INDEPENDENT Steam-TOTP computation ──────────
// (Validates the production generateTotpCode; the independent impl here is test-only.)
function steamTotpExpected(sharedSecretB64: string, timeMs: number): string {
  const t = Math.floor(timeMs / 1000);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(t / 30), 4);
  const hmac = crypto.createHmac('sha1', Buffer.from(sharedSecretB64, 'base64')).update(buf).digest();
  const start = hmac[19] & 0x0f;
  let code = hmac.readUInt32BE(start) & 0x7fffffff;
  const chars = '23456789BCDFGHJKMNPQRTVWXY';
  let out = '';
  for (let i = 0; i < 5; i++) { out += chars[code % chars.length]; code = Math.floor(code / chars.length); }
  return out;
}

test('OTP: generateTotpCode matches an independent known-answer at a fixed time', () => {
  const secret = 'cnOgv/KdpLoP6Nbh0GMkXkPnNyQ=';
  const fixed = 1_700_000_000_000;
  const orig = Date.now;
  Date.now = () => fixed;
  try {
    const code = generateTotpCode(secret);
    assert.equal(code, steamTotpExpected(secret, fixed), 'matches the independent Steam-TOTP computation');
    assert.match(code, /^[23456789BCDFGHJKMNPQRTVWXY]{5}$/, 'valid Steam code alphabet/length');
    // Same 30s window ⇒ identical code (so the copy button can never copy a stale value mid-window).
    Date.now = () => fixed + 5_000;
    assert.equal(generateTotpCode(secret), code, 'stable within the 30s window');
  } finally { Date.now = orig; }
});

test('OTP: msUntilNextTotp aligns to the 30s boundary', () => {
  const orig = Date.now;
  Date.now = () => 1_700_000_000_000; // epoch 1700000000 → 20s into the window → 10s left
  try { assert.equal(msUntilNextTotp(), 10_000); } finally { Date.now = orig; }
});

// ── Confirmations: dedup + deterministic order (thin view of getConfirmations) ──
test('shapeConfirmations: real CConfirmation shape (ISO time / Date timestamp) orders newest-first', () => {
  const older = new Date('2026-07-05T10:00:00.000Z');
  const newer = new Date('2026-07-05T12:00:00.000Z');
  const raw = [
    // CConfirmation shape: ISO STRING `time` + numeric `timestamp` (Date) — the live producer.
    { id: '100', type: 3, title: 'Sell A', time: older.toISOString(), timestamp: older },
    { id: '200', type: 2, title: 'Trade B', time: newer.toISOString(), timestamp: newer },
    { id: '100', type: 3, title: 'Sell A dup', time: older.toISOString(), timestamp: older }, // duplicate confirmation id
    { id: '150', type: 3, title: 'Sell C', time: newer.toISOString(), timestamp: newer },     // ties 200's time → tie-break by id
  ];
  const v = shapeConfirmations(raw);
  assert.equal(v.length, 3, 'duplicate id removed');
  assert.deepEqual(v.map((c) => c.id), ['150', '200', '100'], 'time desc, tie-break id asc');
  assert.equal(v[0].timeMs, newer.getTime(), 'ISO/Date timestamp → real ms epoch');
  assert.equal(v[2].timeMs, older.getTime());
  assert.equal(v[1].typeName, 'trade');
  assert.equal(v[2].typeName, 'market');
  // Raw getlist JSON tolerance: a numeric `time` in seconds still gets the s→ms heuristic.
  const num = shapeConfirmations([{ id: '9', type: 3, title: 'N', time: 1500 }]);
  assert.equal(num[0].timeMs, 1500 * 1000, 'numeric seconds time → ms');
  // Unparseable time → 0 (never NaN).
  const bad = shapeConfirmations([{ id: '8', type: 3, title: 'B', time: 'garbage' }]);
  assert.equal(bad[0].timeMs, 0, 'unparseable time → 0');
  assert.deepEqual(shapeConfirmations(null), [], 'empty/garbage input → empty list');
});

// ── Feature A: the three security invariants of the isolated session ──────────
test('A.1 — context carries ONLY this account\'s auth cookies, on every Steam web domain', () => {
  const spec = buildIsolatedSession({
    username: 'alice',
    cookieStrings: ['steamLoginSecure=ALICE_TOKEN', 'sessionid=ALICE_SID', 'steamCountry=DE%7Cabc', 'foo=bar'],
    network: { type: 'proxy', value: 'http://h:3128' },
  });
  // Still ONLY the two auth cookies — no other site cookie (and no other account's) leaks in.
  assert.deepEqual([...new Set(spec.cookies.map((c) => c.name))].sort(), ['sessionid', 'steamLoginSecure']);
  assert.ok(!spec.cookies.some((c) => c.name === 'steamCountry' || c.name === 'foo'), 'no other cookie leaks in');
  // THIS account's token is carried on EVERY domain we set it on, never another value.
  const sls = spec.cookies.filter((c) => c.name === 'steamLoginSecure');
  assert.ok(sls.length > 0 && sls.every((c) => c.value === 'ALICE_TOKEN'), 'same account token on every domain');
  // Bug 2: the session is established on the community host AND the steampowered tree, so the
  // store / account / help pages stay logged in — not steamcommunity.com alone.
  const domains = new Set(spec.cookies.map((c) => c.domain));
  assert.ok(domains.has('steamcommunity.com'), 'community domain set');
  assert.ok(domains.has('.steampowered.com'), 'store/account/help (steampowered) domain set');
});

test('A.1b — the STORE domain carries steamLoginSecure, not only community (Bug 2)', () => {
  const spec = buildIsolatedSession({
    username: 'alice', cookieStrings: ['steamLoginSecure=TOK', 'sessionid=SID'],
    network: { type: 'proxy', value: 'http://h:3128' },
  });
  // A '.steampowered.com' domain cookie is sent to store.steampowered.com, help/checkout/login
  // and the account pages — exactly the domains that previously showed "logged out".
  const onSteampowered = (name: string) =>
    spec.cookies.some((c) => c.name === name && c.domain === '.steampowered.com');
  assert.ok(onSteampowered('steamLoginSecure'), 'steamLoginSecure present on the steampowered tree (store stays logged in)');
  assert.ok(onSteampowered('sessionid'), 'sessionid present on the steampowered tree');
});

test('A.2 — chosen proxy matches THIS account (and differs per account)', () => {
  const a = buildIsolatedSession({ username: 'bob', cookieStrings: ['steamLoginSecure=X'], network: { type: 'proxy', value: 'http://user:pass@1.2.3.4:8080' } });
  assert.equal(a.proxyServer, 'http://1.2.3.4:8080');
  assert.deepEqual(
    { host: a.proxyAuth!.host, port: a.proxyAuth!.port, user: a.proxyAuth!.username, pass: a.proxyAuth!.password },
    { host: '1.2.3.4', port: 8080, user: 'user', pass: 'pass' },
  );
  const b = buildIsolatedSession({ username: 'carol', cookieStrings: ['steamLoginSecure=Y'], network: { type: 'proxy', value: 'socks5://9.9.9.9:1080' } });
  assert.equal(b.proxyServer, 'socks5://9.9.9.9:1080');
  assert.notEqual(a.proxyServer, b.proxyServer, 'no shared/constant proxy across accounts');
});

test('A.2b — proxy creds extracted for EVERY accepted format (the ERR_PROXY_CONNECTION_FAILED regression)', () => {
  // The login flow accepts all of these via AgentFactory.parseProxy. The clean browser MUST
  // extract the SAME host/port/user/pass from each, or Chromium launches credential-stripped,
  // the authed proxy refuses, and you get ERR_PROXY_CONNECTION_FAILED. (The old URL-only
  // splitProxy silently dropped the creds on every non-URL form.)
  const forms = [
    'http://user:pass@1.2.3.4:8080', // URL form
    'user:pass@1.2.3.4:8080',        // format 4 (no scheme)
    '1.2.3.4:8080:user:pass',        // format 1 (host:port:user:pass)
    'user:pass:1.2.3.4:8080',        // format 3 (user:pass:host:port)
    '1.2.3.4:8080@user:pass',        // format 2 (host:port@user:pass)
  ];
  for (const value of forms) {
    const spec = buildIsolatedSession({ username: 'eve', cookieStrings: ['steamLoginSecure=X'], network: { type: 'proxy', value } });
    assert.ok(spec.proxyAuth, `auth extracted for "${value}"`);
    assert.deepEqual(
      { host: spec.proxyAuth!.host, port: spec.proxyAuth!.port, user: spec.proxyAuth!.username, pass: spec.proxyAuth!.password },
      { host: '1.2.3.4', port: 8080, user: 'user', pass: 'pass' },
      `same creds the login flow would use, from "${value}"`,
    );
    assert.equal(spec.proxyServer, 'http://1.2.3.4:8080', '--proxy-server host/port (creds carried by the relay, not the CLI)');
  }
});

test('A.2c — an authed proxy NEVER launches credential-less', () => {
  // Username present ⇒ a non-empty password MUST ride along (the relay needs it to authenticate).
  const ok = buildIsolatedSession({ username: 'fred', cookieStrings: ['steamLoginSecure=X'], network: { type: 'proxy', value: 'http://user:pass@1.2.3.4:8080' } });
  assert.ok(ok.proxyAuth && ok.proxyAuth.username && ok.proxyAuth.password, 'authed proxy carries full creds for the relay');
  // Authed proxy but the password is empty ⇒ REFUSE (proxyServer null + warning) — never open on a failing proxy.
  const empty = buildIsolatedSession({ username: 'gwen', cookieStrings: ['steamLoginSecure=X'], network: { type: 'proxy', value: 'http://user:@1.2.3.4:8080' } });
  assert.equal(empty.proxyServer, null, 'no credential-less launch when the proxy needs auth but the password is empty');
  assert.equal(empty.proxyAuth, null, 'no half-creds relay');
  assert.ok(empty.warnings.some((w) => /password is empty/i.test(w)), 'warns about the missing password');
});

test('A.2d — an authed SOCKS proxy REFUSES (cannot apply SOCKS auth) rather than leaking', () => {
  const spec = buildIsolatedSession({ username: 'hank', cookieStrings: ['steamLoginSecure=X'], network: { type: 'proxy', value: 'socks5://user:pass@9.9.9.9:1080' } });
  assert.equal(spec.proxyServer, null, 'refuses — no credential-less / unauthable launch');
  assert.ok(spec.warnings.some((w) => /SOCKS/i.test(w)), 'warns it cannot apply SOCKS auth');
});

test('A.3 — no-proxy WARNS instead of leaking the host IP', () => {
  for (const network of [{ type: 'localip', value: '192.168.1.5' }, null]) {
    const spec = buildIsolatedSession({ username: 'dan', cookieStrings: ['steamLoginSecure=Z'], network });
    assert.equal(spec.proxyServer, null, 'never the host IP');
    assert.ok(spec.warnings.some((w) => /NO proxy/i.test(w)), 'warns about the missing proxy');
  }
});

// ── Feature A: the local relay actually AUTHENTICATES the browser to the proxy ──
// This is the part that failed at runtime (ERR_PROXY_CONNECTION_FAILED): the browser was
// reaching an authenticated proxy WITHOUT credentials. A fake upstream proxy that demands
// `Proxy-Authorization: Basic <user:pass>` on CONNECT lets us prove, with no real browser
// or network, that the relay injects THIS account's creds (and never silently succeeds without).

/** Fake upstream HTTP proxy: 200 only when CONNECT carries the expected Basic auth, else 407. */
function fakeUpstreamProxy(expectedB64: string): Promise<{ port: number; lastAuth: () => string | null; close: () => void }> {
  let lastAuth: string | null = null;
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = buf.slice(0, end).toString('latin1');
      const m = /Proxy-Authorization:\s*Basic\s+(\S+)/i.exec(head);
      lastAuth = m ? m[1] : null;
      if (m && m[1] === expectedB64) sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      else sock.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
    });
    sock.on('error', () => sock.destroy());
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    port: (srv.address() as net.AddressInfo).port,
    lastAuth: () => lastAuth,
    close: () => { try { srv.close(); } catch { /* ignore */ } },
  })));
}

/** Drive the relay like a browser: send a CONNECT, resolve the first status line it returns. */
function browserConnect(relayPort: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(relayPort, '127.0.0.1', () => sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = Buffer.alloc(0);
    const to = setTimeout(() => { sock.destroy(); reject(new Error('relay never replied')); }, 4000);
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.indexOf('\r\n\r\n') !== -1) { clearTimeout(to); const line = buf.slice(0, buf.indexOf('\r\n')).toString('latin1'); sock.destroy(); resolve(line); }
    });
    sock.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

test('A.4 — the relay authenticates the browser to the upstream with THIS account\'s creds', async () => {
  const expected = Buffer.from('user:pass').toString('base64');
  const upstream = await fakeUpstreamProxy(expected);
  const relay = await startProxyRelay({ host: '127.0.0.1', port: upstream.port, username: 'user', password: 'pass', scheme: 'http' });
  try {
    const status = await browserConnect(relay.port, 'steamcommunity.com:443');
    assert.match(status, /^HTTP\/1\.[01] 200/, 'the browser sees the tunnel established');
    assert.equal(upstream.lastAuth(), expected, 'the relay injected this account\'s Proxy-Authorization on the upstream CONNECT');
  } finally { relay.close(); upstream.close(); }
});

test('A.4b — wrong/empty proxy creds surface as a FAILURE, never a silent credential-less success', async () => {
  const upstream = await fakeUpstreamProxy(Buffer.from('user:pass').toString('base64'));
  const relay = await startProxyRelay({ host: '127.0.0.1', port: upstream.port, username: 'user', password: 'WRONG', scheme: 'http' });
  try {
    const status = await browserConnect(relay.port, 'steamcommunity.com:443');
    assert.doesNotMatch(status, /200/, 'a rejected upstream auth must NOT look like success to the browser');
    assert.match(status, /HTTP\/1\.[01] 50[0-9]/, 'relay reports a gateway error instead');
  } finally { relay.close(); upstream.close(); }
});

test('A.4c — the relay PERSISTS across multiple browser connections (not one-shot)', async () => {
  // The live bug was teardown firing too early (relay gone under a live window → ERR_PROXY_CONNECTION_FAILED).
  // A browser opens MANY proxy connections over a session, so the relay must keep serving until closed.
  const expected = Buffer.from('user:pass').toString('base64');
  const upstream = await fakeUpstreamProxy(expected);
  const relay = await startProxyRelay({ host: '127.0.0.1', port: upstream.port, username: 'user', password: 'pass', scheme: 'http' });
  try {
    const s1 = await browserConnect(relay.port, 'steamcommunity.com:443');
    const s2 = await browserConnect(relay.port, 'store.steampowered.com:443');
    const s3 = await browserConnect(relay.port, 'api.steampowered.com:443');
    assert.match(s1, /^HTTP\/1\.[01] 200/, '1st CONNECT tunnels');
    assert.match(s2, /^HTTP\/1\.[01] 200/, '2nd CONNECT still tunnels (relay stayed up)');
    assert.match(s3, /^HTTP\/1\.[01] 200/, '3rd CONNECT still tunnels');
  } finally { relay.close(); upstream.close(); }
});

test('helpers: parseCookieStrings', () => {
  assert.deepEqual(parseCookieStrings(['a=1; Path=/', 'b=x=y', 'bad']), { a: '1', b: 'x=y' });
});
