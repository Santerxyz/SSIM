// ════════════════════════════════════════════════════════════════════════════
//  W4_41 — WalletPurchase: buy CS2 PRIME with the account's Steam WALLET BALANCE ONLY.
//
//  Fixed product, fixed ids (owner 2026-08-05): CS2 and its Prime upgrade keep the same
//  package id in every region, so there is nothing to resolve and nothing to configure.
//  No price parameter either — Steam quotes the price in the account's own currency, we
//  check the wallet covers THAT, and we buy.
//
//  The design rests on one structural fact about Steam's checkout:
//
//        inittransaction and getfinalprice DO NOT CHARGE.
//        finalizetransaction is the ONLY step that moves money.
//
//  Which is what makes a price-parameter-free flow safe: the authoritative price arrives from
//  getfinalprice, and everything is still free to abort for two more steps after that.
//
//  WHY THERE IS NO appdetails CALL (the 2026-08-05 field bug): the first cut resolved the
//  package + price from `/api/appdetails?appids=624820`, which answered `{"success":false}` on
//  funded, perfectly normal accounts — that endpoint is IP-rate-limited (~200 req / 5 min) and
//  degrades to a bare success:false, which is indistinguishable from "not sold here". A fleet
//  run tripped it almost immediately. It is gone, not retried around: the ids are constants and
//  the price comes from the checkout itself, which is the only quote that was ever authoritative.
//
//  MONEY-SAFETY INVARIANTS (each one is an executable claim — see walletPurchase.test.ts):
//   1. WALLET-ONLY, PROVEN THREE WAYS. PaymentMethod is the literal 'steamaccount' with
//      bUseRemainingSteamAccount=1, no stored gidPaymentID and no card fields; the wallet is
//      independently read and must COVER Steam's own final total; and if Steam echoes back an
//      EXTERNAL (card/PayPal/…) payment method we abort before finalize.
//   2. 2-DECIMAL WALLETS ONLY. steam-user divides the CM balance by 100 unconditionally, so for
//      a 0-decimal wallet (JPY/KRW/IDR/CLP/VND…) the unit is UNVERIFIED (ManagedSession.wallet,
//      B18). Comparing an unverified balance against Steam's total could clear a purchase 100×
//      the real price, so those accounts are skipped and reported. Same fail-closed call
// BuyService makes for an unrecognised currency code.
//   3. AN UNVERIFIABLE TOTAL IS A REFUSAL. Nobody is watching this checkout, so a total we
//      cannot parse — or one above the absolute ceiling — stops the purchase.
//   4. NEVER BUY WHAT IS ALREADY OWNED — and an ownership signal we cannot READ counts as
//      "do not buy". Skipping is free and re-runnable; a duplicate purchase is not.
//   5. the COMMIT IS NEVER AUTO-RETRIED. A transport fault on finalize is ambiguous by
//      construction; the caller keeps its journal entry and the operator verifies on Steam.
// ════════════════════════════════════════════════════════════════════════════
import {
  StoreShapeError, StoreHttpError, StoreAmbiguousError,
  requireJsonObject, requireEResult, parseMinorUnits,
  type StoreContext, type StoreResponse,
} from './StoreService';
import fs from 'fs';
import { knownCurrencyInfo } from '../pricing/currencies';
import { dataDir } from '../utils/paths';
import { logger } from '../utils/logger';

/** Counter-Strike 2 — the free base game. Prime cannot be bought without it in the library. */
export const CS2_APP_ID = 730;
/** CS2 Prime Status Upgrade. */
export const CS2_PRIME_APP_ID = 624820;

// the PACKAGE ID: A CONSTANT again, BUT NEVER TRUSTED (2026-08-05, fourth field test).
//
// Three attempts got here. (1) Hard-coded 298963 — which is COUNTER-STRIKE 2, the free base game, so
// every run put an unbuyable free item in the cart and Steam refused the order (EResult 2 / detail 7).
// (2) `/api/appdetails` — IP-rate-limited, degrades to `success:false`, i.e. indistinguishable from
// "not sold here". (3) Scraping the id off `/app/624820/` — that page NO LONGER EXISTS; it 302s to the
// Steam front page, so there was no purchase area to scrape. Prime is sold from the CS2 page now.
//
// The id below came from a live account's own CART (see CS2_PRIME_SUB_ID). It is evidence, not a guess.
// And it is still not trusted: after adding it, SSIM reads the cart back out of Steam's embedded
// `data-store_user_config` and refuses unless the cart holds exactly that package, valid and priced.
// A wrong id can therefore cost a refusal — never a charge.

const STORE_ORIGIN = 'https://store.steampowered.com';
const CHECKOUT_ORIGIN = 'https://checkout.steampowered.com';

/** Steam EPaymentMethod. 128 is the Steam Wallet; 2…127 are the EXTERNAL, real-money rails
 *  (2 = CreditCard, 4 = PayPal, 6 = PaySafeCard, …). 0 means "not decided yet" and 1 is an
 *  activation code — neither is evidence of a card, so neither trips the alarm on its own. */
const PM_WALLET = 128;
const isExternalPaymentMethod = (m: number): boolean => Number.isInteger(m) && m >= 2 && m < PM_WALLET;

/**
 * Absolute ceiling on a single purchase, in the wallet's minor units. not an operator setting —
 * there is no price parameter by design. This is the one backstop that does not depend on knowing
 * the price in advance: Prime is ~16.24 EUR / ~14.99 USD, so 200.00 is an order of magnitude of
 * headroom and still catches the case this flow cannot otherwise see — an account whose STANDING
 * Steam cart already held items, on the rare path where Steam hands back no fresh cart id.
 */
export const MAX_PURCHASE_MINOR = 20_000;

export type PurchaseStatus =
  | 'purchased'      // the charge landed and a read-back confirmed it
  | 'owned'          // already had Prime — nothing to do (a success, not a failure)
  | 'skipped'        // a stated reason not to buy (wallet short, currency unsupported) — nothing charged
  | 'refused'        // fail-closed: something could not be verified, so nothing was bought
  | 'unconfirmed';   // the commit went out but the outcome is not confirmed — verify on Steam

