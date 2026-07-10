import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AccountTrader } from '../src/trading/AccountTrader';

// Patch the underlying CJS module the source imports (its `SteamTotp.time(off)` reads
// through this same cached require), NOT the getter-only ESM namespace binding.
const SteamTotp = createRequire(__filename)('steam-totp') as {
  time: (off?: number) => number;
  getTimeOffset: (cb: (err: Error | null, off: number) => void) => void;
  getConfirmationKey: (...args: any[]) => string;
};

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-007 — the PER-ITEM fallback's confirmation times must NOT drift +1s per
//  item ahead of server time. Since 2026-07-10 the happy path is a single
//  `multiajaxop` (one time, no drift possible); this bound matters for the per-item
//  FALLBACK the code takes when the batch fails. The old `SteamTotp.time(off) + idx`
//  signed the Nth accept N seconds in the future; the fix signs each with
//  `max(SteamTotp.time(off), prevT + 1)` — unique + increasing, bounded to ≤1s beyond
//  real server time for any batch size.
//
//  The loops are driven directly (Object.create) with a stubbed SteamTotp.time that
//  advances 1s per call and a stub community whose batch respondToConfirmation FAILS
//  (forcing the per-item fallback under test) and whose per-conf respond() captures
//  the signed time.
// ─────────────────────────────────────────────────────────────────────────────

const CONF_TYPE_MARKET_LISTING = 3;

interface Captured { signed: number; timeNow: number }

/** Build a trader whose per-item respond captures its signed time, and whose BATCH respondToConfirmation
 *  fails (non-rate-limit) so confirmMarketListings/respondToConfirmations take the per-item fallback path. */
function traderWithConfirmations(count: number, type: number): { trader: any; captured: Captured[] } {
  const captured: Captured[] = [];
  const confs = Array.from({ length: count }, (_, i) => ({
    id: `id${i}`,
    creator: `c${i}`,
    key: `nonce${i}`,
    type,
    respond(t: number, _key: unknown, _accept: boolean, cb: (err: Error | null) => void) {
      captured.push({ signed: t, timeNow: clock });
      cb(null);
    },
  }));
  const community = {
    getConfirmations(_time: number, _key: unknown, cb: (err: Error | null, confs: any[]) => void) {
      cb(null, confs);
    },
    // Force the all-or-nothing batch to fail (non-rate-limit) → code falls back to the per-item path.
    respondToConfirmation(_cid: unknown, _ck: unknown, _t: number, _k: unknown, _accept: boolean, cb: (err: Error | null) => void) {
      cb(new Error('force per-item fallback'));
    },
  };
  const trader: any = Object.create(AccountTrader.prototype);
  Object.defineProperty(trader, 'username', { value: 'botA' });
  (trader as any).session = { maFile: { identity_secret: 'secret' } };
  (trader as any).community = community;
  // Fake gate: hand back the stub confs directly (this test exercises respond-time logic, not the fetch).
  (trader as any).confGate = { get: async () => ({ off: 0, confs }), invalidate() { /* noop */ } };
  return { trader, captured };
}

// A monotonic stub clock: SteamTotp.time advances 1s each call, modelling ~1 real
// second elapsing per accept (the worst case the fix must survive). getTimeOffset is
// made synchronous; getConfirmationKey is a cheap no-op.
let clock = 0;
const realTime = SteamTotp.time;
const realOffset = SteamTotp.getTimeOffset;
const realKey = SteamTotp.getConfirmationKey;

function installStub(): void {
  clock = 1_000_000;
  SteamTotp.time = () => clock++;
  SteamTotp.getTimeOffset = (cb: (err: Error | null, off: number) => void) => cb(null, 0);
  SteamTotp.getConfirmationKey = () => 'k';
}
function restoreStub(): void {
  SteamTotp.time = realTime;
  SteamTotp.getTimeOffset = realOffset;
  SteamTotp.getConfirmationKey = realKey;
}

function assertBounded(captured: Captured[], n: number): void {
  assert.equal(captured.length, n, `all ${n} confirmations were signed`);
  const seen = new Set<number>();
  let prev = -Infinity;
  for (const { signed, timeNow } of captured) {
    assert.ok(!seen.has(signed), `signed time ${signed} is unique`);
    seen.add(signed);
    assert.ok(signed > prev, `signed time strictly increasing (${signed} > ${prev})`);
    // The core guarantee: never signed more than 1s beyond the current server time —
    // the old `+idx` code drifted unboundedly (the Nth accept was ~2N seconds ahead).
    assert.ok(signed <= timeNow + 1, `signed time ${signed} ≤ server time ${timeNow} + 1`);
    prev = signed;
  }
}

test('H-TRD-007: confirmMarketListings per-item fallback signs 300 accepts unique+increasing and ≤ server time + 1', async () => {
  installStub();
  try {
    const { trader, captured } = traderWithConfirmations(300, CONF_TYPE_MARKET_LISTING);
    const res = await trader.confirmMarketListings();
    assert.equal(res.confirmed, 300);
    assert.equal(res.error, undefined);
    assertBounded(captured, 300);
  } finally {
    restoreStub();
  }
});

test('H-TRD-007: respondToConfirmations (all=true) per-item fallback signs 300 unique+increasing and ≤ server time + 1', async () => {
  installStub();
  try {
    // type here is irrelevant — all=true actions every pending confirmation (SDA "confirm all").
    const { trader, captured } = traderWithConfirmations(300, CONF_TYPE_MARKET_LISTING);
    const res = await trader.respondToConfirmations([], true, true);
    assert.equal(res.done, 300);
    assert.equal(res.failed.length, 0);
    assertBounded(captured, 300);
  } finally {
    restoreStub();
  }
});
