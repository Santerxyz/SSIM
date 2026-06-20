// ─── Steam trade-offer error parsing (NO secondary fetches) ──────────────────
//
// When a trade offer send fails, steam-tradeoffer-manager hands us an Error whose
// `.message` is Steam's own `strError` text. Its helper also parses out:
//   • `.eresult` – the numeric EResult code embedded as "(NN)" at the end of strError,
//   • `.cause`   – a handful of recognised causes ('TradeBan', 'NewDevice',
//                  'TargetCannotTrade', 'OfferLimitExceeded', 'ItemServerUnavailable').
//
// We read ONLY what Steam already gave us and bubble a clean, human-readable reason
// up to the UI. We deliberately do NOT fire any follow-up request (e.g. fetching the
// receiver's inventory to "confirm" it is full) — the error text is the source of truth.

/** Human-readable names for the EResult codes we are likely to surface on a trade. */
const ERESULT_NAMES: Record<number, string> = {
  2: 'Fail',
  3: 'No Connection',
  5: 'Invalid Password',
  6: 'Logged In Elsewhere',
  8: 'Invalid Parameter',
  10: 'Busy',
  11: 'Invalid State',
  15: 'Access Denied',
  16: 'Timeout',
  17: 'Banned',
  18: 'Account Not Found',
  20: 'Service Unavailable',
  21: 'Not Logged On',
  24: 'Insufficient Privilege',
  25: 'Limit Exceeded',
  26: 'Revoked',
  27: 'Expired',
  28: 'Already Redeemed',
  29: 'Duplicate Request',
  30: 'Already Owned',
  40: 'Blocked',
  41: 'Ignored',
  42: 'No Match',
  50: 'Already Logged In Elsewhere',
  84: 'Rate Limit Exceeded',
};

/** Friendly explanations for the specific causes the trade-offer lib recognises. */
const CAUSE_MESSAGES: Record<string, string> = {
  TradeBan:              'This account has a trade ban and cannot trade.',
  NewDevice:             'Steam Guard: a new-device login was detected — trading is locked for a few days.',
  TargetCannotTrade:     'The recipient is not available to trade right now.',
  OfferLimitExceeded:    'This account has sent too many trade offers — wait a while and try again.',
  ItemServerUnavailable: "Steam's item server is temporarily unavailable — try again later.",
};

/** Steam wording (English + common localisations) for a full RECEIVER inventory. */
const INVENTORY_FULL_RE =
  /inventory (is |may be )?full|full inventory|not enough (room|space)|don'?t have (enough )?(room|space)|no (more )?(free )?(room|space|slots?)|inventar (ist )?voll|kein(en)? (platz|speicherplatz)/i;

export interface ParsedSteamTradeError {
  /** Clean, human-readable reason suitable for showing to the operator. */
  message: string;
  /** Steam EResult code, when one was embedded in the error. */
  eresult?: number;
  /** Recognised cause string from the trade-offer lib, when present. */
  cause?: string;
  /** True when Steam's own text says the recipient's inventory is full. */
  inventoryFull: boolean;
}

/**
 * Parses a raw trade-send error into a clean reason WITHOUT any follow-up request.
 * Priority: full-inventory text → recognised cause → EResult code → raw Steam text.
 */
export function parseSteamTradeError(err: unknown): ParsedSteamTradeError {
  const e = err as { message?: unknown; eresult?: unknown; cause?: unknown } | null | undefined;
  const raw = typeof e?.message === 'string' && e.message.trim() ? e.message.trim() : '';
  const eresult = typeof e?.eresult === 'number' && Number.isFinite(e.eresult) ? e.eresult : undefined;
  const cause = typeof e?.cause === 'string' ? e.cause : undefined;

  // 1) Receiver's inventory is full — the most actionable, surface it explicitly.
  if (raw && INVENTORY_FULL_RE.test(raw)) {
    return {
      message: "The recipient's inventory is full — there is no free space for these items.",
      eresult, cause, inventoryFull: true,
    };
  }

  // 2) A recognised cause has a clearer explanation than the generic Steam text.
  if (cause && CAUSE_MESSAGES[cause]) {
    const tail = eresult != null ? ` (Steam Error ${eresult})` : '';
    return { message: `${CAUSE_MESSAGES[cause]}${tail}`, eresult, cause, inventoryFull: false };
  }

  // 3) Known EResult code → "Steam Error 15: Access Denied".
  if (eresult != null) {
    const name = ERESULT_NAMES[eresult];
    return {
      message: name ? `Steam Error ${eresult}: ${name}` : `Steam Error ${eresult}${raw ? ` – ${raw}` : ''}`,
      eresult, cause, inventoryFull: false,
    };
  }

  // 4) No code/cause — pass Steam's exact text through (or a generic fallback).
  return { message: raw || 'Unknown trade error', eresult, cause, inventoryFull: false };
}

/** Convenience: the clean reason string only. */
export function describeSteamTradeError(err: unknown): string {
  return parseSteamTradeError(err).message;
}
