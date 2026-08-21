import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketEligibility } from '../src/trading/BuyService';

// ════════════════════════════════════════════════════════════════════════════════════════════════
//  1.5.1 — owner report: buy orders fill on most accounts but never on donaldjohnston02, "even
//  though they are the same".
//
//  They were not the same, and the log proves it arithmetically rather than by suspicion. Steam
//  HOLDS the wallet funds behind a resting buy order. That account was accepted for two orders,
//  1.99 and 2.00 EUR, against a 3.02 EUR wallet:
//
//      createbuyorder ... total=199 → 406/22 → confirm → re-POST → 200 success=1   filled=0
//      createbuyorder ... total=200 → 200 success=1                                filled=0
//      wallet balance 3.02  ...  wallet balance 3.02      (never moved)
//
//  Two resting orders totalling 3.99 cannot both be held against 3.02 — the second would have been
//  refused for insufficient funds. Both were accepted and the balance never changed, so NEITHER
//  order ever existed. Steam took the POST and created nothing.
//
//  The reason it does that is `ClientIsLimitedAccount`: a LIMITED account (one that has never spent
//  the ~$5 Steam requires) cannot use the Community Market, and createbuyorder does not report it —
//  it answers success:1, names no order, holds no funds, fills nothing. steam-user has carried the
//  flag on every session all along; SSIM simply never read it. Compare lilycepeda93, wallet ~127
//  EUR, which filled 10 keys at a LOWER price (197) in the same log.
//
//  So the fix is a gate, not a retry: refuse honestly before ordering instead of reporting a placed,
//  confirmed order that does not exist. The most dangerous case here is the UNKNOWN one — blocking a
//  legitimate buy because the CM has not sent the message yet would be a worse bug than the one
//  being fixed.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('H-BUY-090: a LIMITED account is refused, and the reason says how to fix it', () => {
  const r = marketEligibility({ limited: true, communityBanned: false, locked: false });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /LIMITED/);
  assert.match((r as { reason: string }).reason, /\$5/, 'the operator is told what actually lifts it');
});

test('H-BUY-091: unknown limitations NEVER refuse — a missing message must not block a real buy', () => {
  // The CM pushes ClientIsLimitedAccount shortly after login; a buy issued before it lands has no
  // verdict yet. Refusing on absence would break every account whose message is merely late, which
  // is a far bigger failure than the one this gate exists to catch.
  assert.equal(marketEligibility(null).ok, true);
  assert.equal(marketEligibility(undefined).ok, true);
  assert.equal(marketEligibility({}).ok, true, 'an empty object is no verdict either');
});

test('H-BUY-092: a healthy account passes untouched', () => {
  assert.equal(marketEligibility({ limited: false, communityBanned: false, locked: false }).ok, true);
});

test('H-BUY-093: locked and community-banned accounts are refused with their own reason', () => {
  const locked = marketEligibility({ locked: true });
  assert.equal(locked.ok, false);
  assert.match((locked as { reason: string }).reason, /LOCKED/);

  const banned = marketEligibility({ communityBanned: true });
  assert.equal(banned.ok, false);
  assert.match((banned as { reason: string }).reason, /COMMUNITY BANNED/);
});

test('H-BUY-094: a locked account reports LOCKED even when several flags are set', () => {
  // Ordering matters only for the message, but the message is what the operator acts on: "locked"
  // and "limited" need completely different responses, and the harder stop should win.
  const r = marketEligibility({ limited: true, communityBanned: true, locked: true });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /LOCKED/);
});
