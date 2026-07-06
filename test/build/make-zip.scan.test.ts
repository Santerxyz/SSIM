import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── H-SHL-016: the release-ZIP secret scan must catch backslash entries ───────
// Real System.IO.Compression ZipFile FullNames use BACKSLASHES on Windows; the forward-slash
// mafiles/ branch + placeholder allow-list never matched them, so a leaked mafiles/accounts.txt
// (user:pass) slipped through with a "CLEAN" report. Fix: normalise separators + catch accounts.txt
// anywhere. build/make-zip.js executes on require, so we (a) prove the predicate over backslash
// fixtures and (b) assert the shipped file actually carries the fix.

// Predicate duplicated from build/make-zip.js (kept in sync by the source assertion below).
const norm = (name: string) => name.replace(/\\/g, '/');
const SECRET_RE = /vault\.enc|accounts\.json|accounts\.(txt|csv)|refresh_tokens|secrets\.local|license\.(key|token)|\.maFile$|\.mafile$|(^|\/)mafiles\/.+\.(maFile|txt)$|\.log$|protection\.json|value_history|inventories.*\.json|prices\.json|ssim\.lock|ssim\.port/i;
const ALLOW = /mafiles\/PUT_MAFILES_HERE\.txt$/i;
const isOffender = (raw: string) => { const n = norm(raw); return SECRET_RE.test(n) && !ALLOW.test(n); };

test('H-SHL-016: backslash secret entries are caught; the placeholder + legit files are not', () => {
  // Offenders (real backslash ZIP entries):
  assert.equal(isOffender('SSIM\\mafiles\\accounts.txt'), true, 'mafiles/accounts.txt (user:pass) — the one that slipped through pre-fix');
  assert.equal(isOffender('SSIM\\mafiles\\bot1.maFile'), true, 'a real maFile');
  assert.equal(isOffender('SSIM\\data\\vault.enc'), true, 'the vault');
  assert.equal(isOffender('SSIM\\accounts.txt'), true, 'accounts.txt caught ANYWHERE, not just under mafiles/');
  // Allowed / legit:
  assert.equal(isOffender('SSIM\\mafiles\\PUT_MAFILES_HERE.txt'), false, 'the placeholder is allow-listed');
  assert.equal(isOffender('SSIM\\SSIM.exe'), false, 'the shipped exe');
  assert.equal(isOffender('SSIM\\READ ME FIRST.txt'), false, 'a shipped readme');
});

test('H-SHL-016: build/make-zip.js actually carries the normalization + accounts.txt token', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'build', 'make-zip.js'), 'utf8');
  assert.match(src, /\.replace\(\/\\\\\/g, '\/'\)/, 'entry names must be normalized to forward slashes');
  assert.match(src, /accounts\\\.\(txt\|csv\)/, 'SECRET_RE must include the accounts.(txt|csv) token');
});
