import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProxyHealth, BreakerState, isResetClass, proxyKey } from '../src/network/ProxyHealth';

// ════════════════════════════════════════════════════════════════════════════
//  ProxyHealth circuit breaker — the per-proxy "tank" that makes SSIM absorb a
//  flaky provider's reset storm instead of amplifying it into the native fast-fail.
// ════════════════════════════════════════════════════════════════════════════

test('isResetClass matches the field storm signatures, not ordinary failures', () => {
  assert.ok(isResetClass(new Error('Client network socket disconnected before secure TLS connection was established')));
  assert.ok(isResetClass(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })));
  assert.ok(isResetClass(new Error('socket hang up')));
  assert.ok(isResetClass(new Error('Proxy connection timed out')));
  assert.ok(isResetClass(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })));
  // NOT reset-class:
  assert.ok(!isResetClass(new Error('InvalidPassword')));
  assert.ok(!isResetClass(new Error('HTTP 429 rate limited')));
  assert.ok(!isResetClass(null));
});

test('proxyKey derives host:port and ignores proxyless', () => {
  assert.equal(proxyKey('http://user:pass@1.2.3.4:8080'), '1.2.3.4:8080');
  assert.equal(proxyKey('1.2.3.4:8080'), '1.2.3.4:8080');
  assert.equal(proxyKey(''), null);
  assert.equal(proxyKey(undefined), null);
});

test('a null/proxyless key is always allowed and never tracked', () => {
  const h = new ProxyHealth();
  assert.equal(h.shouldAllow(null), true);
  h.record(null, 'reset');
  assert.equal(h.openCount(), 0);
});

test('trips OPEN only after the reset threshold of CONSECUTIVE resets', () => {
  const h = new ProxyHealth({ resetThreshold: 3, baseCooldownMs: 1000 });
  const K = 'p:1';
  h.record(K, 'reset'); h.record(K, 'reset');
  assert.equal(h.shouldAllow(K, 0), true, 'below threshold → still dialing');
  h.record(K, 'reset'); // 3rd consecutive → trips
  assert.equal(h.isOpen(K), true);
  assert.equal(h.shouldAllow(K, 0), false, 'OPEN → bulk dials deferred');
});

test('an ok BEFORE the threshold resets the consecutive count (no premature trip)', () => {
  const h = new ProxyHealth({ resetThreshold: 3 });
  const K = 'p:2';
  h.record(K, 'reset'); h.record(K, 'reset');
  h.record(K, 'ok'); // heals the streak
  h.record(K, 'reset'); h.record(K, 'reset');
  assert.equal(h.isOpen(K), false, 'two fresh resets after an ok is below threshold');
});

test('a non-reset fail never trips the breaker', () => {
  const h = new ProxyHealth({ resetThreshold: 2 });
  const K = 'p:3';
  h.record(K, 'fail'); h.record(K, 'fail'); h.record(K, 'fail');
  assert.equal(h.isOpen(K), false, 'auth/429/app failures are not the storm class');
});

test('OPEN → after cooldown allows exactly ONE half-open probe, holds the rest', () => {
  const h = new ProxyHealth({ resetThreshold: 1, baseCooldownMs: 1000 });
  const K = 'p:4';
  h.record(K, 'reset', 0); // trips at t=0
  assert.equal(h.shouldAllow(K, 500), false, 'within cooldown → deferred');
  assert.equal(h.shouldAllow(K, 1000), true, 'cooldown elapsed → one probe allowed');
  assert.equal(h.shouldAllow(K, 1000), false, 'the probe is outstanding → others held');
});

test('a successful probe closes the breaker; a failed probe reopens with a longer cooldown', () => {
  const h = new ProxyHealth({ resetThreshold: 1, baseCooldownMs: 1000, maxCooldownMs: 10000 });
  const K = 'p:5';
  h.record(K, 'reset', 0);
  h.shouldAllow(K, 1000); // take the probe
  h.record(K, 'ok', 1100); // probe succeeds
  assert.equal(h.isOpen(K), false);
  assert.equal(h.shouldAllow(K, 1200), true, 'recovered → dialing freely');

  // reopen and fail the probe → cooldown doubles
  h.record(K, 'reset', 2000);
  h.shouldAllow(K, 3000); // probe
  h.record(K, 'reset', 3100); // probe fails
  assert.equal(h.shouldAllow(K, 3600), false, 'still deferred: cooldown doubled to 2000ms from 3100');
  assert.equal(h.shouldAllow(K, 5200), true, 'doubled cooldown elapsed → probe again');
});

test('openCount tracks how many proxies are currently storming (drives adaptive concurrency)', () => {
  const h = new ProxyHealth({ resetThreshold: 1 });
  h.record('a:1', 'reset'); h.record('b:1', 'reset'); h.record('c:1', 'ok');
  assert.equal(h.openCount(), 2);
});
