import { test } from 'node:test';
import assert from 'node:assert/strict';
import SteamTotp from 'steam-totp';
import { installSteamTotpTimeout, primeSteamTotpOffset, getSteamTotpOffsetSeconds } from '../src/trading/steamTotpTimeout';
import { generateTotpCode, msUntilNextTotp } from '../src/core/LoginFlow';

// ─────────────────────────────────────────────────────────────────────────────
//  H-ACC-079 — the login TOTP primitive must use the same authoritative Steam
//  clock offset the S6 money paths already maintain, so credential logins and the
//  SDA OTP display survive a local clock skewed beyond Steam's TOTP window.
// ─────────────────────────────────────────────────────────────────────────────

// A dummy but well-formed base64 shared_secret (steam-totp only needs decodable bytes).
const SECRET = Buffer.from('this-is-a-16-byte').toString('base64');

// Stub the REAL vendor getTimeOffset to report a deterministic +42s offset BEFORE install, so the S6
// wrapper wraps our stub. installSteamTotpTimeout wires onRealOffset → the process-wide mirror; priming
// then runs the wrapper (→ stub → success → mirror learns 42). node --test isolates module state per file.
(SteamTotp as unknown as { getTimeOffset: (cb: (e: Error | null, o: number) => void) => void }).getTimeOffset =
  (cb) => cb(null, 42);
installSteamTotpTimeout({ timeoutMs: 50 });
primeSteamTotpOffset();

test('H-ACC-079: the mirror learned the primed offset', () => {
  assert.equal(getSteamTotpOffsetSeconds(), 42, 'primeSteamTotpOffset populated the process-wide mirror');
});

test('H-ACC-079: generateTotpCode feeds the learned offset to SteamTotp.generateAuthCode', () => {
  assert.equal(
    generateTotpCode(SECRET),
    SteamTotp.generateAuthCode(SECRET, 42),
    'the login code is offset-corrected, matching an offset-aware direct call',
  );
});

test('H-ACC-079: msUntilNextTotp uses the Steam-corrected epoch (offset +42)', () => {
  const epoch = Math.floor(Date.now() / 1000) + 42;
  const expected = (30 - (epoch % 30)) * 1000;
  assert.equal(msUntilNextTotp(), expected, 'the window boundary reflects epoch+offset');
});
