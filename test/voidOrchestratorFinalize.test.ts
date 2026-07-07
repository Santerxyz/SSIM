import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MarketService } from '../src/trading/MarketService';
import { TradeService } from '../src/trading/TradeService';

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

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-014 — runMassSend's terminal epilogue now lives in a `finally`, so a
//  rejecting orchestrator still reaches a truthful terminal state (running:false,
//  cancelling:false, finishedAt set) instead of leaving a half-dead job forever.
// ─────────────────────────────────────────────────────────────────────────────

function freshMassJob() {
  return {
    running: true, cancelling: false, cancelled: false, total: 1, done: 0,
    sent: 0, confirmed: 0, unconfirmed: 0, failed: [] as any[], results: [] as any[],
  };
}

test('H-TRD-014: a runMassSend that throws before the snapshot still finalizes and skips release (INV-A6 guard)', async () => {
  const svc: any = Object.create(TradeService.prototype);
  svc.massJob = freshMassJob();
  svc.massCancel = false;
  let logoutCalled = false;
  svc.sessions = { isLive: () => false, logoutAccount: () => { logoutCalled = true; return Promise.resolve(); } };
  svc.snapshotLive = () => { throw new Error('boom'); }; // snapshot never completes ⇒ pool never ran

  await assert.rejects(svc.runMassSend([{ username: 'a', assetIds: ['1'] }], 'url'), /boom/);

  const status = svc.massStatus();
  assert.equal(status.running, false, 'running reset in the finally');
  assert.equal(status.cancelling, false, 'cancelling cleared — no contradictory latched state');
  assert.ok(status.finishedAt, 'finishedAt stamped even on the crash path');
  assert.equal(logoutCalled, false, 'release skipped: this run created no sessions (guard held)');
});

test('H-TRD-014: a release failure does not skip the terminal state writes', async () => {
  const svc: any = Object.create(TradeService.prototype);
  svc.massJob = freshMassJob();
  svc.massCancel = false;
  svc.snapshotLive = () => new Set<string>();
  svc.releaseCreatedSessions = () => Promise.reject(new Error('release boom'));
  svc.sendTrade = () => Promise.resolve({ offerId: '1', status: 'confirmed' });

  await svc.runMassSend([{ username: 'a', assetIds: ['1'] }], 'url'); // resolves — release reject is swallowed

  const status = svc.massStatus();
  assert.equal(status.running, false, 'running reset despite the release throw');
  assert.equal(status.cancelling, false);
  assert.ok(status.finishedAt, 'finishedAt still stamped');
});
