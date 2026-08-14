import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// ─────────────────────────────────────────────────────────────────────────────
//  S23 — ensureLicensed must (a) bound the status probe (a hung backend no longer
//  blanks the UI forever) and (b) distinguish EXPLICIT unlicensed (→ activation)
//  from UNREACHABLE/ambiguous (→ a visible retry screen, NOT the automatic
//  location.replace('/') that looped in sidecar mode). Runs the shipped functions
//  over mocked fetch/document/window.
// ─────────────────────────────────────────────────────────────────────────────

function extractFunction(src: string, name: string): string {
  let start = src.indexOf(`async function ${name}(`); // keep the async keyword so await stays valid
  if (start < 0) start = src.indexOf(`function ${name}(`);
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

async function run(fetchImpl: () => Promise<any>): Promise<{ ok: boolean; replaced: number; appended: number }> {
  let replaced = 0, appended = 0;
  const sandbox: any = {
    fetch: fetchImpl,
    AbortSignal: { timeout: () => ({}) },
    setTimeout: () => 0, // no-op timers → the auto-retry probe never runs in the test
    document: {
      getElementById: (id: string) => (id === 'footer-status' ? { textContent: '' } : null),
      createElement: () => ({ className: '', innerHTML: '', id: '', addEventListener: () => {} }),
      body: { appendChild: () => { appended++; } },
    },
    window: { location: { replace: () => { replaced++; } } },
    location: { reload: () => {} },
  };
  const ctx: any = vm.createContext(sandbox);
  vm.runInContext(
    `${extractFunction(APP_JS, 'timeoutSignal')}\n${extractFunction(APP_JS, 'showBackendUnreachableScreen')}\n` +
    `${extractFunction(APP_JS, 'ensureLicensed')}\nthis.ensureLicensed = ensureLicensed;`, ctx);
  const ok = await ctx.ensureLicensed();
  return { ok, replaced, appended };
}

test('S23: licensed:true → proceeds, no redirect, no retry screen', async () => {
  const r = await run(async () => ({ ok: true, status: 200, json: async () => ({ licensed: true, version: '1.3.5' }) }));
  assert.deepEqual(r, { ok: true, replaced: 0, appended: 0 });
});

test('S23: explicit licensed:false → activation redirect (not the retry screen)', async () => {
  const r = await run(async () => ({ ok: true, status: 200, json: async () => ({ licensed: false }) }));
  assert.equal(r.ok, false); assert.equal(r.replaced, 1); assert.equal(r.appended, 0);
});

test('S23: a 403 LICENSE_MISSING → activation redirect', async () => {
  const r = await run(async () => ({ ok: false, status: 403, json: async () => ({}) }));
  assert.equal(r.replaced, 1);
});

test('S23: UNREACHABLE (fetch throws/timeout) → retry screen, NEVER the redirect loop', async () => {
  const r = await run(async () => { throw new Error('The operation timed out'); });
  assert.equal(r.ok, false);
  assert.equal(r.replaced, 0, 'no redirect on unreachable — that was the sidecar reload loop');
  assert.equal(r.appended, 1, 'a visible retry screen is shown instead');
});

test('S23: an AMBIGUOUS 5xx / half-up backend → retry screen, not a redirect', async () => {
  const r = await run(async () => ({ ok: false, status: 503, json: async () => null }));
  assert.equal(r.replaced, 0); assert.equal(r.appended, 1);
});
