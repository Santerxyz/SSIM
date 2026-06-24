import { test } from 'node:test';
import assert from 'node:assert/strict';

// Smoke test: proves the node:test + ts-node harness is wired up.
test('harness: TypeScript test file loads and runs', () => {
  const x: number = 2 + 2;
  assert.equal(x, 4);
});
