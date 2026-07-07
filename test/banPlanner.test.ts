import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPerEnvBanChecks } from '../src/trading/BanService';

// ─── H-TRD-037: restore the "unit-tested in isolation" claim on planPerEnvBanChecks ──
// The PURE F3c per-environment ban-key planner (BanService.ts) documents itself as unit-tested,
// but no test in the tree exercised it (the original harness lived in the removed _smoke/ dir).
// These cases guard the strict cross-env-isolation property the whole F3c design hangs on:
// every assignment's SteamIDs belong to a single environment, chunks never exceed the clamped
// per-key cap, key indices rotate 0..k-1, and anything an env can't cover surfaces as uncovered.
// The function is imported directly (no live deps) — consistent with sibling ban tests.

// SteamIDs are opaque strings to the planner; unique, env-tagged tokens are enough to prove partitioning.
const sid = (env: string, i: number): string => `${env}-${i}`;

test('H-TRD-037 (1): one env, 120 targets, 3 keys @ perKey 50 → 50/50/20 across keyIndex 0/1/2, none uncovered', () => {
  const targets = Array.from({ length: 120 }, (_, i) => ({ steamId: sid('a', i), envId: 'env-a' }));
  const { assignments, uncovered } = planPerEnvBanChecks(targets, new Map([['env-a', 3]]), 50);

  assert.deepEqual(assignments.map((a) => a.keyIndex), [0, 1, 2], 'key indices rotate 0..k-1');
  assert.deepEqual(assignments.map((a) => a.steamIds.length), [50, 50, 20], 'chunks fill to cap then remainder');
  assert.deepEqual(
    assignments.flatMap((a) => a.steamIds),
    targets.map((t) => t.steamId),
    'the assignments are an exact, in-order partition of the targets — no loss or duplication',
  );
  assert.equal(uncovered.length, 0, 'capacity (150) exceeds targets (120) → nothing uncovered');
});

test('H-TRD-037 (2): interleaved envs → every assignment is single-env and its ids belong to that env', () => {
  const targets: Array<{ steamId: string; envId: string }> = [];
  for (let i = 0; i < 30; i++) {
    targets.push({ steamId: sid('a', i), envId: 'env-a' });
    targets.push({ steamId: sid('b', i), envId: 'env-b' });
  }
  const { assignments, uncovered } = planPerEnvBanChecks(
    targets,
    new Map([['env-a', 2], ['env-b', 2]]),
    50,
  );

  const envOf = new Map(targets.map((t) => [t.steamId, t.envId]));
  for (const a of assignments) {
    for (const s of a.steamIds) {
      assert.equal(envOf.get(s), a.envId, 'no assignment may mix environments (strict cross-env isolation)');
    }
  }
  assert.equal(uncovered.length, 0, 'both envs fit within capacity');
});

test('H-TRD-037 (3): an env with 0 keys → all its targets uncovered, other envs unaffected', () => {
  const targets = [
    ...Array.from({ length: 5 }, (_, i) => ({ steamId: sid('a', i), envId: 'env-a' })),
    ...Array.from({ length: 4 }, (_, i) => ({ steamId: sid('b', i), envId: 'env-b' })),
  ];
  const { assignments, uncovered } = planPerEnvBanChecks(
    targets,
    new Map([['env-a', 1], ['env-b', 0]]),
    50,
  );

  assert.deepEqual(assignments.map((a) => a.envId), ['env-a'], 'only the key-bearing env produces assignments');
  assert.equal(assignments[0].steamIds.length, 5, 'env-a fully covered');
  assert.equal(uncovered.length, 4, 'every env-b target is uncovered');
  for (const u of uncovered) assert.equal(u.envId, 'env-b', 'the uncovered all belong to the 0-key env');
});

test('H-TRD-037 (4): more targets than keys × perKey → exact remainder uncovered, capacity fully packed', () => {
  // 1 env, 2 keys, perKey 3 → capacity 6; 10 targets → 4 uncovered.
  const targets = Array.from({ length: 10 }, (_, i) => ({ steamId: sid('a', i), envId: 'env-a' }));
  const { assignments, uncovered } = planPerEnvBanChecks(targets, new Map([['env-a', 2]]), 3);

  assert.deepEqual(assignments.map((a) => a.steamIds.length), [3, 3], 'both keys packed to the cap');
  assert.equal(uncovered.length, 4, 'exactly the 4 targets beyond capacity');
  assert.deepEqual(
    uncovered.map((u) => u.steamId),
    targets.slice(6).map((t) => t.steamId),
    'the uncovered are precisely the trailing remainder, in order',
  );
});

test('H-TRD-037 (5a): perKey 0 / -5 clamp to cap 1 (never loops, one id per chunk)', () => {
  for (const perKey of [0, -5]) {
    const targets = Array.from({ length: 3 }, (_, i) => ({ steamId: sid('a', i), envId: 'env-a' }));
    const { assignments, uncovered } = planPerEnvBanChecks(targets, new Map([['env-a', 3]]), perKey);

    assert.deepEqual(
      assignments.map((a) => a.steamIds.length),
      [1, 1, 1],
      `perKey ${perKey} clamps to cap 1 → one id per assignment (no infinite loop)`,
    );
    assert.deepEqual(assignments.map((a) => a.keyIndex), [0, 1, 2]);
    assert.equal(uncovered.length, 0);
  }
});

test('H-TRD-037 (5b): fractional perKey 2.7 floors to 2 (never over-fills a chunk)', () => {
  const targets = Array.from({ length: 5 }, (_, i) => ({ steamId: sid('a', i), envId: 'env-a' }));
  const { assignments, uncovered } = planPerEnvBanChecks(targets, new Map([['env-a', 3]]), 2.7);

  assert.deepEqual(assignments.map((a) => a.steamIds.length), [2, 2, 1], 'cap floors to 2 (3×2 capacity ≥ 5)');
  for (const a of assignments) assert.ok(a.steamIds.length <= 2, 'never over-fills the clamped chunk size');
  assert.equal(uncovered.length, 0);
});
