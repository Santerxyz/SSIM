import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  performWalletPurchase, CS2_APP_ID, CS2_PRIME_APP_ID, CS2_PRIME_SUB_ID,
  type WalletPurchaseEnv,
} from '../src/store/WalletPurchase';
import { StoreHttpError, type StoreContext, type StoreResponse } from '../src/store/StoreService';

// ════════════════════════════════════════════════════════════════════════════════════════════════
//  1.5.1 — owner report: "issue with clearing carts when buying prime".
//
//  performWalletPurchase adds a Prime line to the account's real Steam cart and only then discovers,
//  from Steam, whether the order is one it will go through with. Seventeen exits sit between the add
//  and the charge; exactly ONE of them ("the cart price exceeds the wallet") used to take the line
//  back out. Every other refusal, skip and thrown error left Prime sitting in the account's cart.
//
//  That is not untidiness. emptyCart's own header records what a leftover line costs: the next run
//  reads a cart holding TWO Prime lines, is quoted 26,58 EUR against a 13,34 EUR wallet, and skips
//  the account as "not enough" — an account that could comfortably afford one. A batch of refusals
//  poisoned every cart it touched, and the damage only surfaced on the following run.
//
//  These tests drive the real choreography against a cart that behaves like Steam's — it holds what
//  you put in it until something takes it out — and assert on the STATE THE CART IS LEFT IN, because
//  that is what the next run reads. Every case also asserts nothing was finalized: none of this may
//  cost money.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const PRICE = 1329;                    // 13.29 EUR — the live quote from the owner's own run
const EUR = 3;
const ok = (data: unknown, status = 200): StoreResponse => ({ status, data, location: '' });

interface Line { sub: number; line: string; price: number; valid?: boolean }

