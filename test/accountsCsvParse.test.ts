import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAccountsCsv } from '../src/core/maFiles';

// ─── H-ACC-077: a mid-unquoted-field double-quote must be literal ────────────────
// parseCsvLine used to enter quote mode on ANY `"` outside quotes, including mid-field,
// so a password with a double quote (legal in Steam passwords) swallowed commas to EOL →
// the row silently dropped (too few columns) or imported with a mangled password. The fix
// treats `"` as an opening quote ONLY at field start (cur === ''); mid-field quotes stay
// literal, and proper quoted-field semantics (leading `"`, doubled `""`, closing `"`) are
// unchanged. parseCsvLine is not exported — assert its behaviour through parseAccountsCsv,
// whose cells are [username, password, shared_secret, identity_secret].

test('mid-field quote is literal — a,pa"ss,b,c → password pa"ss, row kept', () => {
  const { rows, rejected } = parseAccountsCsv('a,pa"ss,b,c');
  assert.equal(rejected.length, 0, 'the quote-bearing row is no longer dropped');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].username, 'a');
  assert.equal(rows[0].password, 'pa"ss', 'the mid-field quote stays literal, commas not swallowed');
  assert.equal(rows[0].shared_secret, 'b');
  assert.equal(rows[0].identity_secret, 'c');
});

test('leading quote still opens a quoted field — a,"pa,ss",b,c → password pa,ss', () => {
  const { rows, rejected } = parseAccountsCsv('a,"pa,ss",b,c');
  assert.equal(rejected.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].password, 'pa,ss', 'a leading quote still protects an embedded comma');
});

test('doubled-quote escape inside a quoted field unchanged — a,"pa""ss",b,c → password pa"ss', () => {
  const { rows, rejected } = parseAccountsCsv('a,"pa""ss",b,c');
  assert.equal(rejected.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].password, 'pa"ss', 'the "" escape inside a quoted field still yields one literal quote');
});

test('header + valid rows are unchanged by the fix', () => {
  const csv = ['username,password,shared_secret,identity_secret', 'bot1,pw1,sec1,id1', 'bot2,pw2,sec2,'].join('\n');
  const { rows, rejected } = parseAccountsCsv(csv);
  assert.equal(rejected.length, 0, 'no well-formed row is rejected');
  assert.equal(rows.length, 2, 'the header row is skipped, both data rows parse');
  assert.deepEqual(rows[0], { username: 'bot1', password: 'pw1', shared_secret: 'sec1', identity_secret: 'id1' });
  assert.deepEqual(rows[1], { username: 'bot2', password: 'pw2', shared_secret: 'sec2', identity_secret: '' });
});
