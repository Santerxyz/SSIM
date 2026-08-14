import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import child_process from 'node:child_process';

// ════════════════════════════════════════════════════════════════════════════
//  H-LIC-021 — showLockPage spawns `cmd /c start "" <file>` detached to open the
//  lock page in the browser. A ChildProcess is an EventEmitter; when the exe
//  cannot launch (ENOENT off a stripped PATH, EPERM/EACCES under AppLocker) Node
//  emits 'error' on a LATER tick, outside the surrounding try/catch. With no
//  'error' listener that re-throws as an uncaughtException → the global handler
//  writes a misleading crash breadcrumb and ticks the money-ops breaker. The fix
//  attaches a same-tick child.on('error', …) so the failed launch is contained.
//  This stubs child_process.spawn with a fake that emits 'error' next tick and
//  asserts NO uncaughtException escapes.
// ════════════════════════════════════════════════════════════════════════════

test('H-LIC-021: a spawn "error" from showLockPage does not become an uncaughtException', async () => {
  const realSpawn = child_process.spawn;
  let spawned = false;

  // Fake child: a real EventEmitter (so an unlistened 'error' would genuinely
  // throw), with the .unref() the caller invokes, that emits 'error' next tick —
  // exactly Node's semantics when the image cannot be launched.
  const fakeSpawn = (): child_process.ChildProcess => {
    spawned = true;
    const child = new EventEmitter() as unknown as child_process.ChildProcess;
    (child as unknown as { unref: () => void }).unref = () => { /* detached child */ };
    setImmediate(() => child.emit('error', Object.assign(new Error('spawn EPERM'), { code: 'EPERM' })));
    return child;
  };
  (child_process as unknown as { spawn: unknown }).spawn = fakeSpawn;

  // If the finding's defect were present, the async 'error' would land here.
  let uncaught: unknown;
  const onUncaught = (e: unknown): void => { uncaught = e; };
  process.once('uncaughtException', onUncaught);

  try {
    // Require the COMPILED module after the stub is installed so its
    // `import { spawn } from 'child_process'` resolves to our fake.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { printLockScreen } = require('../src/utils/startupError') as typeof import('../src/utils/startupError');
    printLockScreen('LICENSE DENIED', 'synthetic test detail');
    assert.equal(spawned, true, 'showLockPage must reach the spawn (the lock page is written + opened)');

    // Let the setImmediate 'error' + a full macrotask elapse; a leaked uncaught
    // exception would have fired by now.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(uncaught, undefined, 'the spawn "error" must be contained by child.on("error"), not re-thrown');
  } finally {
    process.removeListener('uncaughtException', onUncaught);
    (child_process as unknown as { spawn: unknown }).spawn = realSpawn;
  }
});
