import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { AccountTrader } from '../src/trading/AccountTrader';

// ════════════════════════════════════════════════════════════════════════════════════════════════
//  probeMarketAccess asks STEAM why an account cannot buy, instead of inferring it. Its first cut
//  could not actually perform that read:
//
//   · Steam gates /market/ behind a redirect to /market/eligibilitycheck/, which SETS the
//     webTradeEligibility cookie and bounces back. axios keeps no cookie jar, so an auto-followed
//     redirect never returns the cookie, Steam bounces again, and the probe died as "Maximum number
//     of redirects exceeded" — observed live on a HEALTHY account (lilycepeda93, 2026-08-21).
//   · Even had it landed, it read set-cookie off the FINAL response, while Steam sets the cookie on
//     an INTERMEDIATE hop. It could never have seen the one signal it exists to capture.
//
//  So the chain is walked by hand with an accumulating jar. The same page also carries
//  g_rgWalletInfo — Steam's OWN balance, in minor units. SSIM's balance comes solely from the CM
//  'wallet' event captured at login, so it is only ever as fresh as that event; a resting buy order
//  that draws no funds is only evidence if the balance it drew against was independently read.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const WALLET_JSON = '{"wallet_currency":3,"wallet_country":"DE","wallet_fee":"1",'
  + '"wallet_balance":"302","wallet_delayed_balance":"0","wallet_max_balance":"45000"}';

function marketPage(opts: { allowed?: boolean; wallet?: string | null } = {}): string {
  const { allowed = true, wallet = WALLET_JSON } = opts;
  return `<html><head><script>
    var g_bMarketAllowed = ${allowed ? 'true' : 'false'};
    ${wallet ? `var g_rgWalletInfo = ${wallet};` : ''}
  </script></head><body>market</body></html>`;
}

function fakeTrader(): AccountTrader {
  const t = Object.create(AccountTrader.prototype) as AccountTrader;
  Object.assign(t, {
    username: 'donaldjohnston02',
    session: { webSession: { cookies: ['sessionid=abc', 'steamLoginSecure=xyz'] }, httpsAgent: {} },
  });
  return t;
}

/** Stubs axios.get with a scripted chain and records the Cookie header each hop was sent. */
function withChain(
  hops: Array<{ status: number; location?: string; setCookie?: string[]; body?: string }>,
): { seen: Array<{ url: string; cookie: string }>; restore: () => void } {
  const seen: Array<{ url: string; cookie: string }> = [];
  const orig = axios.get;
  let i = 0;
  (axios as { get: unknown }).get = async (url: string, cfg: { headers?: Record<string, string> }) => {
    seen.push({ url, cookie: cfg?.headers?.Cookie ?? '' });
    const h = hops[Math.min(i, hops.length - 1)];
    i++;
    return {
      status: h.status,
      data: h.body ?? '',
      headers: { location: h.location, 'set-cookie': h.setCookie },
    };
  };
  return { seen, restore: () => { (axios as { get: unknown }).get = orig; } };
}

const ELIGIBLE = 'webTradeEligibility=%7B%22allowed%22%3A1%2C%22steamguard_required_days%22%3A15%7D; Path=/';
const BLOCKED  = 'webTradeEligibility=%7B%22allowed%22%3A0%2C%22steamguard_required_days%22%3A15%2C%22new_device_cooldown_days%22%3A7%7D; Path=/';

