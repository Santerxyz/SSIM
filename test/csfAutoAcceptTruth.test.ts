import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── H-FE-008: CSFloat auto-accept status must not fake an OFF on a transient fetch error ──
// csfLoadTrades used csfApi('/auto-accept').catch(() => ({ enabled: false })), so a transient
// failure (401 cap-token blip, 5xx, socket drop) rendered a hard "OFF" — indistinguishable
// from genuinely off — and csfToggleAutoAccept then read the CURRENT state from the button's
// own text and PUT !cur, driving a real state change from a fabricated default.
// Fix: drop the swallowing .catch so a failure falls to the tab's csfError surface, and derive
// the toggle's current state from data-enabled (set only on a successful fetch), not text.
// Guarded at the source level (the repo's app.js extract pattern — no jsdom / no new dependency).

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
const csfLoadTrades = extractFunction(APP_JS, 'csfLoadTrades');
// The tab was split into fetch (csfLoadTrades) + paint (csfRenderTrades) when it became the
// delivery dashboard, so the toggle's markup now lives in the renderer. The invariant is
// unchanged and still checked end-to-end below: data-enabled may only ever carry a value that
// came back from a SUCCESSFUL /auto-accept fetch.
const csfRenderTrades = extractFunction(APP_JS, 'csfRenderTrades');
const csfToggleAutoAccept = extractFunction(APP_JS, 'csfToggleAutoAccept');

test('H-FE-008: a failed /auto-accept fetch is not coerced to a fake OFF toggle', () => {
  // The swallowing .catch(() => ({ enabled: false })) must be gone.
  assert.doesNotMatch(
    csfLoadTrades,
    /\/auto-accept'\)\.catch\(/,
    'the /auto-accept fetch must not swallow failures into an enabled:false default',
  );
  // The tab already routes any thrown error to csfError — confirm that path still exists,
  // so a transient /auto-accept failure now shows Retry/error, not a plain OFF.
  assert.match(
    csfLoadTrades,
    /catch \(err\) \{ el\.csfloatBody\.innerHTML = csfError\(err\.message\); \}/,
    'a failed sub-fetch must fall to the shared csfError surface',
  );
});

test('H-FE-008: the toggle carries data-enabled from the known-good fetched state', () => {
  // Link 1: the fetched value is the ONLY thing stored — no fabricated default on the way in.
  assert.match(
    csfLoadTrades,
    /CSF\.trd\.auto = !!auto\.enabled;/,
    'the fetched auto.enabled must be what the tab stores',
  );
  // Link 2: the toggle's data-enabled is rendered from that stored value, nothing else.
  assert.match(
    csfRenderTrades,
    /const auto = CSF\.trd\.auto;/,
    'the renderer must read the toggle state from the stored fetch result',
  );
  assert.match(
    csfRenderTrades,
    /data-enabled="\$\{auto \? '1' : '0'\}"/,
    'the toggle must record the fetched state as data-enabled',
  );
});

test('H-FE-008: csfToggleAutoAccept reads cur from data-enabled, not button text', () => {
  assert.match(
    csfToggleAutoAccept,
    /getAttribute\('data-enabled'\) === '1'/,
    'cur must come from data-enabled (set only on a successful fetch)',
  );
  assert.doesNotMatch(
    csfToggleAutoAccept,
    /textContent\.includes\('ON'\)/,
    'cur must no longer be derived from fabricated button text',
  );
});
