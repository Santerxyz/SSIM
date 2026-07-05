// ════════════════════════════════════════════════════════════════════════════
//  S3 — was a money-commit failure TRANSPORT-AMBIGUOUS?
//
//  i.e. the request may have reached Steam and PLACED the buy order / SENT the
//  trade offer, but the RESPONSE was lost — vs. a definite rejection or a
//  pre-commit failure. An ambiguous failure must NOT consume the MoneyOpJournal
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
//   • a definite Steam rejection carries a numeric `eresult` → NOT ambiguous
//     (Steam answered, so the op did not land).
//
//  Pure + side-effect-free; the DO-NOT-TOUCH createBuyOrder finalize re-POST is
//  never involved (this only reads the error it already throws).
// ════════════════════════════════════════════════════════════════════════════

const TRANSPORT_AMBIGUOUS =
  /econnreset|etimedout|esockettimedout|socket hang ?up|timed?\s*out|timeout|econnaborted|epipe|\baborted\b|no response|http (error )?5\d\d\b/i;

export function isAmbiguousCommitFailure(err: unknown): boolean {
  const e = err as { verifyBeforeRetry?: boolean; eresult?: number; message?: string; code?: string } | null | undefined;
  if (!e || typeof e !== 'object') return false;
  if (e.verifyBeforeRetry === true) return true;             // explicit "the order may already exist"
  if (typeof e.eresult === 'number') return false;           // Steam rejected it → the op did not land
  return TRANSPORT_AMBIGUOUS.test(`${e.code ?? ''} ${e.message ?? ''}`);
}
