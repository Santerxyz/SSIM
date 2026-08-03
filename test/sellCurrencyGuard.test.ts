import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketService, sellWalletBlocked } from '../src/trading/MarketService';
import type { CurrencyInfo } from '../src/pricing/currencies';

// ─── Sell-path wallet-currency guard (B11, generalised in v1.4.5) ─────────────
// Steam's market/sellitem reads `price` in the SELLER's own wallet currency, so the
// only requirement is that the quote was READ in that same currency. SSIM now prices
// each bot natively, so a PLN/RUB/USD wallet SELLS (it used to be refused outright and
// the operator saw "wallet currency 6 is not EUR … BLOCKING this bot"). What stays
// fail-CLOSED is a currency we cannot establish at all — guessing one mis-prices by
// the whole FX rate.

test('sellWalletBlocked: any KNOWN currency sells; only an unknowable one is blocked', () => {
  assert.equal(sellWalletBlocked(3), false, 'EUR (3) → allowed');
  assert.equal(sellWalletBlocked(6), false, 'PLN (6) → allowed, priced in PLN (the owner-reported block)');
  assert.equal(sellWalletBlocked(5), false, 'RUB (5) → allowed, priced in RUB');
  assert.equal(sellWalletBlocked(1), false, 'USD (1) → allowed, priced in USD');
  assert.equal(sellWalletBlocked(8), false, 'JPY (8, 0-decimal) → allowed, priced in whole yen');
  assert.equal(sellWalletBlocked(undefined), true, 'wallet event never arrived → fail closed (OQ-B1)');
  assert.equal(sellWalletBlocked(0), true, 'ECurrencyCode.Invalid (no wallet at all) → fail closed');
  assert.equal(sellWalletBlocked(999), true, 'unrecognised code → minor-unit scale unknowable (S64)');
});

/** Runs processBot against a stubbed session layer and reports what it did. */
async function runProcessBot(
  walletCurrency: number | undefined,
  opts?: { cachedWalletCurrency?: number; eventWalletCurrency?: number },
): Promise<{ blocked: number; listed: number; sold: number; error?: string; pricedIn?: CurrencyInfo }> {
  const svc = Object.create(MarketService.prototype) as MarketService;
  const job = { listed: 0, done: 0, blocked: [] as { error: string }[], deferred: [] as unknown[], failed: [] as unknown[] };
  let soldCalls = 0;
  let pricedIn: CurrencyInfo | undefined;

  const trader = {
    walletCurrency,
    httpsAgent: {},
    cookies: ['sessionid=x', 'steamLoginSecure=y'],
    ready: true,
    sessionState: 'LOGGED_IN',
    username: 'sellbot',
    sellOnMarket: async () => { soldCalls++; return { listingId: 'L1' }; },
    getListedAssetIds: async () => new Set<string>(),
  };
  Object.assign(svc, {
    trades: {
      ensureWebSession: async () => trader,
      // The login 'wallet' event source (OQ-B1): undefined unless the case supplies one.
      awaitWallet: async () => (opts?.eventWalletCurrency != null
        ? { hasWallet: true, currency: opts.eventWalletCurrency, balance: 1 }
        : undefined),
    },
    inventory: {
      getCached: () => (opts?.cachedWalletCurrency != null
        ? { wallet: { currency: opts.cachedWalletCurrency, balance: 1 }, items: [] }
        : undefined),
      markListed: () => undefined, // optimistic Owned→Listed cache move; irrelevant here
    },
    job,
    // stub the parts a listing item would reach so a NON-blocked run wouldn't touch Steam here.
    // preflightProbe now yields the already-listed set AND the subset still awaiting a 2FA confirm
    // (one market/mylistings read, both answers) — see H-TRD-029.
    preflightProbe: async () => ({ listed: new Set<string>(), unconfirmed: new Set<string>() }),
    isAssetSellable: () => true,
  });

  const group = { username: 'sellbot', items: [
    { assetId: 'a1', marketHashName: 'AK-47 | Redline' },
    { assetId: 'a2', marketHashName: 'AWP | Asiimov' },
  ] };
  // Captures the currency processBot resolved and threads it back — the whole point of the
  // change is that THIS is the bot's own wallet currency, not a hardcoded EUR.
  const resolveNet = async (_n: string, _c: unknown, _a: number, cur: CurrencyInfo) => {
    pricedIn = cur;
    return { net: 1000, transport: false };
  };
  await (svc as unknown as { processBot: (g: unknown, r: unknown, d: number) => Promise<void> })
    .processBot(group, resolveNet, 0);

  return { blocked: job.blocked.length, listed: job.listed, sold: soldCalls, error: job.blocked[0]?.error, pricedIn };
}

