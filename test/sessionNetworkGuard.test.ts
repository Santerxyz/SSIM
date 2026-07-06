import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/core/SessionManager';

// ════════════════════════════════════════════════════════════════════════════
//  H-ACC-003 — performLogin used to substitute a host-IP binding
//  ({ type:'localip', value:'0.0.0.0' }) when `account.network` was undefined and
//  proceeded to log in from the operator's real IP — fail-open on the farm's core
//  proxy-isolation property. AccountManager.withNetwork attaches a resolved network
//  on every query path, so a missing `network` means a caller hand-built the config
//  and bypassed that layer. performLogin now REFUSES: throws a 'connection'-classified,
//  ceilingRefusal error (token PRESERVED, single attempt, no backoff) BEFORE building
//  the SteamUser client or agent. Mirrors the server.ts open-browser host-IP refusal.
// ════════════════════════════════════════════════════════════════════════════

test('H-ACC-003: loginAccount refuses a config with no resolved network (no fail-open to host IP)', async () => {
  const sm = new SessionManager();

  // Route doLoginAccount into performLogin via the token path without touching disk:
  // a stubbed store that hands back a token and records whether delete() is ever called.
  let deleted = false;
  (sm as unknown as { tokenStore: unknown }).tokenStore = {
    get: () => 'stored-refresh-token',
    delete: () => { deleted = true; return true; },
    set: () => true,
    isDegraded: () => false,
  };

  // Do NOT read a maFile from disk for this account.
  (sm as unknown as { tryLoadMaFile: () => undefined }).tryLoadMaFile = () => undefined;

  const account = { username: 'noNetworkBot', network: undefined } as unknown as Parameters<
    SessionManager['loginAccount']
  >[0];

  let caught: (Error & { ceilingRefusal?: boolean; loginErrorKind?: string }) | undefined;
  await assert.rejects(
    () => sm.loginAccount(account),
    (err: Error & { ceilingRefusal?: boolean; loginErrorKind?: string }) => {
      caught = err;
      return /no resolved network/.test(err.message);
    },
  );

  assert.equal(caught?.ceilingRefusal, true, 'refusal is a single-attempt ceiling-class error (no in-slot retry/backoff)');
  assert.equal(caught?.loginErrorKind, 'connection', "classified 'connection' so the refresh token is preserved");
  assert.equal(deleted, false, 'the stored refresh token is left untouched (never deleted)');
  assert.equal(
    (sm as unknown as { sessions: Map<string, unknown> }).sessions.size,
    0,
    'no session is parked in the map — the throw fires before insertion',
  );

  sm.shutdown();
});
