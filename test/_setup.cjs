// Test preload (required BEFORE any test module loads, so it runs before paths.ts
// captures BASE_DIR at module-load). Points SSIM_HOME at a throwaway temp dir so NO
// test ever reads or writes the real data/ , Vault/ or logs/ folders.
//
// `node --test` forks one child process per test FILE and forwards this preload into each
// child, so every file already gets its own home. The name must be unique per RUN as well
// as per process: `ssim-test-home-${process.pid}` repeats as soon as the OS recycles that
// pid, and because the dirs outlive the run, a later child would adopt an earlier run's
// Vault/accounts.json — `AccountManager.add` then throws `Account "botN" already exists`
// for whichever fixture the previous occupant of that pid happened to leave behind.
// mkdtempSync always creates a brand-new directory, and the exit hook keeps the OS temp
// dir from accumulating one home per test file per run.
const os = require('os');
const path = require('path');
const fs = require('fs');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-test-home-'));
fs.mkdirSync(path.join(home, 'data'), { recursive: true });
process.env.SSIM_HOME = home;

process.on('exit', () => {
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best-effort */ }
});
