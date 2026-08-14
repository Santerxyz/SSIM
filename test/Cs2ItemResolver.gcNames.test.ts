import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cs2SchemaService } from '../src/core/Cs2SchemaService';
import { Cs2ItemResolver } from '../src/core/Cs2ItemResolver';

// ─────────────────────────────────────────────────────────────────────────────
//  Storage-unit naming (owner report 2026-08-11: "they show asset ids not names").
//
//  The Game Coordinator never sends market_hash_name — a casket read is bare econ
//  items — and Steam's WEB inventory deliberately omits casket CONTENTS, so there is
//  no fallback source. The name has to be rebuilt from (def_index, paint_index) +
//  the real paint_wear float. These tests pin that reconstruction, including the
//  three things that silently produce WRONG names if they regress:
//   • StatTrak/Souvenir come from `quality`, not from a name prefix in the payload.
//   • ★ knives/gloves put StatTrak AFTER the star ("★ StatTrak™ …"), not before it.
//   • a def_index-only hit must never claim a PAINTED item (index order matters).
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal ByMykel-shaped skin rows (the real file carries the same fields). */
const SKINS = [
  {
    name: 'AK-47 | Redline', paint_index: '282',
    weapon: { weapon_id: 7, name: 'AK-47' },
    rarity: { id: 'rarity_mythical_weapon' },
    collections: [{ name: 'The Huntsman Collection' }],
    min_float: 0.1, max_float: 0.7, image: 'https://example.invalid/ak.png',
  },
  {
    name: '★ Karambit | Doppler', paint_index: '417',
    weapon: { weapon_id: 507, name: 'Karambit' },
    rarity: { id: 'rarity_ancient' },
    collections: [], min_float: 0, max_float: 0.08,
  },
];

/** Non-painted catalog rows (cases/tools), keyed on def_index alone. */
const DEFS = [
  { d: 1201, n: 'Storage Unit' },
  { d: 4001, n: 'Fracture Case' },
];

function build(): Cs2ItemResolver {
  const schema = new Cs2SchemaService();
  schema.index(SKINS);
  // The resolver reads the shared cs2Schema singleton, so index that one too.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { cs2Schema } = require('../src/core/Cs2SchemaService');
  cs2Schema.index(SKINS);
  const r = new Cs2ItemResolver();
  r.indexRows(DEFS);
  return r;
}

test('a painted item resolves to its exact market_hash_name with the wear from its REAL float', () => {
  const r = build();
  const got = r.resolve({ id: '1', def_index: 7, paint_index: 282, paint_wear: 0.2345678, paint_seed: 412, quality: 4 });
  assert.equal(got.marketHashName, 'AK-47 | Redline (Field-Tested)');
  assert.equal(got.baseName, 'AK-47 | Redline');
  assert.equal(got.wear, 'Field-Tested');
  assert.equal(got.float, 0.2345678);   // the exact GC float, never a wear midpoint estimate
  assert.equal(got.paintSeed, 412);
  assert.equal(got.stattrak, false);
  assert.equal(got.resolved, true);
});

test('quality 9 is StatTrak and quality 12 is Souvenir (the GC sends no name prefix)', () => {
  const r = build();
  const st = r.resolve({ id: '2', def_index: 7, paint_index: 282, paint_wear: 0.031, quality: 9 });
  assert.equal(st.marketHashName, 'StatTrak™ AK-47 | Redline (Factory New)');
  assert.equal(st.stattrak, true);

  const sv = r.resolve({ id: '3', def_index: 7, paint_index: 282, paint_wear: 0.5, quality: 12 });
  assert.equal(sv.marketHashName, 'Souvenir AK-47 | Redline (Battle-Scarred)');
  assert.equal(sv.souvenir, true);
});

test('a ★ knife keeps the star FIRST and splices StatTrak after it', () => {
  const r = build();
  const got = r.resolve({ id: '4', def_index: 507, paint_index: 417, paint_wear: 0.009, quality: 9 });
  // Steam's canonical order is "★ StatTrak™ Karambit | Doppler (Factory New)" — a naive
  // prepend would produce "StatTrak™ ★ Karambit …", which matches no market listing.
  assert.equal(got.marketHashName, '★ StatTrak™ Karambit | Doppler (Factory New)');
});

test('non-painted items resolve from the def_index catalog', () => {
  const r = build();
  assert.equal(r.resolve({ id: '5', def_index: 4001, quality: 4 }).marketHashName, 'Fracture Case');
  assert.equal(r.resolve({ id: '6', def_index: 1201, quality: 4 }).marketHashName, 'Storage Unit');
});

test('an unmappable item is reported honestly, never given an invented name', () => {
  const r = build();
  const got = r.resolve({ id: '7', def_index: 99999, quality: 4 });
  assert.equal(got.resolved, false);
  assert.match(got.marketHashName, /Unknown item \(def 99999\)/);
});

test('a painted item wins over a colliding def_index catalog row', () => {
  // def_index 7 is the AK-47; if a catalog row ever shared that index, resolving by
  // def_index alone would rename every AK in every storage unit. paint_index must win.
  const r = build();
  r.indexRows([...DEFS, { d: 7, n: 'Some Colliding Tool' }]);
  const got = r.resolve({ id: '8', def_index: 7, paint_index: 282, paint_wear: 0.2, quality: 4 });
  assert.equal(got.marketHashName, 'AK-47 | Redline (Field-Tested)');
});

test('a painted item with no readable float is named without a fabricated wear band', () => {
  const r = build();
  const got = r.resolve({ id: '9', def_index: 7, paint_index: 282, quality: 4 });
  assert.equal(got.marketHashName, 'AK-47 | Redline');
  assert.equal(got.wear, null);
  assert.equal(got.float, null);
});
