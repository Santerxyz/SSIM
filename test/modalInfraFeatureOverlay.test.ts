import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── H-FE-009: lazily-built feature overlays must follow the FB-04 lifecycle ───
// The Trade-Up / Casket overlays are created on first open, AFTER setupModalInfra() attached its
// per-overlay observers, so they were never observed. They called onModalOpen(ov) manually but had
// no matching onModalClose on hide → FB04.stack never drained and documentElement.style.overflow
// stayed 'hidden' forever (page could never scroll again; every later modal's reset was gated on
// stack empty). The fix routes them through a shared observeOverlay() attached at creation, and
// removes the manual opens. jsdom is not a project dependency (the FE tests use vm + source
// extraction), so this pins the fix mechanism at the source level — the exact regression surface.

function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found in app.js`);
  const bodyOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const APP_JS = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('H-FE-009: a shared observeOverlay() exists and both wire sites use it', () => {
  assert.match(APP_JS, /function observeOverlay\(overlay\)/, 'the shared overlay-lifecycle wirer must exist');
  assert.match(extractFunction(APP_JS, 'setupModalInfra'), /modalOverlays\(\)\.forEach\(observeOverlay\)/,
    'static overlays must be wired through the shared observeOverlay');
  assert.match(extractFunction(APP_JS, 'ensureFeatureOverlay'), /observeOverlay\(ov\)/,
    'a lazily-built feature overlay must be observed at creation, or its close never reaches onModalClose');
});

test('H-FE-009: no manual onModalOpen(ov) remains (would double-fire / mismatch onModalClose)', () => {
  assert.doesNotMatch(APP_JS, /onModalOpen\(ov\)/,
    'feature overlays must open via the observer, not a manual onModalOpen that has no matching close');
});

// ─── H-FE-010: closing a feature overlay must stop its self-rescheduling status poller ───
// tuPollExec / casketPollMove re-arm tuState.execTimer / ckState.moveTimer while the job is running.
// The feature overlays' only close was a bare classList.add('hidden') — no clearTimeout — so a close
// mid-job left the poller firing status fetches + writing the hidden [data-foot] until the backend
// finally reported running:false (minutes for a large casket move). Since H-FE-009 routes close
// through onModalClose, that is the single choke point: it must run a per-overlay teardown that
// clears the timer. Pinned at source level (the FE tests use source extraction, not jsdom).

test('H-FE-010: onModalClose runs a per-overlay teardown hook', () => {
  assert.match(APP_JS, /const MODAL_TEARDOWNS = new Map\(\)/,
    'a per-overlay teardown registry must exist');
  assert.match(extractFunction(APP_JS, 'onModalClose'), /MODAL_TEARDOWNS\.get\(overlay\.id\)\?\.\(\)/,
    'onModalClose must invoke the closing overlay’s teardown (the single close choke point)');
});

test('H-FE-010: both feature overlays register a teardown that clears their poll timer', () => {
  assert.match(APP_JS, /MODAL_TEARDOWNS\.set\('tradeup-overlay',[^\n]*clearTimeout\(tuState\.execTimer\)/,
    'the Trade-Up overlay must clear tuState.execTimer on close');
  assert.match(APP_JS, /MODAL_TEARDOWNS\.set\('casket-overlay',[^\n]*clearTimeout\(ckState\.moveTimer\)/,
    'the Storage-Unit overlay must clear ckState.moveTimer on close');
});
