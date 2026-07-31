import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractHoldDate } from '../src/core/InventoryManager';

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

test('extractHoldDate: the REAL year-less trade-protection format ("17 Jul @ 2:00pm") parses (v1.4.3/4 fix)', () => {
  // Captured live via the widened log — this is the exact note that showed "date unknown".
  const d = extractHoldDate('⇆ This item is trade-protected and cannot be consumed, modified, or transferred until 17 Jul @ 2:00pm');
  assert.ok(d instanceof Date, 'the year-less "D Mon @ h:mm am/pm" form must parse');
  assert.equal(d.getMonth(), 6, 'July');
  assert.equal(d.getDate(), 17);
  assert.equal(d.getHours(), 14, '2:00pm → 14:00 local');
  assert.ok(d.getTime() > Date.now(), 'the hold is a FUTURE date (year inferred as the nearest future)');
});

test('extractHoldDate: year-less variants — month-first, am/pm, midnight rollover', () => {
  const pm = extractHoldDate('until Jul 17 @ 2:00 PM');            // month-first
  assert.ok(pm && pm.getMonth() === 6 && pm.getDate() === 17 && pm.getHours() === 14, 'month-first pm');
  const am = extractHoldDate('until 3 Aug @ 11:30am');
  assert.ok(am && am.getMonth() === 7 && am.getDate() === 3 && am.getHours() === 11 && am.getMinutes() === 30, 'am');
  const mid = extractHoldDate('transferred until 1 Jan @ 12:00am');
  assert.ok(mid && mid.getMonth() === 0 && mid.getDate() === 1 && mid.getHours() === 0, '12:00am → 00:00, year rolls to next');
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
