// ════════════════════════════════════════════════════════════════════════════
//  currencies.ts – Steam wallet currency table (ECurrencyCode → ISO/decimals).
//
//  Every Steam account has a NATIVE wallet currency (the `currency` number from
//  the steam-user 'wallet' event). Prices, balances and market buy/sell requests
//  must all be handled in THAT account's currency – never a global default.
//
//  `decimals` is the number of minor-unit digits the currency uses on Steam
//  (2 for €/$/£, 0 for ¥/₩/Rp/CLP/HUF/…). We store all money internally in MINOR
//  units (e.g. euro-cents) so integer math stays exact; `decimals` converts to
//  the major unit for display and back for parsing Steam's localized price texts.
// ════════════════════════════════════════════════════════════════════════════

export interface CurrencyInfo {
  /** Steam ECurrencyCode. */
  code: number;
  /** ISO 4217 code (for Intl.NumberFormat in the browser). */
  iso: string;
  /** Minor-unit digit count Steam uses for this currency. */
  decimals: number;
}

/** Steam ECurrencyCode → ISO + minor-unit decimals. */
export const STEAM_CURRENCIES: Record<number, CurrencyInfo> = {
  1:  { code: 1,  iso: 'USD', decimals: 2 },
  2:  { code: 2,  iso: 'GBP', decimals: 2 },
  3:  { code: 3,  iso: 'EUR', decimals: 2 },
  4:  { code: 4,  iso: 'CHF', decimals: 2 },
  5:  { code: 5,  iso: 'RUB', decimals: 2 },
  6:  { code: 6,  iso: 'PLN', decimals: 2 },
  7:  { code: 7,  iso: 'BRL', decimals: 2 },
  8:  { code: 8,  iso: 'JPY', decimals: 0 },
  9:  { code: 9,  iso: 'NOK', decimals: 2 },
  10: { code: 10, iso: 'IDR', decimals: 0 },
  11: { code: 11, iso: 'MYR', decimals: 2 },
  12: { code: 12, iso: 'PHP', decimals: 2 },
  13: { code: 13, iso: 'SGD', decimals: 2 },
  14: { code: 14, iso: 'THB', decimals: 2 },
  15: { code: 15, iso: 'VND', decimals: 0 },
  16: { code: 16, iso: 'KRW', decimals: 0 },
  17: { code: 17, iso: 'TRY', decimals: 2 },
  18: { code: 18, iso: 'UAH', decimals: 2 },
  19: { code: 19, iso: 'MXN', decimals: 2 },
  20: { code: 20, iso: 'CAD', decimals: 2 },
  21: { code: 21, iso: 'AUD', decimals: 2 },
  22: { code: 22, iso: 'NZD', decimals: 2 },
  23: { code: 23, iso: 'CNY', decimals: 2 },
  24: { code: 24, iso: 'INR', decimals: 2 },
  25: { code: 25, iso: 'CLP', decimals: 0 },
  26: { code: 26, iso: 'PEN', decimals: 2 },
  27: { code: 27, iso: 'COP', decimals: 2 },
  28: { code: 28, iso: 'ZAR', decimals: 2 },
  29: { code: 29, iso: 'HKD', decimals: 2 },
  30: { code: 30, iso: 'TWD', decimals: 2 },
  31: { code: 31, iso: 'SAR', decimals: 2 },
  32: { code: 32, iso: 'AED', decimals: 2 },
  33: { code: 33, iso: 'SEK', decimals: 2 },
  34: { code: 34, iso: 'ARS', decimals: 2 },
  35: { code: 35, iso: 'ILS', decimals: 2 },
  37: { code: 37, iso: 'KZT', decimals: 2 },
  38: { code: 38, iso: 'KWD', decimals: 2 },
  39: { code: 39, iso: 'QAR', decimals: 2 },
  40: { code: 40, iso: 'CRC', decimals: 2 },
  41: { code: 41, iso: 'UYU', decimals: 2 },
  42: { code: 42, iso: 'BGN', decimals: 2 },
  43: { code: 43, iso: 'HRK', decimals: 2 },
  44: { code: 44, iso: 'CZK', decimals: 2 },
  45: { code: 45, iso: 'DKK', decimals: 2 },
  46: { code: 46, iso: 'HUF', decimals: 0 },
  47: { code: 47, iso: 'RON', decimals: 2 },
};

/** Currency info for a Steam code; an unknown/absent code falls back to the EUR record (code 3, 2 decimals) —
 *  the input code is discarded, not preserved. For DISPLAY only — a money path must
 *  use {@link knownCurrencyInfo} instead (see S64). */
export function currencyInfo(code: number | undefined): CurrencyInfo {
  return (code != null && STEAM_CURRENCIES[code]) || { code: 3, iso: 'EUR', decimals: 2 };
}

/** Currency info for a KNOWN Steam code, or null when the code is unrecognised. MONEY paths MUST use this
 *  (never currencyInfo's 2-decimal fallback): an unknown code could be a 0-decimal currency, and assuming
 *  2 decimals would mis-scale a per-item price 100× — spending real money at the wrong amount. (S64.) */
export function knownCurrencyInfo(code: number | undefined): CurrencyInfo | null {
  return (code != null && STEAM_CURRENCIES[code]) || null;
}

/**
 * Parses one of Steam's localized money strings ("2,14€", "$1,234.56", "¥150",
 * "1.234,56 zł") into MINOR units for the given currency decimals. The fractional
 * part is the group after the LAST '.'/',' when that group is NOT a 3-digit
 * thousands group and is no longer than `decimals` — an under-padded fraction
 * ("1,5" → 150) is right-padded rather than mis-read as an integer 10×/100× too
 * large. All other separators are thousands groupings. A trailing group longer
 * than `decimals` (that is not 3-digit grouping) is ambiguous → null (fail closed,
 * S64). 0-decimal currencies are read as integers.
 *
 * The 3-digit-group carve-out assumes no currency has `decimals >= 3` (every entry
 * in STEAM_CURRENCIES is 0 or 2, and parseEurCents hardcodes 2); a 3-decimal
 * currency would need this branch revisited, since it would refuse a valid
 * 3-digit fraction.
 */
export function parseSteamMoney(s: unknown, decimals: number): number | null {
  if (typeof s !== 'string') return null;
  const cleaned = s.replace(/[^0-9.,]/g, '');
  if (!cleaned) return null;
  if (decimals === 0) {
    const n = parseInt(cleaned.replace(/[.,]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }
  const lastSep = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','));
  const tail = lastSep >= 0 ? cleaned.slice(lastSep + 1) : '';
  let intPart: string;
  let decPart: string;
  if (lastSep >= 0 && tail.length !== 3 && tail.length <= decimals) {
    // fractional separator (exact- or under-padded): "1,50" / "1,5" → dec 50/50
    intPart = cleaned.slice(0, lastSep).replace(/[.,]/g, '');
    decPart = tail.padEnd(decimals, '0');
  } else if (lastSep < 0 || tail.length === 3) {
    // no separator, or only 3-digit thousands groups → whole value is the integer
    intPart = cleaned.replace(/[.,]/g, '');
    decPart = '0'.repeat(decimals);
  } else {
    // trailing group longer than `decimals` (and not a 3-digit group) — ambiguous
    return null;
  }
  const minor = parseInt(intPart || '0', 10) * Math.pow(10, decimals) + parseInt(decPart || '0', 10);
  return Number.isFinite(minor) ? minor : null;
}
