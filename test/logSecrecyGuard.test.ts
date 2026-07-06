import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from '../src/utils/redact';

// ════════════════════════════════════════════════════════════════════════════
//  H-XCT-009 — the canonical redactor (redact.ts) scrubs ONLY proxy credentials.
//  Non-proxy secret VALUES (identity_secret / shared_secret / revocation_code /
//  tokens / password / license key / 2FA code) have NO masker — the guarantee
//  those values "never land at rest" is upheld by NEVER passing them to a sink,
//  not by scrubbing. This source-level guard (S62/serverAsyncHandler precedent)
//  makes that a build invariant: it FAILS if any logger.* / writeCrash / res.json /
//  res.write('data:…') call feeds a secret-named identifier into the sink — either
//  interpolated (`${…refresh_token…}`) or as a metadata object key ({ token: x }).
//  Static prose that merely NAMES a secret ("maFile missing identity_secret") is
//  fine — only a secret in a dynamic (value-bearing) position trips the scan.
// ════════════════════════════════════════════════════════════════════════════

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const SECRET = 'identity_secret|shared_secret|revocation_code|refresh_?token|access_?token|\\bpassword\\b|apiKey|licenseKey|twoFactorCode';
const SINK = /(logger\.(info|warn|error|debug)|writeCrash|res\.json|res\.write)\s*\(/;
// A secret name inside a ${…} interpolation → a value is being formatted into the sink.
const SECRET_INTERP = new RegExp(`\\$\\{[^}]*(${SECRET})[^}]*\\}`, 'i');
// A secret name as an object key ({ token: x } or shorthand { token }) → metadata leak (H-BOOT-015).
const SECRET_OBJKEY = new RegExp(`[{,]\\s*(${SECRET})\\s*[,:}]`, 'i');

test('H-XCT-009: no non-proxy secret VALUE is fed to a log/crash/API sink', () => {
  const files = walk(join(__dirname, '..', 'src'));
  const offenders: string[] = [];
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!SINK.test(line)) return;
      if (SECRET_INTERP.test(line) || SECRET_OBJKEY.test(line)) {
        offenders.push(`${f.split(/[\\/]/).slice(-2).join('/')}:${i + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    `no non-proxy secret VALUE may be passed to a log/crash/API sink (redact.ts does not scrub them); found: ${offenders.join('  |  ')}`);
});

test('H-XCT-009: the guard would catch a planted secret-bearing sink call', () => {
  // Sanity: the detection is live, not vacuously green.
  const planted = [
    'logger.warn("t", { refresh_token: x })',
    'logger.error(`login failed ${acct.access_token}`)',
    'res.json({ error: e.message, shared_secret })',
  ];
  for (const p of planted) {
    const caught = SINK.test(p) && (SECRET_INTERP.test(p) || SECRET_OBJKEY.test(p));
    assert.ok(caught, `guard must flag a planted secret-at-sink: ${p}`);
  }
  // …and must NOT flag prose that merely names a secret.
  const prose = "logger.warn(`[${account.username}] maFile missing identity_secret (confirmations won't work)`)";
  assert.ok(!(SECRET_INTERP.test(prose) || SECRET_OBJKEY.test(prose)), 'prose naming a secret must not trip the guard');
});

test('H-XCT-009: canonical redactSecrets masks the scheme-less legacy proxy form (H-ACC-006 gap)', () => {
  // The whole-string legacy form host:port:user:pass was NOT masked by the old URL-only regex.
  const out = redactSecrets('1.2.3.4:3128:secretuser:secretpass');
  assert.ok(!out.includes('secretuser') && !out.includes('secretpass'), `legacy proxy creds leaked: ${out}`);
  assert.ok(out.includes('***:***@'), `masked form expected: ${out}`);
});

test('H-XCT-009: canonical redactSecrets still masks embedded URL userinfo and leaves prose intact', () => {
  const masked = redactSecrets('connect ECONNREFUSED via http://bob:hunter2@10.0.0.1:8080 while buying');
  assert.ok(!masked.includes('hunter2'), 'URL password must not survive in an error message');
  assert.equal(redactSecrets('heapUsed=123MB heapTotal=456MB at 12:34:56'), 'heapUsed=123MB heapTotal=456MB at 12:34:56');
});
