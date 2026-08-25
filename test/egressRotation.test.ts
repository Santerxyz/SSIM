import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EgressRotationRegistry } from '../src/network/EgressRotation';
import { pickPricerIdentities } from '../src/pricing/PricerIdentityPool';

// ─────────────────────────────────────────────────────────────────────────────
//  Rotating-proxy detection (2026-08-25).
//
//  SSIM identifies an exit by the proxy STRING, so one rotating proxy — whose
//  connections genuinely land on many different IPs — is indistinguishable from
//  one static proxy, and is throttled as if all its lanes shared an IP. This
//  measures the difference instead of guessing it.
//
//  The verdict is deliberately ASYMMETRIC: two different IPs proves rotation;
//  the same IP twice is only absence of evidence. So "same", "probe failed" and
//  "never measured" all collapse to the SAFE answer (static), because being
//  wrong the other way puts every lane on one IP at N× the safe rate — the
//  failure mode behind the July 2026 rolling lockout.
// ─────────────────────────────────────────────────────────────────────────────

const agent = {} as any;

/** Swaps axios.get for a scripted responder; returns [restore, calls]. */
function mockAxios(ips: Array<string | number>): { restore: () => void; calls: any[] } {
  const ax = require('axios');
  const orig = ax.get;
  const calls: any[] = [];
  let i = 0;
  const responder = async (url: string, cfg: any) => {
    calls.push({ url, cfg });
    const next = ips[Math.min(i++, ips.length - 1)];
    if (next === 0) throw new Error('ECONNRESET');
    if (typeof next === 'number') return { status: next, data: {} };
    return { status: 200, data: { ip: next } };
  };
  ax.get = responder;
  if (ax.default) ax.default.get = responder;
  return { restore: () => { ax.get = orig; if (ax.default) ax.default.get = orig; }, calls };
}

/** observe() is fire-and-forget; let its microtasks/awaits drain. */
const settle = () => new Promise((r) => setTimeout(r, 30));

test('unmeasured keys are NOT rotating — the safe default before any probe runs', () => {
  const reg = new EgressRotationRegistry();
  assert.equal(reg.isRotating('proxy:1.1.1.1:8000'), false);
});

test('two different exit IPs ⇒ ROTATING', async () => {
  const reg = new EgressRotationRegistry();
  const { restore } = mockAxios(['9.9.9.1', '9.9.9.2']);
  try {
    reg.observe('proxy:1.1.1.1:8000', [agent, agent]);
    await settle();
    assert.equal(reg.isRotating('proxy:1.1.1.1:8000'), true);
  } finally { restore(); }
});

test('the same exit IP twice ⇒ static (absence of evidence is not evidence of rotation)', async () => {
  const reg = new EgressRotationRegistry();
  const { restore } = mockAxios(['9.9.9.1', '9.9.9.1']);
  try {
    reg.observe('proxy:1.1.1.1:8000', [agent, agent]);
    await settle();
    assert.equal(reg.isRotating('proxy:1.1.1.1:8000'), false);
  } finally { restore(); }
});

test('the probe forces a FRESH connection — a reused keep-alive socket would mask rotation', async () => {
  const reg = new EgressRotationRegistry();
  const { restore, calls } = mockAxios(['9.9.9.1', '9.9.9.2']);
  try {
    reg.observe('proxy:1.1.1.1:8000', [agent, agent]);
    await settle();
    assert.equal(calls.length, 2, 'exactly two probes');
    for (const c of calls) {
      assert.equal(c.cfg.headers.Connection, 'close', 'Connection: close on every probe');
      assert.equal(c.cfg.proxy, false, 'never re-routed by an ambient env proxy');
      assert.equal(c.cfg.httpsAgent, agent, 'the probe egresses through the session\'s own agent');
    }
  } finally { restore(); }
});

test('a transport failure is INCONCLUSIVE → static, never a rotation verdict', async () => {
  const reg = new EgressRotationRegistry();
  const { restore } = mockAxios([0]);
  try {
    reg.observe('proxy:1.1.1.1:8000', [agent, agent]);
    await settle();
    assert.equal(reg.isRotating('proxy:1.1.1.1:8000'), false);
  } finally { restore(); }
});

test('a non-200 is INCONCLUSIVE → static', async () => {
  const reg = new EgressRotationRegistry();
  const { restore } = mockAxios([503, 503]);
  try {
    reg.observe('proxy:1.1.1.1:8000', [agent, agent]);
    await settle();
    assert.equal(reg.isRotating('proxy:1.1.1.1:8000'), false);
  } finally { restore(); }
});

test('a settled verdict is cached — a second observe() does not re-probe', async () => {
  const reg = new EgressRotationRegistry();
  const { restore, calls } = mockAxios(['9.9.9.1', '9.9.9.2']);
  try {
    reg.observe('proxy:1.1.1.1:8000', [agent, agent]);
    await settle();
    assert.equal(calls.length, 2);
    reg.observe('proxy:1.1.1.1:8000', [agent, agent]);
    await settle();
    assert.equal(calls.length, 2, 'still 2 — the fresh verdict was reused, no probe traffic per fill');
  } finally { restore(); }
});

