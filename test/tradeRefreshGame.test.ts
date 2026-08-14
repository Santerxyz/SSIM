import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── H-FE-006: the post-send trade refresh must carry the active game ──────────
// submitTrade sends app-agnostic offers (CS2 or TF2). Its post-send refresh scheduled a
// game-less startInventoryRefresh, which the route defaults to cs2 — so a TF2 send never
// re-pulled the TF2 cache and the sent items kept showing as sendable (re-send hazard).
// The scheduled refresh must thread game: state.game. Guarded here at the source level
// (the repo's app.js extract pattern — no jsdom / no new dependency).

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
const submitTrade = extractFunction(APP_JS, 'submitTrade');

test('H-FE-006: the scheduled post-send refresh threads game: state.game', () => {
  assert.match(
    submitTrade,
    /startInventoryRefresh\(\{ usernames: affected, game: state\.game \}\)/,
    'post-send refresh must pass game: state.game so a TF2 send re-pulls the TF2 cache',
  );
  assert.doesNotMatch(
    submitTrade,
    /startInventoryRefresh\(\{ usernames: affected \}\)/,
    'the game-less refresh (defaults to cs2) must be gone',
  );
});
