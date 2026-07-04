import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ════════════════════════════════════════════════════════════════════════════
//  S62 — /api/app/check-update was the ONLY route registered with a raw
//  `async (req, res)` handler (no asyncHandler), a latent hanging-request /
//  unhandledRejection class if its body ever rejected. Every async route must be
//  wrapped in asyncHandler so a rejection reaches the error middleware. This is a
//  source-level regression guard: it fails if any raw async route reappears.
// ════════════════════════════════════════════════════════════════════════════

test('S62: every async route handler is wrapped in asyncHandler (no raw async (req,res))', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'api', 'server.ts'), 'utf8');
  const re = /async\s*\(\s*req/g; // an async handler taking (req, …) — note: won't match "asyncHandler("
  const raw: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const before = src.slice(Math.max(0, m.index - 15), m.index);
    if (!before.includes('asyncHandler(')) {
      raw.push(src.slice(Math.max(0, m.index - 45), m.index + 15).replace(/\s+/g, ' '));
    }
  }
  assert.deepEqual(raw, [], `every async route must be wrapped in asyncHandler; found raw handler(s): ${raw.join('  |  ')}`);
});
