import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import axios from 'axios';

// ════════════════════════════════════════════════════════════════════════════
//  H-LIC-005 — the offline-grace / rollback clock anchor must advance ONLY on a
//  POSITIVE, server-authenticated 200, never on "200 and not revoked". The S26
//  fix kept a `: Date.now()` fallback in markOnline and gated the success path on
//  `!revoked`, so a markerless/HTML 200 from a trusted-CA TLS-inspection proxy (or
//  a pre-S26 server) advanced lastOnlineMs and could re-poison maxSeenMs from a
//  forward-wrong local clock — the exact S26 lockout. This drives the REAL shipped
//  onlineRecheck / heartbeat over a mocked license server and asserts the on-disk
//  license.meta.json anchor is untouched unless the server's positive marker is present.
// ════════════════════════════════════════════════════════════════════════════

const LIC_DIR = path.join(__dirname, '..', 'src', 'licensing');
const licPath = (m: string): string => path.join(LIC_DIR, `${m}.ts`);

// A throwaway Ed25519 keypair so verifyToken accepts tokens we sign here. Injected
// via LICENSE_PUBLIC_KEY BEFORE the license modules are (re)required below.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
process.env.LICENSE_PEPPER = 'HLIC005_TEST_PEPPER';
process.env.LICENSE_PUBLIC_KEY = (publicKey.export({ type: 'spki', format: 'pem' }) as string).toString();

// Mock the axios instance the client builds at import time: one programmable stub
// whose response we set per case. esModuleInterop → the client's `import axios` is axios.default.
let mockResponse: unknown;
const httpStub = { post: async (): Promise<unknown> => mockResponse };
const realCreate = axios.create;
const realDefaultCreate = (axios as unknown as { default?: { create?: unknown } }).default?.create;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(axios as any).create = () => httpStub;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if ((axios as any).default) (axios as any).default.create = () => httpStub;

// Cache-bust so config.ts re-reads the injected key and LicenseClient rebuilds `http`
// with the stub, regardless of whether an earlier test already imported these.
for (const m of ['config', 'licenseClock', 'LicenseClient']) {
  try { delete require.cache[require.resolve(licPath(m))]; } catch { /* not yet loaded */ }
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const LC = require(licPath('LicenseClient')) as typeof import('../src/licensing/LicenseClient');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { dataDir } = require(path.join(__dirname, '..', 'src', 'utils', 'paths')) as typeof import('../src/utils/paths');

const META = dataDir('license.meta.json');

function signToken(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(body, 'base64url'), privateKey).toString('base64url');
  return `${body}.${sig}`;
}
const HWID = 'HLIC005-HWID';
function freshToken(): string {
  const now = Date.now();
  return signToken({ hwid: HWID, exp: now + 3_600_000, tier: 'b2c', key: 'K', iat: now });
}
function clearMeta(): void { try { fs.rmSync(META, { force: true }); } catch { /* ignore */ } }
function readMetaFile(): { lastOnlineMs: number; maxSeenMs: number } | undefined {
  try { return JSON.parse(fs.readFileSync(META, 'utf8')) as { lastOnlineMs: number; maxSeenMs: number }; }
  catch { return undefined; }
}
const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

after(() => {
  // restore axios and drop our mocked copies so later tests re-require cleanly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (axios as any).create = realCreate;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((axios as any).default && realDefaultCreate) (axios as any).default.create = realDefaultCreate;
  for (const m of ['config', 'licenseClock', 'LicenseClient']) {
    try { delete require.cache[require.resolve(licPath(m))]; } catch { /* ignore */ }
  }
});

// (a) onlineRecheck: a markerless / HTML 200 (captive-portal or TLS-inspection proxy) must
//     NOT advance the anchor — it is authenticated only negatively ("not revoked").
test('H-LIC-005 (a): onlineRecheck ignores a markerless HTML 200 (no anchor advance)', async () => {
  clearMeta();
  LC.storeToken(freshToken());
  mockResponse = { status: 200, data: '<html>captive portal</html>' };
  await LC.validate(HWID);
  await flush();
  assert.equal(readMetaFile(), undefined, 'a non-license-server 200 must not write the clock anchor');
});

// (b) onlineRecheck: the server's positive marker {status:'ok', serverTime:T} anchors to T.
test('H-LIC-005 (b): onlineRecheck anchors lastOnlineMs to the server time on {status:ok}', async () => {
  clearMeta();
  LC.storeToken(freshToken());
  const T = 1_700_000_000_000;
  mockResponse = { status: 200, data: { status: 'ok', serverTime: T } };
  await LC.validate(HWID);
  await flush();
  assert.equal(readMetaFile()?.lastOnlineMs, T, 'a real {status:ok}+serverTime 200 anchors to the server time');
});

// (c) heartbeat: a 200 with no rolled token in the body is not the license server → no advance.
test('H-LIC-005 (c): heartbeat leaves the anchor untouched on a tokenless 200', async () => {
  clearMeta();
  LC.storeToken(freshToken());
  process.env.LICENSE_HEARTBEAT_MS = '20';
  mockResponse = { status: 200, data: {} };
  LC.startHeartbeat(HWID);
  await new Promise<void>((r) => setTimeout(r, 60));
  await flush();
  LC.stopHeartbeat();
  assert.equal(readMetaFile(), undefined, 'a markerless/tokenless heartbeat 200 must not advance the anchor');
});

// (d) heartbeat: a markerless 200 must NOT bump maxSeenMs to a forward-wrong local clock
//     (the S26 rollback poison). We pre-seed a legitimate anchor and assert it is unchanged.
test('H-LIC-005 (d): a markerless heartbeat 200 does not re-poison maxSeenMs from Date.now()', async () => {
  clearMeta();
  LC.storeToken(freshToken());
  // Seed a legitimate server-time anchor via a real {status:ok} validate.
  const REAL = 1_700_000_000_000;
  mockResponse = { status: 200, data: { status: 'ok', serverTime: REAL } };
  await LC.validate(HWID);
  await flush();
  const seeded = readMetaFile();
  assert.equal(seeded?.maxSeenMs, REAL, 'precondition: anchor seeded to the server time');

  // Now a markerless heartbeat 200 fires while the LOCAL clock (Date.now(), ~2026) is far
  // ahead of REAL (~2023). The old `: Date.now()` fallback would push maxSeenMs to the future.
  process.env.LICENSE_HEARTBEAT_MS = '20';
  mockResponse = { status: 200, data: {} };
  LC.startHeartbeat(HWID);
  await new Promise<void>((r) => setTimeout(r, 60));
  await flush();
  LC.stopHeartbeat();
  assert.equal(readMetaFile()?.maxSeenMs, REAL, 'maxSeenMs must stay at the server time, never bumped to Date.now()');
});
