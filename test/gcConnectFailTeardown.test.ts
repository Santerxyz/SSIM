import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GcActionLayer } from '../src/trading/GcActionLayer';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-047 — a connect() failure must still run the guaranteed teardown. connect()
//  sends gamesPlayed([730]) then waits up to 35s for connectedToGC; if that rejects
//  (GC busy/down, account lacks CS2), the account must NOT stay in-game CS2 with the
//  lib's hello retry loop firing indefinitely. Moving connect() inside the guarded
//  region makes disconnect() (gamesPlayed([])) cover the failure path too.
//  (withSession runs the REAL connect/disconnect against a stub handle that never
//  emits connectedToGC — fake timers advance past the 35s connect timeout.)
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGc = any;

test('H-TRD-047: withSession runs disconnect (gamesPlayed([])) when connect times out', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const gc: AnyGc = Object.create(GcActionLayer.prototype);
    const played: number[][] = [];
    const client = { gamesPlayed: (apps: number[]): void => { played.push(apps); } };
    // A stub handle that never emits connectedToGC → connect() can only settle via its 35s timer.
    const go: AnyGc = new EventEmitter();
    go.haveGCSession = false;

    gc.sessions = { markUsed: () => { /* noop */ }, getSession: () => ({ client }) };
    gc.inFlight = new Set<string>();
    gc.getHandle = () => go; // real connect/disconnect; only the handle lookup is stubbed
    let fnRan = false;

    const op = gc.withSession('bot', async () => { fnRan = true; return 'ok'; }, 300_000);

    // Drive the fake clock past the jitter sleep (≤2s) and the 35s connect timeout.
    let rejected: unknown;
    const guarded = op.catch((e: unknown) => { rejected = e; });
    for (let elapsed = 0; elapsed <= 40_000; elapsed += 1_000) {
      mock.timers.tick(1_000);
      await Promise.resolve();
      await Promise.resolve();
    }
    await guarded;

    assert.ok(rejected instanceof Error, 'the connect timeout rejection propagates to the caller');
    assert.match((rejected as Error).message, /GC connect timeout/, 'rejects with the connect-timeout error');
    assert.equal(fnRan, false, 'fn never runs when connect fails');
    assert.deepEqual(played[0], [730], 'connect() sent gamesPlayed([730])');
    assert.deepEqual(played[played.length - 1], [], 'disconnect() STILL sent gamesPlayed([]) on the connect-failure path');
  } finally {
    mock.timers.reset();
  }
});
