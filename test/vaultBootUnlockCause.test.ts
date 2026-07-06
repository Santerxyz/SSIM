import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountVault, VAULT_NEWER_VERSION_ERROR } from '../src/core/AccountVault';
import { unlockVault } from '../src/core/vaultBoot';
import { logger } from '../src/utils/logger';

// H-ACC-025: the HEADLESS boot-unlock catch must name the real cause, not collapse every failure
// into "wrong password". A newer-vault refusal (Error(VAULT_NEWER_VERSION_ERROR)) — whose whole
// purpose is to say "update SSIM first" instead of the wrong-password screen (B30) — must produce
// the update-first wording and NOT the "did not unlock" text.
test('H-ACC-025: headless boot unlock reports a newer-vault refusal as "update SSIM first"', async () => {
  const errors: string[] = [];

  // Drive the headless branch (no TTY, SSIM_VAULT_PASSWORD set) against a vault that reports it
  // exists but whose unlockOrCreate throws the newer-version error.
  const origIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const origEnv = process.env.SSIM_VAULT_PASSWORD;
  const origCreateEnv = process.env.SSIM_VAULT_CREATE;
  const origExit = process.exit;
  const origError = logger.error;
  const origIsEnabled = AccountVault.isEnabled;
  const origExists = AccountVault.exists;
  const origUnlockOrCreate = AccountVault.unlockOrCreate;

  try {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    process.env.SSIM_VAULT_PASSWORD = 'correct-horse';
    delete process.env.SSIM_VAULT_CREATE;
    AccountVault.isEnabled = () => false;                       // not already unlocked → don't skip the prompt
    AccountVault.exists = () => true;                            // an EXISTING vault (not a first run)
    AccountVault.unlockOrCreate = () => { throw new Error(VAULT_NEWER_VERSION_ERROR); };
    (logger as unknown as { error: (m: string) => void }).error = (m: string) => { errors.push(String(m)); };
    (process as unknown as { exit: (c?: number) => never }).exit =
      ((code?: number) => { throw new Error(`EXIT:${code ?? 0}`); }) as (c?: number) => never;

    await assert.rejects(() => unlockVault(), /EXIT:1/, 'the headless catch exits(1) after logging the cause');
  } finally {
    if (origIsTTY) Object.defineProperty(process.stdin, 'isTTY', origIsTTY);
    if (origEnv === undefined) delete process.env.SSIM_VAULT_PASSWORD; else process.env.SSIM_VAULT_PASSWORD = origEnv;
    if (origCreateEnv === undefined) delete process.env.SSIM_VAULT_CREATE; else process.env.SSIM_VAULT_CREATE = origCreateEnv;
    process.exit = origExit;
    logger.error = origError;
    AccountVault.isEnabled = origIsEnabled;
    AccountVault.exists = origExists;
    AccountVault.unlockOrCreate = origUnlockOrCreate;
  }

  const joined = errors.join('\n');
  assert.match(joined, /update SSIM first/, 'names the newer-vault cause');
  assert.doesNotMatch(joined, /did not unlock/, 'does NOT mislabel it as a wrong password');
});
