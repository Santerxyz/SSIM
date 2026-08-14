import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TradeUpService, type TuExecContract } from '../src/trading/TradeUpService';

// ─────────────────────────────────────────────────────────────────────────────
//  Owner report 2026-08-12: "after waiting so long for 63 contract it just says
//  failed for no real reason".
//
//  The run really did fail 63 times, and the reason really was recorded — into
//  `results`, which the auto planner RESETS at the top of every round and which no
//  screen ever rendered. So the stop line pointed at "the failures" and there were
//  none to see, while the loop ground through all 63 contracts reproducing one
//  identical, account-wide failure at up to ~35s of GC connect apiece.
//
//  These pin the two halves: every failure is tallied somewhere that survives the
//  round reset, and a repeating failure stops the run instead of running it out.
// ─────────────────────────────────────────────────────────────────────────────

/** A 10-input contract; the ids only have to be unique across contracts. */
function contract(n: number): TuExecContract {
  return {
    inputAssetIds: Array.from({ length: 10 }, (_, i) => `${n * 100 + i}`),
    rarityId: 'rarity_rare_weapon',
    stattrak: false,
  };
}

/** A TradeUpService whose GC always answers the same way. */
function serviceWith(craft: () => Promise<{ submitted: boolean; confirmed: boolean; rejected?: boolean }>): TradeUpService {
  const gc = {
    status: () => ({ available: true, casketsEnabled: true, craftEnabled: true, reason: 'test' }),
    opInFlight: () => false,
    craftTradeUp: craft,
  };
  const schema = { rarityLabel: (id: string) => id };
  return new TradeUpService({} as never, {} as never, schema as never, gc as never);
}

/** Runs a job to completion (the service returns immediately; the run is fire-and-forget). */
async function runToEnd(svc: TradeUpService, contracts: TuExecContract[]): Promise<void> {
  svc.startExecute('bot', contracts);
  const deadline = Date.now() + 60_000;
  while (svc.executeStatus().running) {
    if (Date.now() > deadline) throw new Error('trade-up job never finished');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('every contract failure lands in a tally the round reset cannot wipe', async () => {
  const svc = serviceWith(async () => ({ submitted: true, confirmed: false, rejected: true }));
  await runToEnd(svc, [contract(1), contract(2), contract(3), contract(4), contract(5)]);

  const job = svc.executeStatus();
  assert.ok(job.failed > 0, 'the contracts must be counted as failed');
  assert.ok(job.failureReasons?.length, 'a failed run must name at least one reason');
  assert.equal(job.failureReasons![0].count, job.failed, 'the tally must account for every failure');
  assert.match(job.failureReasons![0].error, /refused the contract/i, 'the reason must be the real cause, not a placeholder');
});

test('a repeating account-wide failure stops the run instead of grinding through the plan', async () => {
  let attempts = 0;
  const svc = serviceWith(async () => { attempts++; return { submitted: true, confirmed: false, rejected: true }; });
  await runToEnd(svc, Array.from({ length: 20 }, (_, i) => contract(i + 1)));

  assert.ok(attempts < 20, `must give up early, not attempt all 20 contracts (attempted ${attempts})`);
  assert.ok(attempts >= 3, 'must not give up on a single one-off failure');
  assert.equal(svc.executeStatus().crafted, 0);
});

test('a run that is CRAFTING is never stopped by unrelated failures', async () => {
  // The streak guard must only fire while nothing at all is working, or one bad contract in a
  // healthy batch would abandon every contract after it.
  let n = 0;
  const svc = serviceWith(async () => {
    n++;
    // No outputItemId: the read-back of crafted outputs is a separate concern (and a live GC call).
    return n % 2 === 0
      ? { submitted: true, confirmed: false, rejected: true }
      : { submitted: true, confirmed: true };
  });
  await runToEnd(svc, Array.from({ length: 8 }, (_, i) => contract(i + 1)));

  const job = svc.executeStatus();
  assert.equal(job.crafted + job.failed, 8, 'every contract must be attempted when crafts are landing');
});

test('submitted-but-unconfirmed contracts are counted, not silently dropped', async () => {
  // Neither crafted nor failed, and never retried — but a run of them used to report
  // "0 crafted, 0 failed", which reads as if nothing happened at all.
  const svc = serviceWith(async () => ({ submitted: true, confirmed: false }));
  await runToEnd(svc, [contract(1), contract(2)]);

  const job = svc.executeStatus();
  assert.equal(job.crafted, 0);
  assert.equal(job.failed, 0);
  assert.equal(job.totalUnconfirmed, 2, 'the operator must be told there are 2 contracts to verify in-game');
});
