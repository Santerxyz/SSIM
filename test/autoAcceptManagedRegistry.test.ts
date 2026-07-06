import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TradeService } from '../src/trading/TradeService';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-017 — isManagedSteamId must consult the PERSISTENT SteamID registry,
//  not just live sessions. Mass-send releases every sender session immediately
//  after the last offer (and the idle reaper releases the rest), so a late /
//  unconfirmed internal offer arrives with ZERO matching sessions — the guard
//  used to return false and auto-accept skipped it as "EXTERNAL" forever.
//  accounts.getAll() (accounts.json, written through on every login) is the
//  authoritative registry; the union closes the miss window.
//  isManagedSteamId only reads this.sessions + this.accounts, so Object.create +
//  stubbed collaborators exercises the exact shipped logic.
// ─────────────────────────────────────────────────────────────────────────────

function svc(sessions: Array<{ steamId?: string }>, accounts: Array<{ steamId?: string }>): any {
  const s: any = Object.create(TradeService.prototype);
  s.sessions = { getAllSessions: () => sessions };
  s.accounts = { getAll: () => accounts };
  return s;
}

test('H-TRD-017: managed via the persistent registry even with ZERO live sessions', () => {
  const s = svc([], [{ steamId: '76561198000000001' }]);
  assert.equal(s.isManagedSteamId('76561198000000001'), true,
    'the sender was released post-mass-send but is still one of our accounts');
});

test('H-TRD-017: an unknown SteamID is EXTERNAL', () => {
  const s = svc([], [{ steamId: '76561198000000001' }]);
  assert.equal(s.isManagedSteamId('76561190000000000'), false);
});

test('H-TRD-017: a live session still classifies as managed (sessions checked first)', () => {
  const s = svc([{ steamId: '76561198000000002' }], []);
  assert.equal(s.isManagedSteamId('76561198000000002'), true);
});

test('H-TRD-017: managedSteamIds() unions sessions + registry, deduped', () => {
  const s = svc(
    [{ steamId: '76561198000000001' }, { steamId: undefined }],
    [{ steamId: '76561198000000001' }, { steamId: '76561198000000003' }],
  );
  const ids = s.managedSteamIds().sort();
  assert.deepEqual(ids, ['76561198000000001', '76561198000000003'],
    'the shared id appears once; the undefined session steamId is dropped');
});
