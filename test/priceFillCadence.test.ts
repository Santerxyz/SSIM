import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// ─────────────────────────────────────────────────────────────────────────────
//  S10 — the price-fill watch must not re-pull + re-render the WHOLE fleet on
//  every 2.5s poll. shouldRepullFill coalesces re-pulls to at most one per
//  REPRICE_MIN_REPULL_MS during an active fill, but always pulls the final drain.
//  (Extracts the shipped helper from public/app.js — no jsdom / no new dependency.)
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
vm.runInContext(`${extractFunction(APP_JS, 'shouldRepullFill')}\nthis.__f = shouldRepullFill;`, ctx);
const shouldRepullFill: (progressed: boolean, busy: boolean, since: number, min: number) => boolean = ctx.__f;

const MIN = 10_000;

test('S10: the final drain (queue empty) always re-pulls, regardless of cadence', () => {
  assert.equal(shouldRepullFill(false, false, 0, MIN), true, 'not busy → final pull even with no progress');
  assert.equal(shouldRepullFill(true, false, 1, MIN), true);
});

test('S10: during a fill, a re-pull only fires when progressed AND the cadence has elapsed', () => {
  assert.equal(shouldRepullFill(true, true, MIN + 1, MIN), true, 'progressed + cadence met → pull');
  assert.equal(shouldRepullFill(true, true, MIN - 1, MIN), false, 'progressed but too soon → skip (coalesce)');
  assert.equal(shouldRepullFill(false, true, MIN * 10, MIN), false, 'no progress → no pull even if long since');
});

test('S10: back-to-back fast advances coalesce into one re-pull per interval', () => {
  // The old code re-pulled on each ~2.5s advance. With the cadence, 3 advances inside the 10s window
  // yield ZERO pulls; only once the interval elapses does one fire.
  let pulls = 0;
  let lastRepullAt = 0;
  for (const t of [2500, 5000, 7500]) {                 // 3 fast advances, all within the first 10s
    if (shouldRepullFill(true, true, t - lastRepullAt, MIN)) { pulls++; lastRepullAt = t; }
  }
  assert.equal(pulls, 0, 'no re-pull within the 10s window (old code pulled ~3×)');
  assert.equal(shouldRepullFill(true, true, 10000 - lastRepullAt, MIN), true, 'the cadence elapses at 10s → one pull');
});
