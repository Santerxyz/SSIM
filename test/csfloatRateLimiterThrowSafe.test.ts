import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/csfloat/RateLimiter';

// ════════════════════════════════════════════════════════════════════════════
//  H-FLT-013 — a task that throws SYNCHRONOUSLY from fn (a non-async
//  () => Promise<T> whose body throws before returning) used to increment
//  `active` and never decrement it: `.then/.finally` were never attached, so the
//  permit leaked and pump()'s `active >= maxConcurrent` guard stayed true
//  forever, wedging every subsequent schedule() on that limiter. The fix brackets
//  the call so a sync throw releases the slot and re-pumps.
// ════════════════════════════════════════════════════════════════════════════

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out: ${label} (leaked permit?)`)), ms).unref?.();
    }),
  ]);

test('H-FLT-013: a synchronous throw releases the permit and the limiter keeps dispatching', async () => {
  const lim = new RateLimiter(1, 0);

  // A non-async () => Promise<T> whose synchronous body throws before returning.
  await assert.rejects(
    lim.schedule<string>((): Promise<string> => { throw new Error('sync'); }),
    /sync/,
  );

  // On the buggy code the permit leaked (active stuck at 1) so this never dispatches;
  // the timeout race fails the test instead of hanging the runner.
  const ok = await withTimeout(
    lim.schedule(async () => 'ok'),
    1000,
    'second schedule after a sync throw',
  );
  assert.equal(ok, 'ok', 'the limiter still dispatches after a synchronously-throwing task');
});
