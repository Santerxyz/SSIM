import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import vm from 'vm';
import path from 'path';

// ═════════════════════════════════════════════════════════════════════════════════════════════════
//  1.5.1 — the Batch panel's Prime coverage strip ("which of these accounts already has Prime?").
//
//  The counting is the whole feature, and it has one way to be dangerously wrong: folding an account
//  SSIM has never checked, or could not read, into "needs Prime". Either mistake tells the operator
//  to go and buy licences the fleet may already hold. Four states in, four states out — pulled out of
//  the real public/app.js, not reimplemented here.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

interface PrimeRow { username: string; status: string }
interface Cand { name: string; count: number; price: number }
interface Api {
  state: { prime: { rows: Record<string, PrimeRow> }; inventories: Record<string, unknown>; tf2Inventories: Record<string, unknown>; game: string };
  primeCoverage: (u: string[]) => { owned: number; missing: number; unreadable: number; unchecked: number; missingNames: string[] };
  distPickerRows: (c: Cand[], q: string, chosen: string[]) => { rows: Cand[]; custom: string | null };
  distItemCandidates: (u: string[], game: string) => Cand[];
}

function loadFrontend(): Api {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const grab = (re: RegExp, name: string): string => {
    const m = src.match(re);
    if (!m) throw new Error(`could not extract ${name} from public/app.js — did it get renamed?`);
    return m[0];
  };
  const parts = [
    'const state = { prime: { rows: {} }, inventories: {}, tf2Inventories: {}, game: "cs2" };',
    grab(/function primeCoverage\(usernames\) \{[\s\S]*?\n\}/, 'primeCoverage'),
    grab(/function invForGame\(u, game\) \{[\s\S]*?\n\}/, 'invForGame'),
    grab(/function distItemCandidates\(usernames, game\) \{[\s\S]*?\n\}/, 'distItemCandidates'),
    grab(/function distPickerRows\(candidates, query, chosen\) \{[\s\S]*?\n\}/, 'distPickerRows'),
  ];
  const ctx: Record<string, unknown> = { String, Object, Array, Map, Set, Number };
  vm.createContext(ctx);
  vm.runInContext(`${parts.join('\n')}\nglobalThis.API = { state, primeCoverage, distPickerRows, distItemCandidates };`, ctx);
  return ctx.API as Api;
}

const api = loadFrontend();
/** app.js runs in its own vm realm, so an array it BUILDS carries that realm’s Array.prototype and
 *  would fail deepStrictEqual against a host literal for reasons unrelated to the feature. */
const arr = <T>(v: T[]): T[] => [...v];
const seed = (rows: PrimeRow[]): void => {
  api.state.prime.rows = {};
  for (const r of rows) api.state.prime.rows[r.username.toLowerCase()] = r;
};

test('H-PRM-050: never-checked accounts count as UNCHECKED, never as "needs Prime"', () => {
  seed([]);
  const c = api.primeCoverage(['bot1', 'bot2']);
  assert.deepEqual([c.owned, c.missing, c.unreadable, c.unchecked], [0, 0, 0, 2]);
  assert.deepEqual(arr(c.missingNames), [], 'nothing may be proposed for purchase off no evidence');
});

test('H-PRM-051: an UNREADABLE reading is its own bucket, never folded into "needs Prime"', () => {
  seed([{ username: 'bot1', status: 'unreadable' }]);
  const c = api.primeCoverage(['bot1']);
  assert.deepEqual([c.owned, c.missing, c.unreadable, c.unchecked], [0, 0, 1, 0]);
  assert.deepEqual(arr(c.missingNames), []);
});

test('H-PRM-052: the four states are counted independently, and only "missing" is named', () => {
  seed([
    { username: 'has', status: 'owned' },
    { username: 'needs', status: 'missing' },
    { username: 'dunno', status: 'unreadable' },
  ]);
  const c = api.primeCoverage(['has', 'needs', 'dunno', 'never']);
  assert.deepEqual([c.owned, c.missing, c.unreadable, c.unchecked], [1, 1, 1, 1]);
  assert.deepEqual(arr(c.missingNames), ['needs']);
});

test('H-PRM-053: lookups are case-insensitive — the server keys rows by the real username', () => {
  seed([{ username: 'BotOne', status: 'owned' }]);
  assert.equal(api.primeCoverage(['botone']).owned, 1);
  assert.equal(api.primeCoverage(['BOTONE']).owned, 1);
});

const CANDS: Cand[] = [
  { name: '★ Karambit | Doppler (Factory New)', count: 1, price: 90_000 },
  { name: 'Fracture Case', count: 412, price: 28 },
  { name: 'Sticker | Titan (Holo) | Katowice 2014', count: 2, price: 500_000 },
];

