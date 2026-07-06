import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// ─────────────────────────────────────────────────────────────────────────────
//  H-FE-007 — the SDA Steam-Guard OTP auto-roll must not die permanently on the
//  first transient /otp fetch error (S17 class, uncovered loop). On failure it
//  now shows "—" + a once-per-streak toast AND schedules a bounded guarded retry
//  (SDA_OTP_RETRY_MS) so the display self-recovers once the backend returns. The
//  retry is guarded by SDA.open / SDA.username so a closed or account-switched
//  modal never schedules work.
//  Runs the SHIPPED startSdaOtp over a stubbed api + a controllable setTimeout —
//  it fails against the old catch that set no timer.
// ─────────────────────────────────────────────────────────────────────────────

function extractFunction(src: string, name: string): string {
  let start = src.indexOf(`async function ${name}(`);
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

const APP_JS = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');

interface Harness {
  ctx: any;
  otpEl: { textContent: string };
  scheduled: { fn: () => void; ms: number }[];
  apiCalls: string[];
  toasts: string[];
  runScheduled: () => Promise<void>;
}

function makeHarness(apiImpl: (path: string) => Promise<any>): Harness {
  const otpEl = { textContent: '·····' };
  const barEl = { style: { width: '' } };
  const scheduled: { fn: () => void; ms: number }[] = [];
  const apiCalls: string[] = [];
  const toasts: string[] = [];
  const sandbox: any = {
    SDA: { username: null, otpTimer: null, barTimer: null, code: '·····', confs: [], open: false, otpErr: false },
    SDA_OTP_RETRY_MS: 5000,
    el: { sdaOtp: otpEl, sdaOtpBar: barEl },
    api: (path: string) => { apiCalls.push(path); return apiImpl(path); },
    toast: (msg: string) => { toasts.push(String(msg)); },
    // A setTimeout that records the callback + delay instead of really deferring.
    setTimeout: (fn: () => void, ms: number) => { scheduled.push({ fn, ms }); return scheduled.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    Date, Number, Math, encodeURIComponent, Promise, console,
  };
  const ctx: any = vm.createContext(sandbox);
  vm.runInContext(
    `${extractFunction(APP_JS, 'startSdaOtp')}\nthis.startSdaOtp = startSdaOtp;`, ctx);
  const runScheduled = async () => {
    const pending = scheduled.splice(0);
    for (const p of pending) {
      p.fn(); // fires startSdaOtp() without returning its promise (mirrors the real timer)
      // Flush the async chain (await api → set state → schedule next) before returning.
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
  };
  return { ctx, otpEl, scheduled, apiCalls, toasts, runScheduled };
}

test('H-FE-007: a transient /otp failure schedules a bounded retry (not permanent "—")', async () => {
  let calls = 0;
  const h = makeHarness(async () => {
    calls++;
    if (calls === 1) throw new Error('transient blip');
    return { code: '9K4TC', msRemaining: 12000 };
  });
  h.ctx.SDA.open = true; h.ctx.SDA.username = 'bot1';

  await h.ctx.startSdaOtp('bot1');
  // First fetch failed: display is "—", one toast, and a retry timer is scheduled at SDA_OTP_RETRY_MS.
  assert.equal(h.otpEl.textContent, '—', 'first failure shows the "—" placeholder');
  assert.equal(h.toasts.length, 1, 'first failure toasts once');
  assert.equal(h.scheduled.length, 1, 'a retry is scheduled (the OLD code scheduled nothing here)');
  assert.equal(h.scheduled[0].ms, 5000, 'retry uses SDA_OTP_RETRY_MS (~5s)');

  // Fire the retry → the second fetch resolves → the code shows.
  await h.runScheduled();
  assert.equal(h.apiCalls.length, 2, 'the retry issues a second /otp fetch');
  assert.equal(h.otpEl.textContent, '9K4TC', 'the display self-recovers to the fresh code');
});

test('H-FE-007: the retry stops when the modal is closed (guarded, no runaway)', async () => {
  const h = makeHarness(async () => { throw new Error('down'); });
  h.ctx.SDA.open = true; h.ctx.SDA.username = 'bot1';

  await h.ctx.startSdaOtp('bot1');
  assert.equal(h.scheduled.length, 1, 'a retry was scheduled on failure');

  // Operator closes the modal before the retry fires.
  h.ctx.SDA.open = false;
  await h.runScheduled();
  assert.equal(h.apiCalls.length, 1, 'a closed modal must NOT issue another fetch');
});

test('H-FE-007: the error toast fires once per streak, not on every retry', async () => {
  const h = makeHarness(async () => { throw new Error('still down'); });
  h.ctx.SDA.open = true; h.ctx.SDA.username = 'bot1';

  await h.ctx.startSdaOtp('bot1');           // failure #1 → 1 toast, schedules retry
  await h.runScheduled();                      // failure #2 (retry) → no new toast
  await h.runScheduled();                      // failure #3 (retry) → no new toast
  assert.equal(h.apiCalls.length, 3, 'the auto-roll keeps retrying while it stays down');
  assert.equal(h.toasts.length, 1, 'only the FIRST failure in a streak toasts (no toast storm)');
});

test('H-FE-007: a recovered fetch clears the streak so the next blip toasts again', async () => {
  let calls = 0;
  const h = makeHarness(async () => {
    calls++;
    // fail, succeed, fail
    if (calls === 1 || calls === 3) throw new Error('blip');
    return { code: 'ABCDE', msRemaining: 9000 };
  });
  h.ctx.SDA.open = true; h.ctx.SDA.username = 'bot1';

  await h.ctx.startSdaOtp('bot1');   // fail → toast #1, otpErr=true
  await h.runScheduled();             // success → otpErr cleared
  assert.equal(h.ctx.SDA.otpErr, false, 'a successful fetch clears the error streak flag');
  await h.ctx.startSdaOtp('bot1');   // fail again → new streak → toast #2
  assert.equal(h.toasts.length, 2, 'a fresh failure after recovery toasts again');
});
