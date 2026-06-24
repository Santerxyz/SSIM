import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canConfirm, onTokenAuthFailure } from '../src/core/accountCapability';

// C5 / INV-A1 — "can confirm" must track identity_secret, not the tier label.
test('canConfirm: vault mode → identity_secret is authoritative, tier is ignored', () => {
  // The bug: a "Full" account whose maFile has NO identity_secret claimed it could confirm.
  assert.equal(canConfirm({ vaultEnabled: true, vaultMaFileHasIdentitySecret: false, tier: 'full' }), false);
  // And identity_secret present means it CAN confirm regardless of the tier label.
  assert.equal(canConfirm({ vaultEnabled: true, vaultMaFileHasIdentitySecret: true, tier: 'limited' }), true);
});

test('canConfirm: legacy/plaintext mode falls back to the tier label', () => {
  assert.equal(canConfirm({ vaultEnabled: false, vaultMaFileHasIdentitySecret: false, tier: 'full' }), true);
  assert.equal(canConfirm({ vaultEnabled: false, vaultMaFileHasIdentitySecret: false, tier: 'limited' }), false);
});

// C8 / INV-A2 — never delete a token-only account's SOLE credential on an auth verdict.
test('onTokenAuthFailure: token-only (no maFile) account preserves its token', () => {
  assert.equal(onTokenAuthFailure(false), 'preserve-and-fail');
  assert.equal(onTokenAuthFailure(true),  'delete-and-retry');
});
