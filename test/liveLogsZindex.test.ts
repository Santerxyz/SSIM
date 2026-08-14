import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ════════════════════════════════════════════════════════════════════════════
//  S68 — the "Live Logs" launcher must never obscure or collide with ANY other
//  UI element. History: it was a floating fixed pill at bottom-RIGHT with
//  z-index:99999 (covered toasts/modals), then moved bottom-LEFT with z<40 —
//  but the redesigned sidebar footer (version + status light) lives in exactly
//  that corner, so the pill covered those instead (owner report, 2026-07-08).
//  The launcher is now a REAL sidebar-footer button (#btn-live-logs) that owns
//  reserved layout space: a layout element cannot overlap anything by
//  construction. These guards fail if the floating-pill pattern reappears.
// ════════════════════════════════════════════════════════════════════════════

function indexHtml(): string {
  return readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
}

test('S68: the Live Logs launcher is a real footer control, not a floating overlay', () => {
  const html = indexHtml();
  assert.ok(html.includes('id="btn-live-logs"'), 'the sidebar footer declares the #btn-live-logs button');
  // The launcher block (comment + wiring script) must not re-introduce a fixed-position pill.
  const anchor = html.indexOf('Live Logs');
  assert.ok(anchor >= 0, 'the Live Logs launcher block exists');
  const block = html.slice(anchor, anchor + 2400);
  assert.ok(!/position:\s*fixed/.test(block), 'the launcher is not a fixed-position floating element (it would overlap the sidebar footer / toasts)');
  assert.ok(!/z-index/.test(block), 'the launcher needs no z-index — it occupies reserved layout space');
});

test('S68: the launcher opens the logs window via BOTH paths (browser window.open + shell POST)', () => {
  const html = indexHtml();
  const anchor = html.indexOf('function openLogs');
  assert.ok(anchor >= 0, 'the openLogs wiring exists');
  const block = html.slice(anchor, anchor + 800);
  assert.ok(block.includes("window.open('/logs.html'"), 'browser path: window.open of logs.html');
  assert.ok(block.includes("fetch('/api/app/open-logs'"), 'shell path: POST /api/app/open-logs (capability-exempt, S20)');
});
