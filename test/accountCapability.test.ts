import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canConfirm, onTokenAuthFailure } from '../src/core/accountCapability';

// C5 / INV-A1 — "can confirm" must track the resolved identity_secret, not the tier label.
test('canConfirm: a measured identity_secret is authoritative, tier is ignored', () => {
  // The bug: a "Full" account whose maFile has NO identity_secret claimed it could confirm.
  assert.equal(canConfirm({ identitySecret: 'absent', tier: 'full' }), false);
  // And identity_secret present means it CAN confirm regardless of the tier label.
  assert.equal(canConfirm({ identitySecret: 'present', tier: 'limited' }), true);
});

// H-ACC-084 — the tier label is the honest best-effort ONLY when the real signal is unreadable
// (a fs/JSON error → 'unknown'); it must NEVER override a measured 'present'/'absent'.
test('canConfirm: an unreadable maFile falls back to the tier label', () => {
  assert.equal(canConfirm({ identitySecret: 'unknown', tier: 'full' }), true);
  assert.equal(canConfirm({ identitySecret: 'unknown', tier: 'limited' }), false);
});

// C8 / INV-A2 — never delete a token-only account's SOLE credential on an auth verdict.
test('onTokenAuthFailure: token-only (no maFile) account preserves its token', () => {
  assert.equal(onTokenAuthFailure({ hasMaFile: false, hasPassword: false }), 'preserve-and-fail');
  assert.equal(onTokenAuthFailure({ hasMaFile: true,  hasPassword: true  }), 'delete-and-retry');
});

// H-ACC-085 — a password-less (QR-imported, maFile-attached) account must NOT have its sole
// refresh token deleted: the maFile alone cannot log in (empty password → auth failure).
test('onTokenAuthFailure: maFile present but no password preserves the token', () => {
  assert.equal(onTokenAuthFailure({ hasMaFile: true, hasPassword: false }), 'preserve-and-fail');
});