export interface WalletPurchaseResult {
  username: string;
  appId: number;
  /** The package SSIM resolved off the store page. Null when it never got that far. */
  subId: number | null;
  currencyIso: string | null;
  /** Steam's own final total for this account, in its wallet's minor units. Null when we never
   *  got far enough to be quoted one. */
  priceMinor: number | null;
  walletMinorBefore: number | null;
  walletMinorAfter: number | null;
  /** Observed wallet drop — the money-truth, not what we intended to spend. */
  chargedMinor: number | null;
  transid: string | null;
  status: PurchaseStatus;
  detail: string;
  warnings: string[];
}

/** Everything the choreography needs from the live session, injected so the whole flow is
 *  exercisable with no Steam, no network and no session. */
export interface WalletPurchaseEnv {
  /** The account's wallet, awaited (never read straight off a fresh login — it races). */
  readWallet(): Promise<{ hasWallet: boolean; currency: number; balance: number } | undefined>;
  /** Package ids this account holds, from the LOGGED-IN CM connection (client.licenses). `null` means
   *  "could not read" — which is a refusal, never an assumed "doesn't own it". */
  readOwnedPackageIds(): number[] | null;
  /** Put the FREE Counter-Strike 2 licence on the account — the "add to library" action, which is a
   *  LIBRARY grant and never a cart operation. Returns what Steam says it granted, so the caller can
   *  tell "granted just now" from "nothing happened". Idempotent. */
  grantFreeBaseGame(): Promise<{ grantedPackageIds: number[]; grantedAppIds: number[] }>;
  /** Back-off between transaction-status polls. Injected so tests drive the post-commit read-back
   *  without waiting on real timers; production leaves it out and gets the real schedule. */
  sleep?(ms: number): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Steam wallet → minor units of ITS own currency, or null when that cannot be done SAFELY.
 * Deliberately narrower than a generic converter: an unknown code or a non-2-decimal
 *  currency (B18 — steam-user's ÷100 makes the unit unverified) yields null, and null means the
 *  account is skipped rather than charged against a guessed scale. */
export function walletNativeMinor(w?: { hasWallet: boolean; currency: number; balance: number }): { minor: number; iso: string } | null {
  if (!w) return null;
  const info = knownCurrencyInfo(w.currency);
  if (!info) return null;
  if (info.decimals !== 2) return null;
  if (typeof w.balance !== 'number' || !Number.isFinite(w.balance) || w.balance < 0) return null;
  return { minor: Math.round(w.balance * 100), iso: info.iso };
}

/**
 * Narrow steam-user's under-typed `client.licenses` into the package-id list the ownership gate needs.
 * Returns null for "could not determine", which the caller treats as a REFUSAL to buy.
 *
 * An EMPTY array on a live CM session is not credible — every account in a CS2 fleet holds at least
 * its free CS2 licence — so empty also reads as "could not determine" rather than "owns nothing".
 * That asymmetry is deliberate: mis-reading absence as "doesn't own it" is what buys a second copy.
 */
export function ownedPackageIdsFrom(licenses: unknown): number[] | null {
  if (!Array.isArray(licenses)) return null;
  const ids = licenses.map((l) => Number((l as { package_id?: unknown } | null)?.package_id)).filter(Number.isInteger);
  return ids.length ? ids : null;
}

/**
 * Package/app ids visible to the STORE for this session (`/dynamicstore/userdata/`). Used only to
 * CORROBORATE the CM licence list — never as the sole ownership source, because a stale session
 * gets the same empty arrays a brand-new account does, and "empty" would then read as "buy it".
 * Returns null when the payload is not the shape we expect.
 */
export async function readStoreOwnedPackages(ctx: StoreContext): Promise<{ apps: number[]; packages: number[] } | null> {
  try {
    const res = await ctx.get('/dynamicstore/userdata/');
    if (res.status !== 200) return null;
    const obj = requireJsonObject(res.data, 'userdata');
    const nums = (v: unknown): number[] | null => (Array.isArray(v) ? v.map(Number).filter(Number.isInteger) : null);
    const apps = nums(obj.rgOwnedApps), packages = nums(obj.rgOwnedPackages);
    if (!apps || !packages) return null;
    return { apps, packages };
  } catch { return null; }   // corroboration only — its absence never decides anything on its own
}

/**
 * the PRIME PACKAGE — 54029, and this one is EVIDENCE, not a guess.
 *
 * It was read out of a live account's own Steam cart (2026-08-05):
 *   {"packageid":54029,"is_valid":1,"price_when_added":{"amount_in_cents":"1329","currency_code":3,
 *    "formatted_amount":"13,29€"}}
 * which matches the "Prime-Status-Upgrade 13,29€" line the owner saw in the browser.
 *
 * The previous constant (298963) was COUNTER-STRIKE 2 — the free base game — so every run put an
 * unbuyable free item in the cart. And the attempt after that, scraping the id off
 * store.steampowered.com/app/624820/, failed for a reason worth recording: **that page no longer
 * exists.** It 302s to the Steam front page ("Welcome to Steam"), which has no purchase area at all.
 * Prime is sold from the Counter-Strike 2 page now, not its own.
 *
 * So the id is a constant again — but it is never TRUSTED. After adding it, SSIM re-reads the cart and
 * refuses unless the cart holds exactly this package. A wrong id can therefore cost a refusal, never a
 * charge; and if Valve ever changes it, the failure names the package that actually landed.
 */
export const CS2_PRIME_SUB_ID = 54029;

/** 'unreadable' is NOT 'missing'. Steam answers an unreadable account exactly the way it answers one
 *  that owns nothing, so collapsing the two is the mistake that buys a second copy — and, on the
 *  read-only fleet report, the mistake that tells an operator to go and buy 40 licences they already
 *  have. Every surface keeps the three states apart. */
export type PrimeOwnership = 'owned' | 'missing' | 'unreadable';

/**
 * The ONE CS2-Prime ownership verdict.
 *
 * 1.5.1 added a read-only fleet check ("which of these accounts already has Prime?") next to the
 * purchase. Two implementations of "does this account have Prime" that can disagree would be a
 * liability: the report would say one thing and the money path do another. This function IS the
 * report's implementation, and it reproduces step 2 of performWalletPurchase exactly, in the order
 * that gate has always used:
 *
 *   1. licences unreadable            → 'unreadable'  (refuse to guess; the buy path refuses to buy)
 *   2. store sees the Prime APP        → 'owned'
 *   3. CM licence list holds the sub   → 'owned'
 *   4. store sees the Prime PACKAGE    → 'owned'
 *   5. otherwise                       → 'missing'
 *
 * `licensed` is the CM licence list (authoritative — it comes off the logged-in connection, not a
 * cookie that may have gone stale); `storeOwned` only corroborates and may be null.
 *
 * performWalletPurchase deliberately still holds its own copy of these checks rather than calling in
 * here: rewriting a money gate to add a read-only report is not a trade worth making, and its early
 * return also skips the store fetch entirely when the licences are unreadable. The two are held in
 * step by test/primeOwnershipParity.test.ts, which drives the REAL purchase choreography across
 * every ownership input and asserts it reaches the same verdict this function does. If anyone
 * changes one of them, that test fails.
 */
export function primeOwnership(
  licensed: number[] | null,
  storeOwned: { apps: number[]; packages: number[] } | null,
): { state: PrimeOwnership; detail: string } {
  if (licensed == null)
    return { state: 'unreadable', detail: "could not read this account's licences, so SSIM cannot tell whether it already has Prime" };
  if (storeOwned?.apps.includes(CS2_PRIME_APP_ID))
    return { state: 'owned', detail: 'already has CS2 Prime (the Steam store reports it in the library)' };
  if (licensed.includes(CS2_PRIME_SUB_ID))
    return { state: 'owned', detail: 'already has CS2 Prime' };
  if (storeOwned?.packages.includes(CS2_PRIME_SUB_ID))
    return { state: 'owned', detail: 'already has CS2 Prime (the Steam store reports the package on the account)' };
  return { state: 'missing', detail: 'does not have CS2 Prime' };
}

export interface CartLineItem {
  lineItemId: string;
  packageId: number;
  isValid: boolean;
  priceMinor: number | null;
}
export interface AccountCart {
  items: CartLineItem[];
  subtotalMinor: number | null;
  /** Steam ECurrencyCode the cart is denominated in — compared against the WALLET's currency. */
  currencyCode: number | null;
  isValid: boolean;
  /** The `webapi_token` Steam publishes alongside the cart. It is what the store's own JS uses to call
   *  IAccountCartService, and it is the credential for `ctx.webapi` — never a cookie. */
  webapiToken: string | null;
}

/** HTML entity decode for an attribute payload. `&amp;` LAST, or "&amp;quot;" would double-decode. */
function unescapeHtmlAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, '\'').replace(/&apos;/g, '\'')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * The account's real cart, out of the `data-store_user_config` blob Steam embeds on its store pages.
 *
 * This is the single most useful thing the 2026-08-05 page dump turned up. Steam ships the live cart as
 * JSON on the page — `line_items[]` with `packageid` and `line_item_id` (needed to remove one), each
 * item's `is_valid`, the cart-level `is_valid`, and a `subtotal` with `amount_in_cents` + `currency_code`.
 *
 * That replaces three separate guesses at once: scraping line-item ids out of markup, scraping a price
 * off a store page, and hoping the cart contained what we put in it. Everything is now verified against
 * Steam's own view of the cart before a transaction is ever opened.
 */
export function parseAccountCart(html: string): AccountCart | null {
  const at = html.indexOf('data-store_user_config="');
  if (at < 0) return null;
  const vStart = at + 'data-store_user_config="'.length;
  const vEnd = html.indexOf('"', vStart);          // the value is entity-escaped, so it holds no raw quote
  if (vEnd < 0) return null;
  let cfg: Record<string, unknown>;
  try { cfg = JSON.parse(unescapeHtmlAttr(html.slice(vStart, vEnd))) as Record<string, unknown>; }
  catch { return null; }
  const cart = (cfg.accountcart as { cart?: Record<string, unknown> } | undefined)?.cart;
  if (!cart || typeof cart !== 'object') return null;

  const raw = Array.isArray(cart.line_items) ? cart.line_items as Array<Record<string, unknown>> : [];
  const items: CartLineItem[] = [];
  for (const li of raw) {
    const packageId = Number(li?.packageid);
    if (!Number.isSafeInteger(packageId) || packageId <= 0) continue;
    items.push({
      lineItemId: String(li?.line_item_id ?? ''),
      packageId,
      isValid: li?.is_valid === 1 || li?.is_valid === true,
      priceMinor: parseMinorUnits((li?.price_when_added as Record<string, unknown> | undefined)?.amount_in_cents),
    });
  }
  const sub = cart.subtotal as Record<string, unknown> | undefined;
  const currency = Number(sub?.currency_code);
  const token = typeof cfg.webapi_token === 'string' ? cfg.webapi_token : null;
  return {
    items,
    subtotalMinor: parseMinorUnits(sub?.amount_in_cents),
    currencyCode: Number.isSafeInteger(currency) && currency > 0 ? currency : null,
    isValid: cart.is_valid === 1 || cart.is_valid === true,
    webapiToken: token,
  };
}

/** Read the account cart off a store page. `/cart/` first (where cart state most belongs); the blob is
 *  a GLOBAL store config, so the storefront is a legitimate second read of the same value — not a
 *  fallback that hides anything. Returns null when neither page carried it. */
export async function readAccountCart(ctx: StoreContext): Promise<AccountCart | null> {
  for (const path of ['/cart/', '/']) {
    try {
      const res = await ctx.get(path, { accept: 'text/html' });
      if (res.status !== 200) continue;
      const cart = parseAccountCart(typeof res.data === 'string' ? res.data : '');
      if (cart) return cart;
    } catch { /* try the other page */ }
  }
  return null;
}

/** Best-effort page dump for diagnosis. Bounded, one file per account, never throws. */
export function dumpPage(html: string, username: string, label = 'cart'): string | null {
  try {
    const safe = username.replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
    const file = dataDir(`prime-${label}-${safe}.html`);
    fs.writeFileSync(file, html.slice(0, 600_000), 'utf8');
    logger.warn(`[prime] ${username}: unparseable store page saved to ${file}`);
    return file;
  } catch { return null; }
}
/** Steam's EPurchaseResultDetail, for the handful that actually explain a refused checkout. The raw
 *  number is useless to an operator; "your cart holds something unbuyable" is actionable. */
export function purchaseDetailHint(detail: number): string {
  switch (detail) {
    case 2:  return 'Steam says the funds are insufficient.';
    case 5:  return 'Steam says the package is invalid — the Prime package may have changed id.';
    case 6:  return 'Steam rejected the payment method (the wallet was not accepted for this order).';
    case 7:  return 'Steam says the order data is invalid — this is what it reports when the account\'s Steam cart holds an item that cannot be bought (a free game such as Counter-Strike 2 sitting in the cart will do it). Open store.steampowered.com/cart/ for this account, empty it, and re-run.';
    case 9:  return 'Steam says this was already purchased.';
    case 13: case 19: return 'Steam says this product is not sold in the account\'s country.';
    case 20: return 'Steam says the account is blocked.';
    case 21: return 'Steam says the account is not verified (a new account, or a recent email/password change).';
    case 23: return 'Steam says the account\'s billing country does not match its store country.';
    case 24: return 'Steam says the account does not own an app this purchase requires — the free Counter-Strike 2 licence did not land.';
    case 31: return 'Steam says the wallet currency does not match the store currency.';
    default: return '';
  }
}

/**
 * Make sure the STORE sees Counter-Strike 2 in this account's library before anything goes in the cart.
 *
 * This is the 2026-08-05 field bug, and the ordering is the whole fix. Adding Prime to the cart while
 * Steam thinks the account lacks CS2 makes Steam drop the free base game into the cart alongside it
 * ("your account is missing items required to purchase this content"). CS2 is not purchasable, so the
 * cart becomes un-checkout-able and `inittransaction` answers EResult 2 / detail 7 — for every account,
 * as it did. Nothing is charged, but the account is left with a poisoned cart that blocks later runs.
 *
 * A grant is not enough on its own: `requestFreeLicense` returns as soon as the CM accepts it, and the
 * STORE — which is what decides what the cart may contain — takes a moment to catch up. So we grant and
 * then WAIT for the store to agree, and refuse if it never does.
 *
 * Returns null when CS2 is in the library, or a refusal reason. `owned` is the userdata already read for
 * the Prime check, so the common case (already owns it) costs no extra request.
 */
export async function ensureBaseGameInLibrary(
  ctx: StoreContext,
  env: WalletPurchaseEnv,
  owned: { apps: number[]; packages: number[] } | null,
  warnings: string[],
): Promise<string | null> {
  if (owned?.apps.includes(CS2_APP_ID)) return null;          // the store already sees it — nothing to do

  let granted: { grantedPackageIds: number[]; grantedAppIds: number[] };
  try {
    granted = await env.grantFreeBaseGame();
  } catch (e) {
    return `could not add the free Counter-Strike 2 licence (${(e as Error).message}), and Steam does not sell the Prime upgrade without it. Nothing was bought.`;
  }
  const grantLanded = granted.grantedAppIds.includes(CS2_APP_ID) || granted.grantedPackageIds.length > 0;

  const wait = env.sleep ?? sleep;
  for (let attempt = 0; attempt < 5; attempt++) {
    await wait(700 * (attempt + 1));                          // ~10.5s total, then we stop guessing
    const now = await readStoreOwnedPackages(ctx);
    if (now?.apps.includes(CS2_APP_ID)) return null;          // the store agrees — safe to build a cart
    if (now == null) {
      // We cannot read the store's view. Refuse only on POSITIVE evidence of absence: if the CM said it
      // granted the licence, proceed and let Steam have the final word, loudly flagged.
      if (grantLanded) {
        warnings.push('Steam\'s library read was unavailable, so SSIM could not confirm Counter-Strike 2 landed before building the cart.');
        return null;
      }
    }
  }
  return `Counter-Strike 2 is still not in this account's library after being requested${grantLanded ? ' (Steam accepted the grant but has not applied it yet)' : ' (Steam granted nothing)'}. Adding Prime to the cart now would make Steam add the unbuyable base game alongside it and reject the whole order, so nothing was bought. Re-run in a few minutes.`;
}

/**
 * EMPTY the account's Steam cart, and PROVE it is empty.
 *
 * This is a hard precondition, not tidying (owner 2026-08-05). A Prime line left over from an earlier
 * run made the next run's cart hold two Prime lines: 26,58 € against a 13,34 € wallet, so the account
 * was skipped as "not enough" even though it could well afford one. Every leftover is somebody's money
 * problem later, so the cart must be provably empty before anything is added.
 *
 * Two mechanisms, each tried once and each VERIFIED by re-reading the cart:
 *  1. `IAccountCartService/DeleteCart` over the token WebAPI — what Steam's own store JS uses (the
 *     `webapi_token` sits right next to the cart in the same blob). No cookies, no allowlist change.
 *  2. The legacy `POST /cart/ action=remove_line_item` per line, which is the same handler that
 *     `add_to_cart` demonstrably still works through.
 *
 * Returns the final cart when it is EMPTY, or null when it could not be emptied — and the caller
 * refuses on null. Never throws.
 */
export async function emptyCart(ctx: StoreContext, warnings: string[]): Promise<AccountCart | null> {
  let cart = await readAccountCart(ctx);
  if (!cart) return null;
  if (!cart.items.length) return cart;
  const held = cart.items.length;

  if (cart.webapiToken) {
    try {
      const res = await ctx.webapi('IAccountCartService/DeleteCart/v1', cart.webapiToken);
      const after = await readAccountCart(ctx);
      if (after && !after.items.length) { logger.info(`[prime] ${ctx.username}: emptied ${held} cart line(s) via DeleteCart`); return after; }
      // The read-back is still the only thing that DECIDES — but the status is why it did not work,
      // and it used to be thrown away. webapiPost sets validateStatus:()=>true, so an expired
      // `webapi_token` comes back as a plain 401 and this whole branch failed in total silence: the
      // operator saw "SSIM could not remove" with nothing to act on and no way to tell a dead token
      // from a cart Steam refuses to release.
      if (res.status !== 200) logger.warn(`[prime] ${ctx.username}: DeleteCart → HTTP ${res.status} — falling back to per-line removal`);
      else logger.warn(`[prime] ${ctx.username}: DeleteCart returned 200 but the cart still holds ${after?.items.length ?? '?'} line(s) — falling back to per-line removal`);
      if (after) cart = after;
    } catch (e) { logger.warn(`[prime] ${ctx.username}: DeleteCart failed (${(e as Error).message}) — falling back to per-line removal`); }
  } else {
    logger.warn(`[prime] ${ctx.username}: no webapi_token on the cart page — DeleteCart unavailable, using per-line removal`);
  }

  let posted = 0, postFailed = 0;
  for (const it of cart.items) {
    if (!it.lineItemId) continue;
    try {
      const rm = await ctx.post('/cart/', { action: 'remove_line_item', cart: '-1', lineitem_gid: it.lineItemId, sessionid: ctx.sessionid }, { referer: `${STORE_ORIGIN}/cart/` });
      if (rm.status >= 400) { postFailed++; logger.warn(`[prime] ${ctx.username}: remove_line_item(${it.lineItemId}) → HTTP ${rm.status}`); }
      else posted++;
    }
    catch (e) { postFailed++; logger.warn(`[prime] ${ctx.username}: remove_line_item(${it.lineItemId}) failed: ${(e as Error).message}`); }
  }
  const after = await readAccountCart(ctx);
  if (after && !after.items.length) { logger.info(`[prime] ${ctx.username}: emptied ${held} cart line(s) via remove_line_item`); return after; }

  // Name what was actually tried. "Could not remove" on its own tells whoever reads the run nothing
  // about whether Steam rejected the calls or accepted them and kept the cart anyway.
  const stuck = after?.items.length ?? held;
  logger.error(`[prime] ${ctx.username}: cart NOT emptied — ${stuck} line(s) remain after ${posted} accepted + ${postFailed} failed remove_line_item call(s)${after ? '' : ' (and the cart could not be re-read)'}`);
  warnings.push(`this account's Steam cart still holds ${stuck} item(s) that SSIM could not remove.`);
  return null;
}

/** A finished row, so every early return reads the same way. */
function done(base: Partial<WalletPurchaseResult>, username: string, status: PurchaseStatus, detail: string, warnings: string[]): WalletPurchaseResult {
  return {
    username, appId: CS2_PRIME_APP_ID, subId: null, currencyIso: null, priceMinor: null,
    walletMinorBefore: null, walletMinorAfter: null, chargedMinor: null, transid: null,
    ...base, status, detail, warnings: [...warnings],
  };
}

/**
 * Buy CS2 Prime for the account behind `ctx`, from its wallet balance.
 *
 * Steps 1-3 are reads and refusals. Steps 4-6 build a cart and open a transaction — which still
 * charges nothing, and is where Steam finally quotes the price. Step 7 is the only charge, guarded
 * by `beginCommit` (the caller's double-spend journal) and never retried.
 */
export async function performWalletPurchase(
  ctx: StoreContext,
  env: WalletPurchaseEnv,
  /** Called at the LAST moment before the charge — after every gate has passed, so the caller journals
   *  exactly the op that is about to fire and nothing it merely considered. Returning a string REFUSES
   *  the commit with that reason (that is how a lingering entry from an earlier crash stops a re-fire).
   *  Absent ⇒ nothing is journalled, which is only ever acceptable in tests. */
  beginCommit?: (about: { subId: number; totalMinor: number; currencyIso: string }) => string | null,
): Promise<WalletPurchaseResult> {
  // The choreography's own exits take the Prime line back out of the cart (see `abandon`). This
  // wrapper covers the other way out: a THROW between the add and the charge — a 5xx from the
  // checkout host, a shape error, a dropped connection. Those left the line behind too.
  //
  // `holdsPrime` is set the moment the line lands in the cart and cleared the instant the charge is
  // authorised, so this can never fire after money has moved — past that point Steam owns the cart
  // and SSIM must not touch it.
  const cartState: CartState = { holdsPrime: false };
  try {
    return await purchaseChoreography(ctx, env, cartState, beginCommit);
  } catch (e) {
    if (cartState.holdsPrime) {
      cartState.holdsPrime = false;
      try { await emptyCart(ctx, []); }
      catch { /* best-effort: the original failure is what the caller must see, not this one */ }
    }
    throw e;
  }
}

/** Whether the account's cart currently holds the Prime line THIS call put there. See the wrapper. */
interface CartState { holdsPrime: boolean }

async function purchaseChoreography(
  ctx: StoreContext,
  env: WalletPurchaseEnv,
  cartState: CartState,
  beginCommit?: (about: { subId: number; totalMinor: number; currencyIso: string }) => string | null,
): Promise<WalletPurchaseResult> {
  const username = ctx.username;
  const warnings: string[] = [];
  const money = (m: number, iso: string): string => `${(m / 100).toFixed(2)} ${iso}`;

  // ── 1) The wallet. Read first: it decides the currency everything else is measured in, and an
  //       account we cannot price safely must be skipped before we touch its store at all. ──
  const wallet = await env.readWallet();
  const native = walletNativeMinor(wallet);
  if (!native) {
    // A wallet that has never held funds reports hasWallet:false / currency 0 — a real, empty wallet
    // rather than an unreadable one. Neither can pay, but on a 500-account report "no balance" and
    // "SSIM cannot read this currency" mean very different things to whoever reads it.
    if (wallet && !wallet.hasWallet)
      return done({}, username, 'skipped', 'not bought — this account has no Steam wallet balance at all. Top it up and re-run.', warnings);
    const info = knownCurrencyInfo(wallet?.currency);
    const why = !wallet ? 'its wallet balance could not be read'
      : !info ? `its wallet currency code (${wallet.currency}) is not one SSIM knows`
        : `its wallet is ${info.iso}, a ${info.decimals}-decimal currency whose Steam balance unit SSIM has not verified`;
    return done({}, username, 'skipped', `not bought — ${why}. Comparing a balance at a guessed scale against Steam's price could clear a purchase 100× the real one, so SSIM refuses rather than approximates.`, warnings);
  }
  const { minor: walletBefore, iso } = native;
  const base = { currencyIso: iso, walletMinorBefore: walletBefore };

  // ── 2) Ownership. The CM licence list is authoritative (it comes from the logged-in connection,
  //       not a cookie that may have gone stale); the store's userdata only corroborates it. ──
  const licensed = env.readOwnedPackageIds();
  if (licensed == null)
    return done(base, username, 'refused', 'could not read this account\'s licences, so SSIM cannot tell whether it already has Prime — refusing rather than risking a second purchase.', warnings);
  const storeOwned = await readStoreOwnedPackages(ctx);
  if (storeOwned?.apps.includes(CS2_PRIME_APP_ID))
    return done(base, username, 'owned', 'already has CS2 Prime (the Steam store reports it in the library) — nothing bought.', warnings);

  Object.assign(base, { subId: CS2_PRIME_SUB_ID });
  if (licensed.includes(CS2_PRIME_SUB_ID))
    return done(base, username, 'owned', 'already has CS2 Prime — nothing bought.', warnings);
  if (storeOwned?.packages.includes(CS2_PRIME_SUB_ID))
    return done(base, username, 'owned', 'already has CS2 Prime (the Steam store reports the package on the account) — nothing bought.', warnings);

  // ── 3) The free base game, IN THE LIBRARY and CONFIRMED THERE, before the cart is touched. Getting
  //       this order wrong is what made Steam drop an unbuyable "Counter-Strike 2" line into every
  //       cart and refuse the lot (EResult 2 / detail 7). See ensureBaseGameInLibrary. ──
  const baseGameRefusal = await ensureBaseGameInLibrary(ctx, env, storeOwned, warnings);
  if (baseGameRefusal) return done(base, username, 'refused', baseGameRefusal, warnings);

  // ── 4) Cart: EMPTY IT first (proven empty), add Prime, then verify against Steam's own view. ──
  //       A leftover Prime line from an earlier run is what made a later run hold two of them —
  //       26,58 € against a 13,34 € wallet, skipped as "not enough". Emptying is a precondition now.
  if (!(await emptyCart(ctx, warnings)))
    return done(base, username, 'refused', 'this account\'s Steam cart could not be emptied, so SSIM will not add to it — a leftover item would be paid for or would block the order. Empty it at store.steampowered.com/cart/ and re-run. Nothing was charged.', warnings);

  const add = await ctx.post('/cart/', { action: 'add_to_cart', subid: String(CS2_PRIME_SUB_ID), sessionid: ctx.sessionid, originating_snr: '' }, { referer: `${STORE_ORIGIN}/app/${CS2_APP_ID}/` });
  if (add.status >= 400) throw new StoreHttpError(add.status, `add-to-cart(${CS2_PRIME_SUB_ID}) → ${add.status}`);
  cartState.holdsPrime = true;   // from here the cart holds our line — every exit below takes it back out

  // ── ABANDONING, after the add and before the charge ───────────────────────────────────────────
  // Take the Prime line out again, THEN report. Nothing has been charged on any path that reaches
  // here, so removing what we just added is always the right move.
  //
  // Until 1.5.1 only the "cart price exceeds the wallet" branch did this, and the other fifteen exits
  // — a failed cart read-back, a foreign package, an invalid cart, an inittransaction rejection, a
  // card rail echoed instead of the wallet, wallet-too-low at the FINAL price, a journal refusal —
  // all left Prime sitting in the account cart. That is not untidiness. The NEXT run reads a cart
  // holding two Prime lines, is quoted double, and skips the account as "not enough": exactly the
  // 26,58-against-13,34-EUR failure emptyCart() exists to prevent, arriving from the other
  // direction. At fleet scale one batch of refusals poisoned every cart it touched.
  const abandon = async (b: Partial<WalletPurchaseResult>, status: PurchaseStatus, detail: string): Promise<WalletPurchaseResult> => {
    if (cartState.holdsPrime) {
      cartState.holdsPrime = false;
      // emptyCart pushes its own warning when it cannot clear, so a cart SSIM could not tidy is
      // reported on the row rather than discovered by the next run.
      try { await emptyCart(ctx, warnings); }
      catch { warnings.push(`SSIM could not empty the Steam cart for this account after abandoning the purchase — clear it at ${STORE_ORIGIN}/cart/.`); }
    }
    return done(b, username, status, detail, warnings);
  };

  // the VERIFICATION. Steam publishes the live cart, so we do not hope the cart holds what we put in
  // it — we read it back and require exactly one line, exactly the Prime package, valid, priced, in
  // this wallet's currency. "Exactly one" is load-bearing: checking only for FOREIGN packages let two
  // Prime lines through, and two Prime lines is a doubled bill.
  const cart = await readAccountCart(ctx);
  if (!cart) {
    const body = typeof add.data === 'string' ? add.data : '';
    const dump = body ? dumpPage(body, username, 'cart') : null;
    return await abandon(base, 'refused', `SSIM could not read this account's Steam cart back after adding Prime, so it could not confirm what would be paid for. Nothing was charged.${dump ? ` Page saved to ${dump}.` : ''}`);
  }
  if (cart.items.length !== 1)
    return await abandon(base, 'refused', `this account's Steam cart holds ${cart.items.length} item(s) (package ${cart.items.map((i) => i.packageId).join(', ') || 'none'}) instead of just CS2 Prime, so the order would not be for one Prime. Empty it at store.steampowered.com/cart/ and re-run. Nothing was charged.`);
  const primeLine = cart.items[0];
  if (primeLine.packageId !== CS2_PRIME_SUB_ID)
    return await abandon(base, 'refused', `Steam put package ${primeLine.packageId} in the cart instead of CS2 Prime (${CS2_PRIME_SUB_ID}) — the package id may have changed. Nothing was charged.`);
  if (!primeLine.isValid || !cart.isValid)
    return await abandon(base, 'refused', 'Steam marked this account\'s cart as not valid for checkout (usually a region or ownership restriction on the account). Nothing was charged.');
  if (cart.currencyCode != null && wallet && cart.currencyCode !== wallet.currency)
    return await abandon(base, 'refused', `this account's Steam cart is priced in currency ${cart.currencyCode} but its wallet is currency ${wallet.currency} — a wallet cannot pay a differently-denominated cart. Nothing was charged.`);

  const cartMinor = cart.subtotalMinor ?? primeLine.priceMinor;
  if (cartMinor == null || cartMinor <= 0)
    return await abandon(base, 'refused', 'Steam reported no cart price for CS2 Prime, so the charge could not be verified in advance. Nothing was charged.');
  Object.assign(base, { priceMinor: cartMinor });
  // The cart price is region-correct and authoritative, so an account that cannot afford Prime stops
  // here — and its cart is emptied again so nothing is left sitting in it.
  if (cartMinor > walletBefore)
    return await abandon(base, 'skipped', `not bought — CS2 Prime costs ${money(cartMinor, iso)} for this account and its wallet holds ${money(walletBefore, iso)}. Top it up and re-run. Nothing was charged.`);

  // The account cart IS the cart now (Steam moved carts onto the account), so the checkout is opened
  // against it rather than a per-submit gid.
  const gidShoppingCart = '-1', bUseAccountCart = '1';

  // ── 5) Open the transaction on the CHECKOUT host, wallet forced. Still no charge. ──
  const checkoutUrl = `${CHECKOUT_ORIGIN}/checkout/?${bUseAccountCart === '1' ? 'accountcart=1' : `cart=${gidShoppingCart}`}&purchasetype=self`;
  const co = await ctx.get(checkoutUrl, { accept: 'text/html', referer: `${STORE_ORIGIN}/cart/` });
  if (co.status !== 200) throw new StoreHttpError(co.status, `checkout page → ${co.status}`);
  const coHtml = typeof co.data === 'string' ? co.data : '';
  const coSidM = coHtml.match(/g_sessionID\s*=\s*"([A-Za-z0-9]+)"/i) ?? coHtml.match(/name="sessionid"\s+value="([A-Za-z0-9]+)"/i);
  const checkoutSid = coSidM ? coSidM[1] : ctx.sessionid;

  // Every card/billing field is EMPTY and bSaveBillingAddress is 0: a wallet purchase must neither
  // carry payment details nor write an address onto the account. gidPaymentID empty = no stored card.
  const initForm: Record<string, string> = {
    gidShoppingCart, gidReplayOfTransID: '-1', bUseAccountCart, PaymentMethod: 'steamaccount', abortPendingTransactions: '1',
    bHasCardInfo: '0', CardNumber: '', CardExpirationYear: '', CardExpirationMonth: '', CardCVV2: '',
    FirstName: '', LastName: '', Address: '', AddressTwo: '', Country: '', City: '', State: '', PostalCode: '', Phone: '',
    ShippingFirstName: '', ShippingLastName: '', ShippingAddress: '', ShippingAddressTwo: '', ShippingCountry: '', ShippingCity: '', ShippingState: '', ShippingPostalCode: '', ShippingPhone: '',
    bIsGift: '0', GifteeAccountID: '', GifteeEmail: '', GifteeName: '', GiftMessage: '', Sentiment: '', Signature: '', ScheduledSendOnDate: '',
    BankAccount: '', BankCode: '', BankIBAN: '', BankBIC: '', TPBankID: '', BankAccountID: '',
    bSaveBillingAddress: '0', gidPaymentID: '', bUseRemainingSteamAccount: '1', bPreAuthOnly: '0',
    sessionid: checkoutSid,
  };
  const initRes = await ctx.post(`${CHECKOUT_ORIGIN}/checkout/inittransaction/`, initForm, { referer: checkoutUrl });
  if (initRes.status !== 200) throw new StoreHttpError(initRes.status, `inittransaction → ${initRes.status}`);
  const initObj = requireJsonObject(initRes.data, 'inittransaction');
  const initResult = requireEResult(initObj);
  if (initResult !== 1) {
    const detail = Number(initObj.purchaseresultdetail);
    logger.warn(`[prime] ${username}: inittransaction EResult=${initResult} detail=${initObj.purchaseresultdetail ?? '?'} (cart=${gidShoppingCart}/${bUseAccountCart})`);
    const hint = Number.isInteger(detail) ? purchaseDetailHint(detail) : '';
    return await abandon(base, 'refused', `Steam refused to open the purchase (EResult ${initResult}, detail ${initObj.purchaseresultdetail ?? '?'}). ${hint} Nothing was charged.`.replace(/\s+/g, ' ').trim());
  }
  const transid = String(initObj.transid ?? '');
  if (!transid || transid === 'undefined' || transid === 'null')
    return await abandon(base, 'refused', 'Steam opened no transaction id — nothing was charged.');

  // WALLET-ONLY GATE: Steam echoing a card/PayPal rail here means our PaymentMethod did not take.
  // Bailing now is free — the transaction is open but unpaid, and Steam expires it on its own.
  const echoed = Number(initObj.paymentmethod);
  if (isExternalPaymentMethod(echoed)) {
    logger.error(`[prime] ${username}: REFUSED — Steam selected payment method ${echoed} (external), not the wallet`);
    return await abandon({ ...base, transid }, 'refused', `Steam selected payment method ${echoed} instead of the Steam wallet. SSIM aborted before paying — nothing was charged, and no card was used.`);
  }

  // ── 6) getfinalprice — Steam quotes the price, in this account's currency. This is the only
  //       authoritative price there is, and it arrives while everything is still free to abort. ──
  const fp = await ctx.post(`${CHECKOUT_ORIGIN}/checkout/getfinalprice/`, { count: '1', transid, purchasetype: 'self', microtxnid: '-1', cart: gidShoppingCart, gidReplayOfTransID: '-1', bUseAccountCart, sessionid: checkoutSid }, { referer: checkoutUrl });
  if (fp.status !== 200) throw new StoreHttpError(fp.status, `getfinalprice → ${fp.status}`);
  const fo = requireJsonObject(fp.data, 'getfinalprice');
  const fpResult = requireEResult(fo);
  if (fpResult !== 1)
    return await abandon({ ...base, transid }, 'refused', `Steam did not price the order (EResult ${fpResult}) — nothing was charged.`);

  const total = parseMinorUnits(fo.total);
  if (total == null)
    return await abandon({ ...base, transid }, 'refused', 'Steam did not report an order total, so the charge could not be verified in advance. Nothing was bought.');
  const priced = { ...base, transid, priceMinor: total };
  if (total <= 0) {
    logger.warn(`[prime] ${username}: REFUSED — Steam priced the order at ${total}`);
    return await abandon(priced, 'refused', `Steam priced this order at ${money(total, iso)}, which cannot be right for CS2 Prime. Nothing was charged.`);
  }
  // Now that the store page told us what Prime actually costs here, a total ABOVE it means the cart
  // holds something else. Steam charging less is a sale and fine; charging more is not.
  // The cart said what this costs; the checkout must not exceed it. Less is a sale and fine.
  if (total > cartMinor || total > MAX_PURCHASE_MINOR) {
    logger.error(`[prime] ${username}: REFUSED — order total ${total} exceeds the cart price ${cartMinor} / ceiling ${MAX_PURCHASE_MINOR}`);
    return await abandon(priced, 'refused', `Steam's order total (${money(total, iso)}) is more than the ${money(cartMinor, iso)} its own cart quoted for CS2 Prime. Nothing was charged.`);
  }
  // the coverage check the owner asked for: Steam's real price against this account's real balance.
  if (total > walletBefore)
    return await abandon(priced, 'skipped', `not bought — CS2 Prime costs ${money(total, iso)} for this account and its wallet holds ${money(walletBefore, iso)}. Top it up and re-run. Nothing was charged.`);

  // ── 7) the CHARGE. Journalled first, never retried. ──
  const refusal = beginCommit?.({ subId: CS2_PRIME_SUB_ID, totalMinor: total, currencyIso: iso });
  if (refusal) return await abandon(priced, 'refused', refusal);

  // THE BOUNDARY. Past this line the charge is authorised, so SSIM stops treating the cart as its own
  // to tidy: Steam clears it on a completed order, and after a lost/ambiguous reply the cart is
  // EVIDENCE of what was submitted — emptying it would destroy the one thing an operator reconciling
  // that account can look at. Both `abandon` and the wrapper's catch are no-ops from here.
  cartState.holdsPrime = false;

  let fin: StoreResponse;
  try {
    fin = await ctx.post(`${CHECKOUT_ORIGIN}/checkout/finalizetransaction/`, {
      transid, CardCVV2: '', sessionid: checkoutSid,
      browserInfo: JSON.stringify({ language: 'en-US', javaEnabled: 'false', colorDepth: 24, screenHeight: 1080, screenWidth: 1920 }),
    }, { referer: checkoutUrl });
  } catch (e) {
    // Transport fault on the commit: it MAY have reached Steam. Never re-POST — the journal entry the
    // caller just wrote stays behind and refuses the re-fire until a human has looked.
    if (e instanceof StoreAmbiguousError)
      return done(priced, username, 'unconfirmed', `the purchase was submitted but the reply was lost, so SSIM cannot say whether ${money(total, iso)} was charged. Check this account's Steam purchase history before retrying.`, warnings);
    throw e;
  }
  // From here Steam HAS the commit. Nothing below may throw — a throw would read as "it failed".
  if (fin.status !== 200)
    return done(priced, username, 'unconfirmed', `the purchase was submitted but Steam answered HTTP ${fin.status}. Check this account's Steam purchase history before retrying.`, warnings);

  let finResult = -1;
  try { finResult = requireEResult(requireJsonObject(fin.data, 'finalizetransaction')); } catch { /* classified below */ }
  // EResult 1 = done, 22 = accepted-and-pending (Steam's own checkout polls from here). Anything else
  // is a definite refusal by Steam — no money moved, so the caller may clear its journal entry.
  if (finResult !== 1 && finResult !== 22) {
    const why = finResult === -1 ? 'Steam\'s reply to the purchase could not be decoded' : `Steam rejected the purchase (EResult ${finResult})`;
    return done(priced, username, 'refused', `${why}. Verify on Steam if in doubt — but no charge was confirmed.`, warnings);
  }

  // ── 8) Read back the TRUTH: Steam's own transaction status, then the wallet. ──
  const status = await pollTransactionStatus(ctx, transid, checkoutUrl, env.sleep ?? sleep);
  if (status.paymentMethod != null && isExternalPaymentMethod(status.paymentMethod)) {
    // Loud: the money is already gone and it did not come out of the wallet. Not recoverable here —
    // but it must never be silent.
    logger.error(`[prime] ${username}: PAID WITH PAYMENT METHOD ${status.paymentMethod} (not the Steam wallet) on transaction ${transid} — STOP AND CHECK THIS ACCOUNT`);
    warnings.push(`Steam recorded payment method ${status.paymentMethod}, not the wallet — check this account's payment history immediately.`);
  }

  const after = walletNativeMinor(await env.readWallet().catch(() => undefined));
  const walletAfter = after?.minor ?? null;
  const drop = walletAfter != null ? walletBefore - walletAfter : null;
  const row = { ...priced, walletMinorAfter: walletAfter, chargedMinor: drop };

  if (status.result === 1) {
    const seen = drop != null ? ` (wallet ${money(walletBefore, iso)} → ${money(walletAfter!, iso)})` : '';
    return done(row, username, 'purchased', `bought CS2 Prime for ${money(total, iso)}${seen}.`, warnings);
  }
  // Steam still says "pending", or we could not read the status. A wallet drop that MATCHES the total
  // is independent proof the money moved; anything else is handed to the operator, never guessed at.
  if (drop != null && drop === total)
    return done(row, username, 'purchased', `bought CS2 Prime — Steam had not finished reporting the transaction, but the wallet fell by exactly ${money(total, iso)}.`, warnings);
  return done(row, username, 'unconfirmed', `the purchase was submitted (transaction ${transid}) but SSIM could not confirm it${status.result != null ? ` (Steam status ${status.result})` : ''}${drop != null ? `; the wallet moved by ${money(drop, iso)}` : ''}. Check this account's Steam purchase history before retrying.`, warnings);
}

/** Poll Steam's own view of the transaction. Read-only, so a bounded retry is safe. Never throws —
 *  by the time this runs the money may already have moved, and an exception here would misreport that. */
async function pollTransactionStatus(ctx: StoreContext, transid: string, referer: string, wait: (ms: number) => Promise<void>): Promise<{ result: number | null; paymentMethod: number | null }> {
  let last: { result: number | null; paymentMethod: number | null } = { result: null, paymentMethod: null };
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await wait(1_500 * attempt);
    try {
      const res = await ctx.get(`${CHECKOUT_ORIGIN}/checkout/transactionstatus/?count=1&transid=${encodeURIComponent(transid)}`, { referer });
      if (res.status !== 200) continue;
      const obj = requireJsonObject(res.data, 'transactionstatus');
      const result = typeof obj.success === 'number' ? obj.success : null;
      const pm = Number(obj.paymentmethod);
      last = { result, paymentMethod: Number.isInteger(pm) ? pm : last.paymentMethod };
      if (result === 1) return last;      // settled
    } catch { /* keep the best answer we have; the wallet read-back is the other witness */ }
  }
  return last;
}

// StoreShapeError is part of this module's thrown contract (requireJsonObject/requireEResult raise it).
export { StoreShapeError };
