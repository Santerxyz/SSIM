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
  /**
   * MINIMUM Steam fee per side (Steam's `wallet_fee_minimum`), in MINOR units of this
   * currency. Steam charges `max(percent · net, feeMinimum)` for both the Steam cut and
   * the publisher cut, so on a CHEAP item the floor — not the percentage — decides what
   * the buyer pays. It is 1 minor unit in the "expensive" currencies (EUR/USD/GBP…) but
   * LARGER where a minor unit is worth far less, and assuming 1 everywhere is exactly the
   * v1.4.6 mispricing: a PLN listing quoted at 0,42 gross went live at 0,46.
   *
   * Only values PROVEN against a real listing are recorded here. Everything else omits the
   * field and falls back to `DEFAULT_FEE_MINIMUM` (1) — the pre-1.4.7 assumption, so no
   * currency changes behaviour without evidence. `AccountTrader.getMarketOrders` compares
   * this model against the fee Steam reports on the account's own live listings and warns
   * when they disagree, so a wrong floor announces itself instead of silently mispricing.
   */
  feeMinimum?: number;
}

/** Fee floor assumed for a currency we have no proven value for (Steam's EUR/USD value). */
export const DEFAULT_FEE_MINIMUM = 1;

/** The per-side fee floor to use for `info`, in ITS minor units. */
export function feeMinimumOf(info: CurrencyInfo | undefined | null): number {
  const m = info?.feeMinimum;
  return Number.isFinite(m) && (m as number) >= 1 ? Math.floor(m as number) : DEFAULT_FEE_MINIMUM;
}

