import { test } from 'node:test';
import assert from 'node:assert/strict';
import { achievableWears, wearForFloat, wearMidpoint, computeContract, type TuInput, type OutputProvider } from '../src/trading/tradeupMath';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-075 — warmOutputPrices must not queue wears a skin's float range can't
//  roll. A trade-up output float spans [minFloat, maxFloat]; achievableWears is
//  the shared helper that keeps warmOutputPrices from naming market items that
//  don't exist (each impossible name burns a ~3.5s single-IP fill slot).
// ─────────────────────────────────────────────────────────────────────────────

test('warm skips impossible wears', () => {
  // A 0.40–1.00 skin can never be Factory New / Minimal Wear / Field-Tested.
  const wears = achievableWears(0.40, 1.0);
  assert.deepEqual(wears, ['Well-Worn', 'Battle-Scarred']);
});

test('full 0..1 range keeps every wear', () => {
  const wears = achievableWears(0, 1);
  assert.deepEqual(wears, ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred']);
});

test('a capped-low range drops Battle-Scarred', () => {
  // maxFloat 0.38 → the Battle-Scarred band [0.45, 1.01) never intersects.
  const wears = achievableWears(0, 0.38);
  assert.deepEqual(wears, ['Factory New', 'Minimal Wear', 'Field-Tested']);
});

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-076 — a non-finite input float must be rejected, not coerced to 0. Float
//  0.00 is the BEST wear a skin can roll, so a silent NaN→0 minimizes the output
//  float, biases the wear to Factory New, and inflates EV/profit on a money
//  preview with no flag. Both entry points now throw; the caller catches + skips.
// ─────────────────────────────────────────────────────────────────────────────

const fixtureSchema: OutputProvider = {
  outputsFor: () => [{ name: 'Test Skin', minFloat: 0, maxFloat: 1 }],
  marketHashName: (skinName, wear, stattrak) => `${stattrak ? 'StatTrak™ ' : ''}${skinName} (${wear})`,
};

const mkInput = (float: number): TuInput => ({
  marketHashName: 'Input (Field-Tested)',
  baseName: 'Input',
  collection: 'The Test Collection',
  rarityId: 'rarity_test',
  stattrak: false,
  float,
  priceCents: 100,
});

test('wearForFloat throws on a non-finite float', () => {
  assert.throws(() => wearForFloat(NaN), /non-finite/);
  assert.throws(() => wearForFloat(Infinity), /non-finite/);
});

test('computeContract throws when one input float is non-finite', () => {
  const inputs = Array.from({ length: 10 }, () => mkInput(0.2));
  inputs[3] = mkInput(NaN);
  assert.throws(() => computeContract(inputs, 'rarity_out', fixtureSchema, () => 100), /finite float/);
});

test('computeContract accepts a set of all-finite floats', () => {
  const inputs = Array.from({ length: 10 }, () => mkInput(0.2));
  const c = computeContract(inputs, 'rarity_out', fixtureSchema, () => 100);
  assert.ok(Math.abs(c.avgFloat - 0.2) < 1e-9);
});

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-078 — when the claimed wear band and the skin's [min,max] range don't
//  intersect (schema float-range drift), wearMidpoint must resolve to the NEAREST
//  range bound, not always skinMin. A band sitting wholly above the range answers
//  skinMax; a band below answers skinMin (unchanged). Returning skinMin for an
//  above-range band is the maximally optimistic wrong end (biases EV/profit up).
// ─────────────────────────────────────────────────────────────────────────────

test('wearMidpoint returns skinMax when the band is above the range', () => {
  // Battle-Scarred band [0.45, 1.01) is wholly above a 0..0.38 range → nearest bound is 0.38.
  assert.equal(wearMidpoint('Battle-Scarred', 0, 0.38), 0.38);
});

test('wearMidpoint returns skinMin when the band is below the range', () => {
  // Factory New band [0.00, 0.07) is wholly below a 0.40..1 range → nearest bound is 0.40.
  assert.equal(wearMidpoint('Factory New', 0.4, 1), 0.4);
});

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-080 — an input from a collection the schema can't produce outputs for is
//  a malformed set, not a defensive skip: silently dropping it makes Σprobability
//  < 1 and understates EV in a way indistinguishable from a pricing gap. The empty
//  output pool must throw (the caller catches + skips the candidate).
// ─────────────────────────────────────────────────────────────────────────────

const twoCollectionSchema = (empty: string): OutputProvider => ({
  outputsFor: (collection) => (collection === empty ? [] : [{ name: 'Test Skin', minFloat: 0, maxFloat: 1 }]),
  marketHashName: (skinName, wear, stattrak) => `${stattrak ? 'StatTrak™ ' : ''}${skinName} (${wear})`,
});

const mkInputIn = (collection: string, float: number): TuInput => ({
  marketHashName: 'Input (Field-Tested)',
  baseName: 'Input',
  collection,
  rarityId: 'rarity_test',
  stattrak: false,
  float,
  priceCents: 100,
});

test('computeContract throws when one input collection has no outputs', () => {
  const inputs = [
    ...Array.from({ length: 5 }, () => mkInputIn('Collection A', 0.2)),
    ...Array.from({ length: 5 }, () => mkInputIn('Collection B', 0.2)),
  ];
  assert.throws(
    () => computeContract(inputs, 'rarity_out', twoCollectionSchema('Collection B'), () => 100),
    /no next-rarity outputs/,
  );
});

test('computeContract outcome probabilities sum to 1 when both collections have outputs', () => {
  const inputs = [
    ...Array.from({ length: 5 }, () => mkInputIn('Collection A', 0.2)),
    ...Array.from({ length: 5 }, () => mkInputIn('Collection B', 0.2)),
  ];
  const c = computeContract(inputs, 'rarity_out', twoCollectionSchema('none'), () => 100);
  const total = c.outcomes.reduce((s, o) => s + o.probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});
