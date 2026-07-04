import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PriceCache } from '../src/pricing/PriceCache';

// ════════════════════════════════════════════════════════════════════════════
//  S43 — the old 2s flush window was SHORTER than the ~3.5s inter-fetch delay, so
//  every fetched price rewrote the whole prices.json (up to 100k entries) once per
//  fetch for the entire fill. Writes are now coalesced into a longer max-delay
//  window (FLUSH_MAX_DELAY_MS) with a burst cap (FLUSH_EVERY_N) so a fast warm-up
//  still persists promptly, but a slow fill batches many prices per write.
// ════════════════════════════════════════════════════════════════════════════

const FLUSH_EVERY_N = 250; // must match PriceCache.FLUSH_EVERY_N

const tmp = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-pc-')), 'prices.json');

test('S43: a small number of sets is COALESCED (not rewritten on every set)', () => {
  const p = tmp(); // fresh path — the file does not exist yet
  const cache = new PriceCache(p);
  for (let i = 0; i < 10; i++) cache.set(`item${i}`, 100 + i);
  // Under the old per-fetch behaviour these would each have rewritten the file. Now they sit in a
  // pending coalescing window (a long unref'd timer) — nothing on disk yet.
  assert.equal(fs.existsSync(p), false, 'the writes are coalesced, not one-per-set');
  cache.flush(); // an explicit flush (shutdown/enrich boundary) persists the batch in one write
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(p, 'utf8'))).length, 10, 'all 10 persist in a single write');
});

test('S43: a burst of FLUSH_EVERY_N sets persists SYNCHRONOUSLY (burst cap, no 30s wait, no data held forever)', () => {
  const p = tmp();
  const cache = new PriceCache(p);
  for (let i = 0; i < FLUSH_EVERY_N; i++) cache.set(`item${i}`, 100 + i);
  // The Nth set tripped the burst cap → an immediate flush, so the file is on disk NOW without waiting
  // for the timer. This bounds how much a fast bulk warm-up can hold in memory before persisting.
  assert.ok(fs.existsSync(p), 'the burst cap forced a synchronous flush');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(p, 'utf8'))).length, FLUSH_EVERY_N);
});

test('S43: updating an existing price still marks dirty and flushes on the boundary', () => {
  const p = tmp();
  const cache = new PriceCache(p);
  cache.set('AK', 5000);
  cache.set('AK', 6000); // overwrite
  cache.flush();
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).AK.cents, 6000, 'the latest price persists');
});