/** Steam ECurrencyCode → ISO + minor-unit decimals. */
export const STEAM_CURRENCIES: Record<number, CurrencyInfo> = {
  1:  { code: 1,  iso: 'USD', decimals: 2 },
  2:  { code: 2,  iso: 'GBP', decimals: 2 },
  3:  { code: 3,  iso: 'EUR', decimals: 2 },
  4:  { code: 4,  iso: 'CHF', decimals: 2 },
  5:  { code: 5,  iso: 'RUB', decimals: 2 },
  // PLN's floor is 4 grosz per side — PROVEN by a live listing (owner report, 2026-08-04):
  // a custom net of 0,38 zł went live as 0,46 zł buyer / 0,38 zł net, i.e. a total fee of
  // 0,08 zł. Both percentage components are below that (5%·38 = 1,9 · 10%·38 = 3,8), so both
  // sides were charged the floor: 4 + 4 = 8. With the old assumed floor of 1 the same listing
  // was previewed at 0,42 gross, and every 'lowest'/'undercut' PLN listing landed ABOVE the
  // price it was aiming at (so it did not undercut, and did not sell).
  6:  { code: 6,  iso: 'PLN', decimals: 2, feeMinimum: 4 },
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
 * use {@link knownCurrencyInfo} instead. */
export function currencyInfo(code: number | undefined): CurrencyInfo {
  return (code != null && STEAM_CURRENCIES[code]) || { code: 3, iso: 'EUR', decimals: 2 };
}

/** Currency info for a KNOWN Steam code, or null when the code is unrecognised. MONEY paths MUST use this
 *  (never currencyInfo's 2-decimal fallback): an unknown code could be a 0-decimal currency, and assuming
 * 2 decimals would mis-scale a per-item price 100× — spending real money at the wrong amount. */
export function knownCurrencyInfo(code: number | undefined): CurrencyInfo | null {
  return (code != null && STEAM_CURRENCIES[code]) || null;
}

/**
 * Parses one of Steam's localized money strings ("2,14€", "$1,234.56", "¥150",
 * "1.234,56 zł") into MINOR units for the given currency decimals. The fractional
 * part is the group after the LAST '.'/',' when that group is not a 3-digit
 * thousands group and is no longer than `decimals` — an under-padded fraction
 * ("1,5" → 150) is right-padded rather than mis-read as an integer 10×/100× too
 * large. All other separators are thousands groupings. A trailing group longer
 * than `decimals` (that is not 3-digit grouping) is ambiguous → null (fail closed,
 * S64). 0-decimal currencies are read as integers.
 *
 * The 3-digit-group carve-out assumes no currency has `decimals >= 3` (every entry
 * in STEAM_CURRENCIES is 0 or 2); a 3-decimal currency would need this branch
 * revisited, since it would refuse a valid 3-digit fraction.
 */
export function parseSteamMoney(s: unknown, decimals: number): number | null {
  if (typeof s !== 'string') return null;
  const cleaned = s.replace(/[^0-9.,]/g, '');
  if (!cleaned) return null;
  if (decimals === 0) {
    // Steam sometimes emits a FRACTION even for a 0-decimal currency — verified live
    // 2026-08-03: JPY (code 8) `median_price` came back as "¥ 6,709.04" while
    // `lowest_price` was the plain "¥ 6,685". Blindly stripping every separator reads
    // that as 670904 — 100× the real price (a 100× overbid on the buy path). So apply
    // the same last-separator test as the fractional branch below: a trailing group
    // that is not a 3-digit thousands group is a fraction, and is ROUNDED away.
    const sep = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','));
    const frac = sep >= 0 ? cleaned.slice(sep + 1) : '';
    if (frac.length > 0 && frac.length !== 3) {
      const whole = parseInt(cleaned.slice(0, sep).replace(/[.,]/g, '') || '0', 10);
      const f = parseInt(frac, 10);
      if (!Number.isFinite(whole) || !Number.isFinite(f)) return null;
      return whole + (f / Math.pow(10, frac.length) >= 0.5 ? 1 : 0);
    }
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

// ─── Currency-mismatch detection on Steam's localized price strings ───────────

/**
 * Symbols/abbreviations Steam puts in a localized price string, each mapped to every
 * Steam currency that can legitimately produce it. Deliberately INCOMPLETE: a currency
 * whose marker is absent (AED, SAR, QAR, KWD, ZAR, TRY-as-"TL", PEN…) simply produces
 * no verdict, which is the safe direction — this table may only ever REFUSE a response,
 * never approve one. Groups exist so a shared glyph ('$', '¥', 'kr') can't accuse a
 * sibling currency of being foreign.
 */
const PRICE_TEXT_MARKERS: ReadonlyArray<{ re: RegExp; isos: readonly string[] }> = [
  { re: /€/,                isos: ['EUR'] },
  { re: /£/,                isos: ['GBP'] },
  { re: /\$/,               isos: ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'TWD', 'MXN', 'ARS', 'CLP', 'COP', 'UYU', 'BRL', 'PEN'] },
  { re: /¥/,                isos: ['JPY', 'CNY'] },
  { re: /kr/i,              isos: ['NOK', 'SEK', 'DKK'] },
  { re: /zł/i,              isos: ['PLN'] },
  { re: /₽|руб|pуб/i,       isos: ['RUB'] },   // Steam serves "3334,32 pуб." — Latin p, Cyrillic уб
  { re: /₺/,                isos: ['TRY'] },
  { re: /₴|грн/i,           isos: ['UAH'] },
  { re: /₪/,                isos: ['ILS'] },
  { re: /₩/,                isos: ['KRW'] },
  { re: /₹/,                isos: ['INR'] },
  { re: /₫/,                isos: ['VND'] },
  { re: /฿/,                isos: ['THB'] },
  { re: /₱/,                isos: ['PHP'] },
  { re: /₸/,                isos: ['KZT'] },
  { re: /₡/,                isos: ['CRC'] },
  { re: /Kč/i,              isos: ['CZK'] },
  { re: /Ft/i,              isos: ['HUF'] },
  { re: /CHF/i,             isos: ['CHF'] },
  { re: /Rp/i,              isos: ['IDR'] },
  { re: /RM/i,              isos: ['MYR'] },
  { re: /лв/i,              isos: ['BGN'] },
  { re: /lei/i,             isos: ['RON'] },
  { re: /\bkn\b/i,          isos: ['HRK'] },
];

/**
 * MONEY SAFETY. Steam's priceoverview answers a `currency=<code>` request with a plain
 * LOCALIZED string ("157,03 zł") and never echoes the code, so a request that came back
 * in the WRONG currency is indistinguishable from a correct one by the number alone —
 * and parsing it against the currency we asked for would mis-price the listing by the
 * whole FX rate (a PLN wallet listing at EUR numbers is the ~99% underprice B11 guarded
 * against, only now silent).
 *
 * Returns the ISO of the currency the text is clearly denominated in when that
 * CONTRADICTS `expectedIso`, else null. It only ever speaks up on a POSITIVE match for
 * a different currency: an unrecognised (or symbol-less) string yields null and is
 * accepted, so this can add a refusal but never a false "looks fine".
 */
export function priceTextForeignCurrency(text: unknown, expectedIso: string): string | null {
  if (typeof text !== 'string' || !text) return null;
  const hits = PRICE_TEXT_MARKERS.filter((m) => m.re.test(text));
  if (hits.length === 0) return null;
  // Any marker that ACCEPTS the expected currency clears the string — a glyph shared with
  // a sibling ('$' for both USD and CAD) must never be read as a contradiction.
  if (hits.some((m) => m.isos.includes(expectedIso))) return null;
  return hits[0].isos.join('/');
}
