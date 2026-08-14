import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import SteamTotp from 'steam-totp';
import type { MaFile } from '../src/types/account';
import { installSteamTotpTimeout, primeSteamTotpOffset } from '../src/trading/steamTotpTimeout';
import { buildLogOnOptions, restampTotp } from '../src/core/LoginFlow';

// ─────────────────────────────────────────────────────────────────────────────
//  H-ACC-080 — buildLogOnOptions bakes a single-window TOTP code into a payload
//  that SessionManager re-sends for up to ~2 min. restampTotp must refresh that
//  code to the CURRENT 30s window before each retry so attempt 2 carries a live
//  code instead of losing the stale-code Steam Guard race against the login timeout.
// ─────────────────────────────────────────────────────────────────────────────

// A dummy but well-formed base64 shared_secret (steam-totp only needs decodable bytes).
const SECRET = Buffer.from('this-is-a-16-byte').toString('base64');

// Prime the process-wide offset mirror to 0 (no skew) so restampTotp's code equals a
// plain SteamTotp.generateAuthCode(secret) call. node --test isolates module state per file.
(SteamTotp as unknown as { getTimeOffset: (cb: (e: Error | null, o: number) => void) => void }).getTimeOffset =
  (cb) => cb(null, 0);
installSteamTotpTimeout({ timeoutMs: 50 });
primeSteamTotpOffset();

const account = { username: 'bot1', password: 'pw', maFilePath: 'bot1.maFile' } as unknown as
  Parameters<typeof buildLogOnOptions>[0];
const maFile = { shared_secret: SECRET } as unknown as MaFile;

test('H-ACC-080: restampTotp refreshes a stale-window code to the current window', () => {
  mock.timers.enable({ apis: ['Date'] });
  try {
    // T: build the payload → code A.
    const t0 = 1_700_000_000_000; // a fixed epoch on a 30s boundary is not required
    mock.timers.setTime(t0);
    const options = buildLogOnOptions(account, maFile) as Record<string, unknown>;
    const codeA = options.twoFactorCode;

    // Advance 90s (three full TOTP windows) — the baked code is now long dead.
    mock.timers.setTime(t0 + 90_000);
    restampTotp(options, maFile);

    assert.notEqual(options.twoFactorCode, codeA, 'the re-stamped code is not the stale one');
    assert.equal(
      options.twoFactorCode,
      SteamTotp.generateAuthCode(SECRET, 0),
      'the re-stamped code is the current-window offset-corrected code at T+90',
    );
  } finally {
    mock.timers.reset();
  }
});

test('H-ACC-080: SessionManager re-stamps the TOTP inside attemptLogin before every retry', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'core', 'SessionManager.ts'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('private async attemptLogin(');
  assert.notEqual(start, -1, 'attemptLogin exists');
  // Bound the scan to attemptLogin's body (up to the next private method, performLogin).
  const end = src.indexOf('private tryLoadMaFile', start);
  const body = src.slice(start, end === -1 ? undefined : end);
  assert.match(
    body,
    /for\s*\([\s\S]*restampTotp\([\s\S]*this\.performLogin/,
    'restampTotp is called inside the retry for-loop before performLogin',
  );
});
