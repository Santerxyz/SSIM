import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';

// ─── H-API-005: the same-origin / anti-CSRF + DNS-rebind guard is now the SINGLE source of
// truth (the two contradictory inline layers in server.ts were removed). These cases pin the
// consolidated guard's contract, including the LAN opt-in (HOST=<LAN-IP>) that the old inline
// server.ts CSRF layer wrong-blocked. `ENFORCE_LOCALHOST_HOST` is captured from process.env.HOST
// at module load, so each HOST regime loads a fresh copy of the module. ─────────────────────────

type Verdict = { next: boolean; status?: number; code?: string };

/** Loads `sameOriginGuard` under a given HOST env, then runs it against a mock request. */
function run(host: string | undefined, req: Partial<Request>): Verdict {
  const prev = process.env.HOST;
  if (host === undefined) delete process.env.HOST;
  else process.env.HOST = host;
  try {
    delete require.cache[require.resolve('../src/api/originGuard')];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { sameOriginGuard } = require('../src/api/originGuard') as typeof import('../src/api/originGuard');
    const verdict: Verdict = { next: false };
    const res = {
      status(s: number) { verdict.status = s; return this; },
      json(body: unknown) { verdict.code = (body as { code?: string }).code; return this; },
    } as unknown as Response;
    const next: NextFunction = () => { verdict.next = true; };
    sameOriginGuard({ method: 'GET', path: '/api/x', headers: {}, ...req } as Request, res, next);
    return verdict;
  } finally {
    if (prev === undefined) delete process.env.HOST;
    else process.env.HOST = prev;
    delete require.cache[require.resolve('../src/api/originGuard')];
  }
}

test('same-origin loopback POST passes', () => {
  const v = run('127.0.0.1', { method: 'POST', headers: { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' } });
  assert.equal(v.next, true);
});

test('foreign Origin on a loopback POST is blocked (BAD_ORIGIN)', () => {
  const v = run('127.0.0.1', { method: 'POST', headers: { host: '127.0.0.1:1', origin: 'http://evil.com' } });
  assert.equal(v.next, false);
  assert.equal(v.status, 403);
  assert.equal(v.code, 'BAD_ORIGIN');
});

test('non-localhost Host on the default loopback bind is blocked (BAD_HOST)', () => {
  const v = run('127.0.0.1', { method: 'POST', headers: { host: 'evil.com', origin: 'http://evil.com' } });
  assert.equal(v.next, false);
  assert.equal(v.status, 403);
  assert.equal(v.code, 'BAD_HOST');
});

test('mutating request with no Origin/Referer is blocked (NO_ORIGIN)', () => {
  const v = run('127.0.0.1', { method: 'POST', headers: { host: '127.0.0.1:1' } });
  assert.equal(v.next, false);
  assert.equal(v.status, 403);
  assert.equal(v.code, 'NO_ORIGIN');
});

test('regression: sanctioned LAN opt-in (HOST=0.0.0.0) same-origin POST passes', () => {
  // The old server.ts CSRF layer compared Origin against a fixed boundHost allowlist (0.0.0.0),
  // never the real LAN IP the browser sends, so it 403'd every mutating call from the LAN
  // dashboard. With that layer removed, sameOriginGuard's exact same-origin match admits it.
  const v = run('0.0.0.0', { method: 'POST', headers: { host: '192.168.1.50:3000', origin: 'http://192.168.1.50:3000' } });
  assert.equal(v.next, true);
});
