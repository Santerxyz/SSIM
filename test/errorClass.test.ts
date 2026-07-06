import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyNetworkError } from '../src/utils/errorClass';
import { isAmbiguousCommitFailure } from '../src/trading/commitAmbiguity';

// ════════════════════════════════════════════════════════════════════════════
//  H-XCT-001 — one shared network-error taxonomy. Before, three prose regexes
//  (refresh / mass-sell / money-commit) disagreed on the same wire condition:
//  EPIPE/ECONNABORTED/"no response" were transient only on the commit path, so a
//  broken-pipe blip during a refresh or a sell was hard-failed instead of retried.
//  These tests pin the union (transient) and the never-landed exclusion (ambiguous).
// ════════════════════════════════════════════════════════════════════════════

test('H-XCT-001: EPIPE / ECONNABORTED are transient (the refresh & sell copies used to miss them)', () => {
  for (const m of ['write EPIPE', 'EPIPE', 'ECONNABORTED', 'aborted', 'no response']) {
    assert.equal(classifyNetworkError(new Error(m)).transient, true, `"${m}" must be transient`);
  }
  // a bare code with no message is classified too (message-only regexes missed this)
  assert.equal(classifyNetworkError(Object.assign(new Error(''), { code: 'ECONNABORTED' })).transient, true);
});

test('H-XCT-001: the union covers every token each subsystem retried before', () => {
  // tokens that WERE in one copy but not another — all must be transient now
  const shared = [
    'read ECONNRESET', 'socket hang up', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'timeout of 15000ms',
    'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'network error', 'proxy tunnel failed',
    'HTTP error 502', 'bad gateway', 'gateway time-out', 'service unavailable',
    'eresult 3', 'error 503', 'temporarily unavailable',
  ];
  for (const m of shared) {
    assert.equal(classifyNetworkError(new Error(m)).transient, true, `"${m}" must be transient`);
  }
});

test('H-XCT-001: rate-limit verdict is the H-INV-001-anchored \\b429\\b (not a substring 429)', () => {
  assert.equal(classifyNetworkError(new Error('HTTP 429 Too Many Requests')).rateLimited, true);
  assert.equal(classifyNetworkError(new Error('rate-limited')).rateLimited, true);
  assert.equal(classifyNetworkError(new Error('too many requests')).rateLimited, true);
  // a rate-limit is also transient (both retry paths treat it as retryable)
  assert.equal(classifyNetworkError(new Error('HTTP 429')).transient, true);
  // NOT a rate limit: 429 embedded in a larger number (H-INV-001)
  assert.equal(classifyNetworkError(new Error('order id 51429 rejected')).rateLimited, false);
});

test('H-XCT-001: ambiguousCommit is TRUE for response-leg-lost transports', () => {
  for (const m of ['read ECONNRESET', 'socket hang up', 'no response']) {
    assert.equal(classifyNetworkError(new Error(m)).ambiguousCommit, true, `"${m}" may have landed`);
  }
});

test('H-XCT-001: ambiguousCommit is FALSE for "never reached Steam" pre-connection failures', () => {
  // ECONNREFUSED / ENETUNREACH / EHOSTUNREACH are in the transient union (refresh & sell
  // retried them) but must NOT be ambiguous — the request never created an order/offer.
  for (const m of ['connect ECONNREFUSED 1.2.3.4', 'ENETUNREACH', 'EHOSTUNREACH']) {
    const c = classifyNetworkError(new Error(m));
    assert.equal(c.transient, true, `"${m}" is still transient (safe to retry)`);
    assert.equal(c.ambiguousCommit, false, `"${m}" never reached Steam → not ambiguous`);
  }
  // DNS failures are in the never-landed exclusion; they were not in any transient copy,
  // so they stay non-transient AND, above all, non-ambiguous.
  for (const m of ['getaddrinfo ENOTFOUND steamcommunity.com', 'dns lookup failed']) {
    assert.equal(classifyNetworkError(new Error(m)).ambiguousCommit, false, `"${m}" never reached Steam → not ambiguous`);
  }
});

test('H-XCT-001: a non-network message is neither transient nor ambiguous', () => {
  const c = classifyNetworkError(new Error('This profile is private.'));
  assert.equal(c.transient, false);
  assert.equal(c.rateLimited, false);
  assert.equal(c.ambiguousCommit, false);
  // null / non-object is inert
  assert.deepEqual(classifyNetworkError(null), { transient: false, rateLimited: false, ambiguousCommit: false });
});

test('H-XCT-001: numeric eresult still forces isAmbiguousCommitFailure FALSE (except the ambiguous-by-def codes)', () => {
  // a transport-looking message loses to an explicit non-ambiguous eresult (Steam answered)
  assert.equal(isAmbiguousCommitFailure(Object.assign(new Error('read ECONNRESET'), { eresult: 8 })), false);
  assert.equal(isAmbiguousCommitFailure(Object.assign(new Error('no response'), { eresult: 15 })), false);
  // ECONNREFUSED / ENOTFOUND → never landed → not an ambiguous commit
  assert.equal(isAmbiguousCommitFailure(new Error('connect ECONNREFUSED 1.2.3.4')), false);
  assert.equal(isAmbiguousCommitFailure(new Error('getaddrinfo ENOTFOUND steamcommunity.com')), false);
  // ECONNRESET / socket hang up / no response → ambiguous
  assert.equal(isAmbiguousCommitFailure(new Error('read ECONNRESET')), true);
  assert.equal(isAmbiguousCommitFailure(new Error('socket hang up')), true);
  assert.equal(isAmbiguousCommitFailure(new Error('no response')), true);
});
