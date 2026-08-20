import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/core/SessionManager';
import { SessionState } from '../src/types/session';

// ════════════════════════════════════════════════════════════════════════════════════════════════
//  1.5.1 — owner report: "changing Proxy to Local or Local to Proxy requires a restart in some jobs".
//
//  A ManagedSession pins its egress at login — the SteamUser client and the httpsAgent are built from
//  the network resolved at that moment and cannot be re-pointed. Proxy-rule edits are applied lazily
//  ("changes take effect on each account's NEXT login"), which was fine for an idle fleet but wrong
//  for every session-REUSING path: InventoryService.ensureSession, TradeService.getTrader and
//  ensureWebSession kept handing back the session that had logged in over the RETIRED exit, so the
//  only way to move a running job onto the new egress was to restart SSIM.
//
//  SessionManager.isEgressStale is the predicate those sites now consult. These tests pin its
//  contract — including every case where it must answer "not stale", because a false positive forces
//  a needless re-login on every single operation.
// ════════════════════════════════════════════════════════════════════════════════════════════════

type Net = { type: 'proxy' | 'localip'; value: string } | undefined;

/** A SessionManager with one resident session whose login-time egress is `pinned`. */
function managerWith(pinned: Net, peek: (u: string) => Net): SessionManager {
  const sm = new SessionManager();
  (sm as unknown as { sessions: Map<string, unknown> }).sessions.set('bot', {
    account: { username: 'bot', network: pinned },
    state: SessionState.LOGGED_IN,
  });
  sm.setEgressPeekResolver(peek);
  return sm;
}

const LOCAL: Net = { type: 'localip', value: '0.0.0.0' };
const PROXY: Net = { type: 'proxy', value: 'http://u:p@1.2.3.4:8080' };

test('H-PRX-020: local → proxy is STALE (the reported direction)', () => {
  const sm = managerWith(LOCAL, () => PROXY);
  assert.equal(sm.isEgressStale('bot'), true);
  sm.shutdown();
});

test('H-PRX-021: proxy → local is STALE (the other reported direction)', () => {
  const sm = managerWith(PROXY, () => LOCAL);
  assert.equal(sm.isEgressStale('bot'), true);
  sm.shutdown();
});

test('H-PRX-022: a different proxy in the same pool is STALE', () => {
  const sm = managerWith(PROXY, () => ({ type: 'proxy', value: 'http://u:p@9.9.9.9:8080' }));
  assert.equal(sm.isEgressStale('bot'), true);
  sm.shutdown();
});

test('H-PRX-023: same host:port but ROTATED credentials is STALE — a different identity to Steam', () => {
  const sm = managerWith(PROXY, () => ({ type: 'proxy', value: 'http://u:newpass@1.2.3.4:8080' }));
  assert.equal(sm.isEgressStale('bot'), true);
  sm.shutdown();
});

test('H-PRX-024: an unchanged proxy is NOT stale, even written in a different (non-normalized) form', () => {
  // normalizeProxy folds the legacy host:port:user:pass form onto the URL form — the same exit
  // written two ways must not read as a change, or every op would pay a pointless re-login.
  const sm = managerWith(PROXY, () => ({ type: 'proxy', value: '1.2.3.4:8080:u:p' }));
  assert.equal(sm.isEgressStale('bot'), false);
  sm.shutdown();
});

test('H-PRX-025: unchanged local IP is NOT stale', () => {
  const sm = managerWith(LOCAL, () => LOCAL);
  assert.equal(sm.isEgressStale('bot'), false);
  sm.shutdown();
});

test('H-PRX-026: pool-lost (peek returns undefined) is NOT stale — performLogin owns that refusal', () => {
  // Forcing a re-login here would convert a fail-closed login refusal into a hard error thrown
  // in the middle of an unrelated job. Leave the decision where it already lives.
  const sm = managerWith(PROXY, () => undefined);
  assert.equal(sm.isEgressStale('bot'), false);
  sm.shutdown();
});

test('H-PRX-027: unknowable cases answer NOT stale (no resolver, no session, no pinned network)', () => {
  const noResolver = new SessionManager();
  (noResolver as unknown as { sessions: Map<string, unknown> }).sessions.set('bot', {
    account: { username: 'bot', network: LOCAL }, state: SessionState.LOGGED_IN,
  });
  assert.equal(noResolver.isEgressStale('bot'), false, 'no peek resolver wired → unchanged behaviour');
  noResolver.shutdown();

  const noSession = new SessionManager();
  noSession.setEgressPeekResolver(() => PROXY);
  assert.equal(noSession.isEgressStale('ghost'), false, 'nothing resident to be stale');
  noSession.shutdown();

  const noPinned = managerWith(undefined, () => PROXY);
  assert.equal(noPinned.isEgressStale('bot'), false, 'a session with no pinned network cannot be compared');
  noPinned.shutdown();
});

test('H-PRX-028: a peek resolver that THROWS never breaks the op — answers not stale', () => {
  const sm = managerWith(PROXY, () => { throw new Error('vault locked'); });
  assert.equal(sm.isEgressStale('bot'), false);
  sm.shutdown();
});

test('H-PRX-029: the lookup is case-insensitive (sessions are keyed lowercase)', () => {
  const sm = managerWith(LOCAL, () => PROXY);
  assert.equal(sm.isEgressStale('BOT'), true);
  sm.shutdown();
});
