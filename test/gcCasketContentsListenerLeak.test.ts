import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GcActionLayer } from '../src/trading/GcActionLayer';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-049 — a timed-out getCasketContents must leave NO orphan listener on the
//  reused handle. The lib's 30s timeout path fires the error callback but never
//  sets `timedOut` nor detaches its `itemCustomizationNotification` listener
//  (globaloffensive/index.js:399-405), so each timeout permanently adds one
//  listener + closure to the long-lived per-session handle. The layer now clears
//  that event on the error settle (we are the sole listener for it).
//  (withSession runs fn(go) against a stub bound to the REAL lib getCasketContents
//  so the actual timeout/orphan path executes; fake timers advance past 30s.)
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGc = any;

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
const GlobalOffensive: any = require('globaloffensive');

/** A stub handle whose getCasketContents is the REAL lib method, so the timeout path runs. */
function stubGo(casketId: string): AnyGc {
  const go: AnyGc = new EventEmitter();
  go.haveGCSession = true;
  // A casket present but not yet loaded (contained count > loaded count) → lib takes the
  // "load from GC" branch, arms the 30s timeout, and attaches itemCustomizationNotification.
  go.inventory = [{ id: casketId, casket_contained_item_count: 5 }];
  go._send = (): boolean => true; // swallow the CasketItemLoadContents send
  go.getCasketContents = GlobalOffensive.prototype.getCasketContents;
  return go;
}

test('H-TRD-049: getCasketContents timeout leaves no lib listener on the handle', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const gc: AnyGc = Object.create(GcActionLayer.prototype);
    const go = stubGo('123456789');
    gc.withSession = async (_u: string, fn: (g: unknown) => Promise<unknown>) => fn(go);

    const op = gc.getCasketContents('bot', '123456789');
    let rejected: unknown;
    const guarded = op.catch((e: unknown) => { rejected = e; });

    // The lib attached its notification listener when the load was armed.
    assert.equal(go.listenerCount('itemCustomizationNotification'), 1, 'lib armed its notification listener');

    // Fake-advance past the lib's 30s timeout → error callback → our detach.
    mock.timers.tick(30_000);
    await Promise.resolve();
    await guarded;

    assert.ok(rejected instanceof Error, 'the load timeout rejects');
    assert.match((rejected as Error).message, /timed out/i, 'rejects with the lib timeout error');
    assert.equal(go.listenerCount('itemCustomizationNotification'), 0, 'the orphan listener was detached on the error settle');
  } finally {
    mock.timers.reset();
  }
});
