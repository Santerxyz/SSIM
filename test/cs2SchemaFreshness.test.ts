import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Cs2SchemaService } from '../src/core/Cs2SchemaService';
import { logger } from '../src/utils/logger';
import { dataDir } from '../src/utils/paths';

// ════════════════════════════════════════════════════════════════════════════
//  H-INV-028 — the schema cache had an infinite TTL: once any usable array file
//  existed on disk, ByMykel was never consulted again, across every restart. New
//  Valve collections and ByMykel float/rarity corrections never reached an
//  installed fleet. load() now refreshes a usable cache older than SCHEMA_MAX_AGE_MS;
//  a refresh failure of ANY kind serves the dated cache (never empty, never a throw).
// ════════════════════════════════════════════════════════════════════════════

const SCHEMA_FILE = dataDir('cs2-skins.json');
const FOURTEEN_DAYS_MS = 14 * 24 * 3600 * 1000;

/** Replace axios.get with a stub; returns a restore fn. The responder may throw. */
function mockAxios(responder: () => { status: number; data: unknown }): () => void {
  const ax = require('axios');
  const orig = ax.get;
  const fn = async () => responder();
  ax.get = fn; if (ax.default) ax.default.get = fn;
  return () => { ax.get = orig; if (ax.default) ax.default.get = orig; };
}

/** Capture logger.warn lines; returns { lines, restore }. */
function captureWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = logger.warn.bind(logger);
  (logger as unknown as { warn: (m: string) => unknown }).warn = (m: string) => { lines.push(String(m)); return logger; };
  return { lines, restore: () => { (logger as unknown as { warn: unknown }).warn = orig; } };
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

/** Write a fixture to the schema file and back-date its mtime by `ageMs`. */
function writeAgedSchema(fixture: unknown[], ageMs: number): void {
  fs.writeFileSync(SCHEMA_FILE, JSON.stringify(fixture));
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(SCHEMA_FILE, when, when);
}

function cleanSchemaFile(): void {
  try { fs.rmSync(SCHEMA_FILE, { force: true }); } catch { /* ignore */ }
}

test('H-INV-028 (a): a 30-day-old cache + a rejecting refetch serves the dated cache and leaves the file untouched', async () => {
  cleanSchemaFile();
  writeAgedSchema(validFixture(600), 30 * 24 * 3600 * 1000);
  const before = fs.readFileSync(SCHEMA_FILE, 'utf8');
  const svc = new Cs2SchemaService();
  const restore = mockAxios(() => { throw new Error('ENETDOWN refetch blew up'); });
  const warn = captureWarn();
  try {
    await svc.ensureLoaded();                        // must NOT throw — dated cache is served
    assert.equal(svc.isLoaded(), true, 'the service loaded from the dated cache');
    assert.ok(svc.skinCount() > 0, `served ${svc.skinCount()} skins from the stale-but-usable cache`);
    assert.ok(warn.lines.some((l) => /refresh failed/.test(l) && /serving cached schema/.test(l)),
      'a "refresh failed — serving cached schema" warn was logged');
    assert.equal(fs.readFileSync(SCHEMA_FILE, 'utf8'), before, 'the on-disk cache was NOT overwritten on a failed refresh');
  } finally { warn.restore(); restore(); cleanSchemaFile(); }
});

test('H-INV-028 (b): a 30-day-old cache + a valid larger refetch indexes the new data and rewrites the file', async () => {
  cleanSchemaFile();
  writeAgedSchema(validFixture(600), 30 * 24 * 3600 * 1000);
  const svc = new Cs2SchemaService();
  const restore = mockAxios(() => ({ status: 200, data: validFixture(800) }));
  try {
    await svc.ensureLoaded();
    assert.equal(svc.isLoaded(), true, 'the refresh loaded');
    assert.equal(svc.skinCount(), 800, 'the NEW (larger) schema is indexed, not the stale 600');
    const onDisk = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
    assert.equal(onDisk.length, 800, 'the stale file was replaced by the refreshed schema');
    // A rewrite refreshes mtime → the file is now fresh.
    assert.ok(Date.now() - fs.statSync(SCHEMA_FILE).mtimeMs < FOURTEEN_DAYS_MS, 'the rewritten cache is within the TTL again');
  } finally { restore(); cleanSchemaFile(); }
});

test('H-INV-028 (c): a fresh (mtime-now) cache is authoritative — ByMykel is never consulted', async () => {
  cleanSchemaFile();
  writeAgedSchema(validFixture(600), 0);             // mtime ≈ now → within the TTL
  const svc = new Cs2SchemaService();
  let fetched = false;
  const restore = mockAxios(() => { fetched = true; return { status: 200, data: validFixture(800) }; });
  try {
    await svc.ensureLoaded();
    assert.equal(svc.isLoaded(), true, 'loaded straight from the fresh cache');
    assert.equal(svc.skinCount(), 600, 'the fresh cache is served as-is');
    assert.equal(fetched, false, 'a within-TTL cache short-circuits the ByMykel fetch');
  } finally { restore(); cleanSchemaFile(); }
});
