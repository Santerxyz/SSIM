import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
//  H-FE-001 — A failed cold TF2 fetch (the app's flakiest load, over the fleet's
//  proxies) used to render as a COMPLETELY EMPTY inventory: state.game flipped to
//  'tf2', the fetch threw, a transient toast fired, and renderMain painted the TF2
//  views from the empty cache — indistinguishable from a genuinely empty fleet
//  (the S4/S13 UI-truth class at the display layer). The fix carries an explicit
//  failure state (state.tf2LoadError) and renders a distinct error+Retry panel
//  instead of the empty body. (app.js is DOM-coupled, so we assert the shipped
//  wiring via source-presence — these fail against the pre-fix code.)
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

const APP_JS = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const loadTf2 = extractFunction(APP_JS, 'loadTf2Inventories');
const renderMain = extractFunction(APP_JS, 'renderMain');
const renderErr = extractFunction(APP_JS, 'renderTf2LoadError');

test('H-FE-001: state carries an explicit tf2LoadError field (not just tf2Loaded)', () => {
  assert.ok(/tf2LoadError:\s*null/.test(APP_JS),
    'state declares tf2LoadError initialised to null');
});

test('H-FE-001: a failed TF2 fetch records the error; success clears it', () => {
  // The load catch must record the message (not just fire a transient toast).
  assert.ok(/state\.tf2LoadError\s*=\s*err\.message/.test(loadTf2),
    'the failed TF2 load records state.tf2LoadError = err.message');
  // The success path must clear the error so a later good load heals the panel.
  assert.ok(/state\.tf2LoadError\s*=\s*null/.test(loadTf2),
    'the successful TF2 load clears state.tf2LoadError');
});

test('H-FE-001: renderMain shows the error panel when the TF2 load failed', () => {
  assert.ok(
    /state\.game\s*===\s*'tf2'[\s\S]*!state\.tf2Loaded[\s\S]*state\.tf2LoadError[\s\S]*renderTf2LoadError\(\)/.test(renderMain),
    'renderMain routes a failed TF2 load to renderTf2LoadError instead of the empty inventory body',
  );
});

test('H-FE-001: the error panel renders a Retry that re-runs the TF2 load', () => {
  assert.ok(/btn-tf2-retry/.test(renderErr), 'the panel wires a Retry button');
  assert.ok(renderErr.includes('loadTf2Inventories'),
    'the Retry re-runs the same /api/inventory-tf2 load');
  // It must not silently paint an empty inventory — it surfaces the failure text.
  assert.ok(/tf2LoadError/.test(renderErr), 'the panel shows the load-error reason');
});
