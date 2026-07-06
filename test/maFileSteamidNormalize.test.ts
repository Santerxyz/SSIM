import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { maFilesDir } from '../src/utils/paths';
import { loadMaFileFromDisk } from '../src/core/maFiles';

// ─── H-ACC-074: parsed maFiles never persist a precision-mangled SteamID ─────────
// SDA writes `Session.SteamID` as a raw JSON NUMBER > 2^53, so JSON.parse ROUNDS it to
// a different id. Persisting that under a type that claims `string` is a wrong-partner
// landmine. normalizeMaFile recovers the exact SteamID64 from the RAW text (never the
// rounded number) into the string `steamid`, and drops the whole dead `Session` block.

const DIR = maFilesDir();
const PREFIX = 'hacc074-';                       // unique tag so we ignore any stray drop-zone files
const written: string[] = [];

function writeFile(name: string, content: string): string {
  const p = path.join(DIR, name);
  fs.writeFileSync(p, content, 'utf-8');
  written.push(p);
  return name;
}

const SECRET = 'wWa1xZ3qShared==';
const STEAMID = '76561198234567890';             // 17 digits, would round if parsed as a number
const NUMSESSION = `${PREFIX}numsession.maFile`;
const STRSTEAMID = `${PREFIX}strsteamid.maFile`;

before(() => {
  fs.mkdirSync(DIR, { recursive: true });
  // Session.SteamID as an UNQUOTED number (the real SDA shape) — JSON.parse would round it.
  writeFile(
    NUMSESSION,
    `{"account_name":"${PREFIX}n","shared_secret":"${SECRET}","Session":{"SteamID":${STEAMID}}}`,
  );
  // A maFile that already carries a precision-safe STRING steamid — must be kept verbatim.
  writeFile(
    STRSTEAMID,
    JSON.stringify({ account_name: `${PREFIX}s`, shared_secret: SECRET, steamid: STEAMID }),
  );
});
after(() => {
  for (const p of written) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
});

test('numeric Session.SteamID → exact string steamid recovered from raw text; Session dropped', () => {
  const mf = loadMaFileFromDisk(NUMSESSION);
  // The recovered id is the EXACT string from the raw file — not a rounded number stringified.
  assert.equal(mf.steamid, STEAMID, 'steamid is the precision-safe SteamID64 from the raw text');
  assert.equal(typeof mf.steamid, 'string', 'steamid is a string, never the parsed number');
  assert.equal(mf.Session, undefined, 'the lossy/dead Session block is dropped before persistence');
});

test('a maFile with a valid string steamid keeps it verbatim', () => {
  const mf = loadMaFileFromDisk(STRSTEAMID);
  assert.equal(mf.steamid, STEAMID, 'a valid string steamid is preserved unchanged');
});
