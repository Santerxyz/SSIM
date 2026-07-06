import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Cs2SchemaService } from '../src/core/Cs2SchemaService';
import { wearMidpoint } from '../src/trading/tradeupMath';
import { dataDir } from '../src/utils/paths';

// ════════════════════════════════════════════════════════════════════════════
//  H-INV-029 — an empty or format-drifted schema array must NOT be accepted as
//  authoritative. Before this fix the only usability check was Array.isArray, so a
//  200 of [] (or a shape-drifted array that indexes to ~0 skins) was persisted to
//  data/cs2-skins.json and re-read on every boot forever — the proven S4/S2 class
//  with an infinite TTL. load() now indexes first and gates on MIN_SCHEMA_SKINS:
//  a too-small disk cache is refetched; a too-small fetch throws + is NOT written.
// ════════════════════════════════════════════════════════════════════════════

const SCHEMA_FILE = dataDir('cs2-skins.json');

/** Replace axios.get with a stub returning {status,data}; returns a restore fn. */
function mockAxios(responder: () => { status: number; data: unknown }): () => void {
  const ax = require('axios');
  const orig = ax.get;
  const fn = async () => responder();
  ax.get = fn; if (ax.default) ax.default.get = fn;
  return () => { ax.get = orig; if (ax.default) ax.default.get = orig; };
}

/** A valid ByMykel-shaped fixture with `count` collection-bearing weapon-tier skins. */
function validFixture(count: number): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      name: `AK-47 | Fixture ${i}`,
      rarity: { id: 'rarity_rare_weapon' },
      collections: [{ name: `The Fixture Collection ${i % 10}` }],
      min_float: 0,
      max_float: 1,
    });
  }
  return out;
}

function cleanSchemaFile(): void {
  try { fs.rmSync(SCHEMA_FILE, { force: true }); } catch { /* ignore */ }
}

test('H-INV-029 (a): a 200 of [] with no disk cache throws /unusable/ and writes nothing', async () => {
  cleanSchemaFile();
  const svc = new Cs2SchemaService();
  const restore = mockAxios(() => ({ status: 200, data: [] }));
  try {
    await assert.rejects(() => svc.ensureLoaded(), /unusable/);
    assert.equal(fs.existsSync(SCHEMA_FILE), false, 'the poisoned empty schema was NOT persisted');
    assert.equal(svc.isLoaded(), false, 'the service stays unloaded so the next click retries');
    assert.equal(svc.skinCount(), 0, 'the failed index left no skins in the map');
  } finally { restore(); cleanSchemaFile(); }
});

test('H-INV-029 (b): a [] disk cache is refetched, and a valid fetch replaces the file', async () => {
  cleanSchemaFile();
  fs.writeFileSync(SCHEMA_FILE, '[]');            // pre-existing poisoned disk cache
  const svc = new Cs2SchemaService();
  const restore = mockAxios(() => ({ status: 200, data: validFixture(600) }));
  try {
    await svc.ensureLoaded();
    assert.equal(svc.isLoaded(), true, 'the valid refetch loaded');
    assert.ok(svc.skinCount() >= 500, `indexed ${svc.skinCount()} skins from the refetch`);
    const onDisk = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
    assert.ok(Array.isArray(onDisk) && onDisk.length >= 500, 'the [] file was replaced by the valid schema');
  } finally { restore(); cleanSchemaFile(); }
});

test('H-INV-029 (c): a valid fetch (no disk cache) resolves and writes the file', async () => {
  cleanSchemaFile();
  const svc = new Cs2SchemaService();
  const restore = mockAxios(() => ({ status: 200, data: validFixture(600) }));
  try {
    await svc.ensureLoaded();
    assert.equal(svc.isLoaded(), true, 'the gate passed');
    assert.equal(fs.existsSync(SCHEMA_FILE), true, 'a proven-usable schema IS persisted');
  } finally { restore(); cleanSchemaFile(); }
});

// ════════════════════════════════════════════════════════════════════════════
//  H-INV-031 — collection extraction must be type-honest. The old
//  String((first)?.name ?? first) fallback stringified an object whose `name`
//  drifted away into "[object Object]", pooling EVERY weapon skin into one
//  pseudo-collection with fabricated trade-up EV. The fix degrades conservatively:
//  a collections[0] object with no string `name` yields '' → excluded, never wrong.
// ════════════════════════════════════════════════════════════════════════════

