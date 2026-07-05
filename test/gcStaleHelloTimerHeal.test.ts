import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GcActionLayer } from '../src/trading/GcActionLayer';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-048 — connect() must heal the globaloffensive v3.3.0 stale-`_helloTimer`
//  bug so ONE ClientLogonFatalError does not permanently brick the reused handle.
//  Upstream: ClientLogonFatalError does clearTimeout(this._helloTimer) but never nulls
//  it (handlers.js:16), and handleAppQuit clears the misnamed _helloInterval instead
//  (index.js:70-74). The stale (cleared, truthy) Timeout then makes _connect() refuse
//  to send a hello forever ("has helloTimer", index.js:104-107) → every later op on the
//  cached handle fakes a 35s connect timeout with a wrong diagnosis.
//
//  This drives the REAL connect() against a stub handle that models the lib faithfully:
//  the client's gamesPlayed([730]) stands in for _connect(), sending a ClientHello
//  (→ connectedToGC) ONLY when _helloTimer is falsy, exactly the lib's gate.
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGc = any;

test('H-TRD-048: connect heals a stale hello timer after a GC fatal error', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const gc: AnyGc = Object.create(GcActionLayer.prototype);

    // The cached handle, reused across both ops. Models the private v3.x fields the heal touches.
    const go: AnyGc = new EventEmitter();
    go.haveGCSession = false;
    go._isInCSGO = false;
    go._helloTimer = null;

    let helloSends = 0;
    // gamesPlayed([730]) stands in for the lib's _connect(): it refuses to send a hello while a
    // (stale) _helloTimer is truthy — the exact gate at index.js:104-107. `mode` decides what a
    // successful hello resolves to for that op.
    let mode: 'fatal' | 'ok' = 'fatal';
    const client = {
      gamesPlayed: (apps: number[]): void => {
        if (apps.length === 0) { go._isInCSGO = false; return; } // disconnect (gamesPlayed([]) → lib appQuit)
        go._isInCSGO = true;
        if (go._helloTimer) return; // "has helloTimer" → _connect refuses to send a hello
        // Send a ClientHello.
        helloSends += 1;
        if (mode === 'fatal') {
          // ClientLogonFatalError: the lib clears the timer but leaves it TRUTHY (the bug), then errors.
          go._helloTimer = setTimeout(() => { /* cleared, never nulled */ }, 60_000);
          clearTimeout(go._helloTimer); // cleared object stays assigned & truthy — reproduces handlers.js:16
          go.emit('error', new Error('Logon Fatal Error: region restricted'));
        } else {
          go.haveGCSession = true;
          go.emit('connectedToGC');
        }
      },
    };

    // Op 1 — the fatal error. connect() rejects; the stale (cleared, truthy) _helloTimer is left behind.
    let op1err: unknown;
    const p1 = (gc.connect(go, client) as Promise<void>).catch((e: unknown) => { op1err = e; });
    await Promise.resolve();
    await p1;
    assert.ok(op1err instanceof Error, 'op 1 rejects on the fatal error');
    assert.match((op1err as Error).message, /Fatal Error/, 'op 1 surfaces the REAL fatal error, not a fake timeout');
    assert.ok(go._helloTimer, 'the upstream bug is reproduced: _helloTimer is stale (cleared but still truthy)');

    // Between ops, withSession's finally runs disconnect(client) = gamesPlayed([]) → the lib's appQuit
    // resets _isInCSGO to false (index.js:70-92). That is the state the heal guard (!_isInCSGO) targets.
    client.gamesPlayed([]);
    assert.equal(go._isInCSGO, false, 'disconnect reset _isInCSGO (matches the real withSession teardown)');
    assert.ok(go._helloTimer, 'but the stale _helloTimer survives the disconnect (the upstream bug)');

    // Op 2 — same reused handle. WITHOUT the heal, the stale _helloTimer blocks the hello and connect()
    // can only settle via its 35s timer. WITH the heal, _helloTimer is nulled → a fresh hello is sent.
    mode = 'ok';
    const helloBefore = helloSends;
    let op2err: unknown;
    let resolved = false;
    const p2 = (gc.connect(go, client) as Promise<void>).then(() => { resolved = true; }, (e: unknown) => { op2err = e; });
    // A healed op2 resolves synchronously (hello → connectedToGC). Advance well past the 35s connect
    // timeout too, so a REGRESSED heal fails loudly via the fake-timeout error instead of hanging.
    for (let elapsed = 0; elapsed <= 40_000; elapsed += 1_000) {
      mock.timers.tick(1_000);
      await Promise.resolve();
      await Promise.resolve();
    }
    await p2;

    assert.equal(op2err, undefined, 'op 2 does NOT fake a connect timeout after the heal');
    assert.ok(resolved, 'op 2 connects: the heal cleared the stale timer so a fresh hello was sent');
    assert.equal(helloSends, helloBefore + 1, 'op 2 attempted a fresh ClientHello send');
    assert.equal(go._helloTimer, null, 'the heal nulled the stale _helloTimer');
  } finally {
    mock.timers.reset();
  }
});

test('H-TRD-048: the heal never disturbs a live hello loop (_isInCSGO true)', async () => {
  const gc: AnyGc = Object.create(GcActionLayer.prototype);

  // A handle mid-hello: _isInCSGO true and a live _helloTimer. The guard (!haveGCSession && !_isInCSGO)
  // must NOT touch this — clearing a live retry timer would silently stall the connect.
  const liveTimer = setTimeout(() => { /* live hello loop */ }, 60_000);
  const go: AnyGc = new EventEmitter();
  go.haveGCSession = false;
  go._isInCSGO = true;
  go._helloTimer = liveTimer;

  const client = { gamesPlayed: (apps: number[]): void => { if (apps.length) go.emit('connectedToGC'); } };

  await gc.connect(go, client);
  assert.equal(go._helloTimer, liveTimer, 'a live hello loop (_isInCSGO true) is left untouched by the heal');
  clearTimeout(liveTimer);
});
