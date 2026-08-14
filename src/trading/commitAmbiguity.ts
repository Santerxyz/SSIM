// ════════════════════════════════════════════════════════════════════════════
// Was a money-commit failure TRANSPORT-AMBIGUOUS?
//
//  i.e. the request may have reached Steam and PLACED the buy order / SENT the
//  trade offer, but the RESPONSE was lost — vs. a definite rejection or a
//  pre-commit failure. An ambiguous failure must not consume the MoneyOpJournal
//  entry: leaving it makes a retry hit the refuse-once gate instead of firing a
//  second real order/offer (a double-spend).
//
//  Bias: when unsure, treat as ambiguous. A false "check Steam, then retry" is
//  cheap friction; a false "safe to retry" double-spends real money.
//
//  Signals:
//   • createBuyOrder marks the response-leg-lost case with `verifyBeforeRetry`
//     (its resting-order probe couldn't confirm through the same broken proxy).
//   • trade sends have no such flag → match the transport signal on message/code.
//   • a definite Steam rejection carries a numeric `eresult` → not ambiguous,
//     EXCEPT the ambiguous-by-definition codes (16 Timeout).
//
//  Pure + side-effect-free; the DO-NOT-TOUCH createBuyOrder finalize re-POST is
//  never involved (this only reads the error it already throws).
//
// The transport-string verdict comes from the shared taxonomy; the
//  verifyBeforeRetry / numeric-eresult semantics stay here.
// ════════════════════════════════════════════════════════════════════════════

import { classifyNetworkError } from '../utils/errorClass';

const AMBIGUOUS_ERESULTS = new Set([16]); // EResult.Timeout — Steam's trade backend timed out; the offer may have been created anyway

export function isAmbiguousCommitFailure(err: unknown): boolean {
  const e = err as { verifyBeforeRetry?: boolean; eresult?: number; message?: string; code?: string } | null | undefined;
  if (!e || typeof e !== 'object') return false;
  if (e.verifyBeforeRetry === true) return true;             // explicit "the order may already exist"
  if (typeof e.eresult === 'number') return AMBIGUOUS_ERESULTS.has(e.eresult); // Steam answered → the op did not land, except the ambiguous-by-definition codes
  return classifyNetworkError(e).ambiguousCommit;
}
