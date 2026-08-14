import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
//  H-BOOT-022 — migrateVaultDir() renameSyncs the two authoritative vault files
//  (vault.enc / accounts.json). It used to run BEFORE acquireInstanceLock(), so a
//  refused 2nd instance still mutated those files with no cross-process lock — the
//  exact check-then-act the single-instance guard exists to forbid. The call now
//  runs UNDER the lock. (bootstrap() calls process.exit and index.ts self-bootstraps,
//  so an in-process spy is untestable — same rationale as signalShutdown.test.ts;
//  this locks the source order, verified alongside `tsc`.)
// ─────────────────────────────────────────────────────────────────────────────

const SRC = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');

test('H-BOOT-022: migrateVaultDir() runs AFTER acquireInstanceLock() in bootstrap()', () => {
  const boot = /async function bootstrap\(\)[\s\S]*?\n}/.exec(SRC)?.[0] ?? '';
  assert.ok(boot, 'the bootstrap() function must exist');
  const lockIdx = boot.indexOf('acquireInstanceLock(');
  const migrateIdx = boot.indexOf('migrateVaultDir(');
  assert.ok(lockIdx >= 0, 'bootstrap() must still acquire the single-instance lock');
  assert.ok(migrateIdx >= 0, 'bootstrap() must still run the one-time vault migration');
  assert.ok(lockIdx < migrateIdx,
    'the vault-file migration must happen UNDER the single-instance lock, not before it');
});
