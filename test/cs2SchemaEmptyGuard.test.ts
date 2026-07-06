import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Cs2SchemaService } from '../src/core/Cs2SchemaService';
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
