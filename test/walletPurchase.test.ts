import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  performWalletPurchase, ownedPackageIdsFrom, walletNativeMinor, readStoreOwnedPackages, purchaseDetailHint,
  parseAccountCart,
  CS2_APP_ID, CS2_PRIME_APP_ID, MAX_PURCHASE_MINOR,
  type WalletPurchaseEnv,
} from '../src/store/WalletPurchase';
import { StoreShapeError, StoreHttpError, StoreAmbiguousError, type StoreContext, type StoreResponse } from '../src/store/StoreService';

// ════════════════════════════════════════════════════════════════════════════════════════════════
//  W4_41 — the wallet-only CS2 Prime purchase, driven against a SCRIPTED StoreContext: no Steam,
//  no session, no network, no timers. Every assertion is a money claim.
//
//  The single most important thing these tests pin down is WHERE the money moves.
//  finalizetransaction is the only step that charges, so a test asserting "no finalize was POSTed"
//  is asserting that nothing could possibly have been billed. `finalized(posts)` is that assertion,
//  and it appears in every refusal case below.
//
//  Note what is NOT here any more: any call to /api/appdetails. That endpoint answered
//  {"success":false} on funded, normal accounts (it is IP-rate-limited and degrades to exactly the
//  same shape as "not sold here"), so the ids are constants now and the price comes from the
//  checkout. H-BUY-004 pins that the choreography never reaches for it again.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const ok = (data: unknown, status = 200, location = ''): StoreResponse => ({ status, data, location });

const PRICE = 1624;                 // 16.24 EUR, in euro-cents — whatever Steam quotes
/** CS2 Prime Status Upgrade. Read out of a live account's own cart on 2026-08-05 — evidence, not a
 *  guess (the previous constant, 298963, was the FREE base game). */
const PRIME_SUB = 54029;
/** The free Counter-Strike 2 package — what the old constant actually pointed at. Putting it in a
 *  purchase cart is precisely what made Steam refuse every order. */
const FREE_CS2_SUB = 298963;

/**
 * A store page carrying Steam's `data-store_user_config` blob, shaped exactly like the one recovered
 * from the live dump (HTML-entity-escaped JSON in an attribute, `accountcart.cart` inside it).
 */
