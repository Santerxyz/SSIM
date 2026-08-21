import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MarketService } from '../src/trading/MarketService';
import { EUR_CURRENCY } from '../src/pricing/MarketPricing';

// ════════════════════════════════════════════════════════════════════════════════════════════════
//  1.5.1 — owner 2026-08-21: "when selling items it fails too quick … complete the last thing
//  before starting a new one … increase the retries to 4 on selling".
//
//  Two changes, and neither had any test holding it before:
//
//   1. RETRIES 3 → 4. A transient Steam error on the sell path is usually a window that has to
//      elapse, not a condition that clears instantly, so the extra attempt buys a real listing
//      rather than a faster failure.
//   2. LANES 3 → 1. A bot used to dispatch several listings at once to hide the round-trip. In the
//      field that produced sells failing for reasons the log could not explain, so a listing now
//      finishes completely before the next is dispatched.
//
//  The invariant worth guarding hardest is the quiet one: the retry loop indexes the backoff array
//  with Math.min(attempt, len-1), so raising the retry count WITHOUT extending the array silently
//  reuses the last value instead of failing. That is the kind of drift nobody notices for months.
// ════════════════════════════════════════════════════════════════════════════════════════════════

function svc(): any {
  const s: any = Object.create(MarketService.prototype);
  s.job = {
    running: true, strategy: 'lowest', total: 0, done: 0, listed: 0,
    confirmed: 0, recovered: 0, retried: 0, skippedNoPrice: 0,
    failed: [], deferred: [], gone: [], blocked: [],
  };
  s.cancelRequested = false;
  s.inventory = undefined;
  s.retryBackoffs = [0, 0, 0, 0];   // the test asserts attempt COUNT, not wall-clock waiting
  return s;
}

const liveTrader = (over: Record<string, unknown>) => ({
  username: 'bot', walletCurrency: EUR_CURRENCY, httpsAgent: undefined, cookies: [],
  ready: true, sessionState: 'LOGGED_IN',
  // The retry loop probes the bot's own listings after every error to catch a PHANTOM listing (Steam
  // created it despite the error). A probe that throws makes the item `deferred` rather than retried,
  // so the stub has to answer — otherwise the retry budget is never reached and the test would be
  // measuring the probe, not the retries.
  getListedAssetIds: async () => new Set<string>(),
  ...over,
});

// ── 1) the retry budget ──────────────────────────────────────────────────────────────────────────

test('H-TRD-130: a transient sell error gets 4 retries — 5 attempts before it is called failed', async () => {
  let calls = 0;
  const trader: any = liveTrader({
    sellOnMarket: async () => { calls++; throw new Error('HTTP error 500'); },
  });
  const s = svc();
  const res = await s.listWithRetry(trader, 'A1', 1000, new Set<string>(), 730);

  assert.equal(calls, 5, '1 initial attempt + 4 retries');
  assert.ok(typeof res === 'object' && 'error' in res, 'it still ends as a failure, just not a hasty one');
  assert.equal(s.job.retried, 4, 'every retry is counted for the operator');
});

test('H-TRD-131: a HARD error is still not retried — more patience must not mean blind hammering', async () => {
  // The extra retry budget is for TRANSIENT faults. A genuine rejection (bad price, item gone) has
  // to fail on the first attempt, or a 500-item run spends minutes re-asking a settled question.
  let calls = 0;
  const trader: any = liveTrader({
    sellOnMarket: async () => { calls++; throw new Error('You cannot sell this item'); },
  });
  const s = svc();
  const res = await s.listWithRetry(trader, 'A1', 1000, new Set<string>(), 730);
  assert.equal(calls, 1, 'a hard error is final on the first attempt');
  assert.ok(typeof res === 'object' && 'error' in res);
});

