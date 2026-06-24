import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webCookiesFresh, ownsCreatedSession, WEB_COOKIE_MAX_AGE_MS } from '../src/core/sessionHealth';

// C16 / INV-A5 — "ready" must mean cookies are still fresh, not merely present.
test('webCookiesFresh: fresh within the window, stale beyond it', () => {
  const now = 1_700_000_000_000;
  assert.equal(webCookiesFresh(new Date(now - 5 * 60_000), now), true);   // 5 min old → fresh
  assert.equal(webCookiesFresh(new Date(now - (WEB_COOKIE_MAX_AGE_MS + 60_000)), now), false); // beyond window → stale
  assert.equal(webCookiesFresh(undefined, now), false);                   // no cookies → not ready
  assert.equal(webCookiesFresh('not-a-date', now), false);                // corrupt → not ready
});

// C17 / INV-A6 — a bulk op may release only a session its own call originated.
test('ownsCreatedSession: only the originating call owns the session', () => {
  assert.equal(ownsCreatedSession(false, false), true);  // no in-flight login, no existing session → we created it
  assert.equal(ownsCreatedSession(true,  false), false); // coalesced onto another login → not ours
  assert.equal(ownsCreatedSession(false, true),  false); // reused/replaced an existing session → not ours
  assert.equal(ownsCreatedSession(true,  true),  false);
});
