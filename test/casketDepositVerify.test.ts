import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GcActionLayer } from '../src/trading/GcActionLayer';

// ─────────────────────────────────────────────────────────────────────────────
//  v1.4.4 issue 8 — "the Storage function is completely not functioning. whatever
//  I try it says items unconfirmed. as well as being insanely slow."
//
//  ROOT CAUSE: verifyMove's DEPOSIT predicate required the deposited item to still
//  be in `go.inventory` carrying `casket_id`. The CS2 GC emits `itemRemoved` for a
//  deposited item — it leaves the inventory array entirely (it only reappears, tagged
//  with casket_id, if getCasketContents later loads that unit). So EVERY successful
//  deposit failed the predicate, burned the full 15s verify window, and was reported
//  "unconfirmed" — which then blew the 20s + 3s/item move budget, leaving most of the
//  selection unattempted. Withdraw was already correct (`itemAcquired`).
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGc = any;

/** A GC stub that behaves like the real one: a deposited item is REMOVED from `inventory`. */
function depositGc(itemIds: string[]) {
  const go = {
    haveGCSession: true,
    inventory: [{ id: 'c1', casket_contained_item_count: 0 }, ...itemIds.map((id) => ({ id }))] as Array<Record<string, unknown>>,
    addToCasket: (_casketId: string, itemId: string) => {
      // Real GC behaviour: itemRemoved → the item drops out of the inventory array.
      go.inventory = go.inventory.filter((x) => String(x.id) !== String(itemId));
    },
    removeFromCasket: () => { /* unused here */ },
    getCasketContents: (_c: string, cb: (e: Error | null, items: unknown[]) => void) => cb(null, []),
  };
  return go;
}

test('a deposit that the GC confirms (item leaves the inventory) counts as MOVED, not unconfirmed', async () => {
  const gc: AnyGc = Object.create(GcActionLayer.prototype);
  const go = depositGc(['a', 'b']);
  gc.withSession = async (_u: string, fn: (g: unknown) => Promise<unknown>) => fn(go);

  const res = await gc.moveCasketItems('bot', 'c1', ['a', 'b'], 'deposit');

  assert.deepEqual(res.moved, ['a', 'b'], 'both deposits must be confirmed MOVED');
  assert.deepEqual(res.unconfirmed, [], 'nothing may be reported unconfirmed');
  assert.deepEqual(res.failed, [], 'nothing may fail');
  assert.equal(res.stopped, 'completed');
});

test('a confirmed deposit does NOT burn the 15s verify window (the "insanely slow" half)', async () => {
  const gc: AnyGc = Object.create(GcActionLayer.prototype);
  const go = depositGc(['a']);
  gc.withSession = async (_u: string, fn: (g: unknown) => Promise<unknown>) => fn(go);

  const t0 = Date.now();
  const res = await gc.moveCasketItems('bot', 'c1', ['a'], 'deposit');
  const elapsed = Date.now() - t0;

  assert.deepEqual(res.moved, ['a']);
  // One item = one verify (immediate) + one pacing sleep (350–750ms). The old code sat in the
  // 15 000ms verify loop before giving up, so anything near that is the bug returning.
  assert.ok(elapsed < 5_000, `a confirmed deposit must settle fast, took ${elapsed}ms (15s ⇒ the old timeout-poll is back)`);
});

test('a deposit of an item that is not a FREE inventory item fails PRE-SEND (no false "moved")', async () => {
  const gc: AnyGc = Object.create(GcActionLayer.prototype);
  // 'ghost' is absent; 'stored' is already inside another unit. Neither may be submitted, and neither
  // may be inferred as "moved" just because it is not a free item.
  const go = depositGc([]);
  go.inventory.push({ id: 'stored', casket_id: 'other-unit' });
  let sends = 0;
  const origAdd = go.addToCasket;
  go.addToCasket = (c: string, i: string) => { sends++; origAdd(c, i); };
  gc.withSession = async (_u: string, fn: (g: unknown) => Promise<unknown>) => fn(go);

  const res = await gc.moveCasketItems('bot', 'c1', ['ghost', 'stored'], 'deposit');

  assert.equal(sends, 0, 'nothing may be sent to the GC for a stale selection');
  assert.deepEqual(res.moved, [], 'a stale id must never be reported as moved');
  assert.deepEqual(res.unconfirmed, []);
  assert.equal(res.failed.length, 2, 'both stale ids are reported as failed');
});

test('withdraw verification is unchanged (item present with no casket_id ⇒ moved)', async () => {
  const gc: AnyGc = Object.create(GcActionLayer.prototype);
  const go = {
    haveGCSession: true,
    inventory: [{ id: 'c1' }, { id: 'w', casket_id: 'c1' }] as Array<Record<string, unknown>>,
    addToCasket: () => { /* unused */ },
    removeFromCasket: (_casketId: string, itemId: string) => {
      // Real GC behaviour: itemAcquired → the item appears free (casket_id cleared).
      const it = go.inventory.find((x) => String(x.id) === String(itemId));
      if (it) delete it.casket_id;
    },
    getCasketContents: (_c: string, cb: (e: Error | null, items: unknown[]) => void) => cb(null, []),
  };
  gc.withSession = async (_u: string, fn: (g: unknown) => Promise<unknown>) => fn(go);

  const res = await gc.moveCasketItems('bot', 'c1', ['w'], 'withdraw');
  assert.deepEqual(res.moved, ['w'], 'withdraw still confirms via the item becoming free');
  assert.deepEqual(res.unconfirmed, []);
});
