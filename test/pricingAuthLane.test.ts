import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SteamPriceSource } from '../src/pricing/sources/SteamPriceSource';
import { PricingService } from '../src/pricing/PricingService';
import { buildCookieHeader, pickPricerIdentities } from '../src/pricing/PricerIdentityPool';

// ─────────────────────────────────────────────────────────────────────────────
//  Identity-budgeted pricing (2026-07-10 root-cause fix): the Steam fill rides an
//  authenticated identity; a 429 retires the lane instead of stalling it; with no
//  identity the fill defers rather than issue an anonymous call.
// ─────────────────────────────────────────────────────────────────────────────

function installAxiosMock(responder: (url: string, cfg: any) => Promise<{ status: number; data: unknown }>): () => void {
  const ax = require('axios');
  const orig = ax.get;
  ax.get = responder;
  if (ax.default) ax.default.get = responder;
  return () => { ax.get = orig; if (ax.default) ax.default.get = orig; };
}

test('buildCookieHeader: requires a real steamLoginSecure, else null', () => {
  assert.equal(buildCookieHeader([]), null, 'empty → null');
  assert.equal(buildCookieHeader(['sessionid=abc', 'steamCountry=DE']), null, 'no steamLoginSecure → null');
  assert.equal(buildCookieHeader(['steamLoginSecure=']), null, 'empty steamLoginSecure value → null');
  assert.equal(
    buildCookieHeader(['sessionid=abc', 'steamLoginSecure=DEAD%7C123']),
    'sessionid=abc; steamLoginSecure=DEAD%7C123',
    'a real auth cookie → joined header',
  );
});

test('pickPricerIdentities: caps, de-dups by username, drops cookieless candidates', () => {
  const agent = {} as any;
  const ids = pickPricerIdentities([
    { username: 'A', cookies: ['steamLoginSecure=1'], agent },
    { username: 'a', cookies: ['steamLoginSecure=2'], agent },   // dup of A (case-insensitive)
    { username: 'B', cookies: ['sessionid=only'], agent },        // no auth cookie → dropped
    { username: 'C', cookies: ['steamLoginSecure=3'], agent },
    { username: 'D', cookies: ['steamLoginSecure=4'], agent },
  ], 2);
  assert.deepEqual(ids.map((i) => i.username), ['A', 'C'], 'de-duped, cookieless dropped, capped at 2');
});

test('SteamPriceSource: attaches the identity Cookie header when routed', async () => {
  const src = new SteamPriceSource();
  let seenCookie: string | undefined;
  const restore = installAxiosMock(async (_url, cfg) => {
    seenCookie = cfg?.headers?.Cookie;
    return { status: 200, data: { success: true, lowest_price: '$1.00' } };
  });
  try {
    await src.fetchPriceCents('AK-47 | Redline (Field-Tested)', 730, { cookieHeader: 'steamLoginSecure=abc; sessionid=x' });
    assert.equal(seenCookie, 'steamLoginSecure=abc; sessionid=x', 'the identity cookie must be sent');
    // And anonymous stays anonymous (no cookie) for the non-fill callers.
    await src.fetchPriceCents('AK-47 | Redline (Field-Tested)', 730);
    assert.equal(seenCookie, undefined, 'no route → no Cookie header');
  } finally { restore(); }
});

test('PricingService: DEFERS (does not fetch) when no identity is web-ready', async () => {
  let fetchCalls = 0;
  const svc = new PricingService(undefined, () => []); // provider yields no identities
  (svc as any).steamSource = { id: 'steam', fetchPriceCents: async () => { fetchCalls++; return 100; } };
  try {
    svc.ensureFilled([{ name: 'DeferMe', appid: 730 }]);
    await new Promise((r) => setTimeout(r, 150));
    const st = svc.status();
    assert.equal(fetchCalls, 0, 'no anonymous fetch may happen without an identity');
    assert.equal(st.processed, 0, 'nothing processed — the name stays queued for kick()');
    assert.equal(st.queued, 1, 'the name is still queued, awaiting an identity');
  } finally { svc.shutdown(); }
});

test('PricingService: kick() starts a deferred fill once an identity appears', async () => {
  let identities: any[] = [];
  let fetchCalls = 0;
  const svc = new PricingService(undefined, () => identities);
  (svc as any).steamSource = { id: 'steam', fetchPriceCents: async () => { fetchCalls++; return 100; } };
  try {
    svc.ensureFilled([{ name: 'LaterName', appid: 730 }]);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fetchCalls, 0, 'deferred while no identity');
    identities = [{ username: 'p', cookieHeader: 'steamLoginSecure=x', agent: undefined }];
    svc.kick();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(fetchCalls, 1, 'kick() drained the queued name once an identity was available');
  } finally { svc.shutdown(); }
});

test('PricingService: 2 consecutive 429s RETIRE the lane and soft-miss the rest (no grind)', async () => {
  const svc = new PricingService(undefined, () => [{ username: 'p', cookieHeader: 'steamLoginSecure=x', agent: undefined as any }]);
  let calls = 0;
  (svc as any).steamSource = { id: 'steam', fetchPriceCents: async () => { calls++; throw new Error('RATE_LIMIT'); } };
  try {
    svc.ensureFilled([
      { name: 'N1', appid: 730 }, { name: 'N2', appid: 730 }, { name: 'N3', appid: 730 }, { name: 'N4', appid: 730 },
    ]);
    // One lane, FETCH_DELAY 3.5s: request#1 (429) → 3.5s → request#2 (429) → retire. Give it ~4.2s for 2 calls.
    await new Promise((r) => setTimeout(r, 4200));
    assert.equal(calls, 2, 'the lane retired after 2 consecutive 429s — it did NOT grind through all 4 names');
    const st = svc.status();
    assert.equal(st.running, false, 'the fill ended (aborted), not stuck in a 60-80s loop');
    // Every name resolved (2 attempted + soft-missed, 2 abandoned + soft-missed) and de-queued.
    assert.equal(st.queued, 0, 'no name left queued — all cached as short soft-misses for a ~10min retry');
    assert.equal(st.processed, 4, 'all four names reached a terminal (soft-miss) outcome');
    assert.equal(svc.priceCents('N1', 730), null, 'a retried 429 name is a fresh soft-miss (served null briefly, re-tried in min)');
    assert.equal(svc.priceCents('N4', 730), null, 'an abandoned name is soft-missed too, not left to hammer');
  } finally { svc.shutdown(); }
});
