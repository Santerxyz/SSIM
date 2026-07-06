import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ════════════════════════════════════════════════════════════════════════════
//  H-FE-018 — the license-key <input> carries CSS text-transform:uppercase, which
//  only restyles the rendered glyphs; key.value stays as typed. Server keys are
//  generated from an uppercase-only Crockford-base32 alphabet and looked up
//  case-sensitively, so a lowercase/mixed-case submission was rejected as
//  "Unknown license key" while the screen showed the "correct" uppercase key.
//  The fix upcases the value at read time so the transmitted value equals the
//  displayed value. These are source-level regression guards (no DOM/jsdom in
//  this repo — same pattern as liveLogsZindex.test.ts).
// ════════════════════════════════════════════════════════════════════════════

function licenseHtml(): string {
  return readFileSync(join(__dirname, '..', 'public', 'license.html'), 'utf8');
}

test('H-FE-018: the submit handler upcases the trimmed key before POST', () => {
  const html = licenseHtml();
  // The load-bearing change: the value read from the field is upcased so the
  // sent value matches the uppercase glyphs the CSS displays.
  assert.match(html, /const value = key\.value\.trim\(\)\.toUpperCase\(\);/,
    'the license key must be upcased at read time to match the uppercase display');
  // Guard against a regression back to the raw lowercase-preserving read.
  assert.doesNotMatch(html, /const value = key\.value\.trim\(\);/,
    'the raw (non-upcased) read must not be reintroduced');
  // The POST still sends `value` (the upcased string), not the raw field value.
  assert.match(html, /body: JSON\.stringify\(\{ key: value \}\)/,
    'the activation POST must transmit the upcased value');
});

test('H-FE-018: the inline FALLBACK_HTML also upcases the key before POST', () => {
  const src = readFileSync(
    join(__dirname, '..', 'src', 'licensing', 'ActivationServer.ts'), 'utf8',
  );
  assert.match(src, /body:JSON\.stringify\(\{key:k\.value\.trim\(\)\.toUpperCase\(\)\}\)/,
    'the fallback form must upcase the key so it matches the case-sensitive server lookup');
});

test('H-FE-018: server keys are uppercase-only, so upcasing can never invalidate a valid key', (t) => {
  // Cross-check the invariant the fix relies on: the key alphabet is uppercase-only.
  // The license server is a sibling repo; skip cleanly if it isn't checked out here.
  const licensesPath = join(__dirname, '..', '..', 'ssim-license-server', 'src', 'licenses.js');
  if (!existsSync(licensesPath)) { t.skip('ssim-license-server sibling not present'); return; }
  const licenses = readFileSync(licensesPath, 'utf8');
  const m = /const alphabet = '([^']+)';/.exec(licenses);
  assert.ok(m, 'the license-server key alphabet is declared');
  const alphabet = m![1];
  assert.equal(alphabet, alphabet.toUpperCase(),
    'the key alphabet must be uppercase-only for client upcasing to be safe');
});
