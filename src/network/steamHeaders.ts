// ════════════════════════════════════════════════════════════════════════════
//  steamHeaders — one browser fingerprint for EVERY Steam community request.
//
//  ROOT CAUSE (2026-07-10, corrected): the wave of HTTP 429s across the community
//  endpoints (market/priceoverview, inventory, market/mylistings, mobileconf) was
//  Steam's newly-deployed bot-detection rejecting requests that DON'T look like a
//  real browser — requests carrying only a User-Agent + Accept were flagged. It was
//  NOT (primarily) a per-IP volume budget. The fix is to make every request carry a
//  full Chromium fingerprint: the sec-ch-ua Client Hints (the single strongest "I am
//  a real Chrome" signal — non-browser HTTP clients never send them), the Sec-Fetch
//  metadata, Accept-Language, and a browser-grade Accept-Encoding.
//
//  SSIM reaches Steam two ways, so the fingerprint is applied at BOTH:
//   1. Direct axios calls (priceoverview, inventory, mylistings, sellitem,
//      createbuyorder, …) — spread STEAM_XHR_HEADERS into the request headers.
//   2. The vendored `steamcommunity` library (mobileconf/confirmations, profile) —
//      default STEAM_LIBRARY_HEADERS onto its injected `request` instance and pass
//      STEAM_BROWSER_UA as the constructor's userAgent (see AccountTrader).
//
//  Every SSIM community request is an XHR/fetch issued (in a real browser) by the
//  market/community page's own JS to its OWN origin. So the Sec-Fetch values below
//  are the XHR set (dest:empty, mode:cors, site:same-origin) — NOT a navigation set
//  (dest:document, Sec-Fetch-User, Upgrade-Insecure-Requests), which a real browser
//  never sends on these endpoints and which would itself read as inconsistent.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Canonical Chrome-on-Windows User-Agent. SINGLE SOURCE so the UA and the sec-ch-ua
 * Client Hints below always agree on the browser + major version — a UA/hint mismatch
 * is itself a bot tell. Bump the version here and in CLIENT_HINTS together.
 */
export const STEAM_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Chromium Client Hints for STEAM_BROWSER_UA (Chrome 124). Present ⟹ a real Chromium
 *  browser; this is the header set Steam's 2026-07 check keys on. Lowercase names match
 *  what Chrome emits on the wire. */
const CLIENT_HINTS: Record<string, string> = {
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

/** Fetch-metadata for a same-origin XHR/fetch (what every SSIM community call emulates). */
const FETCH_METADATA: Record<string, string> = {
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

/**
 * Browser-grade Accept-Encoding for the AXIOS paths only. axios (Node) transparently
 * decodes gzip, deflate AND brotli, so advertising `br` is safe and drops the
 * non-browser `compress` token axios would otherwise send by default. Real Chrome also
 * offers `zstd`, which axios cannot decode — so we stop at `br`.
 *
 * NOT exported for the vendored `request` library: it has no brotli decoder, so telling
 * Steam it may send brotli there would yield an undecodable (garbled) body. The library
 * keeps its own `gzip, deflate` (which it CAN decode) — see STEAM_LIBRARY_HEADERS.
 */
export const STEAM_ACCEPT_ENCODING = 'gzip, deflate, br';

/**
 * The fingerprint bundle to spread into a DIRECT axios community request, e.g.
 *   headers: { ...STEAM_XHR_HEADERS, Cookie: …, 'User-Agent': STEAM_BROWSER_UA, Accept: … }
 * Spread it FIRST so the call's own Cookie / User-Agent / Accept / (any endpoint-specific)
 * Accept-Language win on collision — this bundle only contributes the browser-look headers
 * a bare HTTP client omits, and never overrides a caller's money-relevant value.
 */
export const STEAM_XHR_HEADERS: Record<string, string> = {
  ...CLIENT_HINTS,
  ...FETCH_METADATA,
  // A default locale; a caller that needs a specific one (e.g. the EUR pricer's de-DE) sets
  // its own after the spread and wins. Present so a call that sets none still looks human.
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': STEAM_ACCEPT_ENCODING,
};

/**
 * Header defaults for the vendored `steamcommunity` `request` instance (mobileconf,
 * confirmations, profile XML, eligibility). Deliberately a SUBSET of STEAM_XHR_HEADERS:
 *  • NO `Accept` — the library sets `Accept: application/json` per-call on its `json:true`
 *    mobileconf ops ONLY when no Accept already exists (request.prototype.json). A default
 *    Accept here would suppress that and change the money-critical confirmation path.
 *  • NO `Accept-Encoding` — the `request` library cannot decode brotli; it keeps its own
 *    `gzip, deflate`.
 *  • NO `User-Agent` — supplied via `new SteamCommunity({ userAgent: STEAM_BROWSER_UA })`
 *    so it stays the single source and can't drift from the Client Hints.
 * This mirrors the upstream fix (which added the Client Hints to the community lib and only
 * Accept-Language to the confirmations path) while staying safe for request's json handling.
 */
export const STEAM_LIBRARY_HEADERS: Record<string, string> = {
  ...CLIENT_HINTS,
  ...FETCH_METADATA,
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * XHR fingerprint headers appropriate for a request that sends User-Agent `ua`.
 * The sec-ch-ua Client Hints are Chrome-version-specific and only coherent with STEAM_BROWSER_UA — so a
 * request that overrides the UA (e.g. a per-account Firefox / older-Chrome / mobile UA) must NOT carry the
 * Chrome-124 hints: a UA/hint MISMATCH is itself a bot tell (the very thing this module exists to avoid).
 * For such a UA we drop ONLY the Client Hints and keep the UA-agnostic Sec-Fetch + Accept-Language/Encoding
 * (a real non-Chromium browser sends those and no sec-ch-ua at all). The canonical UA gets the full bundle.
 */
export function steamXhrHeadersFor(ua: string): Record<string, string> {
  if (ua === STEAM_BROWSER_UA) return STEAM_XHR_HEADERS;
  return { ...FETCH_METADATA, 'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': STEAM_ACCEPT_ENCODING };
}
