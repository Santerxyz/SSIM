import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasLiveSessionId } from '../src/trading/TradeService';
import type { ManagedSession } from '../src/types/session';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-008 — the money-op pre-flight freshness check must be FAIL-CLOSED (reuse
//  the canonical webCookiesFresh policy helper), NOT the old fail-open inline math.
//  An absent/corrupt `obtainedAt` is UNKNOWN age → treated as STALE (return false)
//  so ensureWebSession re-establishes the cookies, rather than trusted as "fresh"
//  and fired into the exact "no sessionid cookie – cannot place order" failure the
//  pre-flight exists to prevent.
// ─────────────────────────────────────────────────────────────────────────────

/** A session with a valid non-empty `sessionid` cookie, obtained at `obtainedAt`. */
function sessionWith(obtainedAt: unknown): ManagedSession {
  return {
    webSession: {
      sessionId: 'abc',
      cookies: ['sessionid=abc'],
      obtainedAt,
    },
  } as unknown as ManagedSession;
}

test('H-TRD-008: unknown obtainedAt with a valid sessionid cookie is STALE (fail-closed)', () => {
  assert.equal(hasLiveSessionId(sessionWith(undefined)), false);
});

test('H-TRD-008: a freshly-obtained sessionid cookie is live', () => {
  assert.equal(hasLiveSessionId(sessionWith(new Date())), true);
});

test('H-TRD-008: a long-stale sessionid cookie is not live', () => {
  assert.equal(hasLiveSessionId(sessionWith(new Date(Date.now() - 60 * 60 * 1000))), false);
});