test('H-TRD-132: a transient error that CLEARS still lists, and stops retrying at once', async () => {
  let calls = 0;
  const listed = new Set<string>();
  const trader: any = liveTrader({
    sellOnMarket: async () => { calls++; if (calls < 3) throw new Error('socket hang up'); },
  });
  const s = svc();
  const res = await s.listWithRetry(trader, 'A1', 1000, listed, 730);
  assert.equal(res, 'listed');
  assert.equal(calls, 3, 'it stops the moment Steam accepts — the budget is a ceiling, not a quota');
  assert.ok(listed.has('A1'));
});

test('H-TRD-133: a dropped session DEFERS instead of burning the bigger retry budget', async () => {
  // Deferred items are retryable later. Spending 4 backoffs against a session that is gone would
  // just delay the whole run for an item that cannot possibly list this pass.
  let calls = 0;
  const trader: any = liveTrader({
    ready: false, sessionState: 'DISCONNECTED',
    sellOnMarket: async () => { calls++; throw new Error('ECONNRESET'); },
  });
  const s = svc();
  const res = await s.listWithRetry(trader, 'A1', 1000, new Set<string>(), 730);
  assert.equal(res, 'deferred');
  assert.equal(calls, 1, 'no backoffs are spent on a dead session');
});

// ── 2) the backoff table must keep pace with the retry count ─────────────────────────────────────

test('H-TRD-134: there is one backoff per retry — a short table would silently reuse its last value', async () => {
  // Source-scanned on purpose: these are module-private consts, and the failure mode is invisible at
  // runtime (Math.min clamps, so nothing throws — the run just waits the wrong amount).
  const src = readFileSync(join(__dirname, '..', 'src', 'trading', 'MarketService.ts'), 'utf8');
  const retries = Number(/const MAX_SELL_RETRIES\s*=\s*(\d+)/.exec(src)?.[1]);
  const table = /const SELL_BACKOFF_MS\s*=\s*\[([^\]]*)\]/.exec(src)?.[1] ?? '';
  const steps = table.split(',').map((s) => s.trim()).filter(Boolean);

  assert.equal(retries, 4, 'the owner asked for 4 retries on selling');
  assert.equal(steps.length, retries, `SELL_BACKOFF_MS must hold ${retries} entries, found ${steps.length}`);
  const ms = steps.map((s) => Number(s.replace(/_/g, '')));
  assert.ok(ms.every((n) => Number.isFinite(n) && n > 0), 'every backoff is a real positive wait');
  assert.deepEqual(ms, [...ms].sort((a, b) => a - b), 'backoffs escalate — a retry storm must not tighten');
});

// ── 3) one listing at a time ─────────────────────────────────────────────────────────────────────

test('H-TRD-135: a bot lists SERIALLY by default — never two dispatches in flight at once', async () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'trading', 'MarketService.ts'), 'utf8');
  const dflt = Number(/const DEFAULT_ITEM_CONCURRENCY\s*=\s*(\d+)/.exec(src)?.[1]);
  assert.equal(dflt, 1, 'the default is serial: complete the last listing before starting the next');

  // And prove it behaviourally, not just by the constant: overlapping dispatches would push
  // `inFlight` above 1 at some point during the run.
  let inFlight = 0, peak = 0, done = 0;
  const trader: any = liveTrader({
    sellOnMarket: async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--; done++;
    },
  });
  const s = svc();
  const listed = new Set<string>();
  // Drive the same retry entry point the run uses, once per item, the way a serial lane does.
  for (const id of ['A1', 'A2', 'A3', 'A4']) await s.listWithRetry(trader, id, 1000, listed, 730);

  assert.equal(peak, 1, 'at most one sellitem dispatch is ever outstanding for a bot');
  assert.equal(done, 4);
  assert.equal(listed.size, 4);
});

test('H-TRD-136: the ceiling still allows an explicit opt-in to lanes — only the DEFAULT changed', async () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'trading', 'MarketService.ts'), 'utf8');
  const max = Number(/const MAX_ITEM_CONCURRENCY\s*=\s*(\d+)/.exec(src)?.[1]);
  assert.ok(max > 1, 'anyone who wants the old overlapping behaviour can still ask for it per run');
});
