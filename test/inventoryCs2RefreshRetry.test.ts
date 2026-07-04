import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InventoryService } from '../src/core/InventoryService';
import { InventoryManager } from '../src/core/InventoryManager';

// ════════════════════════════════════════════════════════════════════════════
//  S50 — the CS2 full-refresh fetchRaw pair (context 2 + 16) had NO transient/429
//  retry layer, while the TF2/quick path did. One 429 or proxy blip on either
//  context threw straight out and failed the whole account for the pass → inflated
//  `failed` counts at fleet scale. Now each context fetch runs under the same
//  bounded REFRESH_RETRIES loop; a non-transient error still fails fast.
// ════════════════════════════════════════════════════════════════════════════

function bareSvc(): InventoryService {
  const sessions = { getSession: () => undefined };
  const accounts = { get: (u: string) => ({ username: u, network: { type: 'proxy' } }) };
  const svc = new InventoryService(sessions as never, accounts as never);
  (svc as unknown as { pause: (ms: number) => Promise<void> }).pause = async () => {}; // no real backoff wait
  return svc;
}

test('S50: a transient fetchRaw error is RETRIED (not propagated as a failed account)', async () => {
  const svc = bareSvc();
  const orig = InventoryManager.fetchRaw;
  let calls = 0;
  (InventoryManager as unknown as { fetchRaw: unknown }).fetchRaw = async () => {
    calls++;
    if (calls === 1) throw new Error('Request failed with status code 429 (rate limit)');
    return { success: 1, assets: [], descriptions: [], truncated: false };
  };
  try {
    const raw = await (svc as unknown as { fetchRawRetrying: (s: unknown, c: number, u: string) => Promise<{ success: number }> })
      .fetchRawRetrying({ steamId: '1' }, 2, 'bot');
    assert.equal(calls, 2, 'the transient 429 was retried once, then succeeded');
    assert.equal(raw.success, 1);
  } finally { (InventoryManager as unknown as { fetchRaw: unknown }).fetchRaw = orig; }
});

test('S50: a NON-transient fetchRaw error fails fast (auth/private inventory is not retried)', async () => {
  const svc = bareSvc();
  const orig = InventoryManager.fetchRaw;
  let calls = 0;
  (InventoryManager as unknown as { fetchRaw: unknown }).fetchRaw = async () => { calls++; throw new Error('This profile is private.'); };
  try {
    await assert.rejects(
      () => (svc as unknown as { fetchRawRetrying: (s: unknown, c: number, u: string) => Promise<unknown> }).fetchRawRetrying({ steamId: '1' }, 2, 'bot'),
      /private/,
    );
    assert.equal(calls, 1, 'a non-transient error is thrown on the first attempt (no wasted retries)');
  } finally { (InventoryManager as unknown as { fetchRaw: unknown }).fetchRaw = orig; }
});
