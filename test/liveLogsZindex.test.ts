import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ════════════════════════════════════════════════════════════════════════════
//  S68 — the floating "Live Logs" launcher used z-index:99999 in the bottom-RIGHT
//  corner, so it rendered ABOVE every overlay (modals z-40, banners/menus z-50,
//  toasts z-60, splash z-70) AND collided with the bottom-right toast stack /
//  price-fill badge. It now sits bottom-LEFT with z-index < 40. Source-level
//  regression guards: fail if a high z-index or the bottom-right anchor reappears.
// ════════════════════════════════════════════════════════════════════════════

// Match only QUOTED cssText tokens (e.g. 'z-index:30') so a value mentioned in a nearby comment can't fool
// the guard. The launcher block is the LAST 'Live Logs' occurrence's cssText (comment + button).
function launcherBlock(): string {
  const html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const anchor = html.indexOf('Live Logs');
  assert.ok(anchor >= 0, 'the Live Logs launcher block exists');
  return html.slice(anchor, anchor + 2400);
}

test('S68: the Live Logs launcher z-index is below the overlay layers (never obscures alerts)', () => {
  const m = /'z-index:\s*(\d+)'/.exec(launcherBlock());
  assert.ok(m, 'the launcher declares a z-index in its cssText');
  const z = Number(m![1]);
  assert.ok(z < 40, `the Live Logs launcher z-index (${z}) must be below the modal layer (z-40) so it never obscures toasts/modals/banners`);
});

test('S68: the Live Logs launcher is anchored bottom-LEFT (off the bottom-right toast/price-fill corner)', () => {
  const block = launcherBlock();
  assert.ok(/'left:\s*\d+px'/.test(block), 'the launcher is positioned from the LEFT edge');
  assert.ok(/'bottom:\s*\d+px'/.test(block), 'the launcher is anchored to the bottom');
  assert.ok(!/'right:\s*\d+px'/.test(block), 'the launcher no longer sits in the bottom-right toast corner');
});
