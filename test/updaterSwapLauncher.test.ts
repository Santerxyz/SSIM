import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { swapAndRelaunch, parseManifest, type SpawnLauncher } from '../src/update/Updater';
import { getUpdateOutcome, setUpdateOutcome } from '../src/update/updateStatus';

// ════════════════════════════════════════════════════════════════════════════
//  H-LIC-002 — swapAndRelaunch spawned wscript.exe with NO 'error' listener. On
//  a hardened / EDR-managed box where WSH is disabled or removed, the async
//  'error' emit was re-thrown as an uncaughtException → a false crash marker +
//  a money-ops circuit-breaker tick for a benign "your OS blocks WSH" condition,
//  AND emitUpdate('SSIM_UPDATING')/process.exit(0) still fired unconditionally.
//  The launcher failure is now classified (swap-blocked), keeps-current (no
//  exit, no SSIM_UPDATING), and never escapes as an uncaughtException.
// ════════════════════════════════════════════════════════════════════════════

const SHA = 'a'.repeat(64);
const info = parseManifest({ latest: '9.9.9', sha256: SHA, url: 'https://license.ssim.dev/SSIM.exe', sigKind: 'AAAA' })!;

test('H-LIC-002: a launcher that fails to start resolves {updated:false}, records swap-blocked, and never emits SSIM_UPDATING or exits', async () => {
  // A launcher whose image can't be launched (WSH disabled): emit 'error' asynchronously, exactly as a
  // real ChildProcess does when spawning fails.
  const blockedLauncher: SpawnLauncher = () => {
    const ee = new EventEmitter() as ChildProcess;
    (ee as unknown as { unref: () => void }).unref = () => {};
    setImmediate(() => ee.emit('error', Object.assign(new Error('spawn wscript.exe ENOENT'), { code: 'ENOENT' })));
    return ee;
  };

  // Fail the test if the missing 'error' listener regression ever re-throws.
  const onUncaught = (e: Error): void => { throw new Error(`uncaughtException escaped swapAndRelaunch: ${e.message}`); };
  process.once('uncaughtException', onUncaught);

  // Spy stdout for the SSIM_UPDATING token (emitUpdate's only sink) and process.exit.
  const realWrite = process.stdout.write.bind(process.stdout);
  let sawUpdatingToken = false;
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => {
    if (typeof s === 'string' && s.includes('SSIM_UPDATING')) sawUpdatingToken = true;
    return true;
  };
  const realExit = process.exit;
  let exitCalled = false;
  (process as unknown as { exit: () => void }).exit = () => { exitCalled = true; };

  setUpdateOutcome('ok'); // a distinct prior value so we can prove the classification changed it

  try {
    const res = await swapAndRelaunch('C:/nope/new.exe', info, blockedLauncher);
    assert.equal(res.updated, false, 'a blocked launcher must keep-current, not claim a swap');
    assert.equal(res.reason, 'swap launcher blocked (WSH disabled?)');
    assert.equal(getUpdateOutcome(), 'swap-blocked', 'the launcher failure is classified for the C4 telemetry');
    assert.equal(sawUpdatingToken, false, 'SSIM_UPDATING must NOT be emitted when the swap will not happen');
    assert.equal(exitCalled, false, 'the process must NOT exit when the launcher failed to start');
  } finally {
    process.stdout.write = realWrite;
    (process as unknown as { exit: typeof realExit }).exit = realExit;
    process.removeListener('uncaughtException', onUncaught);
  }
});
