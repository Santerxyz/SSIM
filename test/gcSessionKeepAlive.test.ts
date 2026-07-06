import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { GcActionLayer } from '../src/trading/GcActionLayer';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-046 — GcActionLayer.withSession must keep the session out of the idle
//  reaper for the WHOLE op. A large casket move legitimately runs 10-35+ min; the
//  reaper's 30-min TTL logs out any session whose lastActivityAt is stale (B40's
//  contract: markUsed at every op entry). withSession is the GC entry point, so it
//  markUsed()s on entry AND arms a 60s keep-alive so lastActivityAt is never staler
//  than 60s — the reaper can never select the session mid-move/mid-craft.
//  (withSession is driven on a bare instance with the connect/handle machinery
//  stubbed, so this exercises only the keep-alive, not a real GC session.)
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGc = any;

test('H-TRD-046: withSession keeps the session out of the idle reaper (markUsed on entry + every 60s)', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const gc: AnyGc = Object.create(GcActionLayer.prototype);
    let marks = 0;
    gc.sessions = {
      markUsed: () => { marks += 1; },
      getSession: () => ({ client: {} }),
    };
    gc.inFlight = new Set<string>();
    // Stub the GC machinery so withSession exercises only the keep-alive, not a real connect.
    gc.getHandle = () => ({ haveGCSession: true });
    gc.connect = async () => { /* resolved connect */ };
    gc.disconnect = () => { /* noop */ };

    // fn resolves after 130s → the 60s keep-alive fires at 60s and 120s.
    const op = gc.withSession('bot', () => new Promise((r) => setTimeout(r, 130_000)), 300_000);

    // Drive the fake clock forward in small steps, yielding to the microtask queue between
    // ticks so each awaited step (jitter sleep → connect → fn) can settle.
    for (let elapsed = 0; elapsed <= 135_000; elapsed += 5_000) {
      mock.timers.tick(5_000);
      await Promise.resolve();
      await Promise.resolve();
    }
    await op;

    assert.ok(marks >= 2, `expected >=2 markUsed calls across the op; got ${marks}`);
  } finally {
    mock.timers.reset();
  }
});

test('H-TRD-046: the keep-alive interval is cleared when the op finishes (no runaway markUsed)', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const gc: AnyGc = Object.create(GcActionLayer.prototype);
    let marks = 0;
    gc.sessions = {
      markUsed: () => { marks += 1; },
      getSession: () => ({ client: {} }),
    };
    gc.inFlight = new Set<string>();
    gc.getHandle = () => ({ haveGCSession: true });
    gc.connect = async () => { /* resolved connect */ };
    gc.disconnect = () => { /* noop */ };

    // A fast op (resolves ~immediately) → clear the jitter + let it settle.
    const op = gc.withSession('bot', async () => 'ok', 300_000);
    for (let i = 0; i < 5; i++) { mock.timers.tick(2_000); await Promise.resolve(); }
    const res = await op;
    assert.equal(res, 'ok');

    const afterOp = marks;
    // Advance far past several 60s intervals — a cleared interval must not keep marking.
    mock.timers.tick(300_000);
    await Promise.resolve();
    assert.equal(marks, afterOp, 'the keep-alive interval was cleared in finally (no marks after the op)');
  } finally {
    mock.timers.reset();
  }
});
