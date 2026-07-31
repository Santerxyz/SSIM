import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STEAM_BROWSER_UA, STEAM_XHR_HEADERS, STEAM_LIBRARY_HEADERS, STEAM_ACCEPT_ENCODING, steamXhrHeadersFor,
} from '../src/network/steamHeaders';
import { SteamPriceSource } from '../src/pricing/sources/SteamPriceSource';
import { MarketPricing } from '../src/pricing/MarketPricing';

// ─────────────────────────────────────────────────────────────────────────────
//  Browser-fingerprint headers (2026-07-10 root-cause fix): Steam's bot-detection
//  429s requests that don't look like a real Chrome. Every community request must
//  carry the sec-ch-ua Client Hints + Sec-Fetch metadata. Two bundles:
//   • STEAM_XHR_HEADERS — spread into DIRECT axios calls (may advertise brotli).
//   • STEAM_LIBRARY_HEADERS — for the vendored `request` lib (NO Accept: it would
//     suppress the lib's per-call application/json on json:true mobileconf ops;
//     NO Accept-Encoding: `request` can't decode brotli).
// ─────────────────────────────────────────────────────────────────────────────

function installAxiosMock(responder: (url: string, cfg: any) => Promise<{ status: number; data: unknown }>): () => void {
  const ax = require('axios');
  const orig = ax.get;
  ax.get = responder;
  if (ax.default) ax.default.get = responder;
  return () => { ax.get = orig; if (ax.default) ax.default.get = orig; };
}

