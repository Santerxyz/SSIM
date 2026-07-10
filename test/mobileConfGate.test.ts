import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MobileConfGate } from '../src/trading/MobileConfGate';
import { AccountTrader } from '../src/trading/AccountTrader';

const SteamTotp = createRequire(__filename)('steam-totp') as {
  time: (off?: number) => number;
  getTimeOffset: (cb: (err: Error | null, off: number) => void) => void;
  getConfirmationKey: (...args: any[]) => string;
};

// ═════════════════════════════════════════════════════════════════════════════
//  MobileConfGate: single-flight + short snapshot + 429 cooldown, and the
//  batch multiajaxop happy path (1 mobileconf op instead of N). (2026-07-10)
// ═════════════════════════════════════════════════════════════════════════════

const CONF_TYPE_MARKET_LISTING = 3;

test('gate: concurrent callers share ONE getlist (single-flight)', async () => {
  let fetches = 0;
  let release!: () => void;
  const gate = new MobileConfGate('u', () => new Promise((r) => { fetches++; release = () => r({ off: 0, confs: [] }); }));
  const a = gate.get('fresh');
  const b = gate.get('recent');
  const c = gate.get('fresh');
  release();
  await Promise.all([a, b, c]);
  assert.equal(fetches, 1, 'three concurrent callers issued exactly one getlist');
});

test('gate: a recent caller reuses the snapshot; a fresh caller re-fetches', async () => {
  let fetches = 0;
  let clock = 1000;
  const gate = new MobileConfGate('u', async () => { fetches++; return { off: 0, confs: [{ id: fetches }] }; }, () => clock);
  await gate.get('fresh');                 // fetch #1
  assert.equal(fetches, 1);
  clock += 2000;                            // 2s later — within RECENT_TTL (8s)
  const recent = await gate.get('recent');  // served from snapshot, no fetch
  assert.equal(fetches, 1, 'recent within TTL reuses the snapshot');
  assert.equal((recent.confs[0] as any).id, 1);
  const fresh = await gate.get('fresh');    // fresh always re-fetches
  assert.equal(fetches, 2, 'fresh re-fetches');
  assert.equal((fresh.confs[0] as any).id, 2);
});

test('gate: after a 429, fresh throws the cooldown and recent serves stale', async () => {
  let clock = 1000;
  let mode: 'ok' | 'rl' = 'ok';
  const gate = new MobileConfGate('u', async () => {
    if (mode === 'rl') throw new Error('HTTP error 429');
    return { off: 0, confs: [{ id: 'snap' }] };
  }, () => clock);
  await gate.get('fresh');           // seed a snapshot
  mode = 'rl';
  clock += 100;
  await assert.rejects(() => gate.get('fresh'), /429/, 'the 429 propagates and latches a cooldown');
  clock += 100;                       // still inside the 60s cooldown
  const recent = await gate.get('recent');
  assert.equal((recent.confs[0] as any).id, 'snap', 'recent serves the stale snapshot during cooldown (never fails the panel)');
  await assert.rejects(() => gate.get('fresh'), /429|cooling down/, 'fresh is refused during the cooldown without a network call');
});

test('gate: cooldown ESCALATES on consecutive 429s and RESETS on a successful getlist', async () => {
  let clock = 1000;
  let mode: 'rl' | 'ok' = 'rl';
  // rand=()=>0 → no jitter, so the cooldown is exactly 60/120/240s and assertions are deterministic.
  const gate = new MobileConfGate('u', async () => {
    if (mode === 'rl') throw new Error('HTTP error 429');
    return { off: 0, confs: [] };
  }, () => clock, () => 0);

  const err1: any = await gate.get('fresh').catch((e) => e);
  assert.equal(err1.retryAfterSeconds, 60, '1st 429 → 60s');
  clock += 60_001;
  const err2: any = await gate.get('fresh').catch((e) => e);
  assert.equal(err2.retryAfterSeconds, 120, '2nd consecutive 429 → 120s (doubled)');
  clock += 120_001;
  const err3: any = await gate.get('fresh').catch((e) => e);
  assert.equal(err3.retryAfterSeconds, 240, '3rd → 240s — probes land progressively later, breaking the boundary re-arm');

  // A successful getlist means Steam's window cleared → the escalation resets.
  mode = 'ok';
  clock += 240_001;
  assert.deepEqual((await gate.get('fresh')).confs, [], 'a clear getlist succeeds');
  mode = 'rl';
  clock += 1;
  const err4: any = await gate.get('fresh').catch((e) => e);
  assert.equal(err4.retryAfterSeconds, 60, 'a successful getlist reset the escalation → back to 60s');
});

