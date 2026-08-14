import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// ─────────────────────────────────────────────────────────────────────────────
//  S32 — interactive "live" routes (orders / confirmations / ?refresh=1) queue
//  behind a fleet refresh's login semaphore; with no client abort the modal
//  spinner sat for many minutes. api() now bounds every call with a timeout
//  (overridable per call). Runs the shipped api() over a signal-aware fetch mock.
// ─────────────────────────────────────────────────────────────────────────────

function extractFunction(src: string, name: string): string {
  let start = src.indexOf(`async function ${name}(`);
  if (start < 0) start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found in app.js`);
  // Skip the parameter list (which may contain a `{}` default, e.g. `opts = {}`) before the body brace.
  const parenOpen = src.indexOf('(', start);
  let pd = 0, j = parenOpen;
  for (; j < src.length; j++) { if (src[j] === '(') pd++; else if (src[j] === ')') { pd--; if (pd === 0) break; } }
  const bodyOpen = src.indexOf('{', j);
  let depth = 0;
  for (let i = bodyOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const APP_JS = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');

function loadApi(fetchImpl: (url: string, init: any) => Promise<any>): (p: string, o?: any) => Promise<any> {
  const sandbox: any = {
    API: '', fetch: fetchImpl,
    AbortSignal, AbortController, setTimeout, clearTimeout, Promise, Date, Error, Set, JSON, console,
    window: { __SSIM_CAP__: 'tok' },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    document: { getElementById: () => null, createElement: () => ({ className: '', innerHTML: '', addEventListener: () => {} }), body: { appendChild: () => {} } },
  };
  const ctx: any = vm.createContext(sandbox);
  vm.runInContext(
    'const MUTATING_METHODS = new Set(["POST","PUT","PATCH","DELETE"]);\n' +
    `${extractFunction(APP_JS, 'capToken')}\n${extractFunction(APP_JS, 'awaitCap')}\n` +
    `${extractFunction(APP_JS, 'timeoutSignal')}\n${extractFunction(APP_JS, 'renderCapabilityBanner')}\n` +
    `${extractFunction(APP_JS, 'api')}\nthis.api = api;`, ctx);
  return ctx.api;
}

// A fetch that hangs until its AbortSignal fires, then rejects like the real one (TimeoutError/AbortError).
const hangingFetch = (_url: string, init: any) => new Promise((_res, reject) => {
  const s = init && init.signal;
  if (s) s.addEventListener('abort', () => {
    const err: any = new Error('aborted'); err.name = (s.reason && s.reason.name) || 'AbortError'; reject(err);
  });
});

test('S32: a hanging request aborts after the timeout (no indefinite spinner)', async () => {
  const api = loadApi(hangingFetch as any);
  await assert.rejects(
    api('/api/orders', { timeoutMs: 40 }),
    (e: any) => e.timedOut === true && /timed out/i.test(e.message),
  );
});

test('S32: timeoutMs:0 disables the client timeout (for a known-long call)', async () => {
  let sawSignal: unknown = 'unset';
  const api = loadApi(async (_u, init) => { sawSignal = init.signal; return { ok: true, json: async () => ({ ok: 1 }) }; });
  const r = await api('/api/something', { timeoutMs: 0 });
  assert.deepEqual(r, { ok: 1 });
  assert.equal(sawSignal, undefined, 'no AbortSignal attached when the timeout is disabled');
});

test('S32: a normal fast response is unaffected by the default timeout', async () => {
  const api = loadApi(async () => ({ ok: true, json: async () => ({ hello: 'world' }) }));
  assert.deepEqual(await api('/api/x'), { hello: 'world' });
});
