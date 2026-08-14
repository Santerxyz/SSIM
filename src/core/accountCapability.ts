// ════════════════════════════════════════════════════════════════════════════
//  accountCapability — pure policy for two account invariants:
// • INV-A1: "can this account confirm trades?" has one real signal — the
//     maFile's identity_secret, resolved the way login resolves it (vault then disk,
//     see LoginFlow.identitySecretPresence). `tier` is a label and is consulted only
//     when that signal is genuinely unreadable, never as an independent source of truth.
// • INV-A2: a token-only (LIMITED, no maFile) account's refresh token is its
//     SOLE credential. Deleting it on an 'auth' verdict would strand the account, so
//     it is preserved and the account is surfaced as needing re-import.
//  Pure (no runtime imports; type-only import is erased) so the policy is unit-testable in isolation.
// ════════════════════════════════════════════════════════════════════════════

import type { AccountTier } from '../types/account';

export interface CanConfirmInput {
  /**
   * The RUNTIME identity_secret presence, resolved exactly the way login resolves the
   * maFile — vault then disk (see LoginFlow.identitySecretPresence). `'present'`/`'absent'`
   * are the real signal; `'unknown'` means the maFile was unreadable (fs/JSON error) so
   * the honest capability can't be measured and we fall back to the tier label.
   */
  identitySecret: 'present' | 'absent' | 'unknown';
  /** Legacy/plaintext fallback: the stored tier label (used ONLY when the real signal is unreadable). */
  tier?: AccountTier;
}

/**
 * The single "can confirm trades / market listings" predicate. The maFile's identity_secret
 * — resolved vault then disk, mirroring the login credential resolution — is authoritative in
 * both modes; the tier label is consulted only when that signal is genuinely unreadable
 * (`'unknown'`), never as an independent source of truth. This is what the dashboard should
 * display instead of raw `tier`, so "Full" can never claim a capability the maFile doesn't
 * back — for vault-resident and disk-resident accounts alike.
 */
export function canConfirm(input: CanConfirmInput): boolean {
  if (input.identitySecret === 'present') return true;
  if (input.identitySecret === 'absent') return false;
  return input.tier !== 'limited';
}

export type TokenAuthFailureAction = 'delete-and-retry' | 'preserve-and-fail';

/**
 * What to do when a stored-refresh-token login fails with an 'auth' verdict:
 *   • a credential fallback exists — a maFile (for TOTP; shared_secret is guaranteed
 *     by both load paths) and a password — → delete the bad token and retry via
 *     credentials.
 *   • no usable credential fallback (no maFile, OR a password-less account — e.g. a
 *     QR-imported account whose only maFile was attached without a password) → the
 *     refresh token is the SOLE credential; PRESERVE it and fail this round (a
 *     misclassified/transient 'auth' must not permanently destroy the only way in).
 *     The operator re-imports via QR/credentials.
 */
export function onTokenAuthFailure(fallback: { hasMaFile: boolean; hasPassword: boolean }): TokenAuthFailureAction {
  return fallback.hasMaFile && fallback.hasPassword ? 'delete-and-retry' : 'preserve-and-fail';
}
