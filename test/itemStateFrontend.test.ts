import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { bucketOf } from '../src/core/MarketModel';

// ═════════════════════════════════════════════════════════════════════════════════════════════════
//  The frontend's item-state derivation must be a faithful TWIN of bucketOf (src/core/MarketModel.ts).
//  It cannot simply read `category`: TF2 records carry none (tagCategories only runs for source==='gc'),
//  so 162 live items depend on the derivation path alone.
//
//  Before 2026-07-10 statusCell never looked at `category` at all, so a LISTED item (tradable:false,
//  expiry:null) and a PERMANENTLY untradable item (Storage Unit, Veteran Coin) both rendered as a red
//  "Locked" — a countdown that never arrives. 723 listed + 262 inert items in the live cache.
//
//  These functions are pulled out of the real public/app.js, not reimplemented.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

function loadFrontend(): { statusCell: (i: unknown) => string; itemStatusKey: (i: unknown) => string } {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const grab = (re: RegExp, name: string): string => {
    const m = src.match(re);
    if (!m) throw new Error(`could not extract ${name} from public/app.js — did it get renamed?`);
    return m[0];
  };
  const parts = [
    grab(/const TRADE_LOCK_UNKNOWN_MS = [^\n]*\n/, 'TRADE_LOCK_UNKNOWN_MS'),
    grab(/function escapeHtml\([\s\S]*?\n\}/, 'escapeHtml'),
    grab(/function escapeAttr\([^\n]*\n/, 'escapeAttr'),
    grab(/function lockDateUnknown\(date\) \{[\s\S]*?\n\}/, 'lockDateUnknown'),
    grab(/function lockCountdown\(date\) \{[\s\S]*?\n\}/, 'lockCountdown'),
    grab(/function itemStatusKey\(i\)[^\n]*\n/, 'itemStatusKey'),
    grab(/function statusCell\(item\) \{[\s\S]*?\n\}/, 'statusCell'),
  ];
  const ctx: Record<string, unknown> = { Date, Math, Number, String, isNaN, JSON };
  vm.createContext(ctx);
  vm.runInContext(`${parts.join('\n')}\nglobalThis.API = { statusCell, itemStatusKey };`, ctx);
  return (ctx.API as { statusCell: (i: unknown) => string; itemStatusKey: (i: unknown) => string });
}

const SOON = new Date(Date.now() + 3 * 864e5);
const SENTINEL = new Date('2099-01-01T00:00:00.000Z');

const CASES: Array<{ name: string; item: Record<string, unknown>; key: string; label: RegExp }> = [
  { name: 'freely tradable',            item: { tradable: true,  tradeLockExpiry: null, category: 'tradable' },    key: 'tradable',    label: /Tradable/ },
  { name: 'listed on the market',       item: { tradable: false, tradeLockExpiry: null, category: 'listed' },      key: 'listed',      label: /Listed/ },
  { name: 'genuinely trade-held',       item: { tradable: false, tradeLockExpiry: SOON, category: 'tradelocked' }, key: 'tradelocked', label: /days?, \d+ h/ },
  { name: 'held, unreadable date',      item: { tradable: false, tradeLockExpiry: SENTINEL, category: 'tradelocked' }, key: 'tradelocked', label: /date unknown/ },
  { name: 'permanently untradable',     item: { tradable: false, tradeLockExpiry: null, category: 'untradable' },  key: 'untradable',  label: /Not tradable/ },
  // TF2: NO category at all — everything must come from the derivation.
  { name: 'TF2 inert (no category)',    item: { tradable: false, tradeLockExpiry: null },                          key: 'untradable',  label: /Not tradable/ },
  { name: 'TF2 held (no category)',     item: { tradable: false, tradeLockExpiry: SOON },                          key: 'tradelocked', label: /days?, \d+ h/ },
  { name: 'TF2 tradable (no category)', item: { tradable: true,  tradeLockExpiry: null },                          key: 'tradable',    label: /Tradable/ },
];

for (const c of CASES) {
  test(`H-UI-001: ${c.name} → status "${c.key}"`, () => {
    const { statusCell, itemStatusKey } = loadFrontend();
    assert.equal(itemStatusKey(c.item), c.key);
    assert.match(statusCell(c.item), c.label);
  });
}

test('H-UI-001: a listed item is NEVER rendered as "Locked"', () => {
  const { statusCell } = loadFrontend();
  const html = statusCell({ tradable: false, tradeLockExpiry: null, category: 'listed' });
  assert.doesNotMatch(html, /Locked/, '723 live items used to say "Locked" here');
  assert.match(html, /Listed/);
});

test('H-UI-001: a permanently untradable item is NEVER rendered as "Locked"', () => {
  const { statusCell } = loadFrontend();
  const html = statusCell({ tradable: false, tradeLockExpiry: null, category: 'untradable' });
  assert.doesNotMatch(html, /Locked/, 'a Storage Unit has no countdown to wait for');
  assert.match(html, /Not tradable/);
});

test('H-UI-001: a real trade hold still shows its countdown, not "Not tradable"', () => {
  const { statusCell } = loadFrontend();
  const html = statusCell({ tradable: false, tradeLockExpiry: SOON });
  assert.match(html, /days?, \d+ h/);
  assert.doesNotMatch(html, /Not tradable/);
});

test('H-UI-001: the frontend derivation agrees with bucketOf on every state', () => {
  const { itemStatusKey } = loadFrontend();
  const now = Date.now();
  for (const c of CASES) {
    const backend = bucketOf(c.item as never, now);
    assert.equal(itemStatusKey(c.item), backend, `${c.name}: frontend and bucketOf must agree`);
  }
});
