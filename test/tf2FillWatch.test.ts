import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
//  S29 — the first CS2→TF2 toggle enriches + queues a server-side price fill for
//  the cold TF2 cache, but setGame() started NO watcher (unlike boot/refresh/
//  source-switch), so TF2 prices stayed "…" until an unrelated trigger. setGame's
//  first-load branch must now start watchPriceFill. (Source-presence: setGame is
//  DOM-coupled, so we assert the shipped wiring — it fails against the old code.)
// ─────────────────────────────────────────────────────────────────────────────

function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found in app.js`);
  const bodyOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const APP_JS = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const setGame = extractFunction(APP_JS, 'setGame');
// H-FE-001 relocated the TF2 first-load body from setGame into a reusable loadTf2Inventories()
// (so the load-error Retry button can re-run it); setGame now delegates the first load to it.
// The S29 watch-start guarantee is unchanged — it now lives in loadTf2Inventories.
const loadTf2 = extractFunction(APP_JS, 'loadTf2Inventories');

test('S29: the first TF2 load starts a price-fill watch', () => {
  assert.ok(setGame.includes('loadTf2Inventories') || setGame.includes('tf2Loaded'),
    'setGame guards + drives the first TF2 load');
  assert.ok(/tf2Loaded/.test(loadTf2), 'the TF2 load guards/records the first-load state');
  assert.ok(loadTf2.includes('watchPriceFill(refreshActiveViewFromCache)'),
    'the first TF2 load must start watchPriceFill so TF2 prices fill in live (S29)');
});
