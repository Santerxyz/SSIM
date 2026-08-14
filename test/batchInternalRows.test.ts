import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BatchJobService, JobRegistry, type BatchAccounts, type JobDef } from '../src/core/BatchJobService';

// ════════════════════════════════════════════════════════════════════════════════════════════════
//  W4_41 — the batch engine's internal loop now PUBLISHES what each account actually did.
//
//  done/failed counts cannot express a money job's outcomes: "already owned", "wallet too low" and
//  "bought" are all non-failures that mean very different things, and a run that reported them only
//  as `done` would be indistinguishable from one that spent real money on every account. These tests
//  pin the two halves of that contract: rows appear as they happen, and jobs that return nothing
//  (every pre-W4_41 job) are completely unaffected.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const accounts: BatchAccounts = {
  get: (u) => (['a', 'b', 'c'].includes(u) ? { username: u, enabled: true } : undefined),
  getByEnvironment: () => [],
};

function serviceFor(perAccount: (u: string, i: number) => Promise<unknown>): BatchJobService {
  const def: JobDef = {
    jobType: 'j', label: 'J', group: 'money', moneySafe: true, enabled: true, experimental: true, paramSchema: [],
    adapter: async ({ runInternal }) => { runInternal(perAccount); return { source: { kind: 'internal' } }; },
  };
  return new BatchJobService(accounts, new JobRegistry().add(def));
}

/** The internal loop is fire-and-forget; wait for it to drain. */
async function settle(svc: BatchJobService): Promise<void> {
  for (let i = 0; i < 200 && svc.status().running; i++) await new Promise((r) => setTimeout(r, 5));
}

test('H-BAT-010: a row returned per account is published on status().result.rows, in order', async () => {
  const svc = serviceFor(async (u) => ({ username: u, status: 'owned' }));
  await svc.run({ jobType: 'j', scope: { usernames: ['a', 'b', 'c'] } });
  await settle(svc);
  const st = svc.status();
  assert.equal(st.done, 3);
  assert.deepEqual((st.result as { rows: unknown[] }).rows, [
    { username: 'a', status: 'owned' }, { username: 'b', status: 'owned' }, { username: 'c', status: 'owned' },
  ]);
});

test('H-BAT-011: a job that returns nothing leaves result unset — no behaviour change for existing jobs', async () => {
  const svc = serviceFor(async () => undefined);
  await svc.run({ jobType: 'j', scope: { usernames: ['a', 'b'] } });
  await settle(svc);
  const st = svc.status();
  assert.equal(st.done, 2);
  assert.equal(st.result, undefined);
});

test('H-BAT-012: an account that THREW is counted failed and contributes no row — the two never conflate', async () => {
  const svc = serviceFor(async (u) => { if (u === 'b') throw new Error('boom'); return { username: u, status: 'purchased' }; });
  await svc.run({ jobType: 'j', scope: { usernames: ['a', 'b', 'c'] } });
  await settle(svc);
  const st = svc.status();
  assert.equal(st.done, 3);
  assert.deepEqual(st.failed, [{ username: 'b', error: 'boom' }]);
  assert.deepEqual((st.result as { rows: Array<{ username: string }> }).rows.map((r) => r.username), ['a', 'c']);
});

test('H-BAT-013: rows land AS THEY HAPPEN — a run still in flight already shows what it has spent', async () => {
  // The point of the money job: an operator watching a 500-account run must see outcomes accrue, and a
  // run that is cancelled (or dies) must still show every account it already charged.
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => { release = r; });
  const svc = serviceFor(async (u) => { if (u === 'b') await gate; return { username: u }; });
  await svc.run({ jobType: 'j', scope: { usernames: ['a', 'b', 'c'] } });
  for (let i = 0; i < 100 && !svc.status().result; i++) await new Promise((r) => setTimeout(r, 5));

  const mid = svc.status();
  assert.equal(mid.running, true);
  assert.deepEqual((mid.result as { rows: Array<{ username: string }> }).rows, [{ username: 'a' }]);

  release!();
  await settle(svc);
  assert.equal((svc.status().result as { rows: unknown[] }).rows.length, 3);
});

test('H-BAT-014: a cancelled run keeps the rows it already produced', async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => { release = r; });
  const svc = serviceFor(async (u) => { if (u === 'b') await gate; return { username: u }; });
  await svc.run({ jobType: 'j', scope: { usernames: ['a', 'b', 'c'] } });
  for (let i = 0; i < 100 && !svc.status().result; i++) await new Promise((r) => setTimeout(r, 5));
  svc.cancel();
  release!();
  await settle(svc);

  const st = svc.status();
  assert.equal(st.running, false);
  // 'a' and 'b' completed; the cancel stopped the loop BEFORE 'c' — and both finished rows survive.
  assert.deepEqual((st.result as { rows: Array<{ username: string }> }).rows.map((r) => r.username), ['a', 'b']);
  assert.equal(svc.history()[0].outcome, 'cancelled');
});