test('gate: cooldown is capped at 15 min', async () => {
  let clock = 1000;
  const gate = new MobileConfGate('u', async () => { throw new Error('HTTP error 429'); }, () => clock, () => 0);
  let last = 0;
  for (let i = 0; i < 10; i++) {
    const err: any = await gate.get('fresh').catch((e) => e);
    last = err.retryAfterSeconds;
    clock += (last + 1) * 1000;
  }
  assert.equal(last, 900, 'the escalating cooldown caps at 900s (15 min), never unbounded');
});

// ── Batch happy path: confirmMarketListings issues ONE multiajaxop ──────────────
test('confirmMarketListings: one multiajaxop accepts all listings (no per-listing ajaxop)', async () => {
  // stub steam-totp so keys/time are cheap + deterministic
  const realTime = SteamTotp.time, realOff = SteamTotp.getTimeOffset, realKey = SteamTotp.getConfirmationKey;
  SteamTotp.time = () => 1_000_000;
  SteamTotp.getTimeOffset = (cb) => cb(null, 0);
  SteamTotp.getConfirmationKey = () => 'k';
  try {
    let batchCalls = 0; let perItemCalls = 0; let batchIds: string[] = [];
    const confs = Array.from({ length: 50 }, (_, i) => ({
      id: `id${i}`, key: `nonce${i}`, type: CONF_TYPE_MARKET_LISTING,
      respond(_t: number, _k: unknown, _a: boolean, cb: (e: Error | null) => void) { perItemCalls++; cb(null); },
    }));
    const community = {
      respondToConfirmation(cid: string[], _ck: string[], _t: number, _k: string, _a: boolean, cb: (e: Error | null) => void) {
        batchCalls++; batchIds = cid; cb(null);
      },
    };
    const trader: any = Object.create(AccountTrader.prototype);
    Object.defineProperty(trader, 'username', { value: 'botA' });
    trader.session = { maFile: { identity_secret: 'secret' } };
    trader.community = community;
    trader.confGate = { get: async () => ({ off: 0, confs }), invalidate() { /* noop */ } };

    const res = await trader.confirmMarketListings();
    assert.equal(res.confirmed, 50, 'all 50 listings confirmed');
    assert.equal(res.error, undefined);
    assert.equal(batchCalls, 1, 'exactly ONE multiajaxop POST for the whole batch');
    assert.equal(perItemCalls, 0, 'no per-listing ajaxop on the happy path');
    assert.equal(batchIds.length, 50, 'the batch carried all 50 confirmation ids');
  } finally {
    SteamTotp.time = realTime; SteamTotp.getTimeOffset = realOff; SteamTotp.getConfirmationKey = realKey;
  }
});

test('confirmMarketListings: a 429 on the batch does NOT fall to a per-item storm', async () => {
  const realTime = SteamTotp.time, realOff = SteamTotp.getTimeOffset, realKey = SteamTotp.getConfirmationKey;
  SteamTotp.time = () => 1_000_000;
  SteamTotp.getTimeOffset = (cb) => cb(null, 0);
  SteamTotp.getConfirmationKey = () => 'k';
  try {
    let perItemCalls = 0;
    const confs = Array.from({ length: 20 }, (_, i) => ({
      id: `id${i}`, key: `n${i}`, type: CONF_TYPE_MARKET_LISTING,
      respond(_t: number, _k: unknown, _a: boolean, cb: (e: Error | null) => void) { perItemCalls++; cb(null); },
    }));
    const community = {
      respondToConfirmation(_cid: string[], _ck: string[], _t: number, _k: string, _a: boolean, cb: (e: Error | null) => void) {
        cb(new Error('HTTP error 429'));
      },
    };
    const trader: any = Object.create(AccountTrader.prototype);
    Object.defineProperty(trader, 'username', { value: 'botA' });
    trader.session = { maFile: { identity_secret: 'secret' } };
    trader.community = community;
    trader.confGate = { get: async () => ({ off: 0, confs }), invalidate() { /* noop */ } };

    const res = await trader.confirmMarketListings();
    assert.equal(res.confirmed, 0, 'nothing confirmed (all-or-nothing batch 429)');
    assert.ok(res.error && /429/.test(res.error.message), 'the 429 is surfaced for confirmWithRetry to pause on');
    assert.equal(perItemCalls, 0, 'a 429 must NOT trigger a per-item storm against the rate-limited endpoint');
  } finally {
    SteamTotp.time = realTime; SteamTotp.getTimeOffset = realOff; SteamTotp.getConfirmationKey = realKey;
  }
});
