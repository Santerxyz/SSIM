import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// ─────────────────────────────────────────────────────────────────────────────
//  S17 — the refresh / mass / sell progress pollers must not die on the FIRST
//  transient status-fetch error while the job keeps running (else the completion
//  re-pull never fires and the view stays stale). They now use the same bounded
//  error-retry the fbuy poller has: retry until POLL_STALL_MS of continuous
//  errors, then give up.
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

const APP_JS = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('S17: pollerStalled(key, 0) is a bounded error window — retry, then give up, reset on success', () => {
  let clock = 1_000_000;
  const ctx: any = vm.createContext({ state: {}, POLL_STALL_MS: 180_000, Date: { now: () => clock } });
  vm.runInContext(
    `${extractFunction(APP_JS, 'pollerStalled')}\n${extractFunction(APP_JS, 'resetPoller')}\n` +
    `this.pollerStalled = pollerStalled; this.resetPoller = resetPoller;`, ctx);
  const { pollerStalled, resetPoller } = ctx as { pollerStalled: (k: string, d: number) => boolean; resetPoller: (k: string) => void };

  assert.equal(pollerStalled('refreshErr', 0), false, 'first error → retry (inside the window)');
  clock += 60_000; assert.equal(pollerStalled('refreshErr', 0), false, '1 min of errors → still retry');
  clock += 130_000; assert.equal(pollerStalled('refreshErr', 0), true, '>3 min of continuous errors → give up');
  resetPoller('refreshErr');
  assert.equal(pollerStalled('refreshErr', 0), false, 'a successful poll resets the window (reset → retry again)');
});

test('S17: all three pollers wire the bounded retry (fails against the old silent-death catch)', () => {
  assert.ok(APP_JS.includes("if (!pollerStalled('refreshErr', 0)) { pollRefresh(); return; }"), 'refresh poller retries');
  assert.ok(APP_JS.includes("if (!pollerStalled('massErr', 0)) { pollMass(); return; }"), 'mass poller retries');
  assert.ok(APP_JS.includes("if (!pollerStalled('sellErr', 0)) { pollSell(); return; }"), 'sell poller retries');
  // And each clears its error window on a good poll.
  for (const k of ['refreshErr', 'massErr', 'sellErr']) {
    assert.ok(APP_JS.includes(`resetPoller('${k}')`), `${k} is reset on a successful poll`);
  }
});
