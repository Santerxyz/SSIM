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
  // 2026-07-09 regression (owner screenshot: "26473 days"): worded months in non-Latin scripts,
  // non-ASCII digits, and year-first orders parsed by NOTHING → every such item fell to the 2099
  // sentinel, which the UI then rendered as an absurd countdown. Locale-worded months now resolve
  // through the ICU month map; digits/bidi marks are normalized; year-first shapes are covered.
  ['Arabic  worded month', '⇆ هذا العنصر محمي من التبادل ولا يمكن نقله حتى 12 يوليو 2099 الساعة 14:00.'],
  ['Arabic  arabic-indic digits + RTL marks', '⇆ لا يمكن نقله حتى ‏١٢ ‏يوليو ‏٢٠٩٩.'],
  ['Russian genitive month', '⇆ Этот предмет защищён и не может быть передан до 12 июля 2099 г.'],
  ['Greek   genitive month', '⇆ Αυτό το αντικείμενο προστατεύεται έως 12 Ιουλίου 2099.'],
  ['Portuguese de-month-de', '⇆ Este item está protegido até 12 de julho de 2099 às 14:00.'],
  ['Turkish worded month',  '⇆ Bu eşya 12 Temmuz 2099 tarihine kadar takas korumalı.'],
  ['Korean  년월일',          '⇆ 이 아이템은 2099년 7월 12일 14:00까지 거래할 수 없습니다.'],
  ['Vietnamese tháng-N',    '⇆ Vật phẩm này được bảo vệ đến 12 tháng 7, 2099.'],
  ['Japanese year-first slashed', '⇆ このアイテムは 2099/07/12 14:00 まで取引できません。'],
  ['Hungarian year-first dotted', '⇆ Ez a tárgy 2099. 07. 12. 14:00-ig védett.'],
  ['Hungarian year-first worded', '⇆ Ez a tárgy 2099. július 12. napjáig védett.'],
  ['Thai    Buddhist-era year', '⇆ ไอเทมนี้ถูกล็อกจนถึง 12 กรกฎาคม 2642 เวลา 14:00 น.'],
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

// ── 2026-07-10: the "⇆" marker is NOT proof of a trade hold ───────────────────────────────────────
// Steam stamps the SAME marker on the market-listing note, which carries no date. The old code treated
// any dateless "⇆" note as a hold AND returned the sentinel from INSIDE the scan loop. Two live-observed
// consequences (741 warnings in one log, every one of them this single note):
//   • a merely-listed item became "Locked (date unknown)";
//   • a listed item that IS trade-held lost its countdown, because the market note precedes the hold note
//     and the early return abandoned the rest of the scan.
const MARKET_NOTE = '⇆ This item is listed on the Steam Community Market and cannot be consumed or modified.';
const HOLD_NOTE   = '⇆ This item is trade protected and cannot be transferred until Jul 12, 2099 (14:00:00) GMT.';

test('parseTradeLock: the market-listing note is NOT a trade hold (no sentinel, no fake date)', () => {
  const listed: any = { tradable: 0, owner_descriptions: [{ type: 'html', value: MARKET_NOTE }] };
  assert.equal(parseTradeLock(listed), null, 'a listed item has no lock date; tradable=0 already renders "Locked"');
});

test('parseTradeLock: a localized market-listing note is also not a hold', () => {
  const de: any = { tradable: 0, owner_descriptions: [{ type: 'html', value: '⇆ Dieser Gegenstand ist im Steam-Community-Markt gelistet und kann nicht verbraucht werden.' }] };
  assert.equal(parseTradeLock(de), null, 'no date and no after/until ⇒ not a hold, in any language');
});

test('parseTradeLock: a listed AND trade-held item keeps its real countdown (market note FIRST)', () => {
  const both: any = { tradable: 0, owner_descriptions: [{ value: MARKET_NOTE }, { value: HOLD_NOTE }] };
  const r = parseTradeLock(both);
  assert.ok(r, 'must yield a date');
  assert.equal(r!.getUTCFullYear(), 2099);
  assert.equal(r!.getUTCMonth(), 6);
  assert.equal(r!.getUTCDate(), 12);
});

test('parseTradeLock: note ORDER never changes the answer', () => {
  const a: any = { tradable: 0, owner_descriptions: [{ value: MARKET_NOTE }, { value: HOLD_NOTE }] };
  const b: any = { tradable: 0, owner_descriptions: [{ value: HOLD_NOTE }, { value: MARKET_NOTE }] };
  assert.equal(parseTradeLock(a)!.toISOString(), parseTradeLock(b)!.toISOString());
});

test('parseTradeLock: the hold note is found even when it sits in the OTHER pool', () => {
  const split: any = { tradable: 0, owner_descriptions: [{ value: MARKET_NOTE }], descriptions: [{ value: HOLD_NOTE }] };
  const r = parseTradeLock(split);
  assert.ok(r && r.getUTCFullYear() === 2099, 'a dateless note in pool 1 must not abandon the scan of pool 2');
});

test('parseTradeLock: a marker note on an item Steam still calls TRADABLE stays fail-closed', () => {
  // Self-contradictory input → keep locking it rather than let isSellable() wave it through.
  const odd: any = { tradable: 1, owner_descriptions: [{ type: 'html', value: MARKET_NOTE }] };
  const r = parseTradeLock(odd);
  assert.ok(r && r.toISOString() === TRADE_LOCK_DATE_UNKNOWN.toISOString(), 'fail-safe retained for tradable=1');
});
