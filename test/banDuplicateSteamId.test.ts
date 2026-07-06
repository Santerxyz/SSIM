import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { BanService } from '../src/trading/BanService';
import type { AccountManager } from '../src/core/AccountManager';
import type { SessionManager } from '../src/core/SessionManager';
import type { TradeService } from '../src/trading/TradeService';
import type { AccountConfig } from '../src/types/account';

// ─── H-TRD-031: two accounts resolving to the SAME SteamID64 must not silently overwrite ──────
// each other in `bySteamId`. First-in wins; the duplicate is flagged with an actionable error and
// (critically) is NEVER reported as authoritatively `clean`. Uses the STEAM_WEB_API_KEY override
// path so no login/session stubbing is needed — both accounts carry a cached `steamId`, so
// resolveSteamId returns it offline and only fetchBans (axios) is exercised.

const SHARED_SID = '76561198000000001';

function acct(username: string): AccountConfig {
  return {
    id: username,
    username,
    password: 'x',
    maFilePath: `${username}.maFile`,
    environmentId: 'env-a',
    enabled: true,
    steamId: SHARED_SID, // both cached to the SAME id → the config anomaly this finding guards
  } as AccountConfig;
}

function makeService(accounts: AccountConfig[]): BanService {
  const byName = new Map(accounts.map((a) => [a.username.toLowerCase(), a]));
  const stubAccounts = {
    get: (u: string) => byName.get(u.toLowerCase()),
  } as unknown as AccountManager;
  // Never reached on the cached-steamId + override-key path, but present for shape.
  const stubSessions = {
    getSession: () => undefined,
    isLive: () => false,
    isReady: () => false,
  } as unknown as SessionManager;
  const stubTrades = {} as unknown as TradeService;
  return new BanService(stubAccounts, stubSessions, stubTrades);
}

test('H-TRD-031: duplicate SteamID64 → loser flagged (not overwritten), winner gets ban data, neither clean', async () => {
  const a = acct('winner');
  const b = acct('loser');
  const svc = makeService([a, b]);

  const origGet = axios.get;
  const origKey = process.env.STEAM_WEB_API_KEY;
  process.env.STEAM_WEB_API_KEY = 'OVERRIDEKEY';
  (axios as { get: unknown }).get = async () => ({
    status: 200,
    data: { players: [{ SteamId: SHARED_SID, VACBanned: true, NumberOfVACBans: 1 }] },
  });
  try {
    const res = await svc.checkBans(['winner', 'loser']);

    const winner = res.accounts.find((x) => x.username === 'winner')!;
    const loser  = res.accounts.find((x) => x.username === 'loser')!;

    // First-in wins: the winner carries the fetched ban data.
    assert.equal(winner.error, undefined, 'winner must not be errored');
    assert.equal(winner.vacBanned, true, 'winner must carry the fetched VAC ban');
    assert.deepEqual(winner.categories, ['vac']);

    // Loser is flagged as a duplicate — NOT silently overwritten, NOT reported clean.
    assert.match(loser.error ?? '', /Duplicate SteamID64/, 'loser must carry the duplicate-registration error');
    assert.deepEqual(loser.categories, [], 'loser must have no category buckets — NEVER "clean"');

    // Exactly one row carries the duplicate error, and the totals reflect it.
    const dupes = res.accounts.filter((x) => /Duplicate SteamID64/.test(x.error ?? ''));
    assert.equal(dupes.length, 1, 'exactly one row carries the duplicate error');
    assert.equal(res.totals.error, 1);
    assert.equal(res.totals.clean, 0, 'no account is counted clean');
    assert.equal(res.totals.vac, 1);
  } finally {
    (axios as { get: unknown }).get = origGet;
    if (origKey === undefined) delete process.env.STEAM_WEB_API_KEY;
    else process.env.STEAM_WEB_API_KEY = origKey;
  }
});
