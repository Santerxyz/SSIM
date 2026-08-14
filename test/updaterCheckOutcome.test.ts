import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Updater } from '../src/update/Updater';

// ════════════════════════════════════════════════════════════════════════════
//  S53 — check() collapsed BOTH "up to date" and "the check failed" into a bare
//  null, so runUpdate recorded a failed check as 'up-to-date' and the stranded-
//  fleet histogram undercounted exactly the cohort it was built to find. check()
//  now returns a discriminated { status } — update | current | check-failed.
// ════════════════════════════════════════════════════════════════════════════

const ok = (data: unknown) => async () => ({ status: 200, data });

// A well-formed manifest for the given version — H-LIC-001's parseManifest now rejects malformed
// fields (non-hex sha256, non-https url) as 'check-failed', so these fixtures must be shape-valid to
// exercise the update/current discrimination this suite is about.
const manifest = (latest: string) => ({ latest, sha256: 'a'.repeat(64), url: 'https://license.ssim.dev/x.exe', sigKind: 'AAAA' });

test('S53: a non-200 is "check-failed" — NOT "current"', async () => {
  const r = await Updater.check('1.0.0', async () => ({ status: 503, data: {} }));
  assert.equal(r.status, 'check-failed', 'a 503 is a failed check, not up-to-date');
});

test('S53: a network error is "check-failed" — NOT "current"', async () => {
  const r = await Updater.check('1.0.0', async () => { throw new Error('ENOTFOUND api'); });
  assert.equal(r.status, 'check-failed');
});

test('S53: a 200 reporting no newer version is "current" (distinct from a failed check)', async () => {
  const r = await Updater.check('1.0.0', ok(manifest('1.0.0')));
  assert.equal(r.status, 'current');
});

test('S53: a 200 with a newer version is "update" and carries the info', async () => {
  const r = await Updater.check('1.0.0', ok(manifest('2.0.0')));
  assert.equal(r.status, 'update');
  if (r.status === 'update') assert.equal(r.info.latest, '2.0.0');
});
