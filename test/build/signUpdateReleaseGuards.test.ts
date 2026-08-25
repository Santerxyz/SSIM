import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';

// ════════════════════════════════════════════════════════════════════════════════════════════════
//  sign-update.js release guards (2026-08-25).
//
//  THE INCIDENT. v1.5.2 was published as a GitHub release, but `version.json` on main still said
//  `latest: 1.5.1` and pointed at a `v1.5.1` tag that was never created. Clients on 1.5.1 were told
//  they were current and never saw 1.5.2; clients on 1.5.0 downloaded a 404 every boot. It looked
//  like "auto-update is broken" and went unnoticed for four days, because a stranded client is
//  indistinguishable from a happy one.
//
//  Nothing in the signer objected, because `--version` and `--url` were free text. These two guards
//  make that mismatch unsignable. Either one alone would have caught the incident, which is why both
//  are pinned here: they are cheap, and the failure they prevent is silent and fleet-wide.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const REPO = path.resolve(__dirname, '..', '..');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version as string;

function fixture(): { exe: string; keyPem: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-signguard-'));
  const exe = path.join(dir, 'SSIM.exe');
  fs.writeFileSync(exe, 'not-a-real-exe');
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyPem = path.join(dir, 'k.pem');
  fs.writeFileSync(keyPem, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  return { exe, keyPem };
}

const run = (args: string[]) =>
  spawnSync(process.execPath, ['build/sign-update.js', ...args], { cwd: REPO, encoding: 'utf8' });

const urlFor = (v: string) => `https://github.com/Santerxyz/SSIM/releases/download/v${v}/SSIM.exe`;

test('signing REFUSES a --version that disagrees with package.json', () => {
  const { exe, keyPem } = fixture();
  const wrong = '9.9.9';
  const r = run(['--exe', exe, '--version', wrong, '--url', urlFor(wrong), '--key', keyPem]);

  assert.notEqual(r.status, 0, 'a version mismatch must be a hard failure, not a warning');
  assert.match(r.stderr, /does not match package\.json/i);
  assert.match(r.stderr, new RegExp(PKG_VERSION.replace(/\./g, '\\.')), 'and it names the version it expected');
});

test('signing REFUSES a --url that does not name the version (the v1.5.1 tag typo)', () => {
  const { exe, keyPem } = fixture();
  // The exact shape of the incident: correct version, URL still pointing at the previous tag.
  const r = run(['--exe', exe, '--version', PKG_VERSION, '--url', urlFor('1.0.0'), '--key', keyPem]);

  assert.notEqual(r.status, 0, 'a URL naming the wrong tag publishes a 404 to the whole fleet');
  assert.match(r.stderr, /--url does not contain the version/i);
});

test('both guards can be overridden explicitly, so the signer stays usable off the happy path', () => {
  const { exe, keyPem } = fixture();
  const r = run(['--exe', exe, '--version', '1.3.6', '--url', 'http://cdn/x.exe', '--key', keyPem,
    '--allow-version-mismatch', '--allow-url-mismatch']);

  // It gets PAST the guards. It may still fail later (the public key resolves from dist/ and this
  // throwaway private key will not match it) — what matters is that neither guard is what stopped it.
  assert.doesNotMatch(r.stderr, /does not match package\.json/i, 'the version guard was overridden');
  assert.doesNotMatch(r.stderr, /--url does not contain the version/i, 'the url guard was overridden');
});

test('a matching version and a well-formed release URL pass both guards', () => {
  const { exe, keyPem } = fixture();
  const r = run(['--exe', exe, '--version', PKG_VERSION, '--url', urlFor(PKG_VERSION), '--key', keyPem]);

  assert.doesNotMatch(r.stderr, /does not match package\.json/i);
  assert.doesNotMatch(r.stderr, /--url does not contain the version/i);
});
