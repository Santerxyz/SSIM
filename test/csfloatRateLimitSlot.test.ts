import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CsFloatClient } from '../src/csfloat/CsFloatClient';

// ════════════════════════════════════════════════════════════════════════════
//  S45 — the 429 backoff used to `await delay()` INSIDE the limiter's scheduled
//  task. With maxConcurrent=1 that held the single-flight slot for the whole
//  backoff, so an interactive request could not preempt a background pricing
//  storm. The backoff now happens OUTSIDE the slot (the task resolves first),
//  so interactive traffic runs during a background retry's wait.
// ════════════════════════════════════════════════════════════════════════════

const wait = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms).unref?.(); });

type Req = (config: unknown) => Promise<unknown>;

test('S45: a 429 backoff frees the single-flight slot so an interactive request preempts', async () => {
  // A unique key so both clients share ONE limiter (CsFloatClient.limiterFor caches per key).
  const KEY = 'S45-shared-key';
  const bg = new CsFloatClient(KEY, undefined, { priority: -1 }); // background pricing
  const inter = new CsFloatClient(KEY, undefined, { priority: 0 }); // interactive tab

  let bgCalls = 0;
  (bg as unknown as { http: { request: Req } }).http = {
    request: async () => { bgCalls++; return bgCalls === 1 ? { status: 429, data: {} } : { status: 200, data: { tag: 'BG' } }; },
  };
  (inter as unknown as { http: { request: Req } }).http = {
    request: async () => ({ status: 200, data: { tag: 'INTERACTIVE' } }),
  };

  const order: string[] = [];
  const pBg = (bg as unknown as { req: Req }).req({ method: 'GET', url: '/bg' }).then(() => order.push('bg'));
  await wait(50); // let the background request hit its 429 and enter backoff
  const pIt = (inter as unknown as { req: Req }).req({ method: 'GET', url: '/it' }).then(() => order.push('it'));

  await Promise.all([pBg, pIt]);
  assert.deepEqual(order, ['it', 'bg'],
    'interactive completed DURING the background 429 backoff — the slot was freed, not held');
  assert.equal(bgCalls, 2, 'the background request still retried its 429 to success');
});
