// ════════════════════════════════════════════════════════════════════════════
// one network-error taxonomy for the retry classifiers.
//
//  Refresh, mass-sell, and the money-commit ambiguity check each grew their own
//  prose regex for "is this network error transient?". They drifted token-by-token
//  (EPIPE/ECONNABORTED/"no response" matched only the commit copy; `eresult 3` only
//  the sell copy), so the same proxy-RST/broken-pipe failure was retried on one path
//  and hard-failed on another. This is the single token table all three now read.
//
//  Three orthogonal verdicts, from one `message`+`code` string:
//   • transient       — a network/proxy/5xx blip; safe to retry the read.
//   • rateLimited      — a 429 / "too many" window; retry with a LONG pause.
//   • ambiguousCommit  — transient and the request may have LANDED (response leg
//                        lost). Excludes the "never reached Steam" pre-connection
//                        failures (a retry there is safe, not ambiguous) — see
//                        NEVER_LANDED below. Numeric-`eresult` handling stays with
//                        the commit classifier (Steam answered → not message-level
//                        ambiguous); this function only classifies the string.
//
//  Pure + side-effect-free. Callers keep their own ACTION mapping (pause lengths,
//  deferred-vs-failed, keep-journal) unchanged — only the boolean is centralized.
// ════════════════════════════════════════════════════════════════════════════

// Union of the three subsystems' transient tokens, kept where retry is safe.
const TRANSIENT =
  /econnreset|etimedout|esockettimedout|econnaborted|epipe|socket hang ?up|timed?\s*out|timeout|econnrefused|enetunreach|ehostunreach|network|noconnection|no response|\baborted\b|tunnel|proxy|eresult 3|http( error)? 5\d\d\b|error 50\d|bad gateway|gateway time-?out|service unavailable|temporarily/i;

// H-INV-001-anchored: a bare word-boundary 429 (not e.g. "1429"), plus the prose forms.
const RATE_LIMITED = /\b429\b|too many|rate.?limit/i;

// "Never reached Steam" — a pre-connection / DNS failure. The request could not have
// created an order/offer, so a commit that fails on one of these is safe to retry, not
// ambiguous. This is stated policy (an explicit exclusion), not an accident of which
// tokens a given regex happened to omit.
const NEVER_LANDED = /econnrefused|enetunreach|ehostunreach|enotfound|\bdns\b/i;

export interface NetworkErrorClass {
  /** A network/proxy/5xx blip — the read is safe to retry. */
  transient: boolean;
  /** A 429 / "too many" rate-limit window — retry with a long pause. */
  rateLimited: boolean;
  /** transient and the request may already have landed (response leg lost). */
  ambiguousCommit: boolean;
}

/** Classify a Steam/network error from its `message` + `code`. Pure. */
export function classifyNetworkError(err: unknown): NetworkErrorClass {
  const e = err as { message?: string; code?: string } | null | undefined;
  const s = e && typeof e === 'object' ? `${e.code ?? ''} ${e.message ?? ''}` : '';
  const rateLimited = RATE_LIMITED.test(s);
  const transient = TRANSIENT.test(s) || rateLimited;
  const ambiguousCommit = transient && !NEVER_LANDED.test(s);
  return { transient, rateLimited, ambiguousCommit };
}
