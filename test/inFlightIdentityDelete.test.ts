import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InventoryService } from '../src/core/InventoryService';

// ─────────────────────────────────────────────────────────────────────────────
//  H-INV-003 — refreshOne's TF2 in-flight cleanup deleted the map key WITHOUT an
//  identity check, unregistering a live forceRefresh promise. Sequence on the same
//  TF2 account (real for mass-buy verification): refreshOne(u,'tf2') registers
//  promise A → forceRefresh(u,'tf2') REPLACES the entry with promise B → A settles
//  → A's finally deletes the key, unregistering B while B's fetch is still live.
//  busy() then reports false mid-fetch (the S14 swap gate can green-light a swap).
//  The fix mirrors the two sibling paths: delete only if the map still holds THIS
//  promise. (Object.create exercises the exact shipped refreshOne/forceRefresh/
//  busy() without the heavy constructor, as updateBusyGate.test.ts does.)
// ─────────────────────────────────────────────────────────────────────────────

type Deferred = { promise: Promise<any>; resolve: (v?: any) => void };
function defer(): Deferred {
  let resolve!: (v?: any) => void;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('H-INV-003: a settling refreshOne must not unregister a live forceRefresh', async () => {
  const svc = Object.create(InventoryService.prototype) as InventoryService;
  (svc as any).inFlight = new Map<string, Promise<any>>();
  (svc as any).job = { running: false };

  // Two controllable deferreds: A serves refreshOne, B serves forceRefresh.
  const dA = defer();
  const dB = defer();
  const calls: Deferred[] = [dA, dB];
  let i = 0;
  (svc as any).doRefreshOne = () => calls[i++].promise;

  assert.equal(svc.busy(), false, 'idle → not busy');

  const a = svc.refreshOne('user', 'tf2');       // registers promise A at tf2:user
  const b = svc.forceRefresh('user', 'tf2');      // REPLACES the entry with promise B
  assert.equal(svc.busy(), true, 'both in flight → busy');

  // Resolve A. Before the fix, A's finally deletes tf2:user, dropping live B.
  dA.resolve({});
  await a;
  assert.equal(svc.busy(), true, 'B is still live — the gate must stay closed');

  dB.resolve({});
  await b;
  assert.equal(svc.busy(), false, 'once B settles, the gate reopens');
});