test('processBot: a PLN wallet now LISTS, priced in PLN (the v1.4.4 hard block is gone)', async () => {
  const r = await runProcessBot(6); // PLN — the currency the owner's fleet was refused on
  assert.equal(r.blocked, 0, 'a foreign wallet is no longer refused');
  assert.ok(r.sold >= 1, 'it reaches sellOnMarket');
  assert.equal(r.pricedIn?.iso, 'PLN', 'and the price was resolved in PLN, not EUR');
});

test('processBot: a 0-decimal wallet (JPY) prices in whole yen', async () => {
  const r = await runProcessBot(8);
  assert.equal(r.blocked, 0);
  assert.equal(r.pricedIn?.iso, 'JPY');
  assert.equal(r.pricedIn?.decimals, 0, 'the minor-unit scale follows the wallet, never a 2-decimal assumption');
});

test('processBot: an EUR wallet still lists (no regression on the common path)', async () => {
  const r = await runProcessBot(3);
  assert.equal(r.blocked, 0);
  assert.ok(r.sold >= 1);
  assert.equal(r.pricedIn?.iso, 'EUR');
});

test('processBot: a walletless account (currency 0) BLOCKS all items with an honest "no Steam wallet" reason', async () => {
  const r = await runProcessBot(0); // ECurrencyCode.Invalid — never-funded bot
  assert.equal(r.sold, 0, 'no item may be listed when there is no wallet (real-money protection)');
  assert.equal(r.blocked, 2, 'both items blocked');
  assert.equal(r.listed, 0);
  assert.match(r.error ?? '', /no Steam wallet/, 'names the walletless state, not a phantom "currency 0"');
});

test('processBot: an UNKNOWN wallet currency now fails CLOSED instead of assuming EUR (OQ-B1)', async () => {
  const r = await runProcessBot(undefined);
  assert.equal(r.sold, 0, 'the old fail-open path would have listed EUR cents onto an unknown wallet');
  assert.equal(r.blocked, 2);
  assert.match(r.error ?? '', /wallet currency unknown/);
});

test('processBot: an unrecognised currency code is blocked (a 0-decimal one would mis-price 100×)', async () => {
  const r = await runProcessBot(999);
  assert.equal(r.sold, 0);
  assert.equal(r.blocked, 2);
  assert.match(r.error ?? '', /unrecognised wallet currency code 999/);
});

test('processBot: an unknown session wallet is recovered from the login wallet EVENT, then lists', async () => {
  const r = await runProcessBot(undefined, { eventWalletCurrency: 5 }); // RUB arrives late
  assert.equal(r.blocked, 0, 'the bounded await closes OQ-B1 sub-case (a) without over-blocking');
  assert.equal(r.pricedIn?.iso, 'RUB');
});

test('processBot: …or from the CACHED inventory wallet when the event never fires (OQ-B1 sub-case b)', async () => {
  const r = await runProcessBot(undefined, { cachedWalletCurrency: 2 }); // GBP from the last refresh
  assert.equal(r.blocked, 0);
  assert.equal(r.pricedIn?.iso, 'GBP');
});
