import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPricerIdentities, LOCAL_EGRESS } from '../src/pricing/PricerIdentityPool';
import { PricingService } from '../src/pricing/PricingService';

// ─────────────────────────────────────────────────────────────────────────────
//  Egress-spread pricing (2026-08-25). Steam meters market/priceoverview PER
//  EXIT IP, so the fill's speed must come from using MORE exits — never from
//  leaning harder on the exits it already has.
//
//  The pre-change fill ran 3 lanes at one request per 3.5s. Whether those landed
//  on one IP or three was accidental, so the pace known to be safe is the worst
//  case it shipped: all 3 on ONE IP ≈ 0.86 req/s per exit. That budget is the
//  invariant these tests defend.
//
//  What must hold:
//   • picks are round-robin over exits, so N proxies give lanes on N IPs before
//     any one IP gets a second — the old "first N in map order" could put the
//     whole fill on a single IP;
//   • NO MORE THAN maxPerExit lanes ever point at one exit. This is the bound
//     that keeps a SINGLE-EXIT setup — proxyless, one static proxy, or one
//     ROTATING proxy (all one egressKey) — at the old, proven pace however many
//     sessions are live and however high the global lane cap goes;
//   • a lane's delay divides its EXIT's budget by the lanes sharing that exit,
//     so an exit's aggregate rate is the same whether it got 1 lane or 3.
// ─────────────────────────────────────────────────────────────────────────────

const agent = {} as any;
const cand = (username: string, egressKey: string) =>
  ({ username, cookies: [`steamLoginSecure=${username}`], agent, egressKey });
const many = (n: number, egressKey: string, prefix = 'bot') =>
  Array.from({ length: n }, (_, i) => cand(`${prefix}${i}`, egressKey));

test('pickPricerIdentities: round-robins across exits instead of taking the first N in order', () => {
  // Six candidates, three proxies, listed so a naive "first 3" would take ALL of P1.
  const ids = pickPricerIdentities([
    cand('a1', 'proxy:1.1.1.1:8000'),
    cand('a2', 'proxy:1.1.1.1:8000'),
    cand('a3', 'proxy:1.1.1.1:8000'),
    cand('b1', 'proxy:2.2.2.2:8000'),
    cand('b2', 'proxy:2.2.2.2:8000'),
    cand('c1', 'proxy:3.3.3.3:8000'),
  ], 3, 3);

  assert.deepEqual(ids.map((i) => i.username), ['a1', 'b1', 'c1'],
    'one per exit before a second from any exit — NOT a1/a2/a3');
  assert.equal(new Set(ids.map((i) => i.egressKey)).size, 3, 'three lanes on three distinct IPs');
  assert.equal(ids.every((i) => i.exitLanes === 1), true, 'each is alone on its exit');
});

// ── The regression this file exists for ──────────────────────────────────────
// A single rotating proxy presents as ONE egressKey (SSIM never observes the
// provider-side exit IP), exactly like a proxyless fleet or one static proxy.
// Raising the global lane cap must NOT turn that into N lanes on one IP.

test('SINGLE EXIT: a rotating/static proxy never gets more than maxPerExit lanes, however many sessions are live', () => {
  const ids = pickPricerIdentities(many(200, 'proxy:1.1.1.1:8000'), 36, 3);
  assert.equal(ids.length, 3,
    '200 live sessions on ONE proxy string still yield 3 lanes — not 36 pointed at the same IP');
  assert.equal(ids.every((i) => i.exitLanes === 3), true, 'and each knows it shares the exit with 2 others');
});

test('SINGLE EXIT: a proxyless fleet is likewise capped at the old lane count', () => {
  const ids = pickPricerIdentities(many(200, LOCAL_EGRESS), 36, 3);
  assert.equal(ids.length, 3, 'the host IP gets the same 3 lanes it always had');
});

test('SINGLE EXIT: the per-exit cap holds even when the global limit is far larger', () => {
  for (const limit of [4, 16, 36, 500]) {
    const ids = pickPricerIdentities(many(50, 'proxy:9.9.9.9:1080'), limit, 3);
    assert.equal(ids.length, 3, `limit ${limit} must not widen a single exit past maxPerExit`);
  }
});

test('MANY EXITS: throughput scales with exits, each still capped at maxPerExit', () => {
  // 12 exits × 4 accounts each, global cap 36 → 3 lanes per exit, 36 total.
  const candidates = Array.from({ length: 12 }, (_, e) => many(4, `proxy:10.0.0.${e}:8000`, `e${e}b`)).flat();
  const ids = pickPricerIdentities(candidates, 36, 3);

  assert.equal(ids.length, 36, '12 exits × 3 lanes');
  const perExit = new Map<string, number>();
  for (const i of ids) perExit.set(i.egressKey, (perExit.get(i.egressKey) ?? 0) + 1);
  assert.equal(perExit.size, 12, 'all twelve exits are in use');
  assert.equal([...perExit.values()].every((n) => n === 3), true, 'and none exceeds 3 lanes');
});

