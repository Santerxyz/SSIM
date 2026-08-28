import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'os';
import { getSpoofedHostname } from 'steam-session/dist/helpers';
import { deviceNameFor, randomDeviceName, logonIdFor, deviceLogOnFields, seededBytes } from '../src/network/accountIdentity';
import { buildLogOnOptions, buildTokenLogOnOptions } from '../src/core/LoginFlow';
import { generateBilling, generateBillingEmail } from '../src/trading/AccountTrader';

// ════════════════════════════════════════════════════════════════════════════════════════════════
//  Audited 2026-08-27: every account in the fleet logged in claiming to be the SAME PC. Neither
//  login path passed a device name, so both fell through to steam-session's getSpoofedHostname() —
//  a sha1 of the OPERATOR's os.hostname(), i.e. one value per installation. 500+ accounts on 500+
//  residential exits all reported one high-entropy string as device_friendly_name, and Steam stores
//  it in each account's authorized-device list permanently.
//
//  These tests pin the three properties the fix depends on: the name is DERIVED from the account,
//  it is STABLE across logins (a PC that renames itself every session is its own anomaly), and it
//  is no longer the installation-wide value.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const BOTS = ['renewbot', 'donaldjohnston02', 'lilycepeda93', 'zalthorvexin24', 'xblacksanterx'];

test('device name is distinct per account', () => {
  const names = BOTS.map(deviceNameFor);
  assert.equal(new Set(names).size, BOTS.length, 'two accounts collided on one device name');
  for (const n of names) assert.match(n, /^DESKTOP-[A-Z]{7}$/, `${n} is not the Windows default shape`);
});

test('device name is stable across logins and case-insensitive in the username', () => {
  assert.equal(deviceNameFor('renewbot'), deviceNameFor('renewbot'));
  assert.equal(deviceNameFor('RenewBot'), deviceNameFor('renewbot'), 'a re-cased record must not mint a second PC');
  assert.equal(deviceNameFor('  renewbot '), deviceNameFor('renewbot'));
});

test('device name is NOT the installation-wide spoofed hostname', () => {
  // The regression this whole module exists to prevent: if any account ever reports this value
  // again, it is sharing an identity with every other account on the operator's machine.
  const shared = getSpoofedHostname();
  assert.match(shared, /^DESKTOP-[A-Z]{7}$/, 'library shape changed — re-check the fallback path');
  for (const bot of BOTS) assert.notEqual(deviceNameFor(bot), shared);
  // …and it must not be the raw machine hostname either.
  for (const bot of BOTS) assert.notEqual(deviceNameFor(bot), hostname());
});

test('randomDeviceName is fresh each call (the QR import, which has no account name yet)', () => {
  const names = new Set(Array.from({ length: 64 }, randomDeviceName));
  assert.ok(names.size > 60, `expected ~64 distinct names, got ${names.size}`);
  for (const n of names) assert.match(n, /^DESKTOP-[A-Z]{7}$/);
});

