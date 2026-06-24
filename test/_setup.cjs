// Test preload (required BEFORE any test module loads, so it runs before paths.ts
// captures BASE_DIR at module-load). Points SSIM_HOME at a throwaway temp dir so NO
// test ever reads or writes the real data/ , Vault/ or logs/ folders.
const os = require('os');
const path = require('path');
const fs = require('fs');

const home = path.join(os.tmpdir(), `ssim-test-home-${process.pid}`);
try { fs.mkdirSync(path.join(home, 'data'), { recursive: true }); } catch { /* ignore */ }
process.env.SSIM_HOME = home;
