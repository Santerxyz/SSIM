import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// ─────────────────────────────────────────────────────────────────────────────
//  S22 — three undismissed error toasts occupied all 3 slots forever (errors
//  never auto-dismissed) → every later toast queued invisibly in an UNBOUNDED
//  queue → the operator lost all op feedback. Fix: error toasts get a long TTL
//  (not never), duplicates collapse, and the queue is capped.
// ─────────────────────────────────────────────────────────────────────────────

function extractFunction(src: string, name: string): string {
  let start = src.indexOf(`async function ${name}(`);
  if (start < 0) start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found in app.js`);
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

const APP_JS = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');

function loadToast() {
  const calls: any[] = [];
  const sandbox: any = {
    Set,
    TOAST_MAX: 3,
    TOAST_QUEUE_CAP: 5, // small cap for the test
    ERROR_TOAST_TTL_MS: 20000,
    toastQueue: [],
    toastShown: 0,
    activeToastKeys: new Set(),
    // stub: a "shown" toast that STAYS visible (never closes) — simulates the stuck-error scenario
    showOneToast(m: string, t: string, _o: unknown, key: string) { sandbox.toastShown++; calls.push({ m, t, key }); },
  };
  const ctx: any = vm.createContext(sandbox);
  vm.runInContext(`${extractFunction(APP_JS, 'toast')}\n${extractFunction(APP_JS, 'drainToasts')}\nthis.toast = toast;`, ctx);
  return { toast: ctx.toast as (m: string, t?: string, o?: any) => void, sandbox, calls };
}

test('S22: identical toasts are de-duped (an error burst collapses to one)', () => {
  const { toast, sandbox, calls } = loadToast();
  toast('Boom', 'error'); toast('Boom', 'error'); toast('Boom', 'error');
  assert.equal(calls.length, 1, 'three identical errors show once');
  assert.equal(sandbox.toastShown, 1);
});

test('S22: three stuck errors no longer block the queue unbounded — later toasts queue, capped', () => {
  const { toast, sandbox } = loadToast();
  toast('E1', 'error'); toast('E2', 'error'); toast('E3', 'error'); // fill the 3 visible slots
  assert.equal(sandbox.toastShown, 3);
  for (let i = 0; i < 20; i++) toast('Q' + i, 'info');              // a flood of distinct notifications
  assert.ok(sandbox.toastQueue.length <= 5, `queue is capped at 5 (was unbounded), got ${sandbox.toastQueue.length}`);
  assert.ok(sandbox.activeToastKeys.size <= 8, 'de-dup key set is bounded too (3 shown + ≤5 queued)');
});

test('S22: error toasts now auto-dismiss after a long TTL (not "never")', () => {
  assert.ok(APP_JS.includes('ERROR_TOAST_TTL_MS'), 'a long error TTL constant exists');
  assert.ok(/type === 'error' \? ERROR_TOAST_TTL_MS/.test(APP_JS), 'errors use the long TTL, not never');
  assert.ok(!/if \(type !== 'error'\) timer = setTimeout/.test(APP_JS), 'the never-dismiss-error path is gone');
});
