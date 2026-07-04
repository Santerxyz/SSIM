import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MarketService } from '../src/trading/MarketService';

// ─────────────────────────────────────────────────────────────────────────────
//  S33 — a fire-and-forget `void this.runMass…()` that ever REJECTS would escape
//  as an unhandledRejection (a money-breaker tick) AND never reach its trailing
//  running=false (the job type latched until restart). Each void launch now has a
//  .catch that releases the job + logs. (Hardening; PROVEN-latent.)
// ─────────────────────────────────────────────────────────────────────────────

test('S33: a crashed mass-sell orchestrator releases the job (running reset, no unhandled rejection)', async () => {
  const svc: any = Object.create(MarketService.prototype);
  svc.job = { running: false };
  svc.runMassSell = () => Promise.reject(new Error('boom')); // simulate an unexpected reject
  svc.startMassSell([], 'lowest');
  assert.equal(svc.job.running, true, 'running is set immediately on start');
  await new Promise((r) => setImmediate(r)); // let the .catch microtask run
  assert.equal(svc.job.running, false, 'the crashed orchestrator released the job — not latched until restart');
});

test('S33: the mass-send / mass-buy void launches also finalize on rejection', () => {
  const trade = readFileSync(join(__dirname, '..', 'src', 'trading', 'TradeService.ts'), 'utf8');
  const buy = readFileSync(join(__dirname, '..', 'src', 'trading', 'BuyService.ts'), 'utf8');
  assert.ok(/void this\.runMassSend\([^)]*\)\.catch\(/.test(trade), 'runMassSend void launch has a .catch');
  assert.ok(/void this\.runMassBuy\([^)]*\)\.catch\(/.test(buy), 'runMassBuy void launch has a .catch');
  // Each catch releases its job so a rejection can't latch the job type.
  assert.ok(/\.catch\(\(err\) => \{\s*this\.massJob\.running = false;/.test(trade), 'mass-send catch releases the job');
  assert.ok(/\.catch\(\(err\) => \{\s*this\.massJob\.running = false;/.test(buy), 'mass-buy catch releases the job');
});
