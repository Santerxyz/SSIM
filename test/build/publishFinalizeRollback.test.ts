import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── H-SHL-005: a finalize whose response is garbled or hangs must reach rollback ──
// finalize makes version.json LIVE server-side BEFORE it returns 201. Previously the finalize call and
// its JSON.parse sat OUTSIDE the Gate-3 rollback region: a 201 with an unparseable body threw to the
// outer .catch(fail) and a hung response parked publish.js forever — in BOTH cases the just-finalized,
// UNVERIFIED manifest stayed live and rollback() never ran. The fix (a) gives request() a bounded
// timeout and (b) routes any post-send finalize failure through the issues[] → rollback() path.

const ROOT = join(__dirname, '..', '..');
const PUBLISH = join(ROOT, 'build', 'publish.js');
const ARTIFACT = join(ROOT, 'release-tauri', 'SSIM', 'SSIM.exe');

// Always-on source-structure pins (run even where the 185 MB artifact is absent, e.g. CI).
test('H-SHL-005: request() carries a bounded, reject-on-timeout deadline', () => {
  const src = readFileSync(PUBLISH, 'utf8');
  assert.match(src, /req\.setTimeout\(/, 'request() must arm a socket timeout');
  assert.match(src, /req\.destroy\(new Error\(`request timeout/, 'a timeout must destroy → reject with a labelled error, never resolve');
  assert.match(src, /timeoutMs: 600_000/, 'the ~185 MB stage upload must pass a larger deadline');
});

// ─── H-SHL-006: the Gate-3 served-sha download must also bound a stalled connection ──
// sha256OfUrl() streams the full ~185 MB served artifact during Gate-3. Its lib.get had no socket
// timeout, so a half-open download (proxy drop mid-stream) parked the publish forever — the same
// no-timeout root as request(). The fix arms req.setTimeout → destroy → reject with a labelled error.
test('H-SHL-006: sha256OfUrl arms a reject-on-timeout deadline on its streaming GET', () => {
  const src = readFileSync(PUBLISH, 'utf8');
  const fn = src.slice(src.indexOf('function sha256OfUrl'), src.indexOf('function rollback'));
  assert.match(fn, /req\.setTimeout\(/, 'the served-sha download must arm a socket timeout');
  assert.match(fn, /req\.destroy\(new Error\(`request timeout/, 'a stalled download must destroy → reject with a labelled error, never hang');
});

test('H-SHL-005: finalize + its parse live inside the issues[]/rollback region', () => {
  const src = readFileSync(PUBLISH, 'utf8');
  // A post-send finalize failure pushes into issues[] (→ rollback) rather than bailing via bare fail().
  assert.match(src, /finalize outcome UNKNOWN — the manifest may already be live/, 'a post-send finalize failure must be classified as may-be-live');
  // Only a genuine pre-send failure (connection refused before any bytes) still fail()s directly.
  assert.match(src, /ECONNREFUSED/, 'a pre-send connection-refused must remain a direct fail() (nothing changed server-side)');
});

// ─── H-SHL-007: the served-signature gate must fail CLOSED on a missing LICENSE_PUBLIC_KEY ──
// Gate 3's signature check is the only enforced proof the release validates against the FLEET's key.
// It used to skip-and-warn (console.log) when LICENSE_PUBLIC_KEY was unset and report success anyway,
// so a shell that never sourced secrets.local.bat could publish a fleet-unverifiable signature. The fix
// moves the presence check up beside the API/PW guards to fail CLOSED before login, with an explicit
// --skip-sig-verify opt-out that restores a LOUD warn-and-proceed for the rare intentional case.
test('H-SHL-007: missing LICENSE_PUBLIC_KEY fails closed at the top-level guards', () => {
  const src = readFileSync(PUBLISH, 'utf8');
  // The guard sits in the same block as the !API / !PW fail()s, before login/stage.
  assert.match(
    src,
    /if \(!process\.env\.LICENSE_PUBLIC_KEY && !SKIP_SIG_VERIFY\) fail\('LICENSE_PUBLIC_KEY not set/,
    'a missing production public key must fail() before publish unless --skip-sig-verify is passed',
  );
  // The Gate-3 skip branch is now reachable only via --skip-sig-verify and warns LOUDLY (console.error).
  assert.match(src, /const SKIP_SIG_VERIFY = process\.argv\.includes\('--skip-sig-verify'\)/, 'the --skip-sig-verify escape hatch must be defined');
  assert.match(src, /console\.error\('  ⚠⚠ --skip-sig-verify:/, 'the skip path must warn loudly via console.error, not a quiet console.log');
});

/**
 * Boot a mock license server: 200 /admin/login, 201 /release/stage (echoing the sha of the bytes it
 * received so Gate-2 matches), and a caller-supplied /release/finalize behaviour. Records whether
 * /release/rollback was hit. `GET /version` returns a prior manifest so rollback has something to
 * restore to.
 */
function mockServer(finalize: (res: http.ServerResponse) => void) {
  let rollbackHit = false;
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    if (url === '/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ latest: '1.0.0', sha256: 'deadbeef', url: 'http://mock/old.exe' }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      if (url === '/admin/login') {
        res.writeHead(200, { 'Set-Cookie': 'sid=test; Path=/', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else if (url.startsWith('/admin/api/release/stage')) {
        const sha = crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sha256: sha, storedAs: 'stored.exe' }));
      } else if (url === '/admin/api/release/finalize') {
        finalize(res); // caller decides: garbled body, or never respond
      } else if (url === '/admin/api/release/rollback') {
        rollbackHit = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404); res.end();
      }
    });
  });
  return { server, get rollbackHit() { return rollbackHit; } };
}

function runPublish(port: number, extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [PUBLISH, '--skip-selftest', '--no-notes'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PUBLISH_API_URL: `http://127.0.0.1:${port}`,
        SSIM_ADMIN_PASSWORD: 'test-pw',
        LICENSE_PUBLIC_KEY: 'x', // non-empty so the real one isn't loaded from secrets.local.bat
        BOT_ANNOUNCE_URL: '', // no announce leg
        ...extraEnv,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

// Integration cases need the real staged artifact (DIR/PRIMARY are fixed). Skip cleanly where it is
// absent so the suite stays hermetic; the source pins above still guard the fix everywhere.
const skip = existsSync(ARTIFACT) ? false : 'release-tauri/SSIM/SSIM.exe not built — skipping the live publish integration';

test('H-SHL-005: a 201 finalize with an unparseable body triggers rollback + non-zero exit', { skip }, async () => {
  const m = mockServer((res) => {
    res.writeHead(201, { 'Content-Type': 'text/html' });
    res.end('<html>proxy error</html>'); // 201 but NOT JSON → JSON.parse throws post-send
  });
  await new Promise<void>((r) => m.server.listen(0, '127.0.0.1', r));
  const port = (m.server.address() as any).port;
  try {
    const { code, out } = await runPublish(port);
    assert.notEqual(code, 0, `publish must exit non-zero on a garbled finalize (out: ${out.slice(-400)})`);
    assert.equal(m.rollbackHit, true, 'publish must call POST /admin/api/release/rollback (pre-fix it exited via the outer catch with NO rollback)');
  } finally {
    await new Promise<void>((r) => m.server.close(() => r()));
  }
});

test('H-SHL-005: a finalize that never responds aborts within the timeout and attempts rollback', { skip }, async () => {
  const m = mockServer(() => { /* accept, never respond → the client must time out, not hang */ });
  await new Promise<void>((r) => m.server.listen(0, '127.0.0.1', r));
  const port = (m.server.address() as any).port;
  try {
    // Short per-request deadline so the hung finalize aborts in ~1 s instead of the 120 s default.
    const { code, out } = await runPublish(port, { PUBLISH_REQUEST_TIMEOUT_MS: '1500' });
    assert.notEqual(code, 0, `publish must abort (not hang) on a hung finalize (out: ${out.slice(-400)})`);
    assert.match(out, /request timeout/, 'the abort must name the request-timeout cause');
    assert.equal(m.rollbackHit, true, 'a hung finalize (manifest possibly live) must attempt rollback');
  } finally {
    await new Promise<void>((r) => m.server.close(() => r()));
  }
});
