import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AccountImportService } from '../src/core/AccountImportService';
import type { AccountManager } from '../src/core/AccountManager';
import type { SessionManager } from '../src/core/SessionManager';

// ════════════════════════════════════════════════════════════════════════════
//  H-ACC-049 — getStatus()/cancel() must prune on the read path. Code guards
//  (EmailCode/DeviceCode) never start library polling until a code is submitted,
//  so the 'timeout' event never fires and nothing moves an abandoned rec off
//  'guard'. With expiry evaluated on read, the frontend's status poll flips a
//  past-deadline session to 'expired' on time and frees its capacity slot —
//  without depending on some LATER import running prune().
// ════════════════════════════════════════════════════════════════════════════

/** A LoginSession stand-in: bare EventEmitter + a no-op cancelLoginAttempt. */
function fakeSession(): EventEmitter & { cancelLoginAttempt(): void } {
  const em = new EventEmitter() as EventEmitter & { cancelLoginAttempt(): void };
  em.cancelLoginAttempt = () => {};
  return em;
}

function makeService() {
  const sessions = { rememberRefreshToken: () => true } as unknown as SessionManager;
  const accounts = { get: () => undefined, add: () => {}, rememberSteamId: () => {} } as unknown as AccountManager;
  return new AccountImportService(accounts, sessions);
}

test('H-ACC-049: getStatus() flips a past-deadline guard session to expired without a later import', () => {
  const svc = makeService();
  const session = fakeSession();
  // An abandoned code guard: no polling ever ran, so no 'timeout' event will fire.
  const rec = {
    id: 'prune-001', method: 'credentials', state: 'guard', session,
    createdAt: Date.now() - 200_000, expiresAt: Date.now() - 1_000,
  } as any;
  (svc as any).active.set(rec.id, rec);

  const st = svc.getStatus(rec.id);

  assert.equal(st?.state, 'expired', 'a past-deadline guard must report expired on read, not stay guard');
  assert.ok(rec.finishedAt, 'hard-expiry must stamp finishedAt so the slot stops counting toward capacity');
});

test('H-ACC-049: getStatus() leaves a still-live guard session untouched', () => {
  const svc = makeService();
  const session = fakeSession();
  const rec = {
    id: 'prune-002', method: 'credentials', state: 'guard', session,
    createdAt: Date.now(), expiresAt: Date.now() + 120_000,
  } as any;
  (svc as any).active.set(rec.id, rec);

  const st = svc.getStatus(rec.id);

  assert.equal(st?.state, 'guard', 'a within-deadline guard must keep reporting guard');
  assert.equal(rec.finishedAt, undefined, 'a live guard must not be finished early');
});
