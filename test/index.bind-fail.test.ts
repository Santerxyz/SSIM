import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
//  H-BOOT-002 — a bind failure left startFullApp RESOLVED (it scheduled exit(1)
//  in 250ms and returned WITHOUT throwing), so `await startFullApp()` in
//  gateAndRun fell through to LicenseClient.startHeartbeat + startUpdateScheduler
//  — arming post-bind services against a server that never listened (log/telemetry
//  noise on an EADDRINUSE post-mortem, and the mechanism that let the re-license
//  caller miss the failure).
//
//  The fix makes startFullApp return Promise<boolean> (true = bound) and guards the
//  gateAndRun call: `if (!(await startFullApp(...))) return;` — so on a first-boot
//  bind failure (which returns false; exit is already scheduled) no heartbeat /
//  update scheduler is armed. The re-license path is UNCHANGED: handleListenError
//  throws BindFailedError before reaching `return false`, so onLicenseLost still
//  recovers (H-BOOT-001). Success path returns true → unchanged behaviour.
//
//  Runtime/process-lifecycle shaped — index.ts self-bootstraps and startFullApp
//  schedules process.exit, so it is untestable in-process (cf. index.relicense-bind);
//  this locks the wiring, verified alongside `tsc`.
// ─────────────────────────────────────────────────────────────────────────────

const SRC = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');

test('H-BOOT-002: startFullApp returns a bound-boolean (true on success, false on a first-boot bind failure)', () => {
  assert.match(SRC, /async function startFullApp\([^)]*\): Promise<boolean>/,
    'startFullApp signals the bind outcome via Promise<boolean>');
  const body = /async function startFullApp\([\s\S]*?\n\}/.exec(SRC)?.[0] ?? '';
  assert.match(body, /handleListenError\([\s\S]*?\n\s*return false;/,
    'the bind-failure path returns false (exit already scheduled) instead of resolving as if bound');
  assert.match(body, /return true;/, 'the successful-bind path returns true');
});

// Renamed gateAndRun → bootAndRun when the licence gate was removed; the licence heartbeat
// that used to be armed here is gone, so startUpdateScheduler is now the only post-bind
// service. The guarantee under test is unchanged: a failed bind arms nothing.
test('H-BOOT-002: bootAndRun stops after a failed startFullApp, before arming post-bind services', () => {
  const body = /async function bootAndRun\([\s\S]*?\n\}\n/.exec(SRC)?.[0] ?? '';
  assert.match(body, /if \(!\(await startFullApp\(\{ firstBoot: !everBound \}\)\)\) return;/,
    'a failed bind (false) returns early so no post-bind services are armed');
  // The update scheduler must be reached ONLY after the guarded call (never on a failed
  // bind, where the process is already exiting in 250ms).
  const guardIdx = body.indexOf('if (!(await startFullApp(');
  const schedulerIdx = body.indexOf('startUpdateScheduler(');
  assert.ok(guardIdx >= 0, 'the bind guard is present');
  assert.ok(schedulerIdx > guardIdx,
    'startUpdateScheduler is armed only after the bind guard');
  // Regression guard for the delicensing: nothing may reintroduce a licence heartbeat here.
  assert.doesNotMatch(body, /startHeartbeat|LicenseClient/,
    'no licence heartbeat may be armed on the boot path');
});
