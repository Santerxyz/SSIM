import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { writeCrash, CRASH_FILE } from '../src/utils/crashlog';

// ════════════════════════════════════════════════════════════════════════════
//  H-BOOT-023 — the unhandledRejection handler feeds writeCrash the raw rejection
//  value, which is frequently NOT an Error (steam-user / steamcommunity reject
//  with EResult objects, `{ eresult, message }` shapes, plain strings, or undefined
//  for a bare Promise.reject()). The old non-Error branch used String(detail),
//  collapsing a plain object to the content-free "[object Object]" on the one
//  record guaranteed to be on disk. It now serializes with structure preserved.
// ════════════════════════════════════════════════════════════════════════════

/** Bytes appended to the real crash sink by the most recent writeCrash call. */
function tailAfter(before: number): string {
  const buf = fs.readFileSync(CRASH_FILE);
  return buf.slice(before).toString('utf8');
}

test('H-BOOT-023: a non-Error rejection object keeps its eresult/message instead of [object Object]', () => {
  const before = fs.existsSync(CRASH_FILE) ? fs.statSync(CRASH_FILE).size : 0;
  writeCrash('H-BOOT-023-TEST', { eresult: 63, message: 'RateLimitExceeded' });
  const rec = tailAfter(before);
  assert.match(rec, /63/, 'the eresult code is preserved');
  assert.match(rec, /RateLimitExceeded/, 'the message is preserved');
  assert.doesNotMatch(rec, /\[object Object\]/, 'the object no longer collapses to [object Object]');
});

test('H-BOOT-023: a bare Promise.reject() (undefined) still writes a record without throwing', () => {
  const before = fs.existsSync(CRASH_FILE) ? fs.statSync(CRASH_FILE).size : 0;
  assert.doesNotThrow(() => writeCrash('H-BOOT-023-UNDEF', undefined));
  const rec = tailAfter(before);
  assert.match(rec, /H-BOOT-023-UNDEF/, 'the label + pid record still lands even for undefined');
});
