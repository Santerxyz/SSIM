import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { AccountTrader } from '../src/trading/AccountTrader';

// ════════════════════════════════════════════════════════════════════════════════════════════════
//  A Steam market buy order carries a billing address, and generateBilling() defaults its country
//  to 'DE'. Every account in this fleet therefore posted a GERMAN billing address regardless of
//  where the account actually is.
//
//  Measured 2026-08-21 with the (repaired) market-access probe:
//
//      donaldjohnston02  country=CZ  wallet=302  eligibility allowed:1   6 orders, NONE created
//      lilycepeda93      country=DE  wallet= 27  eligibility allowed:1   fills
//      zalthorvexin24    country=DE  wallet= 51  eligibility allowed:1   fills
//      xblacksanterx     country=DE  wallet= 36  eligibility allowed:1   moves money normally
//
//  Eligibility is identical and clean on all four, all four wallets are EUR and funded, and the ONE
//  account whose country differs from the hardcoded 'DE' is the ONE account where Steam answers
//  success=1 with a real buy_orderid, holds no funds, rests nothing and fills nothing.
//
//  So the billing country is no longer guessed: it is read from Steam per account. And because
//  guessing is exactly what produced six silent no-op orders reported as placed AND confirmed, an
//  unresolvable country REFUSES the buy instead of falling back to a default.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const WALLET = (country: string): string =>
  `<html><script>var g_rgWalletInfo = {"wallet_currency":3,"wallet_country":"${country}","wallet_balance":"302"};</script></html>`;

function fakeTrader(country?: string): AccountTrader {
  const t = Object.create(AccountTrader.prototype) as AccountTrader;
  Object.assign(t, {
    username: 'donaldjohnston02',
    session: {
      webSession: { cookies: ['sessionid=abc', 'steamLoginSecure=xyz'] },
      httpsAgent: {},
      ...(country ? { walletCountry: country } : {}),
    },
  });
  return t;
}

const REQ = { marketHashName: 'Mann Co. Supply Crate Key', appId: 440, currency: 3, pricePerItemMinor: 200, quantity: 1 };

/** Stubs the market-page GET and the createbuyorder POST, capturing the multipart body sent. */
function stub(page: { status: number; body?: string } | null): {
  posts: string[]; readonly gets: number; restore: () => void;
} {
  const oGet = axios.get, oPost = axios.post;
  const posts: string[] = [];
  let gets = 0;
  (axios as { get: unknown }).get = async () => {
    gets++;
    if (!page) throw new Error('market page unreachable');
    return { status: page.status, data: page.body ?? '', headers: {} };
  };
  (axios as { post: unknown }).post = async (_u: string, body: Buffer) => {
    posts.push(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
    return { status: 200, data: { success: 1, buy_orderid: '8624798659' } };
  };
  // `gets` is read AFTER the calls, so it must be a live getter, not a snapshot of 0.
  return {
    posts,
    get gets() { return gets; },
    restore: () => { (axios as { get: unknown }).get = oGet; (axios as { post: unknown }).post = oPost; },
  };
}

/** Pulls a multipart field's value out of a captured body. */
function field(body: string, name: string): string {
  const m = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(body);
  return m ? m[1] : '';
}

test('H-BUY-110: THE BUG — a CZ account posts a CZ billing country, not the hardcoded DE', async () => {
  const s = stub({ status: 200, body: WALLET('CZ') });
  try {
    const r = await fakeTrader().createBuyOrder(REQ);
    assert.equal(r.placed, true);
    assert.equal(s.posts.length, 1);
    assert.equal(field(s.posts[0], 'billing_country'), 'CZ', 'the account own country, read from Steam');
    assert.notEqual(field(s.posts[0], 'billing_country'), 'DE', 'the hardcoded default must not survive');
  } finally { s.restore(); }
});

test('H-BUY-111: a DE account is unaffected — the accounts that already worked keep working', async () => {
  const s = stub({ status: 200, body: WALLET('DE') });
  try {
    await fakeTrader().createBuyOrder(REQ);
    assert.equal(field(s.posts[0], 'billing_country'), 'DE');
  } finally { s.restore(); }
});

test('H-BUY-112: the country is read ONCE and cached on the session, not per order', async () => {
  const s = stub({ status: 200, body: WALLET('CZ') });
  try {
    const t = fakeTrader();
    await t.createBuyOrder(REQ);
    await t.createBuyOrder(REQ);
    assert.equal(s.posts.length, 2, 'both orders went out');
    assert.equal(s.gets, 1, 'but Steam was asked for the country only once');
    assert.equal(field(s.posts[1], 'billing_country'), 'CZ');
  } finally { s.restore(); }
});

test('H-BUY-113: an already-cached country skips the read entirely', async () => {
  const s = stub(null);   // any GET would throw
  try {
    await fakeTrader('CZ').createBuyOrder(REQ);
    assert.equal(s.gets, 0);
    assert.equal(field(s.posts[0], 'billing_country'), 'CZ');
  } finally { s.restore(); }
});

test('H-BUY-114: an UNREADABLE country refuses the buy — and nothing is POSTed', async () => {
  // Guessing here is what produced six no-op orders reported as placed AND confirmed. Refusing
  // before the POST is unambiguous: no order, no money in flight, nothing to reconcile.
  const s = stub(null);
  try {
    await assert.rejects(
      () => fakeTrader().createBuyOrder(REQ),
      /country/i,
      'the refusal must name the reason',
    );
    assert.equal(s.posts.length, 0, 'NO order may be sent when the country is unknown');
  } finally { s.restore(); }
});

test('H-BUY-115: a page with no wallet block refuses too, rather than defaulting', async () => {
  const s = stub({ status: 200, body: '<html>no wallet here</html>' });
  try {
    await assert.rejects(() => fakeTrader().createBuyOrder(REQ), /refusing to guess/i);
    assert.equal(s.posts.length, 0);
  } finally { s.restore(); }
});

test('H-BUY-116: an explicitly supplied billing profile is still honoured verbatim', async () => {
  const s = stub(null);   // no read needed: the caller already said what to send
  try {
    await fakeTrader().createBuyOrder({
      ...REQ,
      billing: { firstName: 'A', lastName: 'B', address: 'C 1', addressTwo: '', city: 'D', state: '', country: 'PL', postalCode: '00001', save: true },
    });
    assert.equal(field(s.posts[0], 'billing_country'), 'PL');
    assert.equal(s.gets, 0);
  } finally { s.restore(); }
});
