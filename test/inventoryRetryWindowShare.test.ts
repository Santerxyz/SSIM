import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { InventoryService } from '../src/core/InventoryService';
import { SessionState } from '../src/types/session';

// ════════════════════════════════════════════════════════════════════════════
//  H-XCT-003 — ctx2 and ctx16 are read from the SAME Steam per-IP endpoint, so
//  they share ONE rate-limit window. Each context's retry loop used to serve a
//  fresh full 35s RETRY_PAUSE_RATELIMIT independently, so a 429 on both burned
//  up to 2×35s (ctx2) + 2×35s (ctx16) ≈ 140s per account. A per-account
//  ThrottleState now carries the moment ctx2's rate-limit wait ended; ctx16,
//  hitting the identical window ctx2 already waited out, serves only the
//  REMAINDER (≈0 when it starts immediately after) instead of a fresh 35s.
//  The retry COUNT is unchanged — only the duplicate wait on an already-elapsed
//  window is removed; a still-throttled window still exhausts the 2 retries.
// ════════════════════════════════════════════════════════════════════════════

const CS2_STEAMID = '76561190000000011';

// Mocks the axios boundary so fetchRaw / fetchListedItems run naturally. Each of
// ctx2 and ctx16 answers HTTP 429 on its FIRST hit (→ the rate-limit retry pause)
// then an authoritative-empty body (total_inventory_count: 0) so the suspicious-
// empty confirmation re-read is skipped and only the two throttle-shared fetches
// exercise the retry loop.
function installWindowShareAxiosMock(): () => void {
  const ax = require('axios');
  const orig = ax.get;
  let ctx2Hits = 0;
  let ctx16Hits = 0;
  const emptyBody = { success: 1, assets: [], descriptions: [], total_inventory_count: 0 };
  const mock = async (url: string): Promise<{ status: number; data: unknown }> => {
    if (/\/inventory\/\d+\/730\/2(\?|$)/.test(url)) {
      ctx2Hits++;
      if (ctx2Hits === 1) throw new Error('Request failed with status code 429 (rate limit)');
      return { status: 200, data: emptyBody };
    }
    if (/\/inventory\/\d+\/730\/16(\?|$)/.test(url)) {
      ctx16Hits++;
      if (ctx16Hits === 1) throw new Error('Request failed with status code 429 (rate limit)');
      return { status: 200, data: emptyBody };
    }
    if (/market\/mylistings\//.test(url)) return { status: 200, data: { listings: [], buy_orders: [] } };
    return { status: 404, data: {} };
  };
  ax.get = mock;
  if (ax.default) ax.default.get = mock;
  return () => { ax.get = orig; if (ax.default) ax.default.get = orig; };
}

// A service whose `pause` seam ADVANCES a fake clock (that Date.now reads) rather than
// waiting real seconds: a "35s wait" makes 35s of wall time pass in the simulated clock,
// so ctx16's window-remainder math sees ctx2's wait as genuinely elapsed. Each pause value
// is captured so we can assert ctx2 waited a full window and ctx16 only the (near-zero)
// remainder.
function svcSimClock(): { svc: InventoryService; pauses: number[]; restore: () => void } {
  const client: any = new EventEmitter();
  client.steamID = { getSteamID64: () => CS2_STEAMID };
  const session: any = {
    account: { username: 'winbot', network: { type: 'localip' } },
    client, state: SessionState.LOGGED_IN, steamId: CS2_STEAMID,
    webSession: { cookies: ['steamLoginSecure=abc', 'sessionid=xyz'], sessionId: 'xyz', obtainedAt: new Date() },
    httpsAgent: undefined, wallet: undefined,
  };
  const sessions: any = {
    getSession: () => session, isLive: () => true,
    loginAccount: async () => session, loginAccountOwned: async () => ({ session, createdByCall: false }),
    logoutAccount: async () => undefined, markUsed: () => undefined,
  };
  const accounts: any = { get: (u: string) => ({ username: u, network: { type: 'localip' } }) };
  const svc = new InventoryService(sessions, accounts);
  const pauses: number[] = [];
  let simNow = Date.now();
  const realNow = Date.now;
  Date.now = () => simNow;
  (svc as unknown as { pause: (ms: number) => Promise<void> }).pause = async (ms: number) => {
    pauses.push(ms);
    simNow += ms; // the simulated wait genuinely advances wall time
  };
  return { svc, pauses, restore: () => { Date.now = realNow; } };
}

test('H-XCT-003: ctx16 serves only the REMAINDER of the per-IP window ctx2 already waited', async () => {
  const restoreAxios = installWindowShareAxiosMock();
  const { svc, pauses, restore: restoreClock } = svcSimClock();
  try {
    const out = await svc.refreshOneViaGc('winbot');

    // Exactly two rate-limit pauses ran (one retry per context) — the retry COUNT is unchanged.
    assert.equal(pauses.length, 2, 'one rate-limit retry pause per context (ctx2 then ctx16)');

    const [ctx2Pause, ctx16Pause] = pauses;
    // ctx2 hits a fresh window → full 35s.
    assert.equal(ctx2Pause, 35_000, 'ctx2 waits a full rate-limit window (35s)');
    // ctx16 shares the window ctx2 just waited out; the remainder is ≈0 because ctx2's 35s
    // already elapsed in the (simulated) clock — strictly SHORTER than a fresh full window.
    assert.ok(ctx16Pause < 35_000, 'ctx16 is shortened to the window remainder, not a fresh 35s');
    assert.ok(ctx16Pause <= 1_000, `ctx16 remainder is near-zero when it starts right after ctx2's wait (got ${ctx16Pause}ms)`);

    // The refresh still resolved (authoritative-empty), proving the shortened path did not
    // change terminal behavior.
    assert.equal(out.username, 'winbot');
  } finally {
    restoreClock();
    restoreAxios();
  }
});
