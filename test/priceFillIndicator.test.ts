import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceFillIndicator, formatFillEta, repriceDecision, type RepriceState, type PricingStatus } from '../src/pricing/repriceReconciler';

// ─── BUG 1: a boot-time price fill must live-update the UI + show/clear an indicator ──
// The watcher (watchPriceFill) is now started right after the first inventory render on
// startup. This test scripts the exact "load with missing prices → status busy → prices
// land → drained" sequence and proves the LOGIC that drives it: the indicator shows the
// N-left / X-done counts while busy and clears on completion, and the reconciler re-pulls
// on every progress step and does a final re-pull + stop when the queue drains.

test('priceFillIndicator: hidden when idle, visible with counts while busy, hidden when drained', () => {
  // Assert the core show/left/done fields (the eta/long fields are covered separately below).
  const core = (s: PricingStatus | null) => { const { show, left, done } = priceFillIndicator(s); return { show, left, done }; };
  assert.deepEqual(core(null), { show: false, left: 0, done: 0 });
  assert.deepEqual(core({ running: false, queued: 0, fetched: 0 }), { show: false, left: 0, done: 0 });
  // running with a queue → visible
  assert.deepEqual(core({ running: true, queued: 5, fetched: 0 }), { show: true, left: 5, done: 0 });
  // queued but the run() hasn't flipped `running` yet → still visible (a fill is pending)
  assert.deepEqual(core({ running: false, queued: 3, fetched: 2 }), { show: true, left: 3, done: 2 });
  // drained → dismissed
  assert.deepEqual(core({ running: false, queued: 0, fetched: 5 }), { show: false, left: 0, done: 5 });
});

test('1c: the badge carries a rough ETA + a large-inventory hint (single-IP throttle, ~17/min)', () => {
  assert.equal(formatFillEta(0), '', 'nothing left → no ETA');
  assert.equal(formatFillEta(10), '~35s left', '10 names × 3.5s = 35s');
  assert.equal(formatFillEta(100), '~6 min left', '100 × 3.5s = 350s ≈ 6 min');
  assert.equal(formatFillEta(2000), '~1.9 h left', '2000 × 3.5s = 7000s ≈ 1.9 h');
  const small = priceFillIndicator({ running: true, queued: 100, fetched: 0 });
  assert.equal(small.eta, '~6 min left');
  assert.equal(small.long, false, '100 names is not flagged "large"');
  const big = priceFillIndicator({ running: true, queued: 500, fetched: 0 });
  assert.equal(big.eta, '~29 min left', '500 × 3.5s = 1750s ≈ 29 min');
  assert.equal(big.long, true, '500+ names → large-inventory hint');
});

test('BUG 1 boot scenario: missing prices → busy → progress → drained live-updates then clears', () => {
  // A scripted /api/pricing/status timeline for a boot load where items start priceless.
  const timeline: PricingStatus[] = [
    { running: true,  queued: 5, fetched: 0 }, // fill just kicked off by the initial /api/inventory GET
    { running: true,  queued: 3, fetched: 2 }, // 2 prices landed → re-pull (null→priced items appear)
    { running: true,  queued: 0, fetched: 5 }, // last batch fetched, run about to end
    { running: false, queued: 0, fetched: 5 }, // drained
  ];

  let state: RepriceState = { lastPulled: 0, lastProgressAt: 0 };
  const repulls: number[] = []; // record `done` at each re-pull
  let stopped = false;

  for (let i = 0; i < timeline.length; i++) {
    const st = timeline[i];
    // indicator: visible while any of the busy snapshots, hidden on the final drained one
    const ind = priceFillIndicator(st);
    assert.equal(ind.show, i < timeline.length - 1, `indicator visibility at step ${i}`);

    const d = repriceDecision(state, st, (i + 1) * 1000);
    state = d.state;
    if (d.repull) repulls.push(st.fetched ?? 0);
    if (d.stop) { stopped = true; break; }
  }

  // Re-pulled when prices first landed (done=2), progressed (done=5), and a final re-pull on drain.
  assert.ok(repulls.includes(2), 'a re-pull happened when the first prices landed (null→priced)');
  assert.ok(repulls.includes(5), 'a re-pull happened after the remaining prices landed');
  assert.equal(stopped, true, 'the watcher stops once the fill drains');
  // Final indicator state is hidden → the "Fetching prices…" badge dismisses itself.
  assert.equal(priceFillIndicator(timeline[timeline.length - 1]).show, false);
});
