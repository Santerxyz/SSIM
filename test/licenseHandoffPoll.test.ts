import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// ─────────────────────────────────────────────────────────────────────────────
//  H-LIC-009 — the post-activation handoff must be a readiness POLL, not a blind
//  fixed-timer reload. The portal frees the port and gateAndRun runs an unbounded
//  validate→auto-update→vault→startFullApp chain (a staged 185MB update can take
//  minutes); a fixed `location.reload()` would land on a still-downloading /
//  swapped / unbound port → a permanent connection-refused page. The fix polls
//  /api/system/status and navigates ONLY on the full app's `licensed:true` marker
//  (the portal fabricates `licensed:false`), so the reload is proof-gated.
//
//  We extract the shipped `waitForApp` closure from license.html and drive it over
//  a mocked fetch/location — behavioural proof it navigates iff licensed:true — plus
//  source-level guards for the minified FALLBACK_HTML (no VM/jsdom for that form,
//  same style as licenseKeyUppercase.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

function licenseHtml(): string {
  return readFileSync(join(__dirname, '..', 'public', 'license.html'), 'utf8');
}

// Extract the `const waitForApp = () => { … };` arrow from the page's success branch.
function extractWaitForApp(src: string): string {
  const start = src.indexOf('const waitForApp =');
  assert.ok(start >= 0, 'waitForApp closure not found in license.html');
  const bodyOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      if (--depth === 0) {
        // include the trailing `;` after the closing brace
        const end = src.indexOf(';', i);
        return src.slice(start, (end >= 0 ? end : i) + 1);
      }
    }
  }
  throw new Error('unbalanced braces extracting waitForApp');
}

// Run one poll iteration. `status` is the object /api/system/status resolves to
// (or the string 'THROW' to simulate a network error → .catch path). setTimeout is
// stubbed to throw a sentinel so the re-arm is observed but the loop does not recurse.
async function runOnce(status: any): Promise<{ replaced: number; rearmed: boolean }> {
  let replaced = 0;
  let rearmed = false;
  const sandbox: any = {
    fetch: async () =>
      status === 'THROW'
        ? Promise.reject(new Error('connection refused'))
        : ({ json: async () => status }),
    // Record the re-arm but do NOT recurse — a single poll iteration is enough.
    setTimeout: (_fn: () => void, _ms: number) => { rearmed = true; return 0; },
    setMsg: () => {},
    Date: { now: () => 0 }, // keep (now - startedAt) below the 45s text-swap threshold
    startedAt: 0,
    location: { replace: () => { replaced++; } },
    Promise,
  };
  const ctx: any = vm.createContext(sandbox);
  vm.runInContext(`${extractWaitForApp(licenseHtml())}\nthis.__wait = waitForApp;`, ctx);
  ctx.__wait();
  // fetch is async — drain the microtask queue so the resolved/rejected .then/.catch
  // that calls location.replace or the re-arm setTimeout has run before we assert.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return { replaced, rearmed };
}

test('H-LIC-009: waitForApp navigates exactly once on licensed:true', async () => {
  const r = await runOnce({ licensed: true });
  assert.equal(r.replaced, 1, 'must navigate to the dashboard when the full app reports licensed:true');
});

test('H-LIC-009: licensed:false (portal still serving) → no navigate, re-arm poll', async () => {
  const r = await runOnce({ licensed: false });
  assert.equal(r.replaced, 0, 'must NOT navigate while the portal still answers licensed:false');
  assert.equal(r.rearmed, true, 'must keep polling until the full app is licensed');
});

test('H-LIC-009: licensed absent (half-up status) → no navigate, keep polling', async () => {
  const r = await runOnce({ activated: false });
  assert.equal(r.replaced, 0, 'a status that OMITS licensed must not be treated as ready');
  assert.equal(r.rearmed, true);
});

test('H-LIC-009: status fetch rejects (port not yet bound) → no navigate, keep polling', async () => {
  const r = await runOnce('THROW');
  assert.equal(r.replaced, 0, 'a connection-refused probe must not navigate');
  assert.equal(r.rearmed, true, 'must keep polling through the rebind window');
});

test('H-LIC-009: the success branch does not reload on a blind fixed timer', () => {
  const html = licenseHtml();
  assert.doesNotMatch(html, /setTimeout\(\(\)\s*=>\s*location\.reload\(\)/,
    'the blind fixed-timer reload must be replaced by the readiness poll');
  assert.match(html, /fetch\('\/api\/system\/status'/,
    'the success branch must poll /api/system/status for readiness');
  assert.match(html, /s\.licensed === true/,
    'navigation must be gated on the full app\'s licensed:true marker');
});

test('H-LIC-009: the inline FALLBACK_HTML also polls for licensed:true (no blind reload)', () => {
  const src = readFileSync(
    join(__dirname, '..', 'src', 'licensing', 'ActivationServer.ts'), 'utf8',
  );
  assert.doesNotMatch(src, /setTimeout\(\(\)=>location\.reload\(\),2000\)/,
    'the fallback form must not reload on a blind fixed timer');
  assert.match(src, /fetch\('\/api\/system\/status',\{cache:'no-store'\}\)/,
    'the fallback form must poll the status route');
  assert.match(src, /x\.licensed===true/,
    'the fallback form must navigate only on licensed:true');
});
