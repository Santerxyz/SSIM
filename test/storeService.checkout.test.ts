import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performPaysafeCheckout, StoreShapeError, StoreHttpError, type StoreContext, type StoreResponse } from '../src/store/StoreService';

// ════════════════════════════════════════════════════════════════════════════════════════════════
//  The paysafecard checkout choreography, driven against a SCRIPTED StoreContext — no Steam, no
//  browser, no network. Every assertion here is a money-safety claim: a throw means no browser opens,
//  and therefore no charge can occur.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const ok = (data: unknown, status = 200, location = ''): StoreResponse => ({ status, data, location });

/** A realistic EUR addfunds page: currency marker, tiles, and the capital-I sessionID form field. */
const ADDFUNDS_EUR = `
  <input type="hidden" name="sessionID" value="abc123">
  <input id="input_currency" type="hidden" value="EUR">
  <a data-amount="500" data-currency="EUR" onclick="submitAddFunds(this)">5,00€</a>
  <a data-amount="1000" data-currency="EUR" onclick="submitAddFunds(this)">10,00€</a>`;
const ADDFUNDS_USD = ADDFUNDS_EUR.replace(/EUR/g, 'USD');
const CHECKOUT_PAGE = `<script>g_sessionID = "checkoutsid99";</script>`;
const CART_GID = '7788990011';
const SUBMIT_302 = ok('', 302, `https://checkout.steampowered.com/checkout/?cart=${CART_GID}&purchasetype=self`);

interface Script {
  addfunds?: StoreResponse;
  submit?: StoreResponse;
  cart?: StoreResponse;
  checkout?: StoreResponse;
  inittransaction?: StoreResponse;
  getfinalprice?: StoreResponse;
}

/** Builds a ctx that answers each step, and records the forms POSTed so we can assert what Steam was told. */
function makeCtx(script: Script = {}) {
  const posts: Array<{ path: string; form: Record<string, string> }> = [];
  const gets: string[] = [];
  const ctx: StoreContext = {
    username: 'acct', steamId: '76561198000000000', sessionid: 'cookiesid',
    get: async (path) => {
      gets.push(path);
      if (path.includes('/steamaccount/addfunds')) return script.addfunds ?? ok(ADDFUNDS_EUR);
      if (path.includes('/cart/')) return script.cart ?? ok('');
      if (path.includes('checkout.steampowered.com/checkout/')) return script.checkout ?? ok(CHECKOUT_PAGE);
      throw new Error(`unscripted GET ${path}`);
    },
    post: async (path, form) => {
      posts.push({ path, form });
      if (path.includes('addfundssubmit')) return script.submit ?? SUBMIT_302;
      if (path.includes('inittransaction')) return script.inittransaction ?? ok({ success: 1, transid: 'TX-1' });
      if (path.includes('getfinalprice')) return script.getfinalprice ?? ok({ success: 1, base: '500', total: '500' });
      throw new Error(`unscripted POST ${path}`);
    },
  };
  return { ctx, posts, gets };
}

const EUR_WALLET = async () => ({ hasWallet: true, currency: 3, balance: 12.34 });
const EMPTY_WALLET = async () => ({ hasWallet: false, currency: 0, balance: 0 });
const NO_WALLET = async () => undefined;
const BILLING = { firstName: 'A', lastName: 'B', country: 'DE' };
const run = (script: Script = {}, wallet = EUR_WALLET, amountMinor = 500) => {
  const { ctx, posts, gets } = makeCtx(script);
  return { promise: performPaysafeCheckout(ctx, { amountMinor, billing: BILLING }, wallet), posts, gets };
};

// ── Happy path ──────────────────────────────────────────────────────────────────────────────────

test('H-CKO-001: the happy path posts the right amount, forces PaymentMethod=paysafe, and returns the transid', async () => {
  const { promise, posts } = run();
  const r = await promise;

  const submit = posts.find((p) => p.path.includes('addfundssubmit'))!;
  assert.equal(submit.form.amount, '500');          // euro-cents, verbatim — no ×100, no conversion
  assert.equal(submit.form.currency, 'EUR');
  assert.equal(submit.form.sessionID, 'abc123');    // scraped from the page, NOT the cookie sessionid

  const init = posts.find((p) => p.path.includes('inittransaction'))!;
  assert.equal(init.form.PaymentMethod, 'paysafe'); // NOT 'paysafecard' — that silently defaulted to Klarna
  assert.equal(init.form.gidShoppingCart, CART_GID);
  assert.equal(init.form.bUseAccountCart, '0');     // a FRESH cart, not the standing account cart
  assert.equal(init.form.sessionid, 'checkoutsid99');   // the CHECKOUT domain's CSRF token
  assert.equal(init.form.abortPendingTransactions, '1');

  assert.equal(r.transid, 'TX-1');
  assert.match(r.externalUrl, /^https:\/\/checkout\.steampowered\.com\/checkout\/externallink\/\?transid=TX-1$/);
  assert.equal(r.walletMinor, 1234);
  assert.deepEqual(r.warnings, []);
});

test('H-CKO-002: the cart gid comes from THIS submit’s redirect — the standing cart is never read', async () => {
  const { promise, gets } = run();
  await promise;
  assert.equal(gets.filter((g) => g.includes('/cart/')).length, 0);   // no standing-cart read at all
});

test('H-CKO-003: an EMPTY wallet yields a real 0 baseline (a first-ever top-up is confirmable)', async () => {
  const { promise } = run({}, EMPTY_WALLET);
  const r = await promise;
  assert.equal(r.walletMinor, 0);
  assert.deepEqual(r.warnings, []);
});

