import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MONEY_OP_ROUTE } from '../src/api/server';
import { createDispatchThrottle } from '../src/trading/TradeService';

// ─── B13: money-ops circuit-breaker route-set covers CSFloat cash + confirmations ──
test('MONEY_OP_ROUTE gates CSFloat real-cash ops and confirmation approval', () => {
  const money = [
    '/api/csfloat/alice/buy',
    '/api/csfloat/alice/listings',
    '/api/csfloat/alice/buy-orders',
    '/api/accounts/alice/confirmations/respond',
    '/api/trade/send',
    '/api/market/buy',
    '/api/market/sell',
    '/api/tradeup/execute',
    '/api/casket/move',
  ];
  for (const p of money) assert.ok(MONEY_OP_ROUTE.test(p), `${p} MUST be gated by the money breaker`);
});

test('MONEY_OP_ROUTE does NOT gate reads / edits / status siblings', () => {
  const notMoney = [
    '/api/market/buy-price',
    '/api/market/search',
    '/api/market/sell-status',
    '/api/csfloat/alice/listings/12345',   // DELETE/PATCH edit of one listing (not a create)
    '/api/csfloat/alice/buy-orders/999',   // DELETE one buy order
    '/api/accounts/alice/confirmations',   // GET the list
    '/api/inventories/alice',
  ];
  for (const p of notMoney) assert.ok(!MONEY_OP_ROUTE.test(p), `${p} must NOT be gated`);
});

test('MONEY_OP_ROUTE is case-insensitive (Express routing is)', () => {
  assert.ok(MONEY_OP_ROUTE.test('/api/market/BUY'));
  assert.ok(MONEY_OP_ROUTE.test('/api/CSFloat/alice/Buy'));
});

// ─── B44: dispatch throttle spaces every action across all workers ─────────────
test('createDispatchThrottle: reserves slots at least minGap apart (deterministic clock)', () => {
  let t = 0;
  const th = createDispatchThrottle(600, 600, () => t, () => 0); // rand 0 → gap = minGap = 600
  assert.equal(th.reserveWaitMs(), 0, 'first dispatch: no wait');
  assert.equal(th.reserveWaitMs(), 600, 'second: wait a full gap (clock has not advanced)');
  t = 600; // simulate that wait elapsing
  assert.equal(th.reserveWaitMs(), 600, 'third: reserved 600 past the 2nd slot');
});

test('createDispatchThrottle: an idle caller never waits (slot already in the past)', () => {
  let t = 0;
  const th = createDispatchThrottle(600, 1200, () => t, () => 0);
  th.reserveWaitMs();      // reserves slot at 600
  t = 5_000;               // long idle
  assert.equal(th.reserveWaitMs(), 0, 'after a long idle the next slot is in the past → no wait');
});
