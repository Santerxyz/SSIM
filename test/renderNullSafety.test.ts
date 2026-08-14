import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// ─────────────────────────────────────────────────────────────────────────────
//  S30 — one malformed cached row must not break the table + search.
//
//  The item stores accept any JSON, so a corrupt/legacy row can lack `name` /
//  `marketHashName`. The name sort (`compareItems`, key='name') and the search
//  filter dereferenced those fields directly, so a single bad row threw inside
//  filter/sort mid-render, escaped the DOM handler, and left a half-rendered view
//  with zero observability (WebView2 has no console). The fix coerces the fields.
//
//  This extracts the SHIPPED `compareItems` from public/app.js and proves the
//  'name' comparator tolerates missing names — no jsdom / no new dependency.
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
const ctx: any = vm.createContext({});
vm.runInContext(`${extractFunction(APP_JS, 'compareItems')}\nthis.__compareItems = compareItems;`, ctx);
const compareItems: (a: any, b: any, key: string) => number = ctx.__compareItems;

test('S30: name sort tolerates a row with no name (does not throw)', () => {
  // Before the fix this threw: undefined.localeCompare(...) → the whole render aborts.
  assert.doesNotThrow(() => compareItems({ name: undefined }, { name: 'AK-47' }, 'name'));
  assert.doesNotThrow(() => compareItems({ name: 'AK-47' }, {}, 'name'));
  assert.doesNotThrow(() => compareItems({}, {}, 'name'));
});

test('S30: name sort still orders normally when names are present', () => {
  assert.ok(compareItems({ name: 'AK-47' }, { name: 'Bayonet' }, 'name') < 0);
  assert.ok(compareItems({ name: 'Bayonet' }, { name: 'AK-47' }, 'name') > 0);
  assert.equal(compareItems({ name: 'AK-47' }, { name: 'AK-47' }, 'name'), 0);
  // A nameless row coerces to '' and sorts before a named one, deterministically (no crash).
  assert.ok(compareItems({}, { name: 'AK-47' }, 'name') < 0);
});
