import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketService } from '../src/trading/MarketService';
import { TradeUpService } from '../src/trading/TradeUpService';
import { CasketService } from '../src/trading/CasketService';

// ─────────────────────────────────────────────────────────────────────────────
//  S14 — the update busy-gate must also cover mass-sell / trade-up craft / casket
//  moves. Each service now exposes busy() (index.ts ORs them into isBusy, and
//  runUpdate re-checks isBusy immediately before the swap). Here we prove each
//  service reports its running state — the building block the gate consults.
//  (The methods only read the job's `running` flag, so Object.create + a fake job
//  exercises the exact shipped code without their heavy constructors.)
// ─────────────────────────────────────────────────────────────────────────────

test('S14: MarketService.busy() reflects a running mass-sell', () => {
  const m = Object.create(MarketService.prototype) as MarketService & { job: { running: boolean } };
  m.job = { running: false };
  assert.equal(m.busy(), false, 'idle → not busy');
  m.job.running = true;
  assert.equal(m.busy(), true, 'a running mass-sell must gate a swap');
});

test('S14: TradeUpService.busy() reflects a running craft job', () => {
  const t = Object.create(TradeUpService.prototype) as TradeUpService & { execJob: { running: boolean } };
  t.execJob = { running: false };
  assert.equal(t.busy(), false);
  t.execJob.running = true;
  assert.equal(t.busy(), true, 'an in-flight irreversible craft must gate a swap');
});

test('S14: CasketService.busy() reflects a running storage move', () => {
  const c = Object.create(CasketService.prototype) as CasketService & { job: { running: boolean } };
  c.job = { running: false };
  assert.equal(c.busy(), false);
  c.job.running = true;
  assert.equal(c.busy(), true, 'an in-flight casket move must gate a swap');
});
