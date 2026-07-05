import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSteamTradeError } from '../src/utils/steamTradeError';

// ─── H-TRD-125: the parse carries the transport `code` machine-readably ──────────
// A dropped `code` (e.g. 'ECONNRESET') left the transport signal only inside the
// message text; the trade-send route now reads `code` to keep an ambiguous send
// flagged verifyBeforeRetry. The reshape must preserve it on every return branch.

test('H-TRD-125: parseSteamTradeError surfaces the axios/node transport code', () => {
  const parsed = parseSteamTradeError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
  assert.equal(parsed.code, 'ECONNRESET', 'transport code preserved');
  assert.equal(parsed.inventoryFull, false);
});

test('H-TRD-125: code rides along on the full-inventory branch', () => {
  const parsed = parseSteamTradeError(Object.assign(
    new Error("The recipient's inventory is full — there is no free space."),
    { code: 'ECONNRESET', inventoryFull: true },
  ));
  assert.equal(parsed.inventoryFull, true);
  assert.equal(parsed.code, 'ECONNRESET', 'code kept even when the inventory-full text wins');
});

test('H-TRD-125: code rides along on the eresult branch', () => {
  const parsed = parseSteamTradeError(Object.assign(new Error('There was an error sending your trade offer. (15)'), { eresult: 15, code: 'ETIMEDOUT' }));
  assert.equal(parsed.eresult, 15);
  assert.equal(parsed.code, 'ETIMEDOUT');
});

test('H-TRD-125: no transport code → code is undefined (not the empty string)', () => {
  const parsed = parseSteamTradeError(new Error('Unknown'));
  assert.equal(parsed.code, undefined);
  // A blank/empty code is treated as absent.
  assert.equal(parseSteamTradeError(Object.assign(new Error('x'), { code: '' })).code, undefined);
});
