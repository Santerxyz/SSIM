import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GcActionLayer } from '../src/trading/GcActionLayer';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-045 — status().reason must name the ACTUAL disabled-branch cause. Before
//  the fix every disabled case blamed "(SSIM_GC_VERIFIED=0)", so an operator in a
//  dev runtime (env unset) was told the kill switch is set when it is not. The
//  reason is now derived from the shared craftGateResolution() so kill-switch and
//  dev-default read differently.
//  (status() only needs available() + the env gate, so it is driven on a bare
//  instance with available() stubbed true for determinism.)
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGc = any;

test('GcActionLayer.status reason distinguishes kill-switch from dev-default', () => {
  const gc: AnyGc = Object.create(GcActionLayer.prototype);
  gc.available = () => true; // pretend globaloffensive is installed (deterministic)

  const prev = process.env.SSIM_GC_VERIFIED;
  try {
    // Kill switch — explicitly disabled.
    process.env.SSIM_GC_VERIFIED = '0';
    const killed = gc.status();
    assert.equal(killed.craftEnabled, false, 'kill switch disables craft');
    assert.match(killed.reason, /kill switch/, 'kill-switch reason names the kill switch');
    assert.match(killed.reason, /SSIM_GC_VERIFIED=0/, 'kill-switch reason keeps the env=0 hint');

    // Dev default — env unset (dev runtime, IS_PACKAGED false).
    delete process.env.SSIM_GC_VERIFIED;
    const dev = gc.status();
    assert.equal(dev.craftEnabled, false, 'dev default disables craft');
    assert.match(dev.reason, /dev default/, 'dev-default reason names the dev default');
    assert.doesNotMatch(dev.reason, /kill switch/, 'dev-default reason must NOT blame the kill switch');
  } finally {
    if (prev === undefined) delete process.env.SSIM_GC_VERIFIED;
    else process.env.SSIM_GC_VERIFIED = prev;
  }
});
