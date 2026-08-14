import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// ─────────────────────────────────────────────────────────────────────────────
//  H-LIC-008 — the runtime status poll (watchSystemStatus) must turn an explicit
//  server-stated `licensed:false` (a runtime revocation / deactivation) into the
//  activation-screen redirect, because the boot guard (ensureLicensed) runs only
//  once and the shell cannot re-navigate an already-open webview. Strict `=== false`
//  mirrors S23: a half-up status that OMITS `licensed` must NOT redirect. Runs the
//  shipped function over a mocked api()/window with the 30s loop broken after one pass.
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

// Drive one poll iteration: the redirect path `return`s (loop exits); any other path
// falls through to `await new Promise((r) => setTimeout(...))`, where our setTimeout
// throws a sentinel to break the otherwise-infinite loop after exactly one pass.
async function runOnce(status: any): Promise<{ replaced: number }> {
  let replaced = 0;
  const BREAK = Symbol('break-loop');
  const noop = () => {};
  const sandbox: any = {
    api: async () => status,
    setTimeout: () => { throw BREAK; }, // second-pass guard: break out after one iteration
    Promise,
    // render helpers the non-redirect path calls — all no-ops
    renderUpdateIndicator: noop,
    renderBreakerIndicator: noop,
    renderTokenStoreWarning: noop,
    renderCsFloatKeyStoreWarning: noop,
    renderCrashBanner: noop,
    updateInstalling: false,
    toast: noop,
    window: { location: { replace: () => { replaced++; } } },
  };
  const ctx: any = vm.createContext(sandbox);
  vm.runInContext(`${extractFunction(APP_JS, 'watchSystemStatus')}\nthis.watchSystemStatus = watchSystemStatus;`, ctx);
  try {
    await ctx.watchSystemStatus();
  } catch (e) {
    if (e !== BREAK) throw e; // only the loop-break sentinel is expected
  }
  return { replaced };
}

test('H-LIC-008: explicit licensed:false → activation redirect (once)', async () => {
  const r = await runOnce({ licensed: false });
  assert.equal(r.replaced, 1);
});

test('H-LIC-008: licensed:true → no redirect', async () => {
  const r = await runOnce({ licensed: true });
  assert.equal(r.replaced, 0);
});

test('H-LIC-008: licensed absent (half-up status) → no redirect', async () => {
  const r = await runOnce({ update: null });
  assert.equal(r.replaced, 0);
});
