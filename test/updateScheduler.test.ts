import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  currentView, canInstallNow, startUpdateScheduler, stopUpdateScheduler,
} from '../src/licensing/updateScheduler';
import { setAvailableUpdate, setBlockedUpdate } from '../src/licensing/updateStatus';

// ════════════════════════════════════════════════════════════════════════════
//  C5 — periodic/manual update checks + idle-gated swap. (Tests run in-order in a
//  single process, so the first case sees the module before deps are wired.)
// ════════════════════════════════════════════════════════════════════════════

test('C5: canInstallNow is a safe refusal before the scheduler is wired (never throws)', () => {
  const gate = canInstallNow();
  assert.equal(gate.ok, false, 'no deps yet → refuse, do not throw');
});

test('C5: canInstallNow refuses in a dev (non-packaged) build — updates are packaged-only (never swap node.exe)', () => {
  startUpdateScheduler({ currentVersion: '1.3.4', isBusy: () => false }, 999_999);
  const gate = canInstallNow();
  assert.equal(gate.ok, false, 'a dev run never installs/swaps');
  assert.match(gate.reason, /packaged/i);
  stopUpdateScheduler();
});

test('C5: currentView maps available + per-machine block, and blocks only the MATCHING version', () => {
  setAvailableUpdate(undefined);
  setBlockedUpdate(undefined);
  let v = currentView('1.3.4');
  assert.equal(v.available, false);
  assert.equal(v.blocked, false);
  assert.equal(v.current, '1.3.4');

  setAvailableUpdate({ version: '1.3.5' });
  v = currentView('1.3.4');
  assert.equal(v.available, true);
  assert.equal(v.latest, '1.3.5');
  assert.equal(v.blocked, false, 'available but not blocked');

  // A block recorded for a DIFFERENT version must NOT mark the current offer blocked.
  setBlockedUpdate({ version: '1.3.4', sha256: 'x', kind: 'crash', failures: 3, since: 1 });
  assert.equal(currentView('1.3.4').blocked, false, 'block is for another version than the live offer');

  // A block for the SAME offered version marks it blocked (C3 surface).
  setBlockedUpdate({ version: '1.3.5', sha256: 'x', kind: 'no-marker', failures: 3, since: 1 });
  assert.equal(currentView('1.3.4').blocked, true, 'the offered version is blocked on this machine');

  setAvailableUpdate(undefined);
  setBlockedUpdate(undefined);
});
