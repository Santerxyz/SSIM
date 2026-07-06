import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { BanService } from '../src/trading/BanService';
import type { AccountManager } from '../src/core/AccountManager';
import type { SessionManager } from '../src/core/SessionManager';
import type { TradeService } from '../src/trading/TradeService';
import type { AccountConfig } from '../src/types/account';

// ─── H-TRD-036: fetchBans classifies failures (transient vs permanent) and fetchChunk retries only ──
// transient ones (429/5xx, a login-wall/malformed 200, a network throw) up to 3 attempts (1s, 4s).
// A 401/403 key rejection is permanent → exactly one attempt. A malformed 200 body no longer surfaces
// the useless "Steam HTTP 200" — its message names the unexpected body. Uses the STEAM_WEB_API_KEY
// override path so no login/session stubbing is needed (both accounts carry a cached steamId, so only
// fetchBans (axios) is exercised).

const SID_A = '76561198000000001';
const SID_B = '76561198000000002';

function acct(username: string, steamId: string): AccountConfig {
  return {
    id: username,
    username,
    password: 'x',
    maFilePath: `${username}.maFile`,
    environmentId: 'env-a',
    enabled: true,
    steamId,
  } as AccountConfig;
}

function makeService(accounts: AccountConfig[]): BanService {
  const byName = new Map(accounts.map((a) => [a.username.toLowerCase(), a]));
  const stubAccounts = {
    get: (u: string) => byName.get(u.toLowerCase()),
  } as unknown as AccountManager;
  const stubSessions = {
    getSession: () => undefined,
    isLive: () => false,
    isReady: () => false,
  } as unknown as SessionManager;
  const stubTrades = {} as unknown as TradeService;
  return new BanService(stubAccounts, stubSessions, stubTrades);
}

async function withOverrideKey<T>(fn: () => Promise<T>): Promise<T> {
  const origGet = axios.get;
  const origKey = process.env.STEAM_WEB_API_KEY;
  process.env.STEAM_WEB_API_KEY = 'OVERRIDEKEY';
  try {
    return await fn();
  } finally {
    (axios as { get: unknown }).get = origGet;
    if (origKey === undefined) delete process.env.STEAM_WEB_API_KEY;
    else process.env.STEAM_WEB_API_KEY = origKey;
  }
}

test('H-TRD-036 (a): 500, 500, 200-with-players → 3 attempts, accounts get ban data', async () => {
  const svc = makeService([acct('a', SID_A), acct('b', SID_B)]);
  await withOverrideKey(async () => {
    let calls = 0;
    (axios as { get: unknown }).get = async () => {
      calls++;
      if (calls <= 2) return { status: 500, data: 'upstream error' };
      return {
        status: 200,
        data: { players: [
          { SteamId: SID_A, VACBanned: true, NumberOfVACBans: 1 },
          { SteamId: SID_B },
        ] },
      };
    };
    const res = await svc.checkBans(['a', 'b']);

    assert.equal(calls, 3, 'exactly 3 attempts (two transient 500s then success)');
    const a = res.accounts.find((x) => x.username === 'a')!;
    const b = res.accounts.find((x) => x.username === 'b')!;
    assert.equal(a.error, undefined, 'a must not be errored after a successful retry');
    assert.equal(a.vacBanned, true, 'a carries the fetched VAC ban');
    assert.equal(b.error, undefined, 'b must not be errored');
    assert.equal(res.totals.error, 0, 'the transient blips were absorbed — no errored accounts');
  });
});

test('H-TRD-036 (b): 403 key rejection → exactly 1 attempt, all accounts errored', async () => {
  const svc = makeService([acct('a', SID_A), acct('b', SID_B)]);
  await withOverrideKey(async () => {
    let calls = 0;
    (axios as { get: unknown }).get = async () => {
      calls++;
      return { status: 403, data: 'Forbidden' };
    };
    const res = await svc.checkBans(['a', 'b']);

    assert.equal(calls, 1, 'a rejected key is permanent — no retry');
    for (const x of res.accounts) {
      assert.match(x.error ?? '', /Steam rejected the Web API key/,
        `${x.username} must carry the key-rejection error`);
    }
    assert.equal(res.totals.error, 2, 'both accounts errored');
    assert.equal(res.totals.clean, 0, 'no account counted clean');
  });
});

test('H-TRD-036 (c): 200 with an HTML body → retried, error names the unexpected body (not "Steam HTTP 200")', async () => {
  const svc = makeService([acct('a', SID_A), acct('b', SID_B)]);
  await withOverrideKey(async () => {
    let calls = 0;
    (axios as { get: unknown }).get = async () => {
      calls++;
      return { status: 200, data: '<html><body>Sign in</body></html>' };
    };
    const res = await svc.checkBans(['a', 'b']);

    assert.equal(calls, 3, 'a malformed 200 is transient — retried to the attempt cap');
    for (const x of res.accounts) {
      assert.match(x.error ?? '', /unexpected body/,
        `${x.username} error must name the unexpected body`);
      assert.doesNotMatch(x.error ?? '', /Steam HTTP 200/,
        `${x.username} must NOT surface the nonsense "Steam HTTP 200"`);
    }
    assert.equal(res.totals.error, 2, 'both accounts errored after the final malformed body');
  });
});
