import { test } from 'node:test';
import assert from 'node:assert/strict';
import { telemetryRider } from '../src/licensing/LicenseClient';
import { setUpdateOutcome, setLastExitClass } from '../src/licensing/updateStatus';
import { ProcessHealth } from '../src/core/ProcessHealth';

// ════════════════════════════════════════════════════════════════════════════
//  C4 — the health/update telemetry rider carried on the license heartbeat.
//  Backward compatible in BOTH directions: the server destructures only
//  { hwid, token } and ignores the rest; the client never reads it back. The
//  rider must (a) always carry clientVersion + the breaker flag, and (b) OMIT
//  the optional fields when unset (no nulls on the wire).
// ════════════════════════════════════════════════════════════════════════════

test('C4: the rider always carries clientVersion (a real semver) and the breaker flag', () => {
  ProcessHealth.reset();
  const r = telemetryRider();
  assert.match(r.clientVersion, /^\d+\.\d+\.\d+/, 'clientVersion is the real package version');
  assert.equal(r.moneyOpsBreakerTripped, false, 'a healthy process reports the breaker as not tripped');
});

test('C4: optional fields are OMITTED when unset (wire carries no nulls → old servers stay happy)', () => {
  ProcessHealth.reset();
  setUpdateOutcome(undefined as unknown as never); // simulate "no check completed yet"
  setLastExitClass(undefined);
  const r = telemetryRider();
  assert.ok(!('lastUpdateOutcome' in r), 'lastUpdateOutcome omitted when unknown');
  assert.ok(!('lastExitClass' in r), 'lastExitClass omitted when the prior exit is unknown');
});

test('C4: optional fields are INCLUDED once set (so the server can size the stranded fleet)', () => {
  ProcessHealth.reset();
  setUpdateOutcome('selftest-timeout');
  setLastExitClass('backend-crash(code=3221226505)');
  const r = telemetryRider();
  assert.equal(r.lastUpdateOutcome, 'selftest-timeout');
  assert.equal(r.lastExitClass, 'backend-crash(code=3221226505)');
});

test('C4: a tripped money-ops breaker is reflected in the rider', () => {
  ProcessHealth.reset();
  // Trip it: BURST_THRESHOLD (3) uncaught errors within the window.
  ProcessHealth.recordUncaught('a');
  ProcessHealth.recordUncaught('b');
  ProcessHealth.recordUncaught('c');
  assert.equal(telemetryRider().moneyOpsBreakerTripped, true, 'a quarantined process reports the tripped breaker');
  ProcessHealth.reset(); // leave the singleton clean for other tests
});
