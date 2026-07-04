import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ════════════════════════════════════════════════════════════════════════════
//  S68 — the floating "Live Logs" launcher used z-index:99999, so it rendered ABOVE
//  every overlay (modals z-40, banners/menus z-50, toasts z-60, splash z-70) and
//  obscured alerts. Its z-index must sit BELOW the overlay layers. Source-level
//  regression guard: fails if a high z-index reappears.
// ════════════════════════════════════════════════════════════════════════════

test('S68: the Live Logs launcher z-index is below the overlay layers (never obscures alerts)', () => {
  const html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const anchor = html.indexOf('Live Logs'); // the launcher comment / button block (after the toast styles)
  assert.ok(anchor >= 0, 'the Live Logs launcher block exists');
  const block = html.slice(anchor, anchor + 1400);
  // Match the QUOTED cssText token (e.g. 'z-index:30') so a z-index mentioned in a nearby comment can't
  // fool the guard.
  const m = /'z-index:\s*(\d+)'/.exec(block);
  assert.ok(m, 'the launcher declares a z-index in its cssText');
  const z = Number(m![1]);
  assert.ok(z < 40, `the Live Logs launcher z-index (${z}) must be below the modal layer (z-40) so it never obscures toasts/modals/banners`);
});
