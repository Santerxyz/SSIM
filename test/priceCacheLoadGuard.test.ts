import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PriceCache } from '../src/pricing/PriceCache';

// ════════════════════════════════════════════════════════════════════════════
//  H-PRC-011 — load() applied no unit/shape guard, so a bad persisted price (a
//  file that predates the set() INV-E2 guard, was hand-edited, or was written by
//  an old mis-scaled source) loaded verbatim and poisoned totalValueUsd. load()
//  now runs the same cents rule as set(): a negative, non-finite, or non-number
//  cents becomes a null miss; a record missing a string fetchedAt is dropped.
// ════════════════════════════════════════════════════════════════════════════

const tmp = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-pc-load-')), 'prices.json');

test('H-PRC-011: load rejects non-cents persisted values', () => {
  const p = tmp();
  const now = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify({
    a: { cents: -5,   fetchedAt: now }, // negative → miss
    b: { cents: '12', fetchedAt: now }, // string   → miss (would leak a string into item.price)
    c: { cents: 300,  fetchedAt: now }, // valid    → kept verbatim
  }));
  const cache = new PriceCache(p);
  assert.equal(cache.get('a')!.cents, null, 'negative persisted cents becomes a null miss');
  assert.equal(cache.get('b')!.cents, null, 'a string persisted cents becomes a null miss');
  assert.equal(cache.get('c')!.cents, 300, 'a valid persisted price is loaded unchanged');
});

test('H-PRC-011: load coerces NaN/Infinity cents to a miss and rounds fractional cents', () => {
  const p = tmp();
  const now = new Date().toISOString();
  // NaN/Infinity do not survive JSON, so cover them via the shape that reaches load: a fractional
  // cents (a legitimate value from an older float-priced source) must round, matching set().
  fs.writeFileSync(p, JSON.stringify({ d: { cents: 123.4, fetchedAt: now } }));
  const cache = new PriceCache(p);
  assert.equal(cache.get('d')!.cents, 123, 'fractional cents round to integer on load, as in set()');
});

test('H-PRC-011: load drops records with no valid fetchedAt and round-trips soft misses', () => {
  const p = tmp();
  const now = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify({
    e: { cents: 100 },                              // no fetchedAt → dropped
    f: 'not-an-object',                             // not a record → dropped
    g: { cents: null, fetchedAt: now, soft: true }, // soft null    → kept, soft preserved
  }));
  const cache = new PriceCache(p);
  assert.equal(cache.get('e'), undefined, 'a record with no fetchedAt is skipped');
  assert.equal(cache.get('f'), undefined, 'a non-object value is skipped');
  assert.equal(cache.get('g')!.cents, null);
  assert.equal(cache.get('g')!.soft, true, 'a soft miss round-trips its soft flag');
});

test('H-PRC-011: a legitimate warm cache loads unchanged', () => {
  const p = tmp();
  const now = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify({ AK: { cents: 5000, fetchedAt: now } }));
  const cache = new PriceCache(p);
  assert.equal(cache.get('AK')!.cents, 5000);
  assert.equal(cache.get('AK')!.fetchedAt, now, 'fetchedAt round-trips unchanged');
});
