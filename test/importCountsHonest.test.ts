import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { maFilesDir, vaultDir } from '../src/utils/paths';
import { listDropZoneMaFiles, parseAccountsCsv } from '../src/core/maFiles';
import { AccountVault } from '../src/core/AccountVault';
import { AccountManager } from '../src/core/AccountManager';
import { importDropZoneIntoVault, importCsvIntoVault } from '../src/core/vaultBoot';

// ─── H-ACC-078: import pipelines must never lose an entry silently ──────────────
// Three funnels used to drop input with self-consistent-looking counts: a drop-zone
// file that is unparseable / has no account_name / no shared_secret vanished from the
// modal AND was neither imported nor skipped; a parser-dropped CSV row never reached
// the reported totals. The invariant now enforced: imported + skipped(with reasons)
// == submitted, for both the drop-zone and CSV paths.

const DIR = maFilesDir();
const PREFIX = 'hacc078-';                       // unique tag so we ignore any stray drop-zone files
const written: string[] = [];

function writeFile(name: string, content: string): string {
  const p = path.join(DIR, name);
  fs.writeFileSync(p, content, 'utf-8');
  written.push(p);
  return name;
}

function cleanVaultDir(): void {
  for (const f of ['vault.enc', 'vault.enc.bak', 'accounts.json', 'accounts.json.bak']) {
    try { fs.rmSync(vaultDir(f), { force: true }); } catch { /* ignore */ }
  }
}

const SECRET = 'wWa1xZ3qShared==';
const VALID   = `${PREFIX}valid.maFile`;
const BADJSON = `${PREFIX}badjson.maFile`;
const NOSECRET = `${PREFIX}nosecret.maFile`;

before(() => {
  fs.mkdirSync(DIR, { recursive: true });
  writeFile(VALID,   JSON.stringify({ account_name: `${PREFIX}bot`, shared_secret: SECRET }));
  writeFile(BADJSON, 'this is not json {');                                  // unparseable
  writeFile(NOSECRET, JSON.stringify({ account_name: `${PREFIX}nosec` }));   // no shared_secret
  // accounts.txt password so the ONE valid file is actually importable (else it'd skip "no password").
  writeFile('accounts.txt', `${PREFIX}bot:hunter2\n`);
});
after(() => {
  for (const p of written) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  cleanVaultDir();
});

test('listDropZoneMaFiles: 1 valid entry + 2 unreadable (nothing silently swallowed)', () => {
  const { entries, unreadable } = listDropZoneMaFiles();
  const mine = entries.filter((e) => e.file.startsWith(PREFIX));
  const badFiles = unreadable.filter((u) => u.file.startsWith(PREFIX));
  assert.equal(mine.length, 1, 'only the valid maFile is a usable entry');
  assert.equal(mine[0].file, VALID);
  assert.equal(badFiles.length, 2, 'the invalid-JSON and the shared_secret-less file are reported, not dropped');
  const byFile = new Map(badFiles.map((u) => [u.file, u.reason]));
  assert.match(byFile.get(BADJSON) || '', /^unreadable:/);
  assert.equal(byFile.get(NOSECRET), 'no shared_secret');
});

test('importDropZoneIntoVault: ticking all three yields imported===1, skipped===2 with 2 reasons', () => {
  cleanVaultDir();
  try {
    AccountVault.unlockOrCreate('local-pw');
    const accounts = new AccountManager();
    const env = accounts.defaultEnvironmentId();

    const r = importDropZoneIntoVault(accounts, env, null, [VALID, BADJSON, NOSECRET]);
    assert.equal(r.imported, 1, 'only the valid, passworded maFile imports');
    assert.equal(r.skipped, 2, 'the two unreadable/unusable ticked files are counted as skipped');
    const mine = r.reasons.filter((x) => x.file.startsWith(PREFIX));
    assert.equal(mine.length, 2, 'every skipped ticked file carries a reason (no silent no-op)');
    assert.equal(r.imported + r.skipped, 3, 'invariant: imported + skipped === submitted');
  } finally {
    cleanVaultDir();
  }
});

test('parseAccountsCsv: 1 valid, 1 two-column, 1 missing-secret → rows===1, rejected===2', () => {
  const csv = [
    `${PREFIX}csvbot,pw,${SECRET},`,   // valid
    `${PREFIX}short,pw`,               // too few columns
    `${PREFIX}nosec,pw,,idsec`,        // missing shared_secret
  ].join('\n');
  const { rows, rejected } = parseAccountsCsv(csv);
  assert.equal(rows.length, 1, 'only the well-formed row parses');
  assert.equal(rejected.length, 2, 'the two malformed rows are rejected, not silently dropped');
  const reasons = rejected.map((x) => x.reason).sort();
  assert.deepEqual(reasons, ['missing username/password/shared_secret', 'too few columns']);
});

test('importCsvIntoVault: skipped total includes parser-rejected rows so counts sum to submitted', () => {
  cleanVaultDir();
  try {
    AccountVault.unlockOrCreate('local-pw');
    const accounts = new AccountManager();
    const env = accounts.defaultEnvironmentId();

    const csv = [
      `${PREFIX}csvbot,pw,${SECRET},`,   // valid → imported
      `${PREFIX}short,pw`,               // too few columns → rejected
      `${PREFIX}nosec,pw,,idsec`,        // missing shared_secret → rejected
    ].join('\n');
    const r = importCsvIntoVault(accounts, csv, env, null);
    assert.equal(r.imported, 1, 'the one valid row imports');
    assert.equal(r.rejected.length, 2, 'the two malformed rows are surfaced');
    assert.equal(r.imported + r.skipped, 3, 'invariant: imported + skipped === submitted (3 data rows)');
  } finally {
    cleanVaultDir();
  }
});
