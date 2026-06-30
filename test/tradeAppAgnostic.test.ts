import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toEconItem } from '../src/trading/AccountTrader';

// ─── Bug 1: the trade-offer builder is APP-AGNOSTIC (CS2 730 + TF2 440) ──────────
//
// The send path used to hardcode CS2 (appid 730, contextid 2), so a TF2 (440) item was
// either un-selectable in the UI or shipped in an offer with the WRONG app id and never
// arrived. toEconItem is the single point where a selected asset becomes the econ-item
// steam-tradeoffer-manager sends — so it MUST carry each item's REAL app/context, and
// only fall back to CS2 when the caller omits them (older single-app callers).

test('toEconItem carries a TF2 item as appid 440 — NOT rewritten to CS2 730', () => {
  assert.deepEqual(
    toEconItem({ assetId: 'TF2KEY', appId: 440, contextId: '2' }),
    { assetid: 'TF2KEY', appid: 440, contextid: '2', amount: 1 },
    'a TF2 key is built for appid 440 / context 2',
  );
});

test('toEconItem carries a CS2 item as appid 730', () => {
  assert.deepEqual(
    toEconItem({ assetId: 'CS2SKIN', appId: 730, contextId: '2' }),
    { assetid: 'CS2SKIN', appid: 730, contextid: '2', amount: 1 },
  );
});

test('toEconItem defaults to CS2 (730/2) ONLY when the caller omits app/context (back-compat)', () => {
  assert.deepEqual(
    toEconItem({ assetId: 'LEGACY' }),
    { assetid: 'LEGACY', appid: 730, contextid: '2', amount: 1 },
  );
});

test('a mixed selection maps each item to its own app — no item is forced to 730', () => {
  const refs = [
    { assetId: 'A', appId: 440, contextId: '2' },
    { assetId: 'B', appId: 730, contextId: '2' },
  ];
  const econ = refs.map(toEconItem);
  assert.deepEqual(econ.map((e) => e.appid), [440, 730], 'app ids preserved per item');
  assert.ok(econ.some((e) => e.appid === 440), 'the offer builder includes appid-440 items (selection is not filtered to 730)');
});
