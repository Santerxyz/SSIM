import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from '../src/utils/logger';

// ════════════════════════════════════════════════════════════════════════════
//  H-TRD-035 — BanService surfaces error strings to the API (info.error →
//  res.json → DOM). A failed PROXIED login puts the full scheme://user:pass@host
//  URL into Error.message (see logger.ts:14-18), so any info.error derived from
//  err.message must pass through redactSecrets before it leaves the process.
//  This is a source-level regression guard (S62/serverAsyncHandler precedent):
//  it fails if any such assignment reappears without redactSecrets.
// ════════════════════════════════════════════════════════════════════════════

test('H-TRD-035: every error string in BanService that interpolates err.message is redacted', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'trading', 'BanService.ts'), 'utf8').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  // Any line that (a) builds an error string surfaced to the API — an `info.error =`
  // assignment or a `msg` const written into info.error — AND (b) interpolates the
  // caught error's message, MUST wrap it in redactSecrets.
  const errMsg = /\berr(?:\s+as\s+Error)?\)?\.message/;
  const surfaced = /(info\.error\s*=|const\s+msg\s*=)/;
  const offenders: string[] = [];
  lines.forEach((line, i) => {
    if (errMsg.test(line) && surfaced.test(line) && !line.includes('redactSecrets(')) {
      offenders.push(`${i + 1}: ${line.trim()}`);
    }
  });
  assert.deepEqual(offenders, [],
    `every API-surfaced error string interpolating err.message must be wrapped in redactSecrets; found: ${offenders.join('  |  ')}`);
});

test('H-TRD-035: redactSecrets masks proxy userinfo embedded in a login-failure message', () => {
  const masked = redactSecrets(
    'tunneling socket could not be established, cause=connect ECONNREFUSED http://u:p@1.2.3.4:8080');
  assert.ok(!masked.includes('u:p@'), `proxy userinfo must not survive: ${masked}`);
  assert.ok(masked.includes('***:***@'), `masked form expected: ${masked}`);
});
