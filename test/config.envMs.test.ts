import { test } from 'node:test';
import assert from 'node:assert/strict';

import { envMs } from '../src/licensing/config';

// ════════════════════════════════════════════════════════════════════════════
//  H-LIC-018 — numeric env knobs (LICENSE_OFFLINE_GRACE_MS / LICENSE_HEARTBEAT_MS)
//  used to be `Number(process.env.X ?? default)`. The `??` only substitutes the
//  default for null/undefined, so an empty-string (`set "LICENSE_HEARTBEAT_MS="`)
//  or garbage value flowed through: Number('') → 0 (heartbeat becomes a ~1 ms hot
//  loop = self-DoS on the license server) and Number('abc') → NaN (setInterval
//  coerces to 1 ms). `envMs` now rejects empty/garbage/non-positive back to the
//  literal default.
// ════════════════════════════════════════════════════════════════════════════

function withEnv(value: string | undefined, fn: () => void): void {
  const KEY = 'X';
  const prev = process.env[KEY];
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  }
}

test('H-LIC-018: envMs falls back to the default for empty/garbage/non-positive values', () => {
  for (const bad of ['', 'abc', '0', '-5', 'NaN']) {
    withEnv(bad, () => {
      assert.equal(envMs('X', 100), 100, `env value ${JSON.stringify(bad)} must fall back to the default`);
    });
  }
});

test('H-LIC-018: envMs accepts a valid positive numeric string', () => {
  withEnv('5', () => {
    assert.equal(envMs('X', 100), 5, 'a valid positive numeric env value is used');
  });
});

test('H-LIC-018: envMs uses the default when the var is unset', () => {
  withEnv(undefined, () => {
    assert.equal(envMs('X', 100), 100, 'an unset env var falls back to the default');
  });
});
