import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sweepStaleCleanProfiles } from '../src/trading/cleanBrowser';

// ════════════════════════════════════════════════════════════════════════════
//  H-TRD-062 — ephemeral clean-browser profiles hold a LIVE steamLoginSecure web
//  session. When SSIM dies without its 'exit' hook (taskkill /F, SIGKILL, the
//  0xC0000409 native fast-fail) or teardown hits EBUSY, the `ssim-clean-*` dir
//  persists in %TEMP% at rest, bypassing the vault posture. sweepStaleCleanProfiles
//  removes abandoned ones on the next launch, while a dir a live browser still
//  holds (file lock) survives — never delete a profile out from under a live window.
// ════════════════════════════════════════════════════════════════════════════

test('H-TRD-062: sweep deletes an abandoned ssim-clean- profile dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ssim-clean-fakeA-${process.pid}-`));
  fs.writeFileSync(path.join(dir, 'Cookies'), 'steamLoginSecure=stale-live-token');
  assert.ok(fs.existsSync(dir), 'fixture dir should exist before the sweep');

  sweepStaleCleanProfiles();

  assert.ok(!fs.existsSync(dir), 'sweep must remove the abandoned secret-bearing profile dir');
});

test('H-TRD-062: sweep skips a profile a live browser still holds (locked dir) and does not throw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ssim-clean-fakeB-${process.pid}-`));
  fs.writeFileSync(path.join(dir, 'Cookies'), 'steamLoginSecure=in-use-token');
  // A live browser from a previous run holds the profile open (a Windows file lock), which is exactly
  // the case the sweep must skip. Chdir'ing into the dir reproduces that lock deterministically: on
  // Windows rmSync then throws EPERM and the dir is left intact; the sweep must swallow it, not throw.
  const origCwd = process.cwd();
  process.chdir(dir);
  try {
    sweepStaleCleanProfiles(); // must never throw even though this dir cannot be removed
    if (process.platform === 'win32') {
      assert.ok(fs.existsSync(dir), 'a locked (in-use) profile dir must survive the sweep on Windows');
    }
  } finally {
    process.chdir(origCwd);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
});