/** Steam's `data-store_user_config` blob, entity-escaped into a store page exactly as it ships. */
function cartPage(lines: Line[], token: string | null = 'tok'): string {
  const cfg = {
    webapi_token: token,
    accountcart: {
      cart: {
        line_items: lines.map((l) => ({
          line_item_id: l.line, packageid: l.sub, is_valid: (l.valid ?? true) ? 1 : 0,
          price_when_added: { amount_in_cents: String(l.price), currency_code: EUR, formatted_amount: 'x' },
        })),
        subtotal: { amount_in_cents: String(lines.reduce((s, l) => s + l.price, 0)), currency_code: EUR, formatted_amount: 'x' },
        is_valid: 1, validation_details: null,
      },
      success: 1, rwgrsn: -2,
    },
  };
  const escaped = JSON.stringify(cfg).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<html><body><div data-store_user_config="${escaped}"></div></body></html>`;
}

interface Script {
  /** What the cart already holds when the run starts (a leftover from an earlier run, say). */
  startingLines?: Line[];
  /** Steam refuses to release the cart — neither clearing mechanism works. */
  cartUnclearable?: boolean;
  /** Steam drops an EXTRA line into the cart during add_to_cart — the documented field behaviour:
   *  when the store does not yet see CS2 in the library it adds the free base game alongside Prime,
   *  and the whole cart becomes un-checkout-able. */
  injectOnAdd?: Line;
  /** Non-200 from the checkout page, so the choreography THROWS after the add. */
  checkoutStatus?: number;
  initResult?: number;
  finalPrice?: number;
  addStatus?: number;
}

/** A cart that behaves like Steam's: it keeps what you put in it until something removes it. */
function makeCtx(script: Script = {}) {
  let lines: Line[] = [...(script.startingLines ?? [])];
  const posts: Array<{ path: string; form: Record<string, string> }> = [];
  const clearAttempts: string[] = [];
  let charged = false;
  const phase = (): string => (charged ? 'after-charge' : 'pre-charge');

  const ctx: StoreContext = {
    username: 'WesPetarg6n5', steamId: '76561198000000000', sessionid: 'cookiesid',
    webapi: async (method) => {
      clearAttempts.push(`webapi:${method}:${phase()}`);
      if (!script.cartUnclearable) lines = [];
      return ok({ response: {} });
    },
    get: async (path) => {
      if (path.includes('/dynamicstore/userdata')) return ok({ rgOwnedApps: [CS2_APP_ID], rgOwnedPackages: [303386] });
      if (path === '/cart/' || path === '/') return ok(cartPage(lines));
      if (path.includes('/checkout/transactionstatus/')) return ok({ success: 1, paymentmethod: 128 });
      if (path.includes('checkout.steampowered.com/checkout/')) {
        const st = script.checkoutStatus ?? 200;
        return ok(st === 200 ? '<script>g_sessionID = "cosid42";</script>' : 'nope', st);
      }
      throw new Error(`unscripted GET ${path}`);
    },
    post: async (path, form) => {
      posts.push({ path, form });
      if (path === '/cart/') {
        if (form.action === 'remove_line_item') {
          clearAttempts.push(`remove:${form.lineitem_gid}:${phase()}`);
          if (!script.cartUnclearable) lines = lines.filter((l) => l.line !== form.lineitem_gid);
          return ok('{"success":1}');
        }
        if (script.addStatus && script.addStatus >= 400) return ok('nope', script.addStatus);
        lines.push({ sub: CS2_PRIME_SUB_ID, line: 'L-prime', price: PRICE });
        if (script.injectOnAdd) lines.push(script.injectOnAdd);
        return ok('{"success":1}');
      }
      if (path.includes('inittransaction')) return ok({ success: script.initResult ?? 1, transid: 'TX-9', paymentmethod: 128, purchaseresultdetail: 7 });
      if (path.includes('getfinalprice')) return ok({ success: 1, base: String(PRICE), total: String(script.finalPrice ?? PRICE) });
      if (path.includes('finalizetransaction')) { charged = true; return ok({ success: 1 }); }
      throw new Error(`unscripted POST ${path}`);
    },
  };
  return {
    ctx, posts, clearAttempts,
    cartLines: () => lines,
    finalized: () => posts.some((p) => p.path.includes('finalizetransaction')),
    cartTouchedAfterCharge: () => clearAttempts.some((a) => a.endsWith('after-charge')),
  };
}

function env(walletMajor = 50): WalletPurchaseEnv {
  return {
    readWallet: async () => ({ hasWallet: true, currency: EUR, balance: walletMajor }),
    readOwnedPackageIds: () => [303386, 469902],           // readable, and no Prime
    grantFreeBaseGame: async () => ({ grantedPackageIds: [], grantedAppIds: [] }),
    sleep: async () => { /* no real timers */ },
  };
}

// ── Every pre-commit exit hands the cart back the way it found it ────────────────────────────────

test('H-CRT-060: a cart-verification refusal empties the cart — BOTH lines, not just ours', async () => {
  // The documented field case: Steam drops the free base game in alongside Prime, so the read-back
  // sees two lines and SSIM refuses. Before 1.5.1 that refusal walked away and left the poisoned
  // cart in place, which is exactly the state that then blocks every later run on the account.
  const h = makeCtx({ injectOnAdd: { sub: 303386, line: 'L-freecs2', price: 0 } });
  const r = await performWalletPurchase(h.ctx, env());
  assert.equal(r.status, 'refused');
  assert.match(r.detail, /holds 2 item/);
  assert.equal(h.finalized(), false, 'nothing may be charged');
  assert.deepEqual(h.cartLines(), [], 'the cart is left EMPTY — the next run starts clean');
});

test('H-CRT-061: an inittransaction rejection takes the Prime line back out', async () => {
  const h = makeCtx({ initResult: 2 });
  const r = await performWalletPurchase(h.ctx, env());
  assert.equal(r.status, 'refused');
  assert.match(r.detail, /EResult 2/);
  assert.equal(h.finalized(), false);
  assert.deepEqual(h.cartLines(), [], 'a refused order must not leave Prime in the cart');
});

test('H-CRT-062: wallet-too-low at the FINAL price takes the Prime line back out', async () => {
  // The exact shape that made this bug self-amplifying: an account skipped as "not enough" kept the
  // line, so the NEXT run was quoted double and skipped it again — permanently, on its own.
  const h = makeCtx({ finalPrice: PRICE });
  const r = await performWalletPurchase(h.ctx, env(5));           // 5.00 EUR against a 13.29 EUR price
  assert.equal(r.status, 'skipped');
  assert.equal(h.finalized(), false);
  assert.deepEqual(h.cartLines(), [], 'an account that could not afford it is not left with a poisoned cart');
});

test('H-CRT-063: a journal refusal (an earlier attempt died mid-commit) takes the Prime line back out', async () => {
  const h = makeCtx();
  const r = await performWalletPurchase(h.ctx, env(), () => 'a previous attempt never confirmed');
  assert.equal(r.status, 'refused');
  assert.equal(h.finalized(), false, 'the whole point of the refusal is that nothing fires');
  assert.deepEqual(h.cartLines(), [], 'the cart is clean for whoever comes to reconcile the account');
});

test('H-CRT-064: a THROW between the add and the charge clears the cart AND still propagates', async () => {
  // The path the choreography cannot cover with a `return`: a 5xx from the checkout host. The error
  // must reach the caller unchanged — the cleanup must never swallow or replace it.
  const h = makeCtx({ checkoutStatus: 503 });
  await assert.rejects(
    () => performWalletPurchase(h.ctx, env()),
    (e: Error) => {
      assert.ok(e instanceof StoreHttpError, 'the original StoreHttpError survives the cleanup');
      return /checkout page/.test(e.message);
    },
  );
  assert.equal(h.finalized(), false);
  assert.deepEqual(h.cartLines(), [], 'a thrown run does not leave Prime behind either');
});

test('H-CRT-065: a failed add_to_cart triggers NO cleanup — nothing was added to take back out', async () => {
  const h = makeCtx({ addStatus: 500 });
  await assert.rejects(() => performWalletPurchase(h.ctx, env()), /add-to-cart/);
  assert.deepEqual(h.clearAttempts.filter((a) => a.startsWith('remove:')), [], 'no phantom removals');
  assert.deepEqual(h.cartLines(), []);
});

// ── …and the boundary: once the charge is authorised, the cart is not SSIM's to touch ────────────

test('H-CRT-066: after the charge SSIM never touches the cart — it is evidence, not litter', async () => {
  // Steam clears the cart on a completed order. After an ambiguous or lost reply the cart is the one
  // artefact an operator reconciling the account can look at, so emptying it would destroy evidence.
  const h = makeCtx();
  const r = await performWalletPurchase(h.ctx, env());
  assert.equal(r.status, 'purchased');
  assert.equal(h.finalized(), true);
  assert.equal(h.cartTouchedAfterCharge(), false, 'no cart operation may run after finalizetransaction');
});

// ── A cart Steam will not release is reported, not hidden ────────────────────────────────────────

test('H-CRT-067: a cart that cannot be cleared is named on the row, and still nothing is charged', async () => {
  const h = makeCtx({ initResult: 2, cartUnclearable: true });
  const r = await performWalletPurchase(h.ctx, env());
  assert.equal(r.status, 'refused');
  assert.equal(h.finalized(), false);
  assert.ok(
    r.warnings.some((w) => /still holds .* that SSIM could not remove/.test(w)),
    `the operator is told which account needs a manual cart clear; got ${JSON.stringify(r.warnings)}`,
  );
  assert.ok(h.clearAttempts.length > 0, 'both mechanisms were actually tried');
});

test('H-CRT-068: the pre-run empty still refuses to add to a cart it could not clear', async () => {
  // Unchanged precondition, re-pinned here because the cleanup path now shares emptyCart with it.
  const h = makeCtx({ startingLines: [{ sub: 999999, line: 'L-junk', price: 500 }], cartUnclearable: true });
  const r = await performWalletPurchase(h.ctx, env());
  assert.equal(r.status, 'refused');
  assert.match(r.detail, /could not be emptied/);
  assert.equal(h.posts.some((p) => p.form.action === 'add_to_cart'), false, 'nothing is added to a cart SSIM cannot control');
  assert.equal(h.finalized(), false);
});

test('H-CRT-069: an account that already owns Prime never touches the cart at all', async () => {
  const h = makeCtx();
  const owns: WalletPurchaseEnv = { ...env(), readOwnedPackageIds: () => [303386, CS2_PRIME_SUB_ID] };
  const r = await performWalletPurchase(h.ctx, owns);
  assert.equal(r.status, 'owned');
  assert.deepEqual(h.posts.filter((p) => p.path === '/cart/'), [], 'no cart writes on an ownership short-circuit');
  assert.equal(CS2_PRIME_APP_ID, 624820);
});
