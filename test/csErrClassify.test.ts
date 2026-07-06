import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csErr } from '../src/api/server';

// ─── H-API-002: csErr must not flatten transient CSFloat failures to a permanent 400 ──
// Only a real 429 (rate limit) or a genuine upstream 4xx (auth) should surface as such.
// Upstream 5xx and status-less transport failures (timeout / ECONNRESET) are transient and
// must classify as a retryable 502 gateway error — never the "your request was malformed" 400.

test('H-API-002: a 429 rate-limit stays 429', () => {
  assert.equal(csErr({ status: 429 }), 429);
});

test('H-API-002: an upstream 5xx becomes a retryable 502', () => {
  assert.equal(csErr({ status: 503 }), 502);
  assert.equal(csErr({ status: 502 }), 502);
  assert.equal(csErr({ status: 504 }), 502);
});

test('H-API-002: a genuine client error surfaces its own status', () => {
  assert.equal(csErr({ status: 403 }), 403);
  assert.equal(csErr({ status: 401 }), 401);
  assert.equal(csErr({ status: 404 }), 404);
});

test('H-API-002: a status-less transport failure (timeout/ECONN*) is a retryable 502, not 400', () => {
  assert.equal(csErr(new Error('timeout of 20000ms exceeded')), 502);
  assert.equal(csErr({}), 502);
  assert.equal(csErr(new Error('read ECONNRESET')), 502);
});
