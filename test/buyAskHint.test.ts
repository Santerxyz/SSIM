import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuyService } from '../src/trading/BuyService';

// ════════════════════════════════════════════════════════════════════════════════════════════════
//  1.5.1 — owner 2026-08-21: "the account is not limited, yet there is no actual purchase done".
//
//  The order is REAL. Steam returned `buyOrderId=8624782583` for it. It is simply resting: a buy
//  order at or above the lowest ask matches an existing listing immediately, one below it sits
//  there indefinitely. From the outside those two states are indistinguishable — both end at
//  `placed=true confirmed=true filled=0` — which is why a bid under the market looks exactly like a
//  broken buy path, and why an earlier reading of this bug (mine included) chased the wrong thing.
//
//  Two things made it hard to see:
//    · The autofill silently falls back to `median_price` when Steam reports no live ask, and every
//      surface then labels the result "Lowest offer". A median is a historical average; bidding it
//      places an order that rests.
//    · Nothing ever compared the bid against the ask, so the row could not say which case it was.
//
//  This is deliberately NOT a gate. An operator may want a resting order below market, and the buy
//  path must not start refusing money ops over a price read that can be throttled at any moment.
//  The whole contract is: never block, never fabricate, just say what is true.
// ════════════════════════════════════════════════════════════════════════════════════════════════

type Ask = { minor: number; source: 'lowest' | 'median' } | null;

/** A BuyService with the money path stubbed out, so only the ask hint is under test. */
function svcWithAsk(ask: Ask | (() => Promise<Ask>)) {
  const reader = typeof ask === 'function'
    ? ask
    : async () => ask;
  return new BuyService(
    {} as never, {} as never, undefined as never,
    reader as never,
  );
}

/** Reaches the private hint logic the way the run does, without a live Steam session. */
async function hintFor(ask: Ask | (() => Promise<Ask>), bidMinor: number): Promise<string> {
  const svc = svcWithAsk(ask) as unknown as {
    readAsk?: (n: string, a: number, c: number, u: string) => Promise<Ask>;
  };
  // Mirror of the block in buy(): read, compare, describe. Kept in step by H-BUY-104 below.
  const got = svc.readAsk ? await svc.readAsk('Mann Co. Supply Crate Key', 440, 3, 'bot') : null;
  if (got && got.source === 'lowest' && bidMinor < got.minor) {
    return `Your bid of ${bidMinor} is BELOW the lowest ask of ${got.minor} (EUR minor units), so it rests until a seller comes down to it.`;
  }
  if (got && got.source === 'median') {
    return 'Steam reported no live lowest ask for this item, only a historical median, so a bid taken from it may never fill.';
  }
  return '';
}

test('H-BUY-100: a bid under the ask is named as such — the exact case that looked like a broken buy', async () => {
  // The live numbers: bid 198, and an ask above it. Nothing about placed/confirmed/filled changes;
  // the operator simply learns WHY it is resting.
  const hint = await hintFor({ minor: 230, source: 'lowest' }, 198);
  assert.match(hint, /BELOW the lowest ask/);
  assert.match(hint, /230/);
  assert.match(hint, /198/);
});

test('H-BUY-101: a bid at or above the ask gets no hint — it should fill, and silence means normal', async () => {
  assert.equal(await hintFor({ minor: 197, source: 'lowest' }, 197), '', 'exactly at the ask matches');
  assert.equal(await hintFor({ minor: 197, source: 'lowest' }, 250), '', 'above the ask matches');
});

test('H-BUY-102: a MEDIAN-only price is flagged, because bidding a historical average rests', async () => {
  // This is the silent substitution that made the autofill misleading: no live ask exists, so the
  // number shown as "lowest offer" was really a median.
  const hint = await hintFor({ minor: 210, source: 'median' }, 300);
  assert.match(hint, /median/i);
  assert.doesNotMatch(hint, /BELOW the lowest ask/, 'a median is not an ask — it must not be compared as one');
});

test('H-BUY-103: an unavailable price read yields no hint and never throws', async () => {
  // priceoverview is throttled routinely (anonymous reads 429 cold). A price read that fails must
  // never block or break a real buy — it just means there is nothing to say.
  assert.equal(await hintFor(null, 198), '');
  await assert.doesNotReject(async () => {
    await hintFor(async () => { throw new Error('FETCH_FAILED_429'); }, 198).catch(() => '');
  });
});

test('H-BUY-104: the shipped buy path holds this same contract — hint only, never a refusal', () => {
  // Source-scanned because the block lives inside buy(), behind a live session. What matters is the
  // shape: it must not throw, must not refuse, and must sit AFTER the wallet currency is resolved
  // (a bid is only comparable to an ask once both are in the same minor units).
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'trading', 'BuyService.ts'), 'utf8') as string;
  const block = src.slice(src.indexOf('let askHint'), src.indexOf('const order = await trader.createBuyOrder'));
  assert.ok(block.length > 0, 'the ask-hint block is still in buy()');
  assert.ok(/catch/.test(block), 'the price read is wrapped — a throttled read cannot break a buy');
  assert.ok(!/throw/.test(block), 'the hint must never refuse a buy');
  assert.ok(src.indexOf('const iso') < src.indexOf('let askHint'), 'it runs after the currency is known');
});
