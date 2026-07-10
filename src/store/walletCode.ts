// ── W3_31 — Steam wallet-code helpers (bearer-secret handling) ──────────────────
// A wallet code is a BEARER secret: hash-only at rest, mask in every response, never log
// the raw value. These pure helpers give the journal its key and the UI its masked form.
import crypto from 'crypto';

/** Steam wallet codes are XXXXX-XXXXX-XXXXX; strip dashes/space/case so paste variants hash identically. */
export function normalizeCode(s: string): string {
  return String(s ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}
/** sha256 of the normalized code — the WalletRedeemJournal key (globally single-use: keyed on code alone). */
export function codeHash(s: string): string {
  return crypto.createHash('sha256').update(normalizeCode(s)).digest('hex');
}
/** Masked form for logs/responses — NEVER the full code (last 4 of the normalized code only). */
export function codeMasked(s: string): string {
  const last4 = normalizeCode(s).slice(-4);
  return last4 ? `•••••-•••••-•${last4}` : '•••••';
}

export interface RedeemResult { success: boolean; detail: string; ambiguous: boolean }

/** Classify Steam's /account/ajaxredeemwalletcode/ JSON. success===1 (EResult.OK) is the ONLY definite
 *  success; a numeric non-1 success is a DEFINITE reject; anything undecodable is AMBIGUOUS (fail-closed —
 *  never guess a credit happened). Never parses the formatted balance string (fragile per-currency) — the
 *  caller re-reads the wallet after a success instead. */
export function parseRedeemResult(obj: Record<string, unknown>): RedeemResult {
  const success = typeof obj.success === 'number' ? obj.success : NaN;
  if (!Number.isFinite(success)) return { success: false, detail: 'undecodable response', ambiguous: true };
  if (success === 1) return { success: true, detail: 'ok', ambiguous: false };
  const d = obj.detail;
  const detail = (typeof d === 'number' || typeof d === 'string') ? `purchase-result ${d}` : `EResult ${success}`;
  return { success: false, detail, ambiguous: false };
}
