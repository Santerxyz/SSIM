import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InventoryManager } from '../src/core/InventoryManager';
import { InventoryService } from '../src/core/InventoryService';
import { SessionState } from '../src/types/session';

// ════════════════════════════════════════════════════════════════════════════
//  H-INV-010 — the silent cookie-renewal block wrapped BOTH refreshWebSession AND
//  the retried request in one try/catch. When the refresh succeeded but the retry
//  itself rejected (ETIMEDOUT/ECONNRESET through a flaky proxy), the rejection was
//  swallowed, `res` kept the ORIGINAL failed status (e.g. 403), and fetchRaw threw
//  a LYING "private inventory (HTTP 403)". That literal is NOT transient to
//  InventoryService.fetchRawRetrying's classifier → no retry, account failed for
//  the pass with the wrong diagnosis. The retried request now runs OUTSIDE the try,
//  so a transport rejection propagates with its timeout text and the S50 retry
//  ladder engages.
// ════════════════════════════════════════════════════════════════════════════

const STEAMID = '76561190000000010';

function fetchRawSession(): any {
  return {
    account: { username: 'renewbot', userAgent: 'UA', network: { type: 'proxy' } },
    state: SessionState.LOGGED_IN,
    steamId: STEAMID,
    webSession: { cookies: ['steamLoginSecure=abc', 'sessionid=xyz'], sessionId: 'xyz', obtainedAt: new Date() },
    httpsAgent: undefined,
  };
}

// Mocks the axios boundary: page 0 answers HTTP 403 (enters the renewal block); the
// retried request (2nd axios hit) rejects with a timeout. Also stubs refreshWebSession
// to resolve so the retry is actually issued.
function installMock(): () => void {
  const ax = require('axios');
  const sm = require('../src/core/SessionManager');
  const origGet = ax.get;
  const origDefaultGet = ax.default ? ax.default.get : undefined;
  const origRefresh = sm.refreshWebSession;

  let hits = 0;
  const get = async (): Promise<{ status: number; data: unknown }> => {
    hits++;
    if (hits === 1) return { status: 403, data: '<html>Access Denied</html>' }; // primary read: 403
    throw new Error('timeout of 15000ms exceeded');                             // retried read: transport blip
  };
  ax.get = get;
  if (ax.default) ax.default.get = get;
  sm.refreshWebSession = async () => undefined; // cookie renewal succeeds

  return () => {
    ax.get = origGet;
    if (ax.default) ax.default.get = origDefaultGet;
    sm.refreshWebSession = origRefresh;
  };
}

test('H-INV-010: a timeout on the post-renewal retry propagates (not the stale HTTP 403)', async () => {
  const restore = installMock();
  try {
    await assert.rejects(
      () => InventoryManager.fetchRaw(fetchRawSession(), 'cs2', 2),
      (err: Error) => {
        assert.match(err.message, /timeout of 15000ms exceeded/, 'the propagated error is the transport timeout');
        assert.doesNotMatch(err.message, /HTTP 403/, 'the stale 403 status is NOT surfaced');
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('H-INV-010: fetchRawRetrying RETRIES the propagated timeout (S50 ladder engages)', async () => {
  const restore = installMock();
  try {
    const sessions = { getSession: () => undefined };
    const accounts = { get: (u: string) => ({ username: u, network: { type: 'proxy' } }) };
    const svc = new InventoryService(sessions as never, accounts as never);
    (svc as unknown as { pause: (ms: number) => Promise<void> }).pause = async () => {}; // no real backoff wait

    let calls = 0;
    const orig = InventoryManager.fetchRaw;
    (InventoryManager as unknown as { fetchRaw: unknown }).fetchRaw = async (...args: unknown[]) => {
      calls++;
      if (calls === 1) throw new Error('timeout of 15000ms exceeded'); // the H-INV-010 propagated transport error
      return (orig as (...a: unknown[]) => unknown)(...args);           // 2nd attempt: real fetchRaw (mocked axios → 403 then timeout)
    };
    try {
      // The wrapper must RETRY the timeout (transient) rather than fail fast. The real
      // fetchRaw on the retry still rejects (mock always 403→timeout), so the call rejects,
      // but only AFTER at least one retry attempt — proving the classifier engaged.
      await assert.rejects(
        () => (svc as unknown as { fetchRawRetrying: (s: unknown, c: number, u: string) => Promise<unknown> })
          .fetchRawRetrying(fetchRawSession(), 2, 'renewbot'),
        /timeout of 15000ms exceeded/,
      );
      assert.ok(calls >= 2, 'the transient timeout was retried (not failed-fast like a 4xx literal)');
    } finally {
      (InventoryManager as unknown as { fetchRaw: unknown }).fetchRaw = orig;
    }
  } finally {
    restore();
  }
});
