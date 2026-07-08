import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTradeLock, TRADE_LOCK_DATE_UNKNOWN } from '../src/core/InventoryManager';

// A trade-lock notice whose KEYWORD matches but whose DATE cannot be parsed
// ("Xyz 32, 2099" is not a real date). Before the fix this returned now+7d, which
// shifted every refresh and churned stack() identity (keyed on the ISO expiry).
const unparseable: any = { owner_descriptions: [{ type: 'html', value: 'Tradable After Xyz 32, 2099' }] };

test('parseTradeLock: unparseable date → deterministic sentinel, not a wall-clock value (B-5/C22)', () => {
  const a = parseTradeLock(unparseable);
  const b = parseTradeLock(unparseable);
  assert.ok(a, 'still fails SAFE to locked');
  assert.equal(a!.toISOString(), TRADE_LOCK_DATE_UNKNOWN.toISOString(),
    'uses the constant sentinel (would be ~now+7d before the fix → not equal to the sentinel)');
  assert.equal(a!.getTime(), b!.getTime(),
    'two parses are byte-identical → stable stack identity across refreshes');
});

test('parseTradeLock: a real future date is still parsed', () => {
  const desc: any = { owner_descriptions: [{ type: 'html', value: 'Tradable After Jan 1, 2099 (07:00:00) GMT' }] };
  const r = parseTradeLock(desc);
  assert.ok(r && r.getUTCFullYear() === 2099, 'genuine hold dates are unaffected');
});

test('parseTradeLock: freely tradable item → null', () => {
  assert.equal(parseTradeLock({} as any), null);
});

// GLOBAL (language-independent) hold parsing: the "⇆" marker + a format-agnostic date extractor,
// so a farm in ANY Steam language shows the countdown, not a bare "Locked" (owner request 2026-07-08).
// owner_descriptions come back in the account's language despite the l=english fetch param.
const holdCases: Array<[string, string]> = [
  ['German  DD.MM.YYYY', '⇆ Dieser Gegenstand ist handelsgeschützt und kann bis 12.7.2099, 14:00:00 weder verändert noch transferiert werden.'],
  ['English UNTIL month', '⇆ This item is trade protected and cannot be transferred until Jul 12, 2099 (14:00:00) GMT.'],
  ['ISO     YYYY-MM-DD',  '⇆ ... 2099-07-12 14:00:00 ...'],
  ['French  D/M/YYYY',    '⇆ Cet objet est protégé et ne peut être échangé jusqu\'au 12/07/2099 à 14:00:00.'],
  ['CJK     年月日',        '⇆ このアイテムは取引保護されており 2099年7月12日 14:00 まで取引できません。'],
];
for (const [label, note] of holdCases) {
  test(`parseTradeLock GLOBAL: ${label} → parsed to a real future expiry (not bare Locked)`, () => {
    const desc: any = { tradable: 0, owner_descriptions: [{ type: 'html', value: note }] };
    const r = parseTradeLock(desc);
    assert.ok(r, `"${label}" must yield a countdown, not null`);
    assert.equal(r!.getFullYear(), 2099, `${label}: year 2099`);
    assert.equal(r!.getMonth(), 6, `${label}: July (0-indexed) — day/month not swapped`);
    assert.equal(r!.getDate(), 12, `${label}: day 12`);
  });
}

test('parseTradeLock: a ⇆ hold whose date is unparseable → deterministic locked sentinel (fail-safe)', () => {
  const bad: any = { tradable: 0, owner_descriptions: [{ type: 'html', value: '⇆ trade protected until sometime soon' }] };
  const r = parseTradeLock(bad);
  assert.ok(r && r.toISOString() === TRADE_LOCK_DATE_UNKNOWN.toISOString(), 'locked, date-unknown sentinel');
});

test('parseTradeLock: a freely-tradable item with an unrelated date in its description is NOT locked', () => {
  // The aggressive extractor only runs for a ⇆ note or a non-tradable item, so lore dates cannot false-lock.
  const tradable: any = { tradable: 1, descriptions: [{ type: 'html', value: 'Collection released 1.5.2099. Fully tradable.' }] };
  assert.equal(parseTradeLock(tradable), null, 'a tradable item is never locked by a stray date');
});
