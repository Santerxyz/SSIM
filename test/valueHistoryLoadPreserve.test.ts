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
