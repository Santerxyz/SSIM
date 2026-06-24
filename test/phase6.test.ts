import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { generateTotpCode, msUntilNextTotp } from '../src/core/LoginFlow';
import { shapeConfirmations } from '../src/trading/confirmations';
import { buildIsolatedSession, parseCookieStrings, splitProxy } from '../src/trading/cleanBrowser';

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
test('shapeConfirmations: dedups by id, orders newest-first deterministically', () => {
  const raw = [
    { id: '100', type: 3, title: 'Sell A', time: 1000 },
    { id: '200', type: 2, title: 'Trade B', time: 3000 },
    { id: '100', type: 3, title: 'Sell A dup', time: 1000 }, // duplicate confirmation id
    { id: '150', type: 3, title: 'Sell C', time: 3000 },     // ties 200's time → tie-break by id
  ];
  const v = shapeConfirmations(raw);
  assert.equal(v.length, 3, 'duplicate id removed');
  assert.deepEqual(v.map((c) => c.id), ['150', '200', '100'], 'time desc, tie-break id asc');
  assert.equal(v[1].typeName, 'trade');
  assert.equal(v[2].typeName, 'market');
  assert.deepEqual(shapeConfirmations(null), [], 'empty/garbage input → empty list');
});

// ── Feature A: the three security invariants of the isolated session ──────────
test('A.1 — context carries ONLY this account\'s auth cookies', () => {
  const spec = buildIsolatedSession({
    username: 'alice',
    cookieStrings: ['steamLoginSecure=ALICE_TOKEN', 'sessionid=ALICE_SID', 'steamCountry=DE%7Cabc', 'foo=bar'],
    network: { type: 'proxy', value: 'http://h:3128' },
  });
  assert.deepEqual(spec.cookies.map((c) => c.name).sort(), ['sessionid', 'steamLoginSecure']);
  assert.equal(spec.cookies.find((c) => c.name === 'steamLoginSecure')!.value, 'ALICE_TOKEN');
  assert.ok(!spec.cookies.some((c) => c.name === 'steamCountry' || c.name === 'foo'), 'no other cookie leaks in');
  assert.ok(spec.cookies.every((c) => c.domain === 'steamcommunity.com'), 'scoped to steamcommunity.com');
});

test('A.2 — chosen proxy matches THIS account (and differs per account)', () => {
  const a = buildIsolatedSession({ username: 'bob', cookieStrings: ['steamLoginSecure=X'], network: { type: 'proxy', value: 'http://user:pass@1.2.3.4:8080' } });
  assert.equal(a.proxyServer, 'http://1.2.3.4:8080');
  assert.deepEqual({ host: a.proxyAuth!.host, port: a.proxyAuth!.port, user: a.proxyAuth!.username }, { host: '1.2.3.4', port: 8080, user: 'user' });
  const b = buildIsolatedSession({ username: 'carol', cookieStrings: ['steamLoginSecure=Y'], network: { type: 'proxy', value: 'socks5://9.9.9.9:1080' } });
  assert.equal(b.proxyServer, 'socks5://9.9.9.9:1080');
  assert.notEqual(a.proxyServer, b.proxyServer, 'no shared/constant proxy across accounts');
});

test('A.3 — no-proxy WARNS instead of leaking the host IP', () => {
  for (const network of [{ type: 'localip', value: '192.168.1.5' }, null]) {
    const spec = buildIsolatedSession({ username: 'dan', cookieStrings: ['steamLoginSecure=Z'], network });
    assert.equal(spec.proxyServer, null, 'never the host IP');
    assert.ok(spec.warnings.some((w) => /NO proxy/i.test(w)), 'warns about the missing proxy');
  }
});

test('helpers: parseCookieStrings + splitProxy', () => {
  assert.deepEqual(parseCookieStrings(['a=1; Path=/', 'b=x=y', 'bad']), { a: '1', b: 'x=y' });
  assert.deepEqual(splitProxy('http://u:p@host:9'), { scheme: 'http', host: 'host', port: 9, user: 'u', pass: 'p' });
});
