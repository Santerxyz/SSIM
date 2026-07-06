import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlockVault } from '../src/core/vaultBoot';
import { AccountVault } from '../src/core/AccountVault';

// ─── H-ACC-022: a runtime license re-gate calls unlockVault() again while the vault
//     is STILL unlocked (teardown flushes but never locks). It must short-circuit on
//     the already-unlocked state instead of re-prompting / aborting. ───────────────
test('H-ACC-022: unlockVault() with the vault already unlocked resolves without prompting or exiting', async () => {
  const origIsEnabled = AccountVault.isEnabled;
  const origIsTTY = process.stdin.isTTY;
  const origEnvPw = process.env.SSIM_VAULT_PASSWORD;
  const origExit = process.exit;

  // No TTY and no env var: today's code would abort with exit(1) at the headless guard.
  AccountVault.isEnabled = () => true;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  delete process.env.SSIM_VAULT_PASSWORD;
  let exited = false;
  // @ts-expect-error test stub for process.exit
  process.exit = ((): never => { exited = true; throw new Error('process.exit called'); });

  try {
    await unlockVault(); // must resolve — the short-circuit fires before the headless branch
    assert.equal(exited, false, 'process.exit must NOT be called when the vault is already unlocked');
  } finally {
    AccountVault.isEnabled = origIsEnabled;
    Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    if (origEnvPw === undefined) delete process.env.SSIM_VAULT_PASSWORD; else process.env.SSIM_VAULT_PASSWORD = origEnvPw;
    process.exit = origExit;
  }
});