test('concurrent observe() calls collapse to ONE in-flight probe', async () => {
  const reg = new EgressRotationRegistry();
  const { restore, calls } = mockAxios(['9.9.9.1', '9.9.9.2']);
  try {
    reg.observe('proxy:1.1.1.1:8000', [agent, agent]);
    reg.observe('proxy:1.1.1.1:8000', [agent, agent]);
    reg.observe('proxy:1.1.1.1:8000', [agent, agent]);
    await settle();
    assert.equal(calls.length, 2, 'three observes, one probe (two requests)');
  } finally { restore(); }
});

test('SSIM_EGRESS_ROTATION_PROBE=0 emits NO probe traffic at all', async () => {
  const reg = new EgressRotationRegistry();
  const { restore, calls } = mockAxios(['9.9.9.1', '9.9.9.2']);
  const prev = process.env.SSIM_EGRESS_ROTATION_PROBE;
  process.env.SSIM_EGRESS_ROTATION_PROBE = '0';
  try {
    reg.observe('proxy:1.1.1.1:8000', [agent, agent]);
    await settle();
    assert.equal(calls.length, 0, 'the kill switch stops the probe entirely');
    assert.equal(reg.isRotating('proxy:1.1.1.1:8000'), false, 'and everything stays on the safe pace');
  } finally {
    restore();
    if (prev === undefined) delete process.env.SSIM_EGRESS_ROTATION_PROBE;
    else process.env.SSIM_EGRESS_ROTATION_PROBE = prev;
  }
});

test('observe() with no live agents is a no-op', async () => {
  const reg = new EgressRotationRegistry();
  const { restore, calls } = mockAxios(['9.9.9.1', '9.9.9.2']);
  try {
    reg.observe('proxy:1.1.1.1:8000', []);
    await settle();
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

// ── What the verdict actually buys, end to end ───────────────────────────────

const cand = (username: string, egressKey: string, rotatingExit = false) =>
  ({ username, cookies: [`steamLoginSecure=${username}`], agent, egressKey, rotatingExit });
const many = (n: number, egressKey: string, rotatingExit = false) =>
  Array.from({ length: n }, (_, i) => cand(`bot${i}`, egressKey, rotatingExit));

test('ONE ROTATING PROXY: each session becomes its own exit, so lanes scale past the per-exit cap', () => {
  const ids = pickPricerIdentities(many(20, 'proxy:1.1.1.1:8000', true), 36, 3);
  assert.equal(ids.length, 20, '20 sessions on a measured-rotating proxy → 20 lanes, not 3');
  assert.equal(ids.every((i) => i.exitLanes === 1), true,
    'each is alone on its own rotated exit → each gets a full exit budget');
  assert.equal(new Set(ids.map((i) => i.egressKey)).size, 20, 'bucketed as 20 distinct exits');
});

test('ONE STATIC PROXY: the same 20 sessions stay capped at the per-exit limit', () => {
  const ids = pickPricerIdentities(many(20, 'proxy:1.1.1.1:8000', false), 36, 3);
  assert.equal(ids.length, 3, 'unmeasured/static proxy is unchanged — 3 lanes on one IP');
  assert.equal(ids.every((i) => i.exitLanes === 3), true, 'and they share that exit\'s budget');
});

test('a rotating proxy is still bounded by the GLOBAL lane cap', () => {
  const ids = pickPricerIdentities(many(200, 'proxy:1.1.1.1:8000', true), 36, 3);
  assert.equal(ids.length, 36, 'rotation lifts the per-exit cap, never the global concurrency ceiling');
});

test('the synthetic exit key keeps the real proxy in the string, for traceable logs', () => {
  const ids = pickPricerIdentities([cand('bot_a', 'proxy:1.1.1.1:8000', true)], 4, 3);
  assert.match(ids[0].egressKey, /^proxy:1\.1\.1\.1:8000#bot_a$/);
});

test('rotating and static proxies mix correctly in one selection', () => {
  const ids = pickPricerIdentities([
    ...many(4, 'proxy:1.1.1.1:8000', true),      // rotating → 4 exits
    ...Array.from({ length: 4 }, (_, i) => cand(`s${i}`, 'proxy:2.2.2.2:8000', false)), // static → 1 exit, 3 lanes
  ], 36, 3);
  const rotating = ids.filter((i) => i.egressKey.startsWith('proxy:1.1.1.1:8000#'));
  const staticLanes = ids.filter((i) => i.egressKey === 'proxy:2.2.2.2:8000');
  assert.equal(rotating.length, 4, 'every rotating session gets a lane');
  assert.equal(staticLanes.length, 3, 'the static proxy stays capped at 3');
  assert.equal(rotating.every((i) => i.exitLanes === 1), true, 'rotating lanes each own an exit');
  assert.equal(staticLanes.every((i) => i.exitLanes === 3), true, 'static lanes share one');
});
