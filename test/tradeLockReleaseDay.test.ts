import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractHoldDate, parseTradeLock, steamWallClock,
  MAX_YEARLESS_HOLD_DAYS, YEARLESS_PAST_GRACE_MS, STALE_HOLD_NOTE_MS, STEAM_TIME_ZONE,
} from '../src/core/InventoryManager';
import { bucketOf, isSellable } from '../src/core/MarketModel';

// ─────────────────────────────────────────────────────────────────────────────
//  Owner report 2026-08-11: "at a specific date it will start saying unknown,
//  mostly if it reached the same day of the release", with the live log line
//    trade-lock notice present but date unparseable
//    ("… transferred until 11 Aug @ 12:00pm") – treating item as locked (date unknown)
//
//  The note was never unparseable. Steam's short form omits the YEAR, so on release
//  day — once that clock time passes locally — the this-year candidate stops being
//  `> now`, only the yNow+1 roll-over survives, and the 30-day horizon guard (added
//  for the "222-day phantom lock") correctly rejects it. Result: null → "unknown".
//
//  These pin BOTH sides: the release-day note must resolve, and the months-old note
//  the horizon guard exists for must still be rejected.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds Steam's real short note naming the instant `offsetMs` from now — written the way STEAM
 * writes it, i.e. on Steam's own Pacific clock (the whole point of the fix below). Formatting the
 * note in the HOST's zone, as the first version of this file did, silently asserted the old
 * local-time reading and would keep passing while the live fleet stayed hours off.
 */
function noteAt(offsetMs: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: STEAM_TIME_ZONE, month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(Date.now() + offsetMs));
  const at = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return '⇆ This item is trade-protected and cannot be consumed, modified, or transferred until '
    + `${at('day')} ${at('month')} @ ${at('hour')}:${at('minute')}${at('dayPeriod').toLowerCase().replace(/\s/g, '')}`;
}

test('release-day note whose time has just passed resolves to that date, not "unknown"', () => {
  const threeHoursAgo = -3 * 3600 * 1000;
  const got = extractHoldDate(noteAt(threeHoursAgo));
  assert.ok(got, 'the note must parse — this is the reported "date unknown" case');
  // It resolves to roughly when it said, NOT to the same date a year later.
  const drift = Math.abs(got.getTime() - (Date.now() + threeHoursAgo));
  assert.ok(drift < 90_000, `expected ~3h ago, got ${got.toISOString()}`);
});

test('a year-less note still in the future keeps its normal countdown', () => {
  const inThreeHours = 3 * 3600 * 1000;
  const got = extractHoldDate(noteAt(inThreeHours));
  assert.ok(got && got.getTime() > Date.now(), 'a future hold must stay in the future');
});

test('the grace window does NOT resurrect the 222-day phantom lock', () => {
  // A note months in the past: outside the grace, and its next-year roll-over is beyond
  // the horizon — so it must still resolve to null and let `tradable` drive the state.
  const monthsAgo = -120 * 86_400_000;
  assert.equal(extractHoldDate(noteAt(monthsAgo)), null);
});

test('the grace window has a hard edge — just outside it is still rejected', () => {
  const justOutside = -(YEARLESS_PAST_GRACE_MS + 2 * 3600 * 1000);
  assert.equal(extractHoldDate(noteAt(justOutside)), null);
});

test('a note carrying an explicit YEAR always wins over the year-less grace', () => {
  const dated = extractHoldDate('Tradable After Aug 20, 2099 (07:00:00) GMT');
  assert.ok(dated, 'an explicit dated note must parse');
  assert.equal(dated.getUTCFullYear(), 2099);
});

test('a marker note that names no date is still not a hold', () => {
  // Steam stamps the same ⇆ marker on the market-listing note; treating it as a hold
  // once turned every listed item into "Locked (date unknown)".
  assert.equal(extractHoldDate('⇆ This item is listed on the Steam Community Market and cannot be consumed or modified.'), null);
});

test('the horizon guard constant is still the bound the grace reasons against', () => {
  // Guards the invariant the two windows share: the grace is for hours, the horizon for days.
  assert.ok(YEARLESS_PAST_GRACE_MS < MAX_YEARLESS_HOLD_DAYS * 86_400_000);
});

// ─────────────────────────────────────────────────────────────────────────────
//  THE SAFETY INVARIANT (regression, 2026-08-11 — introduced and caught same day).
//
//  Reading the short note's clock as LOCAL time made a still-held item come back
//  bucketOf:'tradable' / isSellable:true — SSIM would have tried to sell or deposit
//  an item Steam still holds. `tradable` does not save us: a trade-PROTECTED item is
//  reported as tradable:1 while the hold is live, so the parsed date is the only gate.
//
//  The note's timezone is not stated and is NOT ours (the same item's tooltip read
//  "11/08/2026, 19:00:00" for a note saying "11 Aug @ 12:00pm"), so an elapsed local
//  reading can never be treated as "released".
// ─────────────────────────────────────────────────────────────────────────────

/** Steam's real short note, with its (Pacific) clock set `hoursAgo` before now. */
function shortNoteHoursAgo(hoursAgo: number): string { return noteAt(-hoursAgo * 3600 * 1000); }

