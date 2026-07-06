import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { ValueHistoryService } from '../src/core/ValueHistoryService';
import { dataDir } from '../src/utils/paths';

// ════════════════════════════════════════════════════════════════════════════
//  H-INV-019 — a failed read of value_history.json used to silently discard the
//  ENTIRE history and the next flush permanently overwrote it. Value history is
//  NOT refetchable (unlike the inventory cache), so load() now PRESERVES the
//  current bytes to a `.corrupt-<ts>` sibling before starting fresh (S12/S5).
//  (SSIM_HOME is a throwaway temp dir per test/_setup.cjs, so HISTORY_PATH
//   resolves to a sandboxed data/value_history.json.)
// ════════════════════════════════════════════════════════════════════════════

const HISTORY = dataDir('value_history.json');
const DIR = dataDir();

function cleanHistory(): void {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* ignore */ }
  for (const f of fs.readdirSync(DIR)) {
    if (f.startsWith('value_history.json')) { try { fs.rmSync(dataDir(f), { force: true }); } catch { /* ignore */ } }
  }
}

function preservedCopies(): string[] {
  return fs.readdirSync(DIR).filter((f) => f.startsWith('value_history.json.corrupt-'));
}

const noopDeps = () => {
  const accounts = { getEnvironments: () => [], getByEnvironment: () => [] };
  const store = { get: () => undefined };
  const tf2Store = { get: () => undefined };
  const pricing = { enrich: () => {}, status: () => ({ running: false, queued: 0 }) };
  const exchange = { getUsdToEur: () => 0.9 };
  return [accounts, store, tf2Store, pricing, exchange] as const;
};

function makeService(): ValueHistoryService {
  const [accounts, store, tf2Store, pricing, exchange] = noopDeps();
  return new ValueHistoryService(accounts as never, store as never, tf2Store as never, pricing as never, exchange as never);
}

test('H-INV-019: garbage bytes are preserved to a .corrupt-* sibling and history boots empty', () => {
  cleanHistory();
  const garbage = '{ this is not json at all';
  fs.writeFileSync(HISTORY, garbage);

  const svc = makeService();

  assert.deepEqual(svc.get('global'), [], 'history boots empty on an unreadable file');
  const copies = preservedCopies();
  assert.equal(copies.length, 1, 'exactly one .corrupt-* sibling was preserved');
  assert.equal(fs.readFileSync(dataDir(copies[0]), 'utf8'), garbage, 'the preserved copy holds the untouched garbage bytes');
  cleanHistory();
});

test('H-INV-019: valid JSON of the wrong shape is preserved too (not silently discarded)', () => {
  cleanHistory();
  const wrongShape = JSON.stringify({ version: 1 }); // valid JSON but no `series`
  fs.writeFileSync(HISTORY, wrongShape);

  const svc = makeService();

  assert.deepEqual(svc.get('global'), [], 'history boots empty on a wrong-shape file');
  const copies = preservedCopies();
  assert.equal(copies.length, 1, 'the wrong-shape file is preserved, not silently dropped');
  assert.equal(fs.readFileSync(dataDir(copies[0]), 'utf8'), wrongShape, 'the preserved copy holds the untouched bytes');
  cleanHistory();
});

test('H-INV-019: a valid history file is loaded and NOT preserved (no .corrupt-* created)', () => {
  cleanHistory();
  const good = JSON.stringify({ version: 1, series: { global: [{ t: 1, items: 500, wallet: 100 }] } });
  fs.writeFileSync(HISTORY, good);

  const svc = makeService();

  assert.equal(svc.get('global').length, 1, 'the good history is loaded');
  assert.equal(svc.get('global')[0].items, 500);
  assert.equal(preservedCopies().length, 0, 'a valid file is never preserved as .corrupt-*');
  cleanHistory();
});

test('H-INV-019: only the newest 2 preserved copies are kept (older ones pruned)', () => {
  cleanHistory();
  // Seed three pre-existing .corrupt-* siblings with ascending timestamps.
  fs.writeFileSync(dataDir('value_history.json.corrupt-1000000000001'), 'old1');
  fs.writeFileSync(dataDir('value_history.json.corrupt-1000000000002'), 'old2');
  fs.writeFileSync(dataDir('value_history.json.corrupt-1000000000003'), 'old3');
  fs.writeFileSync(HISTORY, '{ broken');

  makeService(); // triggers a new preserve → 4 siblings, then prune to newest 2

  const copies = preservedCopies().sort();
  assert.equal(copies.length, 2, 'growth is bounded to the newest 2 preserved copies');
  // The just-written preserve (largest Date.now()) and the previous newest survive; the oldest are gone.
  assert.equal(fs.existsSync(dataDir('value_history.json.corrupt-1000000000001')), false, 'oldest pruned');
  assert.equal(fs.existsSync(dataDir('value_history.json.corrupt-1000000000002')), false, 'second-oldest pruned');
  cleanHistory();
});

// ════════════════════════════════════════════════════════════════════════════
//  H-INV-020 — a corrupt-but-parseable file (top-level `series` is an object, but a
//  series value is a non-array, or a point is malformed) used to flow straight into
//  append() and throw `arr.push is not a function` inside refresh routes / the bare
//  fill-watch setInterval. load() now SANITIZES: non-array series → [], only well-
//  formed points survive, and the `partial` honesty flag is preserved.
// ════════════════════════════════════════════════════════════════════════════

test('H-INV-020: a non-array series is sanitized to [] and malformed points are dropped, partial preserved', () => {
  cleanHistory();
  fs.writeFileSync(HISTORY, JSON.stringify({
    version: 1,
    series: {
      good: [{ t: 1, items: 2, wallet: 3 }],
      bad: 'x',
      mixed: [{ t: 'y' }, { t: 5, items: 1, wallet: 0, partial: true }],
    },
  }));

  const svc = makeService();

  assert.equal(svc.get('good').length, 1, 'a well-formed series is kept intact');
  assert.deepEqual(svc.get('bad'), [], 'a non-array series is sanitized to []');
  assert.equal(svc.get('mixed').length, 1, 'only the one valid point of the mixed series survives');
  const p = svc.get('mixed')[0];
  assert.equal(p.t, 5);
  assert.equal(p.partial, true, 'the partial honesty flag is carried through sanitation');
  assert.equal(preservedCopies().length, 0, 'a parseable file is sanitized in place, not preserved as corrupt');
  cleanHistory();
});

test('H-INV-020: snapshotAll over sanitized history does not throw (the append() crash site is guarded)', () => {
  cleanHistory();
  fs.writeFileSync(HISTORY, JSON.stringify({ version: 1, series: { e1: 'not-an-array' } }));

  const [accounts, , tf2Store, pricing, exchange] = noopDeps();
  const inv = { username: 'bot1', wallet: { currency: 1, balance: 0 }, totalValueUsd: 5000, items: [] };
  const seededAccounts = { getEnvironments: () => [{ id: 'e1' }], getByEnvironment: () => [{ username: 'bot1' }] };
  const seededStore = { get: () => inv };
  const seededPricing = { totalsOf: () => ({ totalCents: 5000, missing: [], softNull: 0 }), status: pricing.status };
  const svc = new ValueHistoryService(
    seededAccounts as never, seededStore as never, tf2Store as never, seededPricing as never, exchange as never,
  );
  void accounts;

  assert.doesNotThrow(() => svc.snapshotAll('test', 'cs2'), 'a sanitized (now-array) series appends cleanly');
  assert.equal(svc.get('e1').length, 1, 'the snapshot appended one point to the previously-corrupt series');
  cleanHistory();
});
