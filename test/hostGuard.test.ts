import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostnameOnly } from '../src/api/server';

// ─── B47: the loopback Host guard must handle bracketed IPv6 ───────────────────
test('hostnameOnly: strips the port, keeping a bracketed IPv6 literal intact', () => {
  assert.equal(hostnameOnly('[::1]:3000'), '[::1]', 'IPv6 loopback must not become "["');
  assert.equal(hostnameOnly('localhost:3000'), 'localhost');
  assert.equal(hostnameOnly('127.0.0.1:3000'), '127.0.0.1');
  assert.equal(hostnameOnly('127.0.0.1'), '127.0.0.1');
  assert.equal(hostnameOnly('[::1]'), '[::1]');
  assert.equal(hostnameOnly('LOCALHOST:8080'), 'localhost', 'case-normalised');
});

test('hostnameOnly: a legit ::1 bind is allowed by the guard predicate', () => {
  const allowed = (h: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostnameOnly(h));
  assert.equal(allowed('[::1]:3000'), true, 'the old split(":")[0] would have 403-ed this');
  assert.equal(allowed('evil.com:3000'), false);
});
