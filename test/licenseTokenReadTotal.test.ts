import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readToken } from '../src/licensing/LicenseClient';
import { dataDir } from '../src/utils/paths';

// ════════════════════════════════════════════════════════════════════════════
//  S58 — heartbeat()/validate() read the token OUTSIDE their try, so an AV-locked
//  license.token could turn a fire-and-forget beat into an unhandledRejection
//  (noise the money breaker can't distinguish). The read is now in-try AND
//  readToken() is TOTAL (S38): an unreadable main file falls through to the
//  sidecar and ultimately returns undefined — it never throws.
// ════════════════════════════════════════════════════════════════════════════

test('S58: readToken() returns undefined (never throws) when the token path is unreadable', () => {
  const p = dataDir('license.token');
  // Force readFileSync(p) to throw EISDIR by making the path a DIRECTORY; the .json sidecar is also absent.
  try { fs.rmSync(p, { force: true, recursive: true }); } catch { /* ignore */ }
  try { fs.rmSync(`${p}.json`, { force: true }); } catch { /* ignore */ }
  fs.mkdirSync(p, { recursive: true });
  try {
    let result: string | undefined = 'sentinel';
    assert.doesNotThrow(() => { result = readToken(); }, 'readToken must swallow the read error, not throw');
    assert.equal(result, undefined, 'an unreadable token yields undefined (ride offline grace), not a throw');
  } finally {
    try { fs.rmdirSync(p); } catch { /* best-effort cleanup */ }
  }
});
