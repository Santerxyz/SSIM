import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCapEnv } from '../src/core/SessionManager';
import { logger } from '../src/utils/logger';

// ─── H-ACC-001: env-tunable safety caps resolve honestly and observably ─────────
// An operator TIGHTENING a cap below its structural floor must be met AT the floor
// (clamped up to `min`), never silently replaced by the looser default. A literal
// "0" opt-out fires only when allowed; an empty string is NOT the opt-out.

test('H-ACC-001: a below-minimum override clamps UP to the minimum (not the looser default) and warns', () => {
  const warn = mock.method(logger, 'warn', () => logger);
  try {
    assert.equal(resolveCapEnv('SSIM_MAX_LIVE_SESSIONS', '10', 25, 150, true), 25);
  } finally {
    mock.restoreAll();
  }
  assert.equal(warn.mock.callCount(), 1, 'a clamp emits exactly one warn');
  assert.match(String(warn.mock.calls[0].arguments[0]), /below the minimum 25 – clamped to 25/);
});

test('H-ACC-001: the literal string "0" opts out (cap DISABLED) when zeroOptOut is set', () => {
  assert.equal(resolveCapEnv('SSIM_MAX_LIVE_SESSIONS', '0', 25, 150, true), 0);
});

test('H-ACC-001: an empty string is NOT the opt-out — it is the default', () => {
  assert.equal(resolveCapEnv('SSIM_MAX_LIVE_SESSIONS', '', 25, 150, true), 150);
});

test('H-ACC-001: a non-numeric value is the default (silent)', () => {
  const warn = mock.method(logger, 'warn', () => logger);
  try {
    assert.equal(resolveCapEnv('SSIM_MAX_LIVE_SESSIONS', 'abc', 25, 150, true), 150);
  } finally {
    mock.restoreAll();
  }
  assert.equal(warn.mock.callCount(), 0, 'the default case is silent');
});

test('H-ACC-001: a value at/above the minimum is honoured (floored)', () => {
  assert.equal(resolveCapEnv('SSIM_MAX_LIVE_SESSIONS', '200.9', 25, 150, false), 200);
});
