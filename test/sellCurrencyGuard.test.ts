import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketService, sellWalletBlocked } from '../src/trading/MarketService';

// ─── Sell-path wallet-currency guard (B11) ─────────────────────────────────────
// Every price SSIM computes is EUR seller-net cents, but Steam's market/sellitem
// interprets the price in the SELLER's wallet currency. A non-EUR wallet would list
// ~99% underpriced. Fail closed for a KNOWN non-EUR wallet; unknown keeps the EUR path.

test('sellWalletBlocked: only a KNOWN non-EUR wallet is blocked', () => {
  assert.equal(sellWalletBlocked(3), false, 'EUR (3) → allowed');
  assert.equal(sellWalletBlocked(undefined), false, 'unknown → keep EUR common path');
  assert.equal(sellWalletBlocked(5), true, 'RUB (5) → blocked');
  assert.equal(sellWalletBlocked(1), true, 'USD (1) → blocked');
  assert.equal(sellWalletBlocked(23), true, 'TRY (23) → blocked');
});

// processBot must BLOCK (never list) every item of a known-non-EUR-wallet bot.
async function runProcessBot(walletCurrency: number | undefined): Promise<{ blocked: number; listed: number; sold: number; error?: string }> {
  const svc = Object.create(MarketService.prototype) as MarketService;
  const job = { listed: 0, done: 0, blocked: [] as { error: string }[], deferred: [] as unknown[], failed: [] as unknown[] };
  let soldCalls = 0;

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
    trades: { ensureWebSession: async () => trader },
    job,
    // stub the parts a listing item would reach so a NON-blocked run wouldn't touch Steam here
    preflightProbe: async () => new Set<string>(),
    isAssetSellable: () => true,
  });

  const group = { username: 'sellbot', items: [
    { assetId: 'a1', marketHashName: 'AK-47 | Redline' },
    { assetId: 'a2', marketHashName: 'AWP | Asiimov' },
  ] };
  const resolveNet = async () => ({ net: 1000, transport: false }); // EUR cents; Steam answered
  await (svc as unknown as { processBot: (g: unknown, r: unknown, d: number) => Promise<void> })
    .processBot(group, resolveNet, 0);

  return { blocked: job.blocked.length, listed: job.listed, sold: soldCalls, error: job.blocked[0]?.error };
}

test('processBot: a known non-EUR wallet BLOCKS all items and NEVER calls sellOnMarket', async () => {
  const r = await runProcessBot(5); // RUB
  assert.equal(r.sold, 0, 'no item may be listed on a non-EUR wallet (real-money protection)');
  assert.equal(r.blocked, 2, 'both items blocked with a clear reason');
  assert.equal(r.listed, 0);
});

test('processBot: a walletless account (currency 0) BLOCKS all items with an honest "no Steam wallet" reason', async () => {
  const r = await runProcessBot(0); // ECurrencyCode.Invalid — never-funded bot
  assert.equal(r.sold, 0, 'no item may be listed when there is no wallet (real-money protection)');
  assert.equal(r.blocked, 2, 'both items blocked');
  assert.equal(r.listed, 0);
  assert.match(r.error ?? '', /no Steam wallet/, 'names the walletless state, not a phantom "currency 0"');
});

test('processBot: an EUR wallet proceeds to the listing path (guard does not over-block)', async () => {
  const r = await runProcessBot(3); // EUR
  assert.equal(r.blocked, 0, 'EUR wallet is not blocked by the currency guard');
  assert.ok(r.sold >= 1, 'EUR wallet reaches sellOnMarket');
});
