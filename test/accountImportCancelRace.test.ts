import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AccountImportService } from '../src/core/AccountImportService';
import type { AccountManager } from '../src/core/AccountManager';
import type { SessionManager } from '../src/core/SessionManager';

// ════════════════════════════════════════════════════════════════════════════
//  H-ACC-050 — cancel() must be terminal. steam-session emits 'authenticated'
//  AFTER its network poll await with no post-await cancel re-check, so a phone
//  approval that lands the instant the user cancels would otherwise run the
//  'authenticated' handler on a rec already removed from `active`, persisting the
//  refresh token and creating the LIMITED account. The handler now bails on a
//  finished/absent rec, so a cancelled import never finalizes anything.
// ════════════════════════════════════════════════════════════════════════════

/** A LoginSession stand-in: bare EventEmitter + a no-op cancelLoginAttempt. */
function fakeSession(): EventEmitter & { cancelLoginAttempt(): void; accountName: string; refreshToken: string } {
  const em = new EventEmitter() as EventEmitter & {
    cancelLoginAttempt(): void; accountName: string; refreshToken: string;
  };
  em.cancelLoginAttempt = () => {};
  em.accountName = 'bob';
  em.refreshToken = 'tok';
  return em;
}

test('H-ACC-050: authenticated firing after cancel() neither persists a token nor creates an account', () => {
  let rememberCalls = 0;
  let addCalls = 0;
  const sessions = { rememberRefreshToken: () => { rememberCalls++; return true; } } as unknown as SessionManager;
  const accounts = {
    get: () => undefined,
    add: () => { addCalls++; },
    rememberSteamId: () => {},
  } as unknown as AccountManager;

  const svc = new AccountImportService(accounts, sessions);
  const session = fakeSession();
  const rec = { id: 'race-0001', method: 'qr', state: 'waiting', session } as any;

  (svc as any).wireEvents(rec);
  (svc as any).active.set(rec.id, rec);

  svc.cancel(rec.id);
  // The poll response lands after the user cancelled — steam-session emits regardless.
  session.emit('authenticated');

  assert.equal(rememberCalls, 0, 'a cancelled import must not persist a refresh token');
  assert.equal(addCalls, 0, 'a cancelled import must not create an account');
  assert.equal(rec.state, 'error', 'cancel() must leave the rec in a terminal state');
  assert.ok(rec.finishedAt, 'cancel() must stamp finishedAt so the handlers observe the terminal state');
});

test('H-ACC-050: a late error event does not overwrite an already-imported terminal state', () => {
  const sessions = { rememberRefreshToken: () => true } as unknown as SessionManager;
  const accounts = { get: () => undefined, add: () => {}, rememberSteamId: () => {} } as unknown as AccountManager;

  const svc = new AccountImportService(accounts, sessions);
  const session = fakeSession();
  const rec = { id: 'race-0002', method: 'qr', state: 'imported', finishedAt: Date.now() } as any;
  rec.session = session;

  (svc as any).wireEvents(rec);
  (svc as any).active.set(rec.id, rec);

  session.emit('error', new Error('late poll error'));

  assert.equal(rec.state, 'imported', 'a late error must not clobber the terminal imported state');
});

test('H-ACC-050: authenticated on a live, unfinished rec still finalizes (happy path untouched)', () => {
  let rememberCalls = 0;
  let addCalls = 0;
  const sessions = { rememberRefreshToken: () => { rememberCalls++; return true; } } as unknown as SessionManager;
  const accounts = {
    get: () => undefined,
    add: () => { addCalls++; },
    rememberSteamId: () => {},
  } as unknown as AccountManager;

  const svc = new AccountImportService(accounts, sessions);
  const session = fakeSession();
  const rec = { id: 'race-0003', method: 'qr', state: 'waiting', environmentId: 'e1', session } as any;

  (svc as any).wireEvents(rec);
  (svc as any).active.set(rec.id, rec);

  session.emit('authenticated');

  assert.equal(rememberCalls, 1, 'a live import still persists its token');
  assert.equal(addCalls, 1, 'a live import still creates the account');
  assert.equal(rec.state, 'imported');
});