test('pickPricerIdentities: a second pass fills from the same exits once every exit is used', () => {
  const ids = pickPricerIdentities([
    cand('a1', 'proxy:1.1.1.1:8000'),
    cand('a2', 'proxy:1.1.1.1:8000'),
    cand('b1', 'proxy:2.2.2.2:8000'),
    cand('b2', 'proxy:2.2.2.2:8000'),
  ], 4, 2);

  assert.deepEqual(ids.map((i) => i.username), ['a1', 'b1', 'a2', 'b2'], 'round 1 then round 2');
  assert.equal(ids.every((i) => i.exitLanes === 2), true, 'two lanes share each exit — each must halve that exit\'s pace');
});

test('pickPricerIdentities: exitLanes counts the SELECTED lanes, not the fleet', () => {
  // Three accounts on one proxy, but only ONE is selected → that lane has the exit to itself.
  const ids = pickPricerIdentities(many(3, 'proxy:1.1.1.1:8000'), 1, 3);
  assert.equal(ids.length, 1);
  assert.equal(ids[0].exitLanes, 1, 'alone among the SELECTED identities → it gets the whole exit budget');
});

test('pickPricerIdentities: maxPerExit defaults to 1 (spread-only unless a caller opts in)', () => {
  const ids = pickPricerIdentities(many(10, 'proxy:1.1.1.1:8000'), 10);
  assert.equal(ids.length, 1, 'the safe default never stacks lanes on one exit');
});

test('pickPricerIdentities: an absent egressKey is treated as the host IP, not as its own exit', () => {
  const ids = pickPricerIdentities([
    { username: 'x', cookies: ['steamLoginSecure=x'], agent } as any,
    { username: 'y', cookies: ['steamLoginSecure=y'], agent } as any,
  ], 2, 2);
  assert.equal(new Set(ids.map((i) => i.egressKey)).size, 1, 'both fall into the one local bucket');
  assert.equal(ids.every((i) => i.exitLanes === 2), true, 'and they share that exit\'s budget');
});

test('pickPricerIdentities: limit 0 or maxPerExit 0 selects nothing (no accidental fan-out)', () => {
  assert.deepEqual(pickPricerIdentities([cand('a', 'proxy:1.1.1.1:8000')], 0, 3), []);
  assert.deepEqual(pickPricerIdentities([cand('a', 'proxy:1.1.1.1:8000')], 3, 0), []);
});

// ── Pacing: one exit's aggregate rate is invariant to how many lanes it got ───

/** Times the gap between a lane's first two fetches — that gap IS the lane's pace. */
async function laneGapMs(exitLanes: number, waitMs: number): Promise<number> {
  const stamps: number[] = [];
  const svc = new PricingService(
    undefined,
    () => [{ username: 'p', cookieHeader: 'steamLoginSecure=x', agent: undefined as any, egressKey: 'proxy:1.1.1.1:8000', exitLanes }],
  );
  (svc as any).steamSource = { id: 'steam', fetchPriceCents: async () => { stamps.push(Date.now()); return 100; } };
  try {
    svc.ensureFilled([{ name: `P${exitLanes}a`, appid: 730 }, { name: `P${exitLanes}b`, appid: 730 }]);
    await new Promise((r) => setTimeout(r, waitMs));
    assert.equal(stamps.length, 2, `both names priced for exitLanes=${exitLanes}`);
    return stamps[1] - stamps[0];
  } finally { svc.shutdown(); }
}

test('PricingService: a lane sharing its exit with 2 others runs at the full 3.5s pace', async () => {
  const gap = await laneGapMs(3, 4_200);
  assert.ok(gap >= 3_300, `3 lanes on one exit → 3.5s each (gap ${gap}ms), preserving ~0.86 req/s on that IP`);
});

test('PricingService: a lane ALONE on its exit gets that exit\'s whole budget, not a single lane\'s', async () => {
  const gap = await laneGapMs(1, 2_000);
  assert.ok(gap >= 1_000, `never faster than the floor (gap ${gap}ms)`);
  assert.ok(gap < 2_000, `one lane spends the whole exit budget (~1.17s), not 3.5s (gap ${gap}ms)`);
});

test('PricingService: the per-exit rate is the SAME whether an exit got 1 lane or 3', async () => {
  const [solo, shared] = [await laneGapMs(1, 2_000), await laneGapMs(3, 4_200)];
  const soloRate = 1 / solo;            // 1 lane at this pace
  const sharedRate = 3 / shared;        // 3 lanes at this pace
  assert.ok(Math.abs(soloRate - sharedRate) / sharedRate < 0.15,
    `an exit's aggregate rate must not depend on lane count (solo ${(soloRate * 1000).toFixed(2)}/s vs shared ${(sharedRate * 1000).toFixed(2)}/s)`);
});