function cartPage(
  lines: Array<{ sub: number; line: string; price: number; valid?: boolean }>,
  opts: { currency?: number; cartValid?: boolean } = {},
): string {
  const currency = opts.currency ?? 3;
  const subtotal = lines.reduce((s, l) => s + l.price, 0);
  const cfg = {
    webapi_token: 'tok', shoppingcart: null, originating_navdata: null, wishlist_item_count: 0,
    accountcart: {
      cart: {
        line_items: lines.map((l) => ({
          line_item_id: l.line, type: 1, packageid: l.sub, bundleid: null,
          is_valid: (l.valid ?? true) ? 1 : 0, validation_details: null, time_added: 1785936306,
          price_when_added: { amount_in_cents: String(l.price), currency_code: currency, formatted_amount: 'x' },
          gift_info: null, flags: { is_gift: 0, is_private: 0 }, gidcoupon_applied: null,
        })),
        subtotal: { amount_in_cents: String(subtotal), currency_code: currency, formatted_amount: 'x' },
        is_valid: (opts.cartValid ?? true) ? 1 : 0, validation_details: null,
      },
      success: 1, rwgrsn: -2,
    },
  };
  const escaped = JSON.stringify(cfg).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<html><body><div data-store_user_config="${escaped}"></div><div id="application_root"></div></body></html>`;
}
const PRIME_IN_CART = ok(cartPage([{ sub: PRIME_SUB, line: '4364337816', price: PRICE }]));
const EMPTY_CART = ok(cartPage([]));
/** The normal case for a CS2 fleet: the store already sees Counter-Strike 2 in the library. */
const USERDATA = { rgOwnedApps: [CS2_APP_ID], rgOwnedPackages: [303386] };
/** An account the store does NOT yet see CS2 on — the state that caused the live failure. */
const USERDATA_NO_CS2 = { rgOwnedApps: [], rgOwnedPackages: [] };
const CHECKOUT_PAGE = `<script>g_sessionID = "cosid42";</script>`;

interface Script {
  /** A single response, or one per successive call (so a grant can be observed to take effect). */
  userdata?: StoreResponse | StoreResponse[];
  /** Cart as seen BEFORE the add (leftovers) and AFTER it (what will actually be paid for). */
  cartBeforeAdd?: StoreResponse;
  cartAfterAdd?: StoreResponse;
  /** Whether the emptying mechanisms actually work (default: DeleteCart does). */
  deleteCartWorks?: boolean;
  removeWorks?: boolean;
  addToCart?: StoreResponse;
  removeLineItem?: StoreResponse;
  checkout?: StoreResponse;
  inittransaction?: StoreResponse;
  getfinalprice?: StoreResponse;
  finalize?: StoreResponse | Error;
  transactionstatus?: StoreResponse;
}

function makeCtx(script: Script = {}) {
  const posts: Array<{ path: string; form: Record<string, string> }> = [];
  const gets: string[] = [];
  const webapiCalls: Array<{ method: string; token: string }> = [];
  let userdataCall = 0;
  let added = false;
  let emptied = false;                 // set by whichever emptying mechanism the script lets succeed
  const ctx: StoreContext = {
    username: 'bot01', steamId: '76561198000000000', sessionid: 'cookiesid',
    webapi: async (method, token) => {
      webapiCalls.push({ method, token });
      if (script.deleteCartWorks !== false) emptied = true;
      return ok({ response: {} });
    },
    get: async (path) => {
      gets.push(path);
      if (path.includes('/dynamicstore/userdata')) {
        const u = script.userdata ?? ok(USERDATA);
        return Array.isArray(u) ? (u[userdataCall++] ?? u[u.length - 1]) : u;
      }
      if (path === '/cart/' || path === '/') {
        if (added) return script.cartAfterAdd ?? PRIME_IN_CART;
        return emptied ? EMPTY_CART : (script.cartBeforeAdd ?? EMPTY_CART);
      }
      if (path.includes('/checkout/transactionstatus/')) return script.transactionstatus ?? ok({ success: 1, paymentmethod: 128 });
      if (path.includes('checkout.steampowered.com/checkout/')) return script.checkout ?? ok(CHECKOUT_PAGE);
      throw new Error(`unscripted GET ${path}`);
    },
    post: async (path, form) => {
      posts.push({ path, form });
      if (path === '/cart/') {
        if (form.action === 'remove_line_item') {
          if (script.removeWorks !== false) emptied = true;
          return script.removeLineItem ?? ok('{"success":1}');
        }
        added = true;
        return script.addToCart ?? ok('{"success":1}');
      }
      if (path.includes('inittransaction')) return script.inittransaction ?? ok({ success: 1, transid: 'TX-9', paymentmethod: 128 });
      if (path.includes('getfinalprice')) return script.getfinalprice ?? ok({ success: 1, base: String(PRICE), total: String(PRICE) });
      if (path.includes('finalizetransaction')) {
        if (script.finalize instanceof Error) throw script.finalize;
        return script.finalize ?? ok({ success: 1 });
      }
      throw new Error(`unscripted POST ${path}`);
    },
  };
  return { ctx, posts, gets, webapiCalls };
}

const wallet = (balance: number, currency = 3, hasWallet = true) => async () => ({ hasWallet, currency, balance });
const OWNS_NO_PRIME = () => [303386, 469902];
const GRANTED_CS2 = { grantedPackageIds: [303386], grantedAppIds: [CS2_APP_ID] };
const GRANTED_NOTHING = { grantedPackageIds: [], grantedAppIds: [] };

function makeEnv(over: Partial<WalletPurchaseEnv> = {}, freeGameCalls?: number[]): WalletPurchaseEnv {
  return {
    readWallet: wallet(50),                       // 50.00 EUR — comfortably covers Prime
    readOwnedPackageIds: OWNS_NO_PRIME,
    grantFreeBaseGame: async () => { freeGameCalls?.push(CS2_APP_ID); return GRANTED_CS2; },
    sleep: async () => { /* no real timers in unit tests */ },
    ...over,
  };
}

function run(script: Script = {}, envOver: Partial<WalletPurchaseEnv> = {}, beginCommit?: (a: { subId: number; totalMinor: number; currencyIso: string }) => string | null) {
  const { ctx, posts, gets, webapiCalls } = makeCtx(script);
  const freeGameCalls: number[] = [];
  return { promise: performWalletPurchase(ctx, makeEnv(envOver, freeGameCalls), beginCommit), posts, gets, freeGameCalls, webapiCalls };
}

/** THE assertion: did any request that can charge money go out? */
const finalized = (posts: Array<{ path: string }>): boolean => posts.some((p) => p.path.includes('finalizetransaction'));
const finalizedCount = (posts: Array<{ path: string }>): number => posts.filter((p) => p.path.includes('finalizetransaction')).length;
/** Did we so much as touch this account's cart? */
const touchedCart = (posts: Array<{ path: string }>): boolean => posts.some((p) => p.path === '/cart/');

// ── Happy path ──────────────────────────────────────────────────────────────────────────────────

test('H-BUY-001: a clean buy pays from the wallet and confirms the charge', async () => {
  const { promise, posts, freeGameCalls } = run();
  const r = await promise;

  assert.deepEqual(freeGameCalls, []);                      // the store already saw CS2 — no pointless grant

  const add = posts.find((p) => p.path === '/cart/' && p.form.action === 'add_to_cart')!;
  assert.equal(add.form.subid, String(PRIME_SUB));          // the PRICED package off the page…
  assert.notEqual(add.form.subid, String(FREE_CS2_SUB));    // …never the free base game

  const init = posts.find((p) => p.path.includes('inittransaction'))!;
  assert.equal(init.form.PaymentMethod, 'steamaccount');    // the wallet rail, explicitly — never a default
  assert.equal(init.form.bUseRemainingSteamAccount, '1');
  assert.equal(init.form.gidPaymentID, '');                 // no stored payment method may be selected
  assert.equal(init.form.bHasCardInfo, '0');
  assert.equal(init.form.CardNumber, '');
  assert.equal(init.form.bIsGift, '0');
  assert.equal(init.form.bSaveBillingAddress, '0');         // a purchase must not write an address onto the account
  // Steam moved carts onto the ACCOUNT, so the checkout opens against the account cart — which is
  // safe precisely because the cart was read back and proven to hold only Prime (H-BUY-014..016).
  assert.equal(init.form.gidShoppingCart, '-1');
  assert.equal(init.form.bUseAccountCart, '1');
  assert.equal(init.form.sessionid, 'cosid42');             // the checkout domain's own CSRF token

  assert.equal(r.status, 'purchased');
  assert.equal(r.transid, 'TX-9');
  assert.equal(r.priceMinor, PRICE);                        // Steam's quote, in the account's currency
  assert.equal(r.subId, PRIME_SUB);
  assert.deepEqual(r.warnings, []);
});

test('H-BUY-002: the observed wallet drop is reported, not the intended spend', async () => {
  let call = 0;
  const { promise } = run({}, { readWallet: async () => ({ hasWallet: true, currency: 3, balance: call++ === 0 ? 50 : 50 - PRICE / 100 }) });
  const r = await promise;
  assert.equal(r.walletMinorBefore, 5000);
  assert.equal(r.walletMinorAfter, 5000 - PRICE);
  assert.equal(r.chargedMinor, PRICE);
});

test('H-BUY-003: the price is taken WHOLE from Steam — no operator cap, no second opinion', async () => {
  // Whatever Steam charges, up to what the page said Prime costs, is what gets paid — a discount is
  // fine and needs no approval. This is the behaviour the owner asked for when the cap parameter came
  // out; the only ceiling left is "not MORE than the page price", which means the cart is wrong.
  for (const quoted of [1, 999, PRICE]) {
    const r = await run({ getfinalprice: ok({ success: 1, total: String(quoted) }) }, { readWallet: wallet(200) }).promise;
    assert.equal(r.status, 'purchased');
    assert.equal(r.priceMinor, quoted);
  }
});

test('H-BUY-004: /api/appdetails is never called — the field bug it caused cannot come back', async () => {
  // It answered {"success":false} on funded accounts (IP rate limit → same shape as "not sold here").
  const { promise, gets, posts } = run();
  await promise;
  assert.equal([...gets, ...posts.map((p) => p.path)].some((p) => p.includes('appdetails')), false);
});

// ── The cart is READ BACK, not assumed (the 2026-08-05 "CS2 in the cart, not Prime" bug) ──────
//  The package id was hard-coded to 298963 — Counter-Strike 2, the free base game. Every run put an
//  unbuyable free item in the cart and Steam refused the order. Scraping the id off /app/624820/
//  failed too: that page 302s to the Steam front page and no longer exists.
//  The id now comes from a live cart (evidence), and is VERIFIED against the cart before checkout.

test('H-BUY-013: the real cart blob parses — line items, validity, price and currency', () => {
  const cart = parseAccountCart(cartPage([{ sub: PRIME_SUB, line: '4364337816', price: PRICE }]))!;
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].packageId, PRIME_SUB);
  assert.equal(cart.items[0].lineItemId, '4364337816');
  assert.equal(cart.items[0].isValid, true);
  assert.equal(cart.subtotalMinor, PRICE);
  assert.equal(cart.currencyCode, 3);
  assert.equal(cart.isValid, true);
  assert.equal(parseAccountCart('<html>no blob here</html>'), null);
});

test('H-BUY-014: a cart holding the FREE base game instead of Prime is refused, never bought', async () => {
  // The exact live failure, now caught before a transaction exists.
  const { promise, posts } = run({ cartAfterAdd: ok(cartPage([{ sub: FREE_CS2_SUB, line: '1', price: 0 }])) });
  const r = await promise;
  assert.equal(r.status, 'refused');
  assert.match(r.detail, new RegExp(`package ${FREE_CS2_SUB}`));
  assert.equal(finalized(posts), false);
});

test('H-BUY-015: the cart is EMPTIED before Prime is added — DeleteCart first, then per-line', async () => {
  const dirty = cartPage([{ sub: 111, line: '900001', price: 500 }, { sub: 222, line: '900002', price: 700 }]);
  const { promise, posts, webapiCalls } = run({ cartBeforeAdd: ok(dirty), deleteCartWorks: false });
  await promise;
  assert.deepEqual(webapiCalls.map((c) => c.method), ['IAccountCartService/DeleteCart/v1']);
  assert.equal(webapiCalls[0].token, 'tok');                    // the token from the same blob, not a cookie
  const removed = posts.filter((p) => p.path === '/cart/' && p.form.action === 'remove_line_item');
  assert.deepEqual(removed.map((p) => p.form.lineitem_gid).sort(), ['900001', '900002']);
  const addIdx = posts.findIndex((p) => p.form.action === 'add_to_cart');
  assert.ok(posts.every((p, i) => p.form.action !== 'remove_line_item' || i < addIdx), 'removals precede the add');
});

test('H-BUY-015b: when DeleteCart works, no per-line removal is needed', async () => {
  const dirty = cartPage([{ sub: 111, line: '900001', price: 500 }]);
  const { promise, posts, webapiCalls } = run({ cartBeforeAdd: ok(dirty) });
  const r = await promise;
  assert.equal(webapiCalls.length, 1);
  assert.equal(posts.filter((p) => p.form.action === 'remove_line_item').length, 0);
  assert.equal(r.status, 'purchased');
});

test('H-BUY-016: a cart that CANNOT be emptied refuses before anything is added', async () => {
  const stuck = cartPage([{ sub: 111, line: '900001', price: 500 }]);
  const { promise, posts } = run({ cartBeforeAdd: ok(stuck), deleteCartWorks: false, removeWorks: false });
  const r = await promise;
  assert.equal(r.status, 'refused');
  assert.match(r.detail, /could not be emptied/);
  assert.equal(posts.some((p) => p.form.action === 'add_to_cart'), false);   // nothing added to a dirty cart
  assert.equal(finalized(posts), false);
});

test('H-BUY-016b: TWO Prime lines are refused — the doubled-bill bug', async () => {
  // The live failure: a leftover Prime plus this run's Prime = 26,58 € against a 13,34 € wallet, which
  // reported "not enough". Checking only for FOREIGN packages let it through; "exactly one" does not.
  const twoPrime = cartPage([{ sub: PRIME_SUB, line: '1', price: PRICE }, { sub: PRIME_SUB, line: '2', price: PRICE }]);
  const { promise, posts } = run({ cartAfterAdd: ok(twoPrime) });
  const r = await promise;
  assert.equal(r.status, 'refused');
  assert.match(r.detail, /holds 2 item\(s\)/);
  assert.equal(finalized(posts), false);
});

test('H-BUY-017: a cart Steam marks NOT valid for checkout is refused', async () => {
  const invalid = ok(cartPage([{ sub: PRIME_SUB, line: '1', price: PRICE, valid: false }], { cartValid: false }));
  const { promise, posts } = run({ cartAfterAdd: invalid });
  const r = await promise;
  assert.equal(r.status, 'refused');
  assert.match(r.detail, /not valid for checkout/);
  assert.equal(finalized(posts), false);
});

test('H-BUY-018: a cart priced in a different currency from the wallet is refused', async () => {
  const usdCart = ok(cartPage([{ sub: PRIME_SUB, line: '1', price: 1499 }], { currency: 1 }));   // USD cart, EUR wallet
  const { promise, posts } = run({ cartAfterAdd: usdCart });
  const r = await promise;
  assert.equal(r.status, 'refused');
  assert.match(r.detail, /differently-denominated cart/);
  assert.equal(finalized(posts), false);
});

test('H-BUY-019: an unreadable cart refuses — SSIM never checks out what it cannot see', async () => {
  // Unreadable now stops at the empty-first precondition, which is even earlier: nothing is added to a
  // cart whose contents SSIM cannot see.
  const { promise, posts } = run({ cartBeforeAdd: ok('<html>nothing</html>'), cartAfterAdd: ok('<html>nothing</html>') });
  const r = await promise;
  assert.equal(r.status, 'refused');
  assert.match(r.detail, /could not be emptied/);
  assert.equal(posts.some((p) => p.form.action === 'add_to_cart'), false);
  assert.equal(finalized(posts), false);
});

test('H-BUY-020a: the CART price skips a short wallet, and empties the cart again on the way out', async () => {
  const { promise, posts } = run({}, { readWallet: wallet(5) });     // 5.00 EUR < 16.24
  const r = await promise;
  assert.equal(r.status, 'skipped');
  assert.equal(r.priceMinor, PRICE);
  assert.equal(finalized(posts), false);
  assert.ok(posts.some((p) => p.form.action === 'remove_line_item'), 'the unaffordable item is taken back out');
});

test('H-BUY-021a: a checkout total above the CART price is refused', async () => {
  const { promise, posts } = run({ getfinalprice: ok({ success: 1, total: String(PRICE * 2) }) }, { readWallet: wallet(200) });
  const r = await promise;
  assert.equal(r.status, 'refused');
  assert.match(r.detail, /more than the .* its own cart quoted/);
  assert.equal(finalized(posts), false);
});


// ── The free base game: the 2026-08-05 field bug ───────────────────────────────────────────────
//  Adding Prime to the cart while Steam still thinks the account lacks CS2 makes Steam drop the
//  UNBUYABLE free base game into the cart alongside it, and then refuse the whole order with
//  EResult 2 / detail 7 — which is exactly what happened to all six live accounts. The fix is the
//  ORDERING plus the confirmation: grant, then wait for the STORE to agree, and only then build a cart.

test('H-BUY-005: CS2 is granted AND confirmed in the library before anything reaches the cart', async () => {
  const seen: string[] = [];
  const { ctx, posts } = makeCtx({ userdata: [ok(USERDATA_NO_CS2), ok(USERDATA)] });   // absent, then present
  const r = await performWalletPurchase(ctx, {
    ...makeEnv(),
    grantFreeBaseGame: async () => { seen.push('grant'); return GRANTED_CS2; },
  });
  seen.push(...posts.map((p) => `${p.path}:${p.form.action ?? ''}`));
  assert.equal(seen[0], 'grant');                                  // grant first…
  assert.equal(seen.filter((s) => s.startsWith('/cart/:add_to_cart')).length, 1);
  assert.ok(seen.indexOf('grant') < seen.findIndex((s) => s.startsWith('/cart/')));   // …then the cart
  assert.equal(r.status, 'purchased');
});

test('H-BUY-006: if the store never confirms CS2, the cart is NEVER built', async () => {
  // The precise live failure. Refusing here costs nothing; proceeding leaves a poisoned cart that
  // blocks every later run on that account.
  const { promise, posts } = run({ userdata: ok(USERDATA_NO_CS2) });
  const r = await promise;
  assert.equal(r.status, 'refused');
  assert.match(r.detail, /still not in this account's library/);
  assert.match(r.detail, /unbuyable base game/);
  assert.equal(touchedCart(posts), false);
});

test('H-BUY-007: a CM grant that throws is a refusal, with no cart touched', async () => {
  const { promise, posts } = run({ userdata: ok(USERDATA_NO_CS2) }, { grantFreeBaseGame: async () => { throw new Error('CM timeout'); } });
  const r = await promise;
  assert.equal(r.status, 'refused');
  assert.match(r.detail, /free Counter-Strike 2 licence \(CM timeout\)/);
  assert.equal(touchedCart(posts), false);
});

test('H-BUY-008: an unreadable library read proceeds ONLY when the CM says the grant landed', async () => {
  const unreadable = ok('<html>login</html>');
  // Grant reported → proceed, but say out loud that it could not be confirmed.
  const okish = await run({ userdata: unreadable }).promise;
  assert.equal(okish.status, 'purchased');
  assert.match(okish.warnings.join(' '), /could not confirm Counter-Strike 2 landed/);

  // Grant reported NOTHING and we cannot see the library → no positive evidence, so no cart.
  const { promise, posts } = run({ userdata: unreadable }, { grantFreeBaseGame: async () => GRANTED_NOTHING });
  const r = await promise;
  assert.equal(r.status, 'refused');
  assert.equal(touchedCart(posts), false);
});

test('H-BUY-009: an account that already has Prime is never granted a licence or given a cart', async () => {
  const { promise, posts, freeGameCalls } = run({}, { readOwnedPackageIds: () => [303386, PRIME_SUB] });
  const r = await promise;
  assert.equal(r.status, 'owned');
  assert.deepEqual(freeGameCalls, []);
  assert.equal(posts.length, 0);
});

test('H-BUY-012: an EResult 2 / detail 7 refusal explains itself in words the operator can act on', async () => {
  const { promise } = run({ inittransaction: ok({ success: 2, purchaseresultdetail: 7 }) });
  const r = await promise;
  assert.equal(r.status, 'refused');
  assert.match(r.detail, /cannot be bought/);
  assert.match(r.detail, /empty it, and re-run/);
  assert.match(r.detail, /Nothing was charged/);
  // The codes that actually explain a refused checkout all say something; the rest stay quiet.
  assert.match(purchaseDetailHint(24), /does not own an app/);
  assert.match(purchaseDetailHint(2), /funds/);
  assert.equal(purchaseDetailHint(999), '');
});

// ── Wallet-only, proven three ways ──────────────────────────────────────────────────────────────

test('H-BUY-020: a wallet that cannot cover Steam\'s price is skipped, and nothing is charged', async () => {
  const { promise, posts } = run({}, { readWallet: wallet(10) });     // 10.00 EUR < 16.24
  const r = await promise;
  assert.equal(r.status, 'skipped');
  assert.match(r.detail, /costs 16\.24 EUR .* holds 10\.00 EUR/);
  assert.equal(r.priceMinor, PRICE);       // the price it could not afford is still reported
  assert.equal(finalized(posts), false);
});

test('H-BUY-021: Steam echoing a CARD payment method aborts before the charge', async () => {
  const { promise, posts } = run({ inittransaction: ok({ success: 1, transid: 'TX-9', paymentmethod: 2 }) });
  const r = await promise;
  assert.equal(r.status, 'refused');
  assert.match(r.detail, /instead of the Steam wallet/);
  assert.equal(finalized(posts), false);           // no charge, and no card was used
});

test('H-BUY-022: a wallet echo (128) is NOT mistaken for an external rail', async () => {
  assert.equal((await run({ inittransaction: ok({ success: 1, transid: 'TX-9', paymentmethod: 128 }) }).promise).status, 'purchased');
});

// ── Currency safety (the 100× hazard) ──────────────────────────────────────────────────────────

test('H-BUY-030: a 0-decimal wallet currency is skipped — its balance unit is unverified', async () => {
  for (const code of [8 /* JPY */, 16 /* KRW */, 10 /* IDR */]) {
    const { promise, posts } = run({}, { readWallet: wallet(500_000, code) });
    const r = await promise;
    assert.equal(r.status, 'skipped');
    assert.match(r.detail, /has not verified|100×/);
    assert.equal(posts.length, 0);
  }
});

test('H-BUY-031: an unrecognised wallet currency code is skipped', async () => {
  const r = await run({}, { readWallet: wallet(50, 9999) }).promise;
  assert.equal(r.status, 'skipped');
  assert.match(r.detail, /not one SSIM knows/);
});

test('H-BUY-032: an unreadable wallet and an EMPTY wallet are both skipped — and say which they are', async () => {
  const unreadable = await run({}, { readWallet: async () => undefined }).promise;
  assert.equal(unreadable.status, 'skipped');
  assert.match(unreadable.detail, /could not be read/);

  const empty = await run({}, { readWallet: wallet(0, 0, false) }).promise;
  assert.equal(empty.status, 'skipped');
  assert.match(empty.detail, /no Steam wallet balance at all/);
});

test('H-BUY-034: walletNativeMinor converts only what it can convert safely', () => {
  assert.deepEqual(walletNativeMinor({ hasWallet: true, currency: 3, balance: 12.34 }), { minor: 1234, iso: 'EUR' });
  assert.deepEqual(walletNativeMinor({ hasWallet: true, currency: 1, balance: 9.5 }), { minor: 950, iso: 'USD' });
  assert.equal(walletNativeMinor({ hasWallet: true, currency: 8, balance: 1500 }), null);      // JPY, 0-decimal
  assert.equal(walletNativeMinor({ hasWallet: true, currency: 4242, balance: 10 }), null);     // unknown code
  assert.equal(walletNativeMinor({ hasWallet: true, currency: 3, balance: -1 }), null);
  assert.equal(walletNativeMinor(undefined), null);
});

// ── Never buy what is already owned ─────────────────────────────────────────────────────────────

test('H-BUY-041: the store library is a second ownership witness', async () => {
  const { promise, posts } = run({ userdata: ok({ rgOwnedApps: [730, CS2_PRIME_APP_ID], rgOwnedPackages: [] }) });
  const r = await promise;
  assert.equal(r.status, 'owned');
  assert.equal(touchedCart(posts), false);
});

test('H-BUY-042: licences we cannot READ are refused — absence is never read as "does not own it"', async () => {
  const { promise, posts } = run({}, { readOwnedPackageIds: () => null });
  const r = await promise;
  assert.equal(r.status, 'refused');
  assert.match(r.detail, /could not read this account's licences/);
  assert.equal(posts.length, 0);
});

test('H-BUY-043: ownedPackageIdsFrom treats an empty/absent licence list as UNKNOWN, not empty', () => {
  assert.deepEqual(ownedPackageIdsFrom([{ package_id: 17906 }, { package_id: 303386 }]), [17906, 303386]);
  assert.equal(ownedPackageIdsFrom([]), null);          // a live CM session always holds SOMETHING
  assert.equal(ownedPackageIdsFrom(undefined), null);
  assert.equal(ownedPackageIdsFrom('nope'), null);
  assert.equal(ownedPackageIdsFrom([{}, { package_id: 'x' }]), null);
});

test('H-BUY-044: an unreadable store userdata does NOT block the buy — the CM licence list decides', async () => {
  // Corroboration only. Treating a flaky store read as "unknown ownership" would make the whole job
  // unrunnable on a slow proxy, and the CM licence list has already answered the question.
  assert.equal((await run({ userdata: ok('<html>login</html>') }).promise).status, 'purchased');
  const { ctx } = makeCtx({ userdata: ok('<html>login</html>') });
  assert.equal(await readStoreOwnedPackages(ctx), null);
});

// ── Price gates: what Steam will actually take ─────────────────────────────────────────────────

test('H-BUY-054: an UNREADABLE order total is a refusal — nobody is watching this checkout', async () => {
  const { promise, posts } = run({ getfinalprice: ok({ success: 1 }) });
  const r = await promise;
  assert.equal(r.status, 'refused');
  assert.match(r.detail, /did not report an order total/);
  assert.equal(finalized(posts), false);
});

test('H-BUY-055: a zero total is refused rather than "bought for free"', async () => {
  const { promise, posts } = run({ getfinalprice: ok({ success: 1, total: '0' }) });
  assert.equal((await promise).status, 'refused');
  assert.equal(finalized(posts), false);
});

test('H-BUY-056: the absolute ceiling still bites even when the PAGE agrees with the total', async () => {
  // Last line of defence: if the store page itself quoted an absurd figure (a page-shape change, a
  // wrong block matched), a rich wallet must not make it payable.
  const absurd = MAX_PURCHASE_MINOR + 500;
  const richPage = ok(`<div class="game_area_purchase_game"><div data-price-final="${absurd}"></div>
    <h1>Prime Status Upgrade</h1><input type="hidden" name="subid" value="${PRIME_SUB}"></div>`);
  const { promise, posts } = run(
    { primePage: richPage, getfinalprice: ok({ success: 1, total: String(absurd) }) },
    { readWallet: wallet(9999) },
  );
  const r = await promise;
  assert.equal(r.status, 'refused');
  assert.equal(finalized(posts), false);
});

test('H-BUY-057: getfinalprice / inittransaction EResult failures never reach the charge', async () => {
  for (const script of [{ getfinalprice: ok({ success: 2, total: String(PRICE) }) }, { inittransaction: ok({ success: 15 }) }, { inittransaction: ok({ success: 1 }) }]) {
    const { promise, posts } = run(script);
    assert.equal((await promise).status, 'refused');
    assert.equal(finalized(posts), false);
  }
});

test('H-BUY-058: an HTML (stale-session) reply to getfinalprice fails closed', async () => {
  const { promise, posts } = run({ getfinalprice: ok('<html>login</html>') });
  await assert.rejects(promise, StoreShapeError);
  assert.equal(finalized(posts), false);
});

// ── The commit: journalled, never retried ──────────────────────────────────────────────────────

test('H-BUY-080: beginCommit fires exactly once, immediately before the charge, with the REAL total', async () => {
  const seen: Array<{ subId: number; totalMinor: number; currencyIso: string }> = [];
  const { promise, posts } = run({ getfinalprice: ok({ success: 1, total: '1500' }) }, {}, (a) => { seen.push(a); return null; });
  await promise;
  assert.deepEqual(seen, [{ subId: PRIME_SUB, totalMinor: 1500, currencyIso: 'EUR' }]);
  assert.equal(finalized(posts), true);
});

test('H-BUY-081: beginCommit is NOT called for a skip or a pre-commit refusal', async () => {
  let calls = 0;
  const bump = () => { calls++; return null; };
  await run({}, { readWallet: wallet(1) }, bump).promise;                        // wallet short
  await run({}, { readOwnedPackageIds: () => [PRIME_SUB] }, bump).promise; // already owned
  await run({}, { readWallet: wallet(50, 8) }, bump).promise;                     // unsupported currency
  await run({ getfinalprice: ok({ success: 1, total: '99999' }) }, { readWallet: wallet(9999) }, bump).promise;   // over the ceiling
  assert.equal(calls, 0);   // a run that never commits must never clear a lingering journal entry
});

test('H-BUY-082: a REFUSING beginCommit (a lingering entry from a crash) stops the charge', async () => {
  const { promise, posts } = run({}, {}, () => 'a previous attempt died mid-commit.');
  const r = await promise;
  assert.equal(r.status, 'refused');
  assert.match(r.detail, /died mid-commit/);
  assert.equal(finalized(posts), false);
});

test('H-BUY-083: a transport fault ON the commit is UNCONFIRMED and is never re-POSTed', async () => {
  const { promise, posts } = run({ finalize: new StoreAmbiguousError('socket hang up') });
  const r = await promise;
  assert.equal(r.status, 'unconfirmed');
  assert.match(r.detail, /cannot say whether/);
  assert.equal(finalizedCount(posts), 1);      // ONE attempt, ever
});

test('H-BUY-084: Steam rejecting the commit outright is a definite non-purchase', async () => {
  const r = await run({ finalize: ok({ success: 2 }) }).promise;
  assert.equal(r.status, 'refused');
  assert.match(r.detail, /rejected the purchase/);
});

test('H-BUY-085: a non-200 on the commit is UNCONFIRMED, never "failed"', async () => {
  assert.equal((await run({ finalize: ok('', 502) }).promise).status, 'unconfirmed');
});

// ── Post-commit read-back: the money-truth ─────────────────────────────────────────────────────

test('H-BUY-090: "pending" plus an exact wallet drop counts as bought', async () => {
  let call = 0;
  const r = await run(
    { finalize: ok({ success: 22 }), transactionstatus: ok({ success: 22 }) },
    { readWallet: async () => ({ hasWallet: true, currency: 3, balance: call++ === 0 ? 50 : 50 - PRICE / 100 }) },
  ).promise;
  assert.equal(r.status, 'purchased');
  assert.match(r.detail, /wallet fell by exactly/);
});

test('H-BUY-091: "pending" with NO observable wallet movement is unconfirmed, never claimed', async () => {
  const r = await run({ finalize: ok({ success: 22 }), transactionstatus: ok({ success: 22 }) }).promise;
  assert.equal(r.status, 'unconfirmed');
  assert.match(r.detail, /Check this account's Steam purchase history/);
});

test('H-BUY-092: a wallet drop that does not match the total is NOT claimed as a purchase', async () => {
  // Something else moved this balance (a market sale landing mid-run). A delta cannot attribute
  // itself to this transaction, so we refuse to pretend it can — same rule as the paysafecard band.
  let call = 0;
  const r = await run(
    { finalize: ok({ success: 22 }), transactionstatus: ok({ success: 22 }) },
    { readWallet: async () => ({ hasWallet: true, currency: 3, balance: call++ === 0 ? 50 : 30 }) },
  ).promise;
  assert.equal(r.status, 'unconfirmed');
});

test('H-BUY-093: a purchase Steam says was paid by CARD is flagged loudly on the result', async () => {
  const r = await run({ transactionstatus: ok({ success: 1, paymentmethod: 2 }) }).promise;
  assert.equal(r.status, 'purchased');            // the money is gone; reporting otherwise would be a lie
  assert.match(r.warnings.join(' '), /not the wallet/);
});

test('H-BUY-094: an unreadable transaction status still reports the wallet-observed truth', async () => {
  let call = 0;
  const r = await run(
    { transactionstatus: ok('<html>nope</html>') },
    { readWallet: async () => ({ hasWallet: true, currency: 3, balance: call++ === 0 ? 50 : 50 - PRICE / 100 }) },
  ).promise;
  assert.equal(r.status, 'purchased');
  assert.equal(r.chargedMinor, PRICE);
});

// ── Transport failures around the cart ─────────────────────────────────────────────────────────

test('H-BUY-101: a 4xx on add-to-cart stops the run — it must not fall through to whatever was in the cart', async () => {
  const { promise, posts } = run({ addToCart: ok('denied', 403) });
  await assert.rejects(promise, StoreHttpError);
  assert.equal(finalized(posts), false);
});

test('H-BUY-102: a non-200 checkout page fails closed', async () => {
  const { promise, posts } = run({ checkout: ok('', 500) });
  await assert.rejects(promise, StoreHttpError);
  assert.equal(finalized(posts), false);
});