test('H-CKO-004: an unreadable wallet still opens, but warns that the credit cannot be auto-confirmed', async () => {
  const { promise } = run({}, NO_WALLET);
  const r = await promise;
  assert.equal(r.walletMinor, null);
  assert.match(r.warnings.join(' '), /could not be read/);
});

// ── EUR-only gates (refused BEFORE any cart exists) ─────────────────────────────────────────────

test('H-CKO-010: a non-EUR addfunds page is refused before a cart is built', async () => {
  const { promise, posts } = run({ addfunds: ok(ADDFUNDS_USD) });
  await assert.rejects(promise, /EUR-only.*USD/);
  assert.equal(posts.length, 0);   // nothing was POSTed → no cart, no transaction, no charge
});

test('H-CKO-011: a non-EUR WALLET is refused even when the page looks EUR', async () => {
  const usdWallet = async () => ({ hasWallet: true, currency: 1, balance: 10 });
  const { promise, posts } = run({}, usdWallet);
  await assert.rejects(promise, /EUR-only.*currency 1/);
  assert.equal(posts.length, 0);
});

test('H-CKO-012: an unreadable page currency is refused, never assumed EUR', async () => {
  const { promise, posts } = run({ addfunds: ok('<html>totally different layout</html>') });
  await assert.rejects(promise, /could not read the wallet currency/);
  assert.equal(posts.length, 0);
});

test('H-CKO-013: a stale session (HTML login page, HTTP 302) fails closed on the addfunds GET', async () => {
  await assert.rejects(run({ addfunds: ok('', 302, '/login/') }).promise, StoreHttpError);
});

// ── The double-charge defence: intent vs. what Steam will actually charge ───────────────────────

test('H-CKO-020: an ACCUMULATED cart (base = 2× the amount) is refused — no browser, no charge', async () => {
  const { promise } = run({ getfinalprice: ok({ success: 1, base: '1000', total: '1000' }) });
  await assert.rejects(promise, /does not match the amount you chose/);
});

test('H-CKO-021: a mismatching total with no base is also refused', async () => {
  await assert.rejects(run({ getfinalprice: ok({ success: 1, total: '750' }) }).promise, /Nothing was opened/);
});

test('H-CKO-022: getfinalprice EResult != 1 is a hard refusal (the old code ignored it)', async () => {
  const { promise } = run({ getfinalprice: ok({ success: 2, base: '500' }) });
  await assert.rejects(promise, /getfinalprice returned EResult 2/);
});

test('H-CKO-023: getfinalprice returning HTML (stale session) fails closed, never opens a browser', async () => {
  await assert.rejects(run({ getfinalprice: ok('<html>login</html>') }).promise, StoreShapeError);
});

test('H-CKO-024: inittransaction EResult != 1 is a hard refusal', async () => {
  const { promise } = run({ inittransaction: ok({ success: 2, purchaseresultdetail: 9 }) });
  await assert.rejects(promise, /inittransaction returned EResult 2/);
});

test('H-CKO-025: inittransaction without a transid is a hard refusal', async () => {
  await assert.rejects(run({ inittransaction: ok({ success: 1 }) }).promise, /no transid/);
});

test('H-CKO-026: an unverifiable order total opens, but warns the operator to check the figure', async () => {
  const { promise } = run({ getfinalprice: ok({ success: 1 }) });
  const r = await promise;
  assert.match(r.warnings.join(' '), /could not be verified/);
});

// ── Cart fallback + submit failures ────────────────────────────────────────────────────────────

test('H-CKO-030: a submit with no cart gid falls back to the standing cart AND warns about it', async () => {
  const { promise, gets } = run({ submit: ok('', 302, '/checkout/'), cart: ok(`<a href="/checkout/?cart=${CART_GID}">`) });
  const r = await promise;
  assert.ok(gets.some((g) => g.includes('/cart/')));
  assert.match(r.warnings.join(' '), /standing cart/);
});

test('H-CKO-031: a 4xx on addfundssubmit does NOT fall through to the standing cart', async () => {
  // Otherwise a rejected add-to-cart would silently check out whatever was already in the cart.
  const { promise, gets } = run({ submit: ok('forbidden', 403) });
  await assert.rejects(promise, StoreHttpError);
  assert.equal(gets.filter((g) => g.includes('/cart/')).length, 0);
});

test('H-CKO-032: a non-200 checkout page fails closed', async () => {
  await assert.rejects(run({ checkout: ok('', 500) }).promise, StoreHttpError);
});

// ── externalurl validation ─────────────────────────────────────────────────────────────────────

test('H-CKO-040: a Steam externalurl is used verbatim', async () => {
  const url = 'https://checkout.steampowered.com/checkout/externallink/?transid=TX-1&x=1';
  const { promise } = run({ getfinalprice: ok({ success: 1, base: '500', total: '500', externalurl: url }) });
  assert.equal((await promise).externalUrl, url);
});

test('H-CKO-041: a NON-Steam externalurl is discarded (never handed to the browser) and warned', async () => {
  const { promise } = run({ getfinalprice: ok({ success: 1, base: '500', total: '500', externalurl: 'https://evil.com/pay' }) });
  const r = await promise;
  assert.match(r.externalUrl, /^https:\/\/checkout\.steampowered\.com\//);
  assert.doesNotMatch(r.externalUrl, /evil\.com/);
  assert.match(r.warnings.join(' '), /unexpected payment URL/);
});

// ── Amount validation ──────────────────────────────────────────────────────────────────────────

test('H-CKO-050: a non-integer / non-positive amount is refused before any request', async () => {
  for (const bad of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 2]) {
    const { promise, posts, gets } = run({}, EUR_WALLET, bad);
    await assert.rejects(promise, /invalid top-up amount/);
    assert.equal(posts.length + gets.length, 0);
  }
});
