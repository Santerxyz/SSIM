import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { maFilesDir } from '../src/utils/paths';
import { loadMaFileFromDisk, readCredentialsFile } from '../src/core/maFiles';

// ─── H-ACC-072: BOM / UTF-16 encoding tolerance in the maFiles disk readers ─────
// Windows tooling writes UTF-16 LE by default (PowerShell 5.1 `>` / Out-File, Notepad
// "Unicode") and can prepend a UTF-8 BOM. Decoded as UTF-8 those made maFiles report
// "not valid JSON" (they ARE valid) and accounts.txt usernames match nothing. The
// readers must accept UTF-8, UTF-8+BOM, UTF-16 LE and UTF-16 BE identically.

const DIR = maFilesDir();
const written: string[] = [];

function writeMaFile(name: string, buf: Buffer): string {
  const p = path.join(DIR, name);
  fs.writeFileSync(p, buf);
  written.push(p);
  return name;
}

before(() => { fs.mkdirSync(DIR, { recursive: true }); });
after(() => { for (const p of written) { try { fs.unlinkSync(p); } catch { /* ignore */ } } });

const SECRET = 'wWa1xZ3qShared==';
const maJson = JSON.stringify({ account_name: 'bot1', shared_secret: SECRET });

test('a maFile saved with a UTF-8 BOM loads (not "invalid JSON")', () => {
  const file = writeMaFile('utf8bom.maFile', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(maJson, 'utf-8')]));
  assert.equal(loadMaFileFromDisk(file).shared_secret, SECRET);
});

test('a maFile saved as UTF-16 LE (PowerShell default) loads', () => {
  const file = writeMaFile('utf16le.maFile', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(maJson, 'utf16le')]));
  assert.equal(loadMaFileFromDisk(file).shared_secret, SECRET);
});

test('a maFile saved as UTF-16 BE loads', () => {
  const le = Buffer.from(maJson, 'utf16le');
  const be = Buffer.from(le); be.swap16();
  const file = writeMaFile('utf16be.maFile', Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
  assert.equal(loadMaFileFromDisk(file).shared_secret, SECRET);
});

test('plain UTF-8 maFile still loads (byte-identical path)', () => {
  const file = writeMaFile('utf8.maFile', Buffer.from(maJson, 'utf-8'));
  assert.equal(loadMaFileFromDisk(file).shared_secret, SECRET);
});

test('accounts.txt written as UTF-16 LE with a BOM resolves the password', () => {
  const file = path.join(DIR, 'accounts.txt');
  fs.writeFileSync(file, Buffer.from('﻿user:pass\n', 'utf16le'));
  written.push(file);
  const creds = readCredentialsFile();
  assert.equal(creds.get('user'), 'pass');
});
