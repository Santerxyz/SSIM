import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── H-SHL-010: the licensing-secret bake must fail CLOSED ─────────────────────
// A non-matching bake marker previously warned-and-continued, shipping a DEV-placeholder licensing
// exe that still passes the self-test (which never reads these values) → fleet-wide licensing
// failure found only in the field, behind a green build log. build/pack.js is executed as a build
// entry (not tsc-compiled, not required by the suite), so this pins the abort structure at source.

const PACK = readFileSync(join(__dirname, '..', '..', 'build', 'pack.js'), 'utf8');

test('H-SHL-010: bakeSecret reports success/failure and a non-match aborts the build', () => {
  assert.match(PACK, /return false;/, 'bakeSecret must return false when the marker does not match');
  assert.match(PACK, /return true;/, 'bakeSecret must return true on a successful bake');
  assert.match(PACK, /bakeResults\.some\(\(ok\) => !ok\)/, 'the call site must detect any failed bake');
  assert.doesNotMatch(PACK, /marker \$\{marker\} not found – leaving as-is/, 'the warn-and-continue path must be gone');
});

test('H-SHL-010: a surviving DEV placeholder sentinel aborts the build', () => {
  for (const sentinel of ['DEV_PEPPER_replace_at_build_time', 'license.example.com', 'DEV_PLACEHOLDER_PUBLIC_KEY']) {
    assert.ok(PACK.includes(sentinel), `the post-bake guard must check for the "${sentinel}" sentinel`);
  }
  assert.match(PACK, /survived the bake — aborting/, 'a surviving sentinel must abort with process.exit(1)');
  assert.match(PACK, /process\.exit\(1\)/, 'the guard must exit non-zero');
});
