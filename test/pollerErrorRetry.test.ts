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

const APP_JS = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');

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

// ─────────────────────────────────────────────────────────────────────────────
//  H-FE-011 — the newer Trade-Up (tuPollExec) status poller must get the SAME
//  bounded error-retry the refresh/mass/sell/casket pollers have, rather than the
//  old bare `catch { /* stop polling on error */ }` that silently froze the foot at
//  e.g. "Executing 2/5" on a single transient status blip — with no resumption and
//  the completion toast never firing, on the irreversible 10-items-destroyed path.
//  On exceeding POLL_STALL_MS it must write a visible terminal line that reads as
//  status LOST, never as success.
// ─────────────────────────────────────────────────────────────────────────────

test('H-FE-011: tuPollExec wires the bounded error-retry (fails against the old silent-death catch)', () => {
  const tuPoll = extractFunction(APP_JS, 'tuPollExec');
  // Bounded retry at the same 1.2s cadence, then give up — mirrors the fbuy/mass/sell pollers.
  assert.ok(tuPoll.includes("if (!pollerStalled('tuExecErr', 0)) { tuState.execTimer = setTimeout(tick, 1200); return; }"),
    'trade-up poller retries within the window instead of dying on the first error');
  // A good poll clears the error window, and the window is cleared on exceeding the stall bound.
  assert.ok(tuPoll.includes("resetPoller('tuExecErr')"), 'tuExecErr is reset on a successful poll / after give-up');
  // The old silent-death catch must be gone.
  assert.ok(!tuPoll.includes('/* stop polling on error */'), 'the bare silent-death catch is removed');
  // Terminal state must read as status LOST — never fabricate a "done"/success.
  assert.ok(/Lost contact with the job[\s\S]*verify in-game/.test(tuPoll),
    'exceeding the stall window shows a visible "status lost — verify in-game" terminal line');
});