test('logonID is a plausible private LAN address, stable and per-account', () => {
  for (const bot of BOTS) {
    const ip = logonIdFor(bot);
    // steam-user only obfuscates a value matching this shape; anything else is passed through raw.
    assert.match(ip, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    assert.ok(/^(192\.168\.|10\.0\.)/.test(ip), `${ip} is not an RFC1918 home subnet`);
    const host = Number(ip.split('.')[3]);
    assert.ok(host >= 2 && host <= 250, `${ip} host octet ${host} outside the sane DHCP range`);
    assert.equal(logonIdFor(bot), ip, 'logonID must not change between logins');
  }
  assert.ok(new Set(BOTS.map(logonIdFor)).size > 1, 'every account got the same LAN address');
});

test('both login paths carry the device fields, and agree on the PC', () => {
  const account = { username: 'renewbot', password: 'pw', environmentId: 'e1' } as never;
  const credential = buildLogOnOptions(account, { shared_secret: 'cnOgv/KdpLoP6Nbh0GMkXkPXALQ=' } as never);
  const token = buildTokenLogOnOptions('renewbot', 'eyJhbGciOi.fake.token');

  for (const [label, opts] of [['credential', credential], ['token', token]] as const) {
    assert.equal(opts.machineName, deviceNameFor('renewbot'), `${label} path lost the device name`);
    assert.equal(opts.logonID, logonIdFor('renewbot'), `${label} path lost the logonID`);
  }
  // The two paths must land on ONE PC. An account that reports a different machine depending on
  // whether its token was still valid is the anomaly this module exists to avoid.
  assert.equal(credential.machineName, token.machineName);
  assert.equal(credential.logonID, token.logonID);
  assert.deepEqual(deviceLogOnFields('renewbot'), { machineName: token.machineName, logonID: token.logonID });
  // The token itself still rides along untouched.
  assert.equal(token.refreshToken, 'eyJhbGciOi.fake.token');
});

test('seededBytes is deterministic, domain-separated and extends past one hash block', () => {
  const a = seededBytes('renewbot', 'billing');
  const b = seededBytes('renewbot', 'billing');
  const c = seededBytes('renewbot', 'device-name');
  const drawA = Array.from({ length: 200 }, a);   // > 32 bytes ⇒ exercises the re-hash
  const drawB = Array.from({ length: 200 }, b);
  const drawC = Array.from({ length: 200 }, c);
  assert.deepEqual(drawA, drawB);
  assert.notDeepEqual(drawA, drawC, 'two domains produced the same stream — derivations would collide');
  assert.ok(new Set(drawA.slice(32, 200)).size > 20, 'stream degenerated after the first block');
});

test('billing is stable per account and distinct between accounts', () => {
  const one = generateBilling('renewbot', 'DE');
  assert.deepEqual(generateBilling('renewbot', 'DE'), one, 'a second order must reuse the saved address');
  assert.notDeepEqual(generateBilling('lilycepeda93', 'DE'), one);
  // Format contract Steam enforces: non-empty fields, exactly 5 postal digits, country passed through.
  assert.match(one.postalCode ?? '', /^\d{5}$/);
  assert.match(one.firstName ?? '', /^[A-Z][a-z]{4,7}$/);
  assert.match(one.lastName ?? '', /^[A-Z][a-z]{4,7}$/);
  assert.match(one.address ?? '', /^[A-Z][a-z]{4,7} \d{1,2}$/);
  assert.match(one.city ?? '', /^[A-Z][a-z]{5,9}$/);
  assert.equal(one.country, 'DE');
  assert.equal(one.save, true);
  // The country is a per-call argument, not part of the seed — a CZ account keeps its own address.
  assert.equal(generateBilling('renewbot', 'CZ').postalCode, one.postalCode);
  assert.equal(generateBilling('renewbot', 'CZ').country, 'CZ');
});

test('billing email is stable per account and distinct between accounts', () => {
  assert.equal(generateBillingEmail('renewbot'), generateBillingEmail('renewbot'));
  assert.notEqual(generateBillingEmail('renewbot'), generateBillingEmail('lilycepeda93'));
  assert.match(generateBillingEmail('renewbot'), /^[a-z0-9]{12}@gmail\.com$/);
});

// ── Vendored-library contract ───────────────────────────────────────────────────────────────────
//  The fix only works because steam-user promotes `machine_name` from the logOn details into
//  steam-session's `machineFriendlyName`, and because a refreshToken logon (the everyday path for
//  the whole fleet) does NOT strip that field. Both are library internals, node_modules is
//  git-ignored, and the tree is baked into the .exe at build time — so a dependency bump could
//  silently put every account back on one shared hostname with nothing in SSIM's own code changing.
//  These pin the promotion against the INSTALLED libraries.
// ────────────────────────────────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-var-requires */
const steamUserMessages = require('steam-user/components/03-messages');
const logonSource: string = require('fs').readFileSync(require.resolve('steam-user/components/09-logon.js'), 'utf8');

/** The device_friendly_name steam-session would put on the wire for the given logOn details. */
function wireDeviceName(logOnDetails: Record<string, unknown>): string {
  const session = steamUserMessages.prototype._getLoginSession.call({ _logOnDetails: logOnDetails });
  return session._handler._getPlatformData().deviceDetails.device_friendly_name;
}

test('steam-user promotes machineName all the way to device_friendly_name', () => {
  assert.equal(wireDeviceName({ machine_name: 'DESKTOP-ZZZZZZZ' }), 'DESKTOP-ZZZZZZZ');
  // …and the pre-fix shape (no machine_name) still falls back to the installation-wide hostname,
  // which is what makes passing the field load-bearing rather than cosmetic.
  assert.equal(wireDeviceName({}), getSpoofedHostname());
});

test('a refreshToken logon keeps the device fields', () => {
  const disallowed = /let disallowedProps = \[([\s\S]*?)\];/.exec(logonSource);
  assert.ok(disallowed, 'steam-user restructured its refreshToken property filter — re-verify the token path');
  assert.ok(!disallowed[1].includes('machine_name'), 'refreshToken logons now strip machine_name');
  assert.ok(!disallowed[1].includes('obfuscated_private_ip'), 'refreshToken logons now strip obfuscated_private_ip');
});

test('a dotted logonID is obfuscated into a NON-ZERO private IP', () => {
  // steam-user only applies the mask to this exact shape; anything else is sent through raw, and an
  // unset logonID sends 0 — which no real Steam client does.
  const mask = /PRIVATE_IP_OBFUSCATION_MASK = (0x[0-9a-fA-F]+)/.exec(logonSource);
  assert.ok(mask, 'steam-user renamed its obfuscation mask — re-verify the logonID shape');
  const { IPv4 } = require('@doctormckay/stdlib');
  for (const bot of BOTS) {
    const obfuscated = (IPv4.stringToInt(logonIdFor(bot)) ^ Number(mask[1])) >>> 0;
    assert.notEqual(obfuscated, 0);
  }
});