test('H-PRB-001: the eligibilitycheck bounce is followed, and the cookie it sets is CARRIED BACK', async () => {
  // Exactly the chain that made axios give up with "Maximum number of redirects exceeded".
  const c = withChain([
    { status: 302, location: 'https://steamcommunity.com/market/eligibilitycheck/?goto=%2Fmarket%2F' },
    { status: 302, location: 'https://steamcommunity.com/market/', setCookie: [ELIGIBLE] },
    { status: 200, body: marketPage() },
  ]);
  try {
    const p = await fakeTrader().probeMarketAccess();
    assert.equal(p.settled, true, 'the chain must reach a real page, not die in the loop');
    assert.equal(p.httpStatus, 200);
    assert.equal(c.seen.length, 3);
    // THE FIX: the cookie Steam set on hop 2 is sent on hop 3. Without a jar Steam re-bounces forever.
    assert.match(c.seen[2].cookie, /webTradeEligibility=/, 'hop 3 must carry the cookie hop 2 set');
    assert.match(c.seen[0].cookie, /steamLoginSecure=xyz/, 'the login cookies still go out on hop 1');
    assert.deepEqual(p.redirects, [
      'https://steamcommunity.com/market/eligibilitycheck/?goto=%2Fmarket%2F',
      'https://steamcommunity.com/market/',
    ]);
  } finally { c.restore(); }
});

test('H-PRB-002: webTradeEligibility is read off the INTERMEDIATE hop that sets it', async () => {
  // The first cut read set-cookie from the final response only — where this cookie never appears.
  const c = withChain([
    { status: 302, location: 'https://steamcommunity.com/market/eligibilitycheck/?goto=%2Fmarket%2F' },
    { status: 302, location: 'https://steamcommunity.com/market/', setCookie: [BLOCKED] },
    { status: 200, body: marketPage({ allowed: false }) },   // final hop sets NOTHING
  ]);
  try {
    const p = await fakeTrader().probeMarketAccess();
    assert.ok(p.tradeEligibility, 'the cookie must survive to the result');
    assert.equal(p.tradeEligibility!.allowed, 0);
    assert.equal(p.tradeEligibility!.new_device_cooldown_days, 7);
    assert.equal(p.marketAllowed, false);
  } finally { c.restore(); }
});

test('H-PRB-003: Steam OWN wallet is read from the same page, in minor units', async () => {
  const c = withChain([{ status: 200, body: marketPage() }]);
  try {
    const p = await fakeTrader().probeMarketAccess();
    assert.equal(p.walletBalanceMinor, 302, 'independent of the CM wallet event SSIM caches');
    assert.equal(p.walletDelayedBalanceMinor, 0);
    assert.equal(p.walletCurrency, 3);
    assert.equal(p.walletCountry, 'DE');
  } finally { c.restore(); }
});

test('H-PRB-004: a page with no wallet block reports null, never a fabricated zero', async () => {
  // A money read must never invent a number: absent and zero are different answers.
  const c = withChain([{ status: 200, body: marketPage({ wallet: null }) }]);
  try {
    const p = await fakeTrader().probeMarketAccess();
    assert.equal(p.walletBalanceMinor, null);
    assert.equal(p.walletCurrency, null);
    assert.equal(p.walletCountry, null);
  } finally { c.restore(); }
});

test('H-PRB-005: an endless bounce reports settled:false instead of a clean-looking blank', async () => {
  // Steam bouncing forever is a REAL finding. It must not read as "probe came back fine, no notice".
  const c = withChain([{ status: 302, location: 'https://steamcommunity.com/market/eligibilitycheck/' }]);
  try {
    const p = await fakeTrader().probeMarketAccess();
    assert.equal(p.settled, false, 'an unsettled probe must announce itself');
    assert.equal(p.marketAllowed, null, 'nothing was parsed, so nothing may be asserted');
    assert.equal(p.walletBalanceMinor, null);
    assert.ok(p.redirects.length >= 6, 'the hop budget is bounded, not infinite');
  } finally { c.restore(); }
});

test('H-PRB-006: a direct 200 (no gate) still reads normally', async () => {
  const c = withChain([{ status: 200, body: marketPage(), setCookie: [ELIGIBLE] }]);
  try {
    const p = await fakeTrader().probeMarketAccess();
    assert.equal(p.settled, true);
    assert.deepEqual(p.redirects, []);
    assert.equal(p.marketAllowed, true);
    assert.equal(p.tradeEligibility!.allowed, 1);
  } finally { c.restore(); }
});
