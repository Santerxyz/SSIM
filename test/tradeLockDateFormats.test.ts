import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractHoldDate, MAX_YEARLESS_HOLD_DAYS } from '../src/core/InventoryManager';

// ─────────────────────────────────────────────────────────────────────────────
//  v1.4.3 issue 1 — the trade-protection hold note ("…cannot be transferred until
//  <date>") shows "date unknown" because its date shape defeats extractHoldDate.
//  English ORDINAL days ("17th") are the most likely culprit; stripping them lets
//  the existing worded-month/English branches bind the day. (Also: the widened
//  diagnostic log in parseTradeLock now reveals the true format for any residual case.)
// ─────────────────────────────────────────────────────────────────────────────

test('extractHoldDate: an ordinal day ("17th") parses IDENTICALLY to the bare day ("17")', () => {
  const pairs: Array<[string, string]> = [
    ['This item is trade-protected and cannot be transferred until July 17th, 2030 (07:00:00) GMT',
     'This item is trade-protected and cannot be transferred until July 17, 2030 (07:00:00) GMT'],
    ['cannot be transferred until 17th July 2030', 'cannot be transferred until 17 July 2030'],
    ['Tradable After Dec 1st, 2030 (07:00:00) GMT', 'Tradable After Dec 1, 2030 (07:00:00) GMT'],
    ['the 23rd of August 2030', 'the 23 of August 2030'],
  ];
  for (const [ordinal, plain] of pairs) {
    const a = extractHoldDate(ordinal);
    const b = extractHoldDate(plain);
    assert.ok(a instanceof Date, `ordinal form must now parse: ${ordinal}`);
    assert.ok(b instanceof Date, `control form must parse: ${plain}`);
    assert.equal(a.getTime(), b.getTime(), `ordinal must equal the bare-day form: ${ordinal}`);
  }
});

// A year-less note is only meaningful RELATIVE TO NOW, so these fixtures are generated from the clock
// rather than hardcoded to a calendar date. (The original fixtures said "17 Jul"; once the real 17 July
// passed they silently flipped from "near-future hold" to "expired note" — the exact confusion that
// produced the 222-day phantom lock below.)
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A date `days` from now, at 14:00 local, as the parts Steam's year-less note would carry. */
function relDate(days: number): { d: Date; day: number; mon: string } {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(14, 0, 0, 0);
  return { d, day: d.getDate(), mon: MON[d.getMonth()] };
}

test('extractHoldDate: the REAL year-less trade-protection format ("D Mon @ h:mmpm") parses (v1.4.3/4 fix)', () => {
  // Shape captured live via the widened log — this is the note that showed "date unknown".
  const { d: want, day, mon } = relDate(5);            // a genuine hold: a few days out
  const d = extractHoldDate(`⇆ This item is trade-protected and cannot be consumed, modified, or transferred until ${day} ${mon} @ 2:00pm`);
  assert.ok(d instanceof Date, 'the year-less "D Mon @ h:mm am/pm" form must parse');
  assert.equal(d.getMonth(), want.getMonth());
  assert.equal(d.getDate(), day);
  assert.equal(d.getHours(), 14, '2:00pm → 14:00 local');
  assert.ok(d.getTime() > Date.now(), 'the hold is a FUTURE date (year inferred as the nearest future)');
});

test('extractHoldDate: year-less variants — month-first, am/pm, midnight rollover', () => {
  const a = relDate(6);
  const pm = extractHoldDate(`until ${a.mon} ${a.day} @ 2:00 PM`);   // month-first
  assert.ok(pm && pm.getMonth() === a.d.getMonth() && pm.getDate() === a.day && pm.getHours() === 14, 'month-first pm');

  const b = relDate(9);
  const am = extractHoldDate(`until ${b.day} ${b.mon} @ 11:30am`);
  assert.ok(am && am.getMonth() === b.d.getMonth() && am.getDate() === b.day && am.getHours() === 11 && am.getMinutes() === 30, 'am');

  const c = relDate(11);
  const mid = extractHoldDate(`transferred until ${c.day} ${c.mon} @ 12:00am`);
  assert.ok(mid && mid.getMonth() === c.d.getMonth() && mid.getDate() === c.day && mid.getHours() === 0, '12:00am → 00:00');
});

test('extractHoldDate: an EXPIRED year-less note is NOT rolled into next year (owner bug: "Storage Unit locked 222 days")', () => {
  // THE REGRESSION. A year-less note whose date already passed THIS year (e.g. a hold that expired in
  // March, read in July) used to fall through to yNow+1 and surface as a ~222-day phantom trade lock on
  // items that are merely non-tradable (Storage Units). An expired hold is not a hold.
  const past = new Date();
  past.setDate(past.getDate() - 60);                   // safely in the past, same calendar year or earlier
  const note = `⇆ This item is trade-protected and cannot be consumed, modified, or transferred until ${past.getDate()} ${MON[past.getMonth()]} @ 2:00pm`;
  assert.equal(extractHoldDate(note), null, 'an expired year-less hold must yield null, not next year');
});

test('extractHoldDate: a year-less date beyond the plausible hold horizon is rejected', () => {
  // Steam's longest hold is 15 days. A year-less date months out is flavour text or an expired note —
  // never a live hold — so it must not become a countdown.
  const far = relDate(200);
  assert.equal(
    extractHoldDate(`Container opened ${far.day} ${far.mon} @ 3:00pm`),
    null,
    `a year-less date ~200 days out must be rejected (>${MAX_YEARLESS_HOLD_DAYS}d horizon)`,
  );
  // …while a date just inside the horizon still parses.
  const near = relDate(10);
  assert.ok(extractHoldDate(`transferred until ${near.day} ${near.mon} @ 3:00pm`), 'a 10-day hold is still honoured');
});

test('extractHoldDate: the year-less fallback NEVER overrides a real dated note', () => {
  // A note carrying BOTH a full date and an @-time must resolve to the full (year-bearing) date.
  const d = extractHoldDate('Tradable After Dec 25, 2030 (07:00:00) GMT — also 17 Jul @ 2:00pm');
  assert.ok(d && d.getFullYear() === 2030 && d.getMonth() === 11 && d.getDate() === 25, 'the dated form wins over the year-less one');
});

test('extractHoldDate: existing formats still parse (no regression from ordinal stripping)', () => {
  assert.ok(extractHoldDate('until Jul 17, 2030 (07:00:00) GMT'), 'English month-name');
  assert.ok(extractHoldDate('kann bis 17.7.2030, 14:00:00'), 'German dotted');
  assert.ok(extractHoldDate('2030-07-17'), 'ISO');
  assert.ok(extractHoldDate('16 июля 2030 г.'), 'Russian worded');
});

test('extractHoldDate: a dateless note yields null (no false lock, no ordinal false-positive)', () => {
  assert.equal(
    extractHoldDate('This item is listed on the Steam Community Market and cannot be consumed or modified.'),
    null,
    'a note that names no moment must not produce a date',
  );
  assert.equal(extractHoldDate('trade-protected and cannot be transferred'), null, 'no date → null');
});
