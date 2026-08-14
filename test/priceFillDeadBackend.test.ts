import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
//  S42 — watchPriceFill against a DEAD backend polled forever with the "Fetching
//  prices…" badge frozen: the status-fetch `catch { continue }` never counted
//  toward a stop. It must now count consecutive failures and stop after a bound.
//  (watchPriceFill is DOM/timer-coupled → source-presence; fails on the old code.)
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
const watch = extractFunction(APP_JS, 'watchPriceFill');

test('S42: watchPriceFill bounds consecutive status-fetch failures and stops', () => {
  assert.ok(/consecErrors/.test(watch), 'a consecutive-error counter exists');
  assert.ok(/MAX_CONSEC_ERRORS/.test(watch), 'a bound exists');
  // On error it stops after the bound (hides the badge + returns), not an unbounded `continue`.
  assert.ok(/\+\+consecErrors\s*>=\s*MAX_CONSEC_ERRORS[\s\S]{0,80}return/.test(watch),
    'the error path stops after the bound instead of spinning forever');
  // A good poll resets the streak so a transient blip never abandons a live fill.
  assert.ok(/status'\);\s*consecErrors\s*=\s*0/.test(watch), 'a successful poll resets the streak');
});
