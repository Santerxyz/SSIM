import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { maFilesDir } from '../src/utils/paths';
import { loadMaFileFromDisk, listDropZoneMaFiles } from '../src/core/maFiles';

// ─── H-ACC-073: parsed maFiles are shape-validated at import time ────────────────
// JSON.parse(raw) was trusted structurally, leaving three holes: file content `null`
// threw a cryptic path-less TypeError; a non-string shared_secret (e.g. `true`) passed
// the truthy check and detonated deep in steam-totp at login time; a numeric
// account_name rode the lying `as string` cast into the entry list and crashed the
// whole import batch at `.toLowerCase()`. Each is now an immediate, per-file,
// path-bearing error / skip reason instead.

const DIR = maFilesDir();
const PREFIX = 'hacc073-';                       // unique tag so we ignore any stray drop-zone files
const written: string[] = [];

function writeFile(name: string, content: string): string {
  const p = path.join(DIR, name);
  fs.writeFileSync(p, content, 'utf-8');
  written.push(p);
  return name;
}

const SECRET = 'wWa1xZ3qShared==';
const NULLFILE  = `${PREFIX}null.maFile`;
const BOOLSEC   = `${PREFIX}boolsec.maFile`;
const NUMNAME   = `${PREFIX}numname.maFile`;
const VALID     = `${PREFIX}valid.maFile`;

before(() => {
  fs.mkdirSync(DIR, { recursive: true });
  writeFile(NULLFILE, 'null');                                                              // parses to null
  writeFile(BOOLSEC,  JSON.stringify({ account_name: `${PREFIX}b`, shared_secret: true })); // non-string secret
  writeFile(NUMNAME,  JSON.stringify({ account_name: 123, shared_secret: SECRET }));        // numeric account_name
  writeFile(VALID,    JSON.stringify({ account_name: `${PREFIX}v`, shared_secret: SECRET }));
});
after(() => {
  for (const p of written) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
});

test('loadMaFileFromDisk: content `null` throws with the file path (not a cryptic TypeError)', () => {
  assert.throws(
    () => loadMaFileFromDisk(NULLFILE),
    (err: Error) => err.message.includes(NULLFILE) && /not a JSON object/.test(err.message),
    'a `null` maFile must surface a path-bearing "not a JSON object" error',
  );
});

test('loadMaFileFromDisk: non-string shared_secret is rejected as missing (not persisted then detonated at login)', () => {
  assert.throws(
    () => loadMaFileFromDisk(BOOLSEC),
    (err: Error) => err.message.includes(BOOLSEC) && /missing shared_secret/.test(err.message),
    'shared_secret: true must throw "missing shared_secret", not pass the truthy check',
  );
});

test('listDropZoneMaFiles: a numeric account_name is excluded and reported, and valid files still list', () => {
  const { entries, unreadable } = listDropZoneMaFiles();
  const mineEntries = entries.filter((e) => e.file.startsWith(PREFIX));
  const mineBad = unreadable.filter((u) => u.file.startsWith(PREFIX));

  // The numeric-account_name file must NOT ride the `as string` cast into an entry.
  assert.equal(mineEntries.some((e) => e.file === NUMNAME), false, 'numeric account_name file is not a usable entry');
  assert.ok(mineBad.some((u) => u.file === NUMNAME && u.reason === 'no account_name'),
    'the numeric-account_name file is reported as skipped, not silently dropped nor crashing the batch');

  // One poisoned file does not abort the batch: the valid file still lists.
  assert.ok(mineEntries.some((e) => e.file === VALID), 'the valid maFile in the same batch still lists');
});
