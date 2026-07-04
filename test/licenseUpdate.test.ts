import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextClockMeta, offlineGraceDecision } from '../src/licensing/licenseClock';
import { buildSwapScript } from '../src/licensing/Updater';

const GRACE = 72 * 3600_000;
const SKEW  = 5 * 60_000;

// C13 / INV-G2 — the clock anchor must never advance from the local clock.
test('nextClockMeta: anchors advance ONLY on server-confirmed contact (no local-clock poisoning)', () => {
  const prev = { lastOnlineMs: 1000, maxSeenMs: 1000 };
  // Offline boot with a FORWARD-jumped local clock must NOT advance the anchor.
  assert.deepEqual(nextClockMeta(prev, 9_999_999, false), prev);
  // A server-confirmed contact advances both.
  assert.deepEqual(nextClockMeta(prev, 5000, true), { lastOnlineMs: 5000, maxSeenMs: 5000 });
});

test('offlineGraceDecision: a non-poisoned anchor still grants grace after the clock returns to true time', () => {
  const meta = { lastOnlineMs: 1_000_000, maxSeenMs: 1_000_000 }; // maxSeen == lastOnline (never poisoned)
  const trueNow = 1_000_000 + 3600_000;                            // 1h later, within grace
  assert.equal(offlineGraceDecision(trueNow, meta, GRACE, SKEW), 'within-grace');
  // Demonstrates the OLD bug: a forward jump had poisoned maxSeenMs into the future →
  const poisoned = { lastOnlineMs: 1_000_000, maxSeenMs: 9_999_999_999 };
  assert.equal(offlineGraceDecision(trueNow, poisoned, GRACE, SKEW), 'rollback-refused');
  assert.equal(offlineGraceDecision(trueNow, undefined, GRACE, SKEW), 'no-meta');
});

// S26 — markOnline now anchors maxSeenMs to the SERVER's time, not the local clock, so a forward-wrong
// clock WHILE ONLINE can't poison the high-water mark and later refuse offline grace after correction.
test('S26: anchoring to the SERVER time (not a forward-wrong local clock) keeps offline grace valid', () => {
  const REAL = 1_700_000_000_000;                          // real "now"
  const FORWARD_WRONG = REAL + 5 * 365 * 24 * 3600_000;    // the local clock, ~5 years ahead, while online

  // OLD: markOnline(Date.now()) anchored to the forward-wrong LOCAL clock → maxSeenMs is in the future.
  const poisoned = nextClockMeta(undefined, FORWARD_WRONG, true);
  assert.equal(offlineGraceDecision(REAL, poisoned, GRACE, SKEW), 'rollback-refused',
    'the OLD local-clock anchor locks out the user once the clock is corrected');

  // NEW (S26): markOnline(res.data.serverTime) anchors to the ACCURATE server time.
  const healthy = nextClockMeta(undefined, REAL, true);
  assert.notEqual(offlineGraceDecision(REAL, healthy, GRACE, SKEW), 'rollback-refused',
    'the server-time anchor never poisons the high-water mark, so a corrected clock still gets grace');
});

// C14 / INV-G3 — the orphan-delete must run ONLY after a confirmed successful swap.
test('buildSwapScript: orphan-delete gated on swap success (no brick on a failed move)', () => {
  const s = buildSwapScript({
    tmp: 'NEW.exe', target: 'SHELL.exe', relaunch: 'SHELL.exe',
    backendPid: 1, deletePaths: ['BACKEND.exe'], vbsPath: 'u.vbs',
  });
  assert.ok(s.includes('&& goto swapped'), 'a successful move jumps to the swapped label');
  const gotoFail = s.indexOf('goto swapfail');
  const swapped  = s.indexOf(':swapped');
  const del      = s.indexOf('del /F /Q "BACKEND.exe"');
  const failLbl  = s.indexOf(':swapfail');
  assert.ok(gotoFail >= 0 && gotoFail < swapped, 'an exhausted (failed) swap jumps PAST the delete');
  assert.ok(swapped < del && del < failLbl, 'the orphan-delete sits strictly between :swapped and :swapfail');
});