test('H-INV-031: a collections[0] object without a string name is excluded, never "[object Object]"', () => {
  const svc = new Cs2SchemaService();
  svc.index([
    { name: 'AK-47 | Drifted', rarity: { id: 'rarity_rare_weapon' }, collections: [{ id: 'x' }], min_float: 0, max_float: 1 },
    { name: 'AK-47 | Named', rarity: { id: 'rarity_rare_weapon' }, collections: ['The Test Collection'], min_float: 0, max_float: 1 },
  ]);
  const drifted = svc.lookup('AK-47 | Drifted');
  assert.ok(drifted, 'the drifted skin is still indexed by name');
  assert.equal(drifted!.collection, '', 'no name → empty collection, not "[object Object]"');
  assert.equal(svc.isEligibleInput(drifted!), false, 'a collection-less skin is not a trade-up input');
  const named = svc.lookup('AK-47 | Named');
  assert.equal(named!.collection, 'The Test Collection', 'a bare string collection pools under that exact name');
  assert.equal(svc.outputsFor('[object Object]', 'rarity_mythical_weapon').length, 0, 'no "[object Object]" mega-collection exists');
});

test('H-INV-031: a collections[0] object WITH a string name still pools under that name', () => {
  const svc = new Cs2SchemaService();
  svc.index([
    { name: 'M4A4 | Obj', rarity: { id: 'rarity_rare_weapon' }, collections: [{ name: 'The Object Collection' }], min_float: 0, max_float: 1 },
  ]);
  const def = svc.lookup('M4A4 | Obj');
  assert.equal(def!.collection, 'The Object Collection', 'object.name is still extracted');
});

// ════════════════════════════════════════════════════════════════════════════
//  H-INV-033 — numOr must be type-honest. Number(null)===0 is finite, so the old
//  numOr returned 0 (not the declared default) for a null/'' float field: a null
//  max_float became 0 instead of 1, collapsing the whole float band to a fabricated
//  0.00 god-roll on the number a user destroys 10 items over. The fix returns the
//  default for anything that is not a finite JS number.
// ════════════════════════════════════════════════════════════════════════════

test('H-INV-033: a null min_float/max_float falls back to the declared defaults [0,1]', () => {
  const svc = new Cs2SchemaService();
  svc.index([
    { name: 'AK-47 | Nullfloat', rarity: { id: 'rarity_rare_weapon' }, collections: ['The Test Collection'], min_float: null, max_float: null },
  ]);
  const def = svc.lookup('AK-47 | Nullfloat');
  assert.ok(def, 'the row is still indexed');
  assert.equal(def!.minFloat, 0, 'null min_float → declared default 0, not Number(null)===0-by-accident');
  assert.equal(def!.maxFloat, 1, 'null max_float → declared default 1, not the fabricated 0');
});

test('H-INV-033: an empty-string max_float falls back to the default 1', () => {
  const svc = new Cs2SchemaService();
  svc.index([
    { name: 'M4A1-S | Emptyfloat', rarity: { id: 'rarity_rare_weapon' }, collections: ['The Test Collection'], min_float: 0, max_float: '' },
  ]);
  const def = svc.lookup('M4A1-S | Emptyfloat');
  assert.equal(def!.maxFloat, 1, "'' max_float → default 1, not Number('')===0");
});

test('H-INV-033: a real numeric max_float is preserved unchanged', () => {
  const svc = new Cs2SchemaService();
  svc.index([
    { name: 'AWP | Realfloat', rarity: { id: 'rarity_rare_weapon' }, collections: ['The Test Collection'], min_float: 0, max_float: 0.38 },
  ]);
  const def = svc.lookup('AWP | Realfloat');
  assert.equal(def!.maxFloat, 0.38, 'a finite number passes through untouched');
});

test('H-INV-033: the restored [0,1] band yields a real FT midpoint, not a fabricated 0', () => {
  // With the poisoned {0,0} band wearMidpoint would return 0 for every wear; the
  // restored [0,1] band produces the true Field-Tested midpoint.
  assert.ok(wearMidpoint('Field-Tested', 0, 1) > 0, 'FT midpoint over [0,1] is non-zero');
  assert.equal(wearMidpoint('Field-Tested', 0, 0), 0, 'the poisoned {0,0} band collapses to 0 (the defect this guards)');
});
