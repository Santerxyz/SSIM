import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOnly, startUpdateScheduler, stopUpdateScheduler } from '../src/update/updateScheduler';
import { setUpdateOutcome, getUpdateOutcome, setAvailableUpdate } from '../src/update/updateStatus';
import { Updater } from '../src/update/Updater';

// ════════════════════════════════════════════════════════════════════════════
//  H-LIC-007 — checkOnly's outcome telemetry must be symmetric across all three
//  Updater.check results (S53 residue in the scheduler's own CHECK-ONLY path). A
//  successful periodic check must clear a stale 'check-failed', so a healthy,
//  up-to-date 24/7 machine is never counted in the C4 stranded-fleet histogram
//  forever. (Tests run in-order in a single process.)
// ════════════════════════════════════════════════════════════════════════════

const OK_INFO = { latest: '9.9.9', url: 'x', sha256: 'x', sig: 'x' };

test('H-LIC-007: a transient check-failed is CLEARED to up-to-date once a later check reports current', async () => {
  const orig = Updater.check;
  const results = [{ status: 'check-failed', error: 'blip' }, { status: 'current' }];
  (Updater as unknown as { check: () => Promise<unknown> }).check = async () => results.shift();
  startUpdateScheduler({ currentVersion: '1.3.5', isBusy: () => false }, 999_999);
  try {
    await checkOnly('periodic'); // tick #1: transient failure
    assert.equal(getUpdateOutcome(), 'check-failed', 'a failed check is not "up to date"');
    await checkOnly('periodic'); // tick #2: succeeds, server says current
    assert.equal(getUpdateOutcome(), 'up-to-date', 'the stale check-failed is now cleared (not stranded forever)');
  } finally {
    (Updater as unknown as { check: typeof orig }).check = orig;
    stopUpdateScheduler();
  }
});

test('H-LIC-007: a successful check that FINDS an update also clears a stale check-failed', async () => {
  const orig = Updater.check;
  const results = [{ status: 'check-failed', error: 'blip' }, { status: 'update', info: OK_INFO }];
  (Updater as unknown as { check: () => Promise<unknown> }).check = async () => results.shift();
  startUpdateScheduler({ currentVersion: '1.3.5', isBusy: () => false }, 999_999);
  try {
    await checkOnly('periodic'); // tick #1: transient failure
    assert.equal(getUpdateOutcome(), 'check-failed');
    await checkOnly('periodic'); // tick #2: reaches the server, gets a newer version back
    assert.notEqual(getUpdateOutcome(), 'check-failed', 'the check demonstrably reached the server → no longer stranded');
  } finally {
    (Updater as unknown as { check: typeof orig }).check = orig;
    setAvailableUpdate(undefined);
    stopUpdateScheduler();
  }
});

test('H-LIC-007: the update-branch guard NEVER clobbers a real swap outcome (only check-failed is overwritten)', async () => {
  const orig = Updater.check;
  (Updater as unknown as { check: () => Promise<unknown> }).check = async () => ({ status: 'update', info: OK_INFO });
  startUpdateScheduler({ currentVersion: '1.3.5', isBusy: () => false }, 999_999);
  try {
    setUpdateOutcome('ok'); // a genuine boot-time swap outcome still riding the heartbeat
    await checkOnly('periodic'); // finds an update, but must not touch a non-check-failed outcome
    assert.equal(getUpdateOutcome(), 'ok', 'a real swap outcome is preserved (guard is load-bearing)');
  } finally {
    (Updater as unknown as { check: typeof orig }).check = orig;
    setAvailableUpdate(undefined);
    stopUpdateScheduler();
  }
});
