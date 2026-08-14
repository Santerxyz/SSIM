import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSwapScript } from '../src/licensing/Updater';

// Split out of the old licenseUpdate.test.ts when the licence gate was removed: that
// file mixed licenseClock tests (deleted with the gate) with this updater test, which
// still matters. The updater survived the OSS pivot — open source is not a reason to
// stop verifying signatures on an exe that handles maFiles and passwords.

// C14 / INV-G3 — the orphan-delete must run ONLY after a confirmed successful swap.
test('buildSwapScript: orphan-delete gated on swap success (no brick on a failed move)', () => {
  const s = buildSwapScript({
    tmp: 'NEW.exe', target: 'SHELL.exe', relaunch: 'SHELL.exe',
    backendPid: 1, deletePaths: ['BACKEND.exe'], vbsPath: 'u.vbs',
  });
  assert.ok(s.includes('&& goto swapped'), 'a successful move jumps to the swapped label');
  const gotoFail = s.indexOf('goto swapfail');
  const swapped  = s.indexOf(':swapped');
  const del      = s.indexOf('del /F /Q "BACKEND.exe"');
  const failLbl  = s.indexOf(':swapfail');
  assert.ok(gotoFail >= 0 && gotoFail < swapped, 'an exhausted (failed) swap jumps PAST the delete');
  assert.ok(swapped < del && del < failLbl, 'the orphan-delete sits strictly between :swapped and :swapfail');
});
