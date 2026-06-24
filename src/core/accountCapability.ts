// ════════════════════════════════════════════════════════════════════════════
//  accountCapability — pure policy for two account invariants:
//   • INV-A1 (C5): "can this account confirm trades?" has ONE real signal — the
//     maFile's identity_secret. `tier` is a label and must be a projection of it,
//     never an independent source of truth.
//   • INV-A2 (C8): a token-only (LIMITED, no maFile) account's refresh token is its
//     SOLE credential. Deleting it on an 'auth' verdict would strand the account, so
//     it is preserved and the account is surfaced as needing re-import.
//  Pure (no imports) so the policy is unit-testable in isolation.
// ════════════════════════════════════════════════════════════════════════════

export interface CanConfirmInput {
  /** Is the encrypted vault the active credential store? */
  vaultEnabled: boolean;
  /** In vault mode: does the vault's maFile for this account carry an identity_secret? */
  vaultMaFileHasIdentitySecret: boolean;
  /** Legacy/plaintext fallback: the stored tier label. */
  tier?: string;
}

/**
 * The single "can confirm trades / market listings" predicate. In vault mode the
 * vault maFile is authoritative (tier is irrelevant); otherwise we fall back to the
 * tier label. This is what the dashboard should display instead of raw `tier`, so
 * "Full" can never claim a capability the maFile doesn't back. (INV-A1 / C5.)
 */
export function canConfirm(input: CanConfirmInput): boolean {
  if (input.vaultEnabled) return input.vaultMaFileHasIdentitySecret;
  return input.tier !== 'limited';
}

export type TokenAuthFailureAction = 'delete-and-retry' | 'preserve-and-fail';

/**
 * What to do when a stored-refresh-token login fails with an 'auth' verdict:
 *   • the account has a maFile (credential fallback) → delete the bad token and retry
 *     via credentials.
 *   • no maFile (token-only LIMITED account) → the token is the SOLE credential;
 *     PRESERVE it and fail this round (a misclassified/transient 'auth' must not
 *     permanently destroy the only way in). The operator re-imports via QR/credentials.
 * (INV-A2 / C8.)
 */
export function onTokenAuthFailure(hasMaFileFallback: boolean): TokenAuthFailureAction {
  return hasMaFileFallback ? 'delete-and-retry' : 'preserve-and-fail';
}
