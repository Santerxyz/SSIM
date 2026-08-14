import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// ─────────────────────────────────────────────────────────────────────────────
//  S1 — Capability token must survive an in-webview reload.
//
//  The shell delivers the per-run money/config token by eval-ing
//  `window.__SSIM_CAP__='…'` into the dashboard. That in-memory value is wiped by
//  ANY reload (F5 / WebView2 renderer recovery / the S23 location.replace), after
//  which every POST/PUT/PATCH/DELETE 401s until a full restart — while reads keep
//  working so the app looks healthy.
//
//  The fix stashes the token in sessionStorage on first sight and falls back to it,
//  so a reload (window.__SSIM_CAP__ gone, sessionStorage intact) still yields the
//  token. This test extracts the SHIPPED `capToken` from public/app.js and runs it
//  against a mock window + sessionStorage — no jsdom / no new dependency.
// ─────────────────────────────────────────────────────────────────────────────

/** Extract a top-level `function <name>() { … }` from source by brace-matching. */
function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found in app.js`);
  const bodyOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

/** A minimal in-memory sessionStorage; `throwing` simulates private-mode / blocked storage. */
function makeSessionStorage(throwing = false) {
  const map = new Map<string, string>();
  return {
    getItem(k: string) { if (throwing) throw new Error('blocked'); return map.has(k) ? map.get(k)! : null; },
    setItem(k: string, v: string) { if (throwing) throw new Error('blocked'); map.set(k, v); },
    removeItem(k: string) { if (throwing) throw new Error('blocked'); map.delete(k); },
    _map: map,
  };
}

const APP_JS = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const CAP_TOKEN_SRC = extractFunction(APP_JS, 'capToken');

/** Build a fresh sandbox holding the shipped capToken over a given window/sessionStorage. */
function loadCapToken(sandbox: Record<string, unknown>): () => string {
  const ctx: any = vm.createContext(sandbox);
  vm.runInContext(`${CAP_TOKEN_SRC}\nthis.__capToken = capToken;`, ctx);
  return ctx.__capToken;
}

test('S1: capToken returns the injected token AND stashes it to sessionStorage', () => {
  const sessionStorage = makeSessionStorage();
  const window = { __SSIM_CAP__: 'deadbeefcafe' };
  const capToken = loadCapToken({ window, sessionStorage });

  assert.equal(capToken(), 'deadbeefcafe');
  // First sight persisted it — the whole point of the fix.
  assert.equal(sessionStorage._map.get('ssim_cap'), 'deadbeefcafe');
});

test('S1: after a reload (window.__SSIM_CAP__ gone) capToken recovers it from sessionStorage', () => {
  const sessionStorage = makeSessionStorage();
  // 1) First load: token present → capToken stashes it.
  const before = loadCapToken({ window: { __SSIM_CAP__: 'abc123token' }, sessionStorage });
  assert.equal(before(), 'abc123token');

  // 2) Reload: the eval-set global is wiped, but sessionStorage persists for the origin.
  const afterReload = loadCapToken({ window: {}, sessionStorage });
  assert.equal(afterReload(), 'abc123token', 'token must survive the reload — this is the S1 defect');
});

test('S1: with neither source, capToken returns empty (no throw)', () => {
  const capToken = loadCapToken({ window: {}, sessionStorage: makeSessionStorage() });
  assert.equal(capToken(), '');
});

test('S1: sessionStorage failure (private mode) degrades to window-only, never throws', () => {
  const capToken = loadCapToken({ window: { __SSIM_CAP__: 'token999' }, sessionStorage: makeSessionStorage(true) });
  assert.equal(capToken(), 'token999'); // window still works; the throw is swallowed
  const capNone = loadCapToken({ window: {}, sessionStorage: makeSessionStorage(true) });
  assert.equal(capNone(), '');          // no window, storage throws → '' (no crash)
});