test('a still-held item is locked to the instant STEAM named, not a host-local reading of it', () => {
  // THE OWNER BUG (2026-08-12). Steam's item panel said the hold lifts at 11:00 local; SSIM showed
  // "14 h, 39 min". The note SSIM parses is the short form on STEAM's clock — 4:00am Pacific is that
  // same 11:00 — so reading it locally put the expiry 7h early, which then tripped the elapsed-note
  // branch and over-locked the item to the end of the day. Pin the instant, not the wall clock.
  const inNinetyMinutes = 90 * 60 * 1000;
  const desc = { tradable: 1, owner_descriptions: [{ value: noteAt(inNinetyMinutes) }] };
  const expiry = parseTradeLock(desc as never, true)!;
  const driftMs = Math.abs(expiry.getTime() - (Date.now() + inNinetyMinutes));
  assert.ok(driftMs < 90_000, `expected the countdown Steam stated (~90 min), got ${expiry.toISOString()}`);
  assert.equal(bucketOf({ tradable: true, tradeLockExpiry: expiry }), 'tradelocked');
});

test('steamWallClock reads a wall clock on Steam\'s timezone, not the host\'s', () => {
  // 12 Aug 2026 04:00 Pacific (PDT, -7) is 11:00 UTC — the exact pairing from the owner's screenshots.
  assert.equal(steamWallClock(2026, 8, 12, 4, 0), Date.UTC(2026, 7, 12, 11, 0));
  // …and it follows the DST switch rather than pinning one offset: January is PST (-8).
  assert.equal(steamWallClock(2026, 1, 12, 4, 0), Date.UTC(2026, 0, 12, 12, 0));
});

test('an elapsed short-form note NEVER makes a held item sellable inside the settle window', () => {
  // tradable:1 + an active ⇆ hold is Steam's real (self-contradictory) trade-protection shape, so the
  // parsed date is the only gate. Steam serves descriptions from a cache, so a note that outlives its
  // own instant by a few minutes must keep the item off every money path.
  const desc = { tradable: 1, owner_descriptions: [{ value: noteAt(-5 * 60 * 1000) }] };
  const expiry = parseTradeLock(desc as never, true);
  const item = { tradable: true, tradeLockExpiry: expiry };
  assert.equal(bucketOf(item), 'tradelocked', 'must stay locked while the note is still fresh');
  assert.equal(isSellable(item), false, 'a held item must never reach a money path');
});

test('the elapsed short-form hold settles a bounded window past the stated instant', () => {
  const statedAt = -5 * 60 * 1000;
  const desc = { tradable: 1, owner_descriptions: [{ value: noteAt(statedAt) }] };
  const expiry = parseTradeLock(desc as never, true)!;
  const overLock = expiry.getTime() - Date.now();
  assert.ok(overLock > 0, 'must still read as locked');
  assert.ok(overLock <= STALE_HOLD_NOTE_MS, `over-lock must be bounded by the settle window, got ${overLock}ms`);
  // Derived from the NOTE, never from the clock: two reads a second apart must agree, or every
  // refresh would re-key the stacks (InventoryManager.stack keys on this ISO string).
  assert.equal(parseTradeLock(desc as never, true)!.getTime(), expiry.getTime());
});

test('a note whose instant is long past is stale — it stops driving the lock', () => {
  // Steam drops the note when the hold really lifts, so one still standing hours later is a cache
  // artefact, not a live hold. It must not resurrect the multi-hour phantom countdown.
  const desc = { tradable: 1, owner_descriptions: [{ value: shortNoteHoursAgo(3) }] };
  assert.equal(parseTradeLock(desc as never, true), null);
});

test('a stale note on a NON-tradable item still leaves it off every money path', () => {
  // The note stops deciding, but `tradable` takes over — the fail-safe every other path relies on.
  const desc = { tradable: 0, owner_descriptions: [{ value: shortNoteHoursAgo(3) }] };
  const expiry = parseTradeLock(desc as never, false);
  assert.equal(isSellable({ tradable: false, tradeLockExpiry: expiry }), false);
});

test('an elapsed note never masks a SECOND note that is an unreadable hold', () => {
  // The elapsed branch used to return outright; a genuinely unparseable hold sitting after it in the
  // same description list would have lost its fail-closed sentinel.
  const desc = {
    tradable: 1,
    owner_descriptions: [
      { value: shortNoteHoursAgo(3) },
      { value: '⇆ Tradable After …' },   // states a "when", names no readable date
    ],
  };
  const expiry = parseTradeLock(desc as never, true);
  assert.ok(expiry, 'the unreadable hold must still fail closed');
  assert.equal(isSellable({ tradable: true, tradeLockExpiry: expiry }), false);
});

test('the LONG form Steam also sends parses to its exact stated instant', () => {
  // "⇆ … until 11/08/2026, 19:00:00" — day-first with a full year and time. This is the shape
  // that yields a real countdown; the short-form handling above is only the fallback.
  const y = new Date().getFullYear() + 1;
  const desc = { tradable: 1, owner_descriptions: [{ value: `⇆ This item is trade-protected and cannot be consumed, modified, or transferred until 11/08/${y}, 19:00:00` }] };
  const expiry = parseTradeLock(desc as never, true)!;
  assert.equal(expiry.getDate(), 11);
  assert.equal(expiry.getMonth(), 7);      // August (0-indexed) — day-first, NOT 8 November
  assert.equal(expiry.getHours(), 19);
  assert.equal(bucketOf({ tradable: true, tradeLockExpiry: expiry }), 'tradelocked');
});
