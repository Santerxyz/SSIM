import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GcActionLayer } from '../src/trading/GcActionLayer';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-051 — craftTradeUp must reject 10 non-UNIQUE input asset ids before any
//  GC contact. The length guard passes for ['A','A','B',…] (10 elements, 9 ids);
//  a duplicate then reaches the irreversible GC send. A uniqueness check keeps the
//  malformed contract off the item-destroying path entirely — it throws pre-
//  withSession, so the session layer is never entered.
//  (withSession is overridden per-instance with a spy — same seam as
//  craftRejectionClassify — to prove fn(go) is never reached.)
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGc = any;

const TEN_UNIQUE = Array.from({ length: 10 }, (_, i) => String(i));

test('H-TRD-051: craftTradeUp rejects duplicate input ids without entering the session layer', async () => {
  const gc: AnyGc = Object.create(GcActionLayer.prototype);
  let entered = false;
  gc.withSession = async (_u: string, fn: (g: unknown) => Promise<unknown>) => { entered = true; return fn({}); };
  const withDup = ['0', '0', '2', '3', '4', '5', '6', '7', '8', '9']; // 10 elements, 9 unique
  const prev = process.env.SSIM_GC_VERIFIED;
  process.env.SSIM_GC_VERIFIED = '1'; // gate ON → any throw is unambiguously the uniqueness guard
  try {
    await assert.rejects(
      () => gc.craftTradeUp('bot', { inputAssetIds: withDup, inputRarityId: 'rarity_common_weapon', stattrak: false }),
      /10 UNIQUE input asset ids/,
      'a duplicate input id is refused before any GC send',
    );
  } finally {
    if (prev === undefined) delete process.env.SSIM_GC_VERIFIED; else process.env.SSIM_GC_VERIFIED = prev;
  }
  assert.equal(entered, false, 'withSession must never be entered for a malformed contract');
});

test('H-TRD-051: craftTradeUp with 10 unique ids passes the uniqueness guard and enters the session layer', async () => {
  const gc: AnyGc = Object.create(GcActionLayer.prototype);
  let entered = false;
  // fn(go) is never awaited to completion here — we only assert the guard let it through.
  gc.withSession = async (_u: string, _fn: (g: unknown) => Promise<unknown>) => { entered = true; return { submitted: true, confirmed: true }; };
  const prev = process.env.SSIM_GC_VERIFIED;
  process.env.SSIM_GC_VERIFIED = '1';
  try {
    await gc.craftTradeUp('bot', { inputAssetIds: TEN_UNIQUE, inputRarityId: 'rarity_common_weapon', stattrak: false });
  } finally {
    if (prev === undefined) delete process.env.SSIM_GC_VERIFIED; else process.env.SSIM_GC_VERIFIED = prev;
  }
  assert.equal(entered, true, '10 unique ids must reach the session layer');
});
