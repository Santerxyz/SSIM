import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExchangeRateService } from '../src/pricing/ExchangeRateService';

// ════════════════════════════════════════════════════════════════════════════
//  S44 — a failed FX refresh used to wait the full 12h before retrying, stranding
//  the fallback/stale rate for half a day on a transient blip. It now arms a short
//  bounded-backoff retry (minutes); a success cancels it and resets the budget.
// ════════════════════════════════════════════════════════════════════════════

function mockAxios(responder: () => { data: unknown }): () => void {
  const ax = require('axios');
  const orig = ax.get;
  const fn = async () => responder();
  ax.get = fn; if (ax.default) ax.default.get = fn;
  return () => { ax.get = orig; if (ax.default) ax.default.get = orig; };
}

const tmp = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-fx-')), 'exchange_rate.json');

type Internals = { refresh: () => Promise<void>; retryTimer?: NodeJS.Timeout; retryAttempt: number };

test('S44: a failed refresh arms a short retry (not a 12h wait)', async () => {
  const svc = new ExchangeRateService(tmp());
  const restore = mockAxios(() => { throw new Error('ENOTFOUND api.frankfurter.app'); });
  try {
    await (svc as unknown as Internals).refresh();
    assert.ok((svc as unknown as Internals).retryTimer, 'a short retry timer is armed after a failure');
    assert.equal((svc as unknown as Internals).retryAttempt, 1, 'backoff advanced to attempt 1');
  } finally { restore(); svc.stop(); }
});

test('S44: a 200 with no usable rate is treated as a failure (also retried)', async () => {
  const svc = new ExchangeRateService(tmp());
  const restore = mockAxios(() => ({ data: { rates: {} } })); // 200 but no EUR
  try {
    await (svc as unknown as Internals).refresh();
    assert.ok((svc as unknown as Internals).retryTimer, 'a garbage 200 does not silently skip the retry');
  } finally { restore(); svc.stop(); }
});

test('S44: a successful refresh cancels the pending retry and resets the backoff', async () => {
  const svc = new ExchangeRateService(tmp());
  let restore = mockAxios(() => { throw new Error('blip'); });
  await (svc as unknown as Internals).refresh(); // fail → retry armed
  restore();
  restore = mockAxios(() => ({ data: { rates: { EUR: 0.88 } } }));
  try {
    await (svc as unknown as Internals).refresh(); // success
    assert.equal((svc as unknown as Internals).retryTimer, undefined, 'the pending retry is cancelled on success');
    assert.equal((svc as unknown as Internals).retryAttempt, 0, 'the backoff budget is reset');
    assert.equal(svc.getUsdToEur(), 0.88, 'the live rate is applied');
    assert.equal(svc.getInfo().fallback, false, 'no longer on the hardcoded fallback');
  } finally { restore(); svc.stop(); }
});

test('S44: backoff is bounded — at MAX_RETRIES no further retry is scheduled (no busy loop)', async () => {
  const svc = new ExchangeRateService(tmp());
  const restore = mockAxios(() => { throw new Error('down'); });
  try {
    (svc as unknown as Internals).retryAttempt = 4; // MAX_RETRIES
    await (svc as unknown as Internals).refresh();
    assert.equal((svc as unknown as Internals).retryTimer, undefined, 'past the cap, wait for the next 12h tick');
  } finally { restore(); svc.stop(); }
});
