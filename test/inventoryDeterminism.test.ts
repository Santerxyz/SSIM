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
