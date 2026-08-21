import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import vm from 'vm';
import path from 'path';

// ═════════════════════════════════════════════════════════════════════════════════════════════════
//  Active Orders must be able to show a game the INVENTORIES tab is not on.
//
//  The buy modal has its own CS2/TF2 selector (`el.buyGame`), so a TF2 order can be filed while the
//  tab reads CS2. Before this fix `ordersScope()` derived the appId from `state.game` alone and both
//  the route and the scan filtered on it, so that 440 order was invisible — a real, accepted order
//  looked like it had never been placed. Same shape as the Distribute game-switch bug (1.5.1).
//
//  These functions are pulled out of the real public/app.js, not reimplemented.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

interface Scope { mode: string; usernames: string[]; appId: number; label: string }
interface Api {
  state:         Record<string, any>;
  ordersGame:    () => string;
  ordersScope:   () => Scope;
  ordersScopeKey:(sc: Scope) => string;
  ordersSetGame: (g: string) => void;
  calls:         string[];
}

function loadFrontend(): Api {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const grab = (re: RegExp, name: string): string => {
    const m = src.match(re);
    if (!m) throw new Error(`could not extract ${name} from public/app.js — did it get renamed?`);
    return m[0];
  };
  const parts = [
    grab(/function ordersGame\(\)[^\n]*\n/, 'ordersGame'),
    grab(/function ordersSetGame\(game\) \{[\s\S]*?\n\}/, 'ordersSetGame'),
    grab(/function ordersScope\(\) \{[\s\S]*?\n\}/, 'ordersScope'),
    grab(/function ordersScopeKey\(sc\)[^\n]*\n/, 'ordersScopeKey'),
  ];
  const calls: string[] = [];
  const ctx: Record<string, unknown> = {
    JSON, String, Number,
    state: {
      game: 'cs2',
      invMode: 'account',
      activeUsername: 'donaldjohnston02',
      activeFolder: null,
      tree: { folders: [] },
      allAccounts: [{ username: 'donaldjohnston02', displayName: 'Donald' }],
      orders: { run: 0, timer: null, key: '', rows: null, autoStart: false, cursor: 0, game: null },
    },
    // Collaborators ordersScope/ordersSetGame reach for, stubbed to keep this about the game scope.
    findFolderNode:      () => null,
    collectFolderAccounts: () => [],
    selectedUsernames:   () => [],
    stopOrdersPoll:      () => { calls.push('stopOrdersPoll'); },
    renderOrdersView:    () => { calls.push('renderOrdersView'); },
  };
  vm.createContext(ctx);
  vm.runInContext(`${parts.join('\n')}
    globalThis.API = { ordersGame, ordersScope, ordersScopeKey, ordersSetGame };`, ctx);
  const api = ctx.API as Omit<Api, 'state' | 'calls'>;
  return { ...api, state: ctx.state as Record<string, any>, calls };
}

test('H-ORD-001: with no pin, Active Orders follows the Inventories tab (unchanged default)', () => {
  const f = loadFrontend();
  f.state.game = 'cs2';
  assert.equal(f.ordersGame(), 'cs2');
  assert.equal(f.ordersScope().appId, 730);
  f.state.game = 'tf2';
  assert.equal(f.ordersGame(), 'tf2');
  assert.equal(f.ordersScope().appId, 440);
});

test('H-ORD-002: THE BUG — a TF2 order is reachable while the tab is on CS2', () => {
  const f = loadFrontend();
  f.state.game = 'cs2';                 // Inventories tab on CS2…
  f.ordersSetGame('tf2');               // …but the buy went out on TF2.
  assert.equal(f.ordersGame(), 'tf2');
  assert.equal(f.ordersScope().appId, 440, 'the 440 order must be reachable from a CS2 tab');
  assert.equal(f.state.game, 'cs2', 'pinning Active Orders must NOT move the Inventories tab');
});

test('H-ORD-003: the pin also works the other way (CS2 orders from a TF2 tab)', () => {
  const f = loadFrontend();
  f.state.game = 'tf2';
  f.ordersSetGame('cs2');
  assert.equal(f.ordersScope().appId, 730);
});

test('H-ORD-004: the scope KEY changes with the game, so cached rows cannot leak across a switch', () => {
  const f = loadFrontend();
  f.state.game = 'cs2';
  const cs2Key = f.ordersScopeKey(f.ordersScope());
  f.ordersSetGame('tf2');
  const tf2Key = f.ordersScopeKey(f.ordersScope());
  assert.notEqual(cs2Key, tf2Key, 'a different game is a different question');
  assert.match(cs2Key, /\|730\|/);
  assert.match(tf2Key, /\|440\|/);
});

test('H-ORD-005: switching game drops the rows in hand and re-renders', () => {
  const f = loadFrontend();
  f.state.orders.rows = { buy: [{ buyOrderId: '8624798659' }], sell: [] };
  f.state.orders.key  = 'account|730|donaldjohnston02';
  f.ordersSetGame('tf2');
  assert.equal(f.state.orders.rows, null, 'CS2 rows must not be shown under a TF2 heading');
  assert.equal(f.state.orders.key, '');
  assert.deepEqual(f.calls, ['stopOrdersPoll', 'renderOrdersView']);
});

test('H-ORD-006: re-picking the game already shown is a no-op (no refetch, no row loss)', () => {
  const f = loadFrontend();
  f.state.game = 'cs2';
  const rows = { buy: [], sell: [] };
  f.state.orders.rows = rows;
  f.ordersSetGame('cs2');
  assert.equal(f.state.orders.rows, rows, 'an idempotent click must not throw away the fetched rows');
  assert.deepEqual(f.calls, []);
});
