import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { logger } from '../src/utils/logger';
import { openBrowser } from '../src/utils/openBrowser';

// openBrowser.ts does `import { spawn } from 'child_process'` → the compiled code reads
// `.spawn` off the require-cached module object at CALL time, so stubbing that same object
// intercepts the real spawn. (A `import * as` namespace exposes spawn as a read-only getter
// that mock.method cannot replace — the CJS module object is mutable and is what runs.)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const childProcess = require('child_process') as typeof import('child_process');

// ════════════════════════════════════════════════════════════════════════════
//  H-BOOT-031 — a spawn LAUNCH failure (missing opener: no xdg-open/open, blocked
//  cmd policy) is reported ASYNCHRONOUSLY as an 'error' event on the detached
//  child, NOT thrown synchronously. openBrowser calls .unref() and its try/catch
//  only ever saw synchronous arg errors, so the 'error' emit reached the global
//  process.on('uncaughtException') and was mis-recorded as a CRASH (crash-log
//  entry + ProcessHealth.recordUncaught). The fix attaches an 'error' listener to
//  each spawned child that performs the author-intended warn-and-continue.
//
//  This test stubs child_process.spawn to return an EventEmitter that emits
//  'error' on the next tick and asserts: exactly one logger.warn fires and NO
//  'uncaughtException' is emitted.
// ════════════════════════════════════════════════════════════════════════════

test("H-BOOT-031: an async spawn 'error' warns-and-continues, it does NOT reach uncaughtException", async () => {
  const prevOpen = process.env.SSIM_OPEN_BROWSER;
  const prevNo = process.env.SSIM_NO_BROWSER;
  process.env.SSIM_OPEN_BROWSER = '1'; // force the dev opt-in path so spawn runs
  delete process.env.SSIM_NO_BROWSER;

  // A detached child that fails to launch: an EventEmitter with .unref() that emits
  // 'error' on the next tick, exactly like a real ENOENT spawn failure.
  const child = Object.assign(new EventEmitter(), { unref: () => {} });
  const spawnMock = mock.method(childProcess, 'spawn', () => {
    process.nextTick(() => child.emit('error', new Error('spawn xdg-open ENOENT')));
    return child as unknown as ChildProcess;
  });
  const warnMock = mock.method(logger, 'warn', () => logger);

  // If the 'error' emit escaped to the global handler, THIS listener would fire.
  let uncaught = 0;
  const onUncaught = (): void => { uncaught += 1; };
  process.on('uncaughtException', onUncaught);

  try {
    openBrowser('http://localhost:5000');
    // Let the queued nextTick 'error' emit land.
    await new Promise((r) => setImmediate(r));

    assert.equal(spawnMock.mock.callCount(), 1, 'exactly one opener was spawned');
    assert.equal(uncaught, 0, "the spawn 'error' must NOT reach process.on('uncaughtException')");
    assert.equal(warnMock.mock.callCount(), 1, 'the failure path warned exactly once');
    assert.match(
      warnMock.mock.calls[0].arguments[0] as string,
      /could not open browser automatically .*ENOENT.* – open http:\/\/localhost:5000 manually/,
      'the warn names the cause and the manual URL',
    );
  } finally {
    process.removeListener('uncaughtException', onUncaught);
    warnMock.mock.restore();
    spawnMock.mock.restore();
    if (prevOpen === undefined) delete process.env.SSIM_OPEN_BROWSER; else process.env.SSIM_OPEN_BROWSER = prevOpen;
    if (prevNo === undefined) delete process.env.SSIM_NO_BROWSER; else process.env.SSIM_NO_BROWSER = prevNo;
  }
});