test('H-DST-040: typing filters the candidate list, case-insensitively and on substrings', () => {
  // The whole point of the picker (owner: "nobody will remember names") — you type a fragment of
  // what you half-remember and the real name comes to you.
  assert.deepEqual(api.distPickerRows(CANDS, 'karam', []).rows.map((r) => r.name), ['★ Karambit | Doppler (Factory New)']);
  assert.deepEqual(api.distPickerRows(CANDS, 'CASE', []).rows.map((r) => r.name), ['Fracture Case']);
  assert.equal(api.distPickerRows(CANDS, '', []).rows.length, 3, 'an empty query shows everything');
});

test('H-DST-041: an already-picked name drops out of the list — the same filter twice is meaningless', () => {
  const r = api.distPickerRows(CANDS, '', ['Fracture Case']);
  assert.deepEqual(r.rows.map((x) => x.name), ['★ Karambit | Doppler (Factory New)', 'Sticker | Titan (Holo) | Katowice 2014']);
  assert.equal(r.custom, null, 'and no custom entry is offered for an empty query');
});

test('H-DST-042: a query matching nothing is offered as a CUSTOM filter, not a dead end', () => {
  // The backend matches substrings, so "Souvenir" is a legitimate filter even when no single item
  // is named that. Losing this would make the picker weaker than the free-text box it replaced.
  const r = api.distPickerRows(CANDS, 'Souvenir', []);
  assert.deepEqual(r.rows, []);
  assert.equal(r.custom, 'Souvenir');
});

test('H-DST-043: a query that IS an exact candidate offers no duplicate custom row', () => {
  const r = api.distPickerRows(CANDS, 'fracture case', []);
  assert.deepEqual(r.rows.map((x) => x.name), ['Fracture Case']);
  assert.equal(r.custom, null, 'the real item is right there — a custom row would just be noise');
});

test('H-DST-044: a query already picked offers neither a row nor a custom entry', () => {
  const r = api.distPickerRows(CANDS, 'Karambit', ['Karambit']);
  assert.deepEqual(r.rows, [], 'the candidate is hidden because a matching filter is already on');
  assert.equal(r.custom, null, 'and it is not offered a second time as a custom entry');
});

test('H-DST-045: whitespace-only input never becomes a filter that matches everything', () => {
  const r = api.distPickerRows(CANDS, '   ', []);
  assert.equal(r.custom, null);
  assert.equal(r.rows.length, 3);
});

// ── The Distribute picker must be able to see TF2, not just whatever tab you left ────────────────
//  Owner 2026-08-20: "the distribute items selection only selects from CS2, and not from TF2 too".
//  Distribute is single-game by construction (one plan = one appId), and it read `state.game` — the
//  Inventories toggle, which setNav HIDES on the Batch screen. So the game was decided by a control
//  that was not on the page. distItemCandidates now takes the game explicitly.

const stock = (name: string, price: number) =>
  ({ marketHashName: name, quantity: 3, price, tradable: true, tradeLockExpiry: null, category: 'tradable' });

test('H-DST-046: the candidate list follows the GAME it is given, not the Inventories tab', () => {
  api.state.game = 'cs2';                                    // the tab is on CS2 …
  api.state.inventories.bot = { items: [stock('Fracture Case', 28)] };
  api.state.tf2Inventories.bot = { items: [stock('Mann Co. Supply Crate Key', 250)] };

  assert.deepEqual(arr(api.distItemCandidates(['bot'], 'cs2')).map((c) => c.name), ['Fracture Case']);
  // … and TF2 is still reachable, which it was not before: the picker offered CS2 names only.
  assert.deepEqual(arr(api.distItemCandidates(['bot'], 'tf2')).map((c) => c.name), ['Mann Co. Supply Crate Key']);
});

test('H-DST-047: an account with no cache for that game contributes nothing (and does not throw)', () => {
  api.state.game = 'cs2';
  api.state.inventories.only = { items: [stock('Fracture Case', 28)] };
  delete api.state.tf2Inventories.only;
  assert.deepEqual(arr(api.distItemCandidates(['only'], 'tf2')), [], 'a never-refreshed TF2 account is empty, not an error');
});

test('H-DST-048: the pool gate still applies per game — locked/listed/unpriced never offered', () => {
  api.state.tf2Inventories.gated = { items: [
    stock('Refined Metal', 8),
    { ...stock('Locked Key', 250), tradeLockExpiry: '2099-01-01', category: 'tradelocked' },
    { ...stock('Listed Key', 250), tradable: false, category: 'listed' },
    { ...stock('Unpriced Hat', 0), price: null },
  ] };
  assert.deepEqual(arr(api.distItemCandidates(['gated'], 'tf2')).map((c) => c.name), ['Refined Metal']);
});