/** Case-insensitive header lookup (Node/axios preserve provided case; tests must not care). */
function h(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

test('UA and sec-ch-ua agree on the Chrome major version (an inconsistent pair is itself a bot tell)', () => {
  const uaMajor = /Chrome\/(\d+)\./.exec(STEAM_BROWSER_UA)?.[1];
  assert.ok(uaMajor, 'UA carries a Chrome major version');
  const hint = h(STEAM_XHR_HEADERS, 'sec-ch-ua')!;
  assert.match(hint, /Google Chrome";v="(\d+)"/, 'sec-ch-ua names Google Chrome with a version');
  const hintMajor = /Google Chrome";v="(\d+)"/.exec(hint)?.[1];
  assert.equal(hintMajor, uaMajor, 'the Client-Hint Chrome version matches the User-Agent');
});

test('STEAM_XHR_HEADERS carries the full Chromium fingerprint (Client Hints + Sec-Fetch + browser Accept-Encoding)', () => {
  assert.ok(h(STEAM_XHR_HEADERS, 'sec-ch-ua'), 'sec-ch-ua present');
  assert.equal(h(STEAM_XHR_HEADERS, 'sec-ch-ua-mobile'), '?0');
  assert.equal(h(STEAM_XHR_HEADERS, 'sec-ch-ua-platform'), '"Windows"');
  assert.equal(h(STEAM_XHR_HEADERS, 'sec-fetch-dest'), 'empty');
  assert.equal(h(STEAM_XHR_HEADERS, 'sec-fetch-mode'), 'cors');
  assert.equal(h(STEAM_XHR_HEADERS, 'sec-fetch-site'), 'same-origin');
  assert.equal(h(STEAM_XHR_HEADERS, 'accept-encoding'), STEAM_ACCEPT_ENCODING);
  assert.match(STEAM_ACCEPT_ENCODING, /\bbr\b/, 'axios path advertises brotli (axios can decode it)');
  // Must NOT pin Cookie/User-Agent/Accept — those are the caller's money-relevant values.
  assert.equal(h(STEAM_XHR_HEADERS, 'cookie'), undefined, 'the bundle never carries a Cookie');
  assert.equal(h(STEAM_XHR_HEADERS, 'user-agent'), undefined, 'UA is set explicitly by each call');
});

test('STEAM_LIBRARY_HEADERS omits Accept + Accept-Encoding (request lib json/brotli safety) but keeps the fingerprint', () => {
  assert.ok(h(STEAM_LIBRARY_HEADERS, 'sec-ch-ua'), 'client hints present on the library path');
  assert.ok(h(STEAM_LIBRARY_HEADERS, 'sec-fetch-mode'), 'sec-fetch present on the library path');
  assert.ok(h(STEAM_LIBRARY_HEADERS, 'accept-language'), 'accept-language present (the friend\'s confirmations.js change)');
  assert.equal(h(STEAM_LIBRARY_HEADERS, 'accept'), undefined,
    'NO Accept — else request.prototype.json would not set application/json on mobileconf ops');
  assert.equal(h(STEAM_LIBRARY_HEADERS, 'accept-encoding'), undefined,
    'NO Accept-Encoding — the request lib has no brotli decoder');
  assert.equal(h(STEAM_LIBRARY_HEADERS, 'user-agent'), undefined,
    'UA comes from the SteamCommunity constructor userAgent option (single source)');
});

test('SteamPriceSource sends the Client Hints + browser UA on the wire', async () => {
  const src = new SteamPriceSource();
  let seen: Record<string, string> = {};
  const restore = installAxiosMock(async (_url, cfg) => {
    seen = cfg?.headers ?? {};
    return { status: 200, data: { success: true, lowest_price: '$1.00' } };
  });
  try {
    await src.fetchPriceCents('AK-47 | Redline (Field-Tested)', 730);
    assert.ok(h(seen, 'sec-ch-ua'), 'priceoverview request carries sec-ch-ua');
    assert.equal(h(seen, 'sec-fetch-site'), 'same-origin');
    assert.equal(h(seen, 'user-agent'), STEAM_BROWSER_UA, 'the canonical browser UA is sent');
    assert.equal(h(seen, 'accept'), 'application/json', 'the JSON Accept is preserved (wins over the bundle)');
  } finally { restore(); }
});

test('SteamPriceSource sets proxy:false on BOTH the routed and the anonymous-fallback call (review Defect B)', async () => {
  const src = new SteamPriceSource();
  let seenCfg: any = {};
  const restore = installAxiosMock(async (_url, cfg) => {
    seenCfg = cfg ?? {};
    return { status: 200, data: { success: true, lowest_price: '$1.00' } };
  });
  try {
    // Anonymous fallback (no route): must still pin proxy:false so an ambient HTTP(S)_PROXY env var can't
    // silently re-route the call through the shared pool (it must egress the host IP, per the P1 design).
    await src.fetchPriceCents('AK-47 | Redline (Field-Tested)', 730);
    assert.equal(seenCfg.proxy, false, 'anonymous fallback disables env-proxy routing (proxy:false)');
    assert.equal(seenCfg.httpsAgent, undefined, 'anonymous fallback binds no agent → host IP');
    // Routed (authenticated) call: proxy:false AND the account agent.
    const agent = { marker: 'agent' } as any;
    await src.fetchPriceCents('AK-47 | Redline (Field-Tested)', 730, { agent, cookieHeader: 'steamLoginSecure=x' });
    assert.equal(seenCfg.proxy, false, 'routed call also disables env-proxy routing');
    assert.equal(seenCfg.httpsAgent, agent, 'routed call binds the account agent');
  } finally { restore(); }
});

test('steamXhrHeadersFor: drops the Chrome Client Hints for a non-canonical UA, keeps the UA-agnostic set (review Defect C)', () => {
  // Canonical UA → the full bundle (with hints).
  assert.equal(steamXhrHeadersFor(STEAM_BROWSER_UA), STEAM_XHR_HEADERS, 'canonical UA gets the full bundle incl. hints');
  // A custom/older/non-Chrome UA → NO sec-ch-ua (a UA/hint mismatch is itself a bot tell), but the
  // UA-agnostic Sec-Fetch + Accept-Language/Encoding are kept.
  const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0';
  const hdrs = steamXhrHeadersFor(firefox);
  assert.equal(h(hdrs, 'sec-ch-ua'), undefined, 'no sec-ch-ua for a non-Chrome UA');
  assert.equal(h(hdrs, 'sec-ch-ua-mobile'), undefined, 'no sec-ch-ua-mobile for a non-Chrome UA');
  assert.equal(h(hdrs, 'sec-ch-ua-platform'), undefined, 'no sec-ch-ua-platform for a non-Chrome UA');
  assert.equal(h(hdrs, 'sec-fetch-mode'), 'cors', 'UA-agnostic Sec-Fetch kept');
  assert.ok(h(hdrs, 'accept-language'), 'Accept-Language kept');
  assert.equal(h(hdrs, 'accept-encoding'), STEAM_ACCEPT_ENCODING, 'Accept-Encoding kept');
});

test('MarketPricing keeps its EUR-locale Accept-Language while adding the fingerprint (money-path parse unchanged)', async () => {
  const market = new MarketPricing();
  let seen: Record<string, string> = {};
  const restore = installAxiosMock(async (_url, cfg) => {
    seen = cfg?.headers ?? {};
    return { status: 200, data: { success: true, lowest_price: '1,23€', median_price: '1,20€', volume: '5' } };
  });
  try {
    const info = await market.getSellInfo('AWP | Asiimov (Field-Tested)');
    assert.equal(info.lowestCents, 123, 'EUR "1,23€" parsed as 123 cents — comma-decimal locale parsing intact');
    assert.ok(h(seen, 'sec-ch-ua'), 'the sell-price read carries the fingerprint');
    assert.equal(h(seen, 'accept-language'), 'de-DE,de;q=0.9',
      'the de-DE locale is preserved (Steam formats EUR by locale) — NOT overwritten by the bundle default');
  } finally { restore(); }
});
