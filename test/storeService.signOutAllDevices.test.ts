import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StoreService, StoreAmbiguousError, type StoreContext, type StoreResponse } from '../src/store/StoreService';

// ════════════════════════════════════════════════════════════════════════════════════════════════
//  "Sign out of all devices" (owner 2026-08-25) — Steam's account-wide session revocation, driven
//  against a SCRIPTED StoreContext (no Steam, no network).
//
//  The claim under test is the OUTCOME CLASSIFICATION, because the caller acts on it: on `done` OR
//  `ambiguous` the route drops SSIM's own session and clears the stored refresh token (the token is
//  revoked either way), and on `failed` it leaves both alone and reports the error. So a wrong
//  classification either strands a live account or tells the operator every device was signed out
//  when nothing happened.
//
//  Steam answers the real action with a 302 back to the manage page. A 200 on this endpoint means
//  the page re-rendered — which is how a stale/rejected CSRF surfaces — so a 200 HTML body is
//  AMBIGUOUS, never success. This is not a re-runnable operation (a real deauthorize kills the very
//  session a retry would need), so guessing "ok" here is the expensive mistake.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const res = (status: number, data: unknown = '', location = ''): StoreResponse => ({ status, data, location });

/** A StoreService whose session plumbing is replaced by a scripted ctx, so only the classification runs. */
function svcWith(answer: StoreResponse | Error) {
  const posts: Array<{ path: string; form: Record<string, string> }> = [];
  const svc = new StoreService({} as never, {} as never);
  const ctx: StoreContext = {
    username: 'bot_a', steamId: '76561198000000000', sessionid: 'CSRF-SID',
    get: async () => { throw new Error('unscripted GET'); },
    post: async (path, form) => {
      posts.push({ path, form });
      if (answer instanceof Error) throw answer;
      return answer;
    },
    webapi: async () => { throw new Error('unscripted webapi'); },
  };
  (svc as unknown as { withStoreSession: unknown }).withStoreSession =
    async (_u: string, fn: (c: StoreContext) => Promise<unknown>) => fn(ctx);
  return { svc, posts };
}

test('signOut: POSTs action=deauthorize with the CSRF sessionid to twofactor/manage_action', async () => {
  const { svc, posts } = svcWith(res(302, '', 'https://store.steampowered.com/twofactor/manage'));
  await svc.deauthorizeAllDevices('bot_a');
  assert.equal(posts.length, 1, 'exactly one POST — this operation is never retried internally');
  assert.equal(posts[0].path, '/twofactor/manage_action');
  assert.equal(posts[0].form.action, 'deauthorize');
  assert.equal(posts[0].form.sessionid, 'CSRF-SID', 'the CSRF token must be the session\'s own sessionid');
});

test('signOut: a 302 back to the manage page is DONE (POSTs are never auto-followed)', async () => {
  const { svc } = svcWith(res(302, '', 'https://store.steampowered.com/twofactor/manage'));
  assert.equal((await svc.deauthorizeAllDevices('bot_a')).status, 'done');
});

test('signOut: a 200 with an explicit success flag is trusted', async () => {
  const yes = svcWith(res(200, { success: true }));
  assert.equal((await yes.svc.deauthorizeAllDevices('bot_a')).status, 'done');

  const one = svcWith(res(200, { success: 1 }));
  assert.equal((await one.svc.deauthorizeAllDevices('bot_a')).status, 'done', 'Steam uses 1 as often as true');

  const no = svcWith(res(200, { success: false }));
  assert.equal((await no.svc.deauthorizeAllDevices('bot_a')).status, 'failed',
    'an explicit rejection is a FAILURE — the token must NOT be cleared');
});

test('signOut: a 200 HTML page is AMBIGUOUS, never a silent success', async () => {
  const { svc } = svcWith(res(200, '<html><body>Manage Steam Guard</body></html>'));
  const r = await svc.deauthorizeAllDevices('bot_a');
  assert.equal(r.status, 'ambiguous',
    'a re-rendered page is how a rejected CSRF looks — reporting "signed out" here would be a lie');
  assert.match(r.detail, /unknown/i, 'and the operator is told the outcome is unknown');
});

test('signOut: a non-2xx/3xx is a definite failure carrying the status', async () => {
  const { svc } = svcWith(res(403));
  const r = await svc.deauthorizeAllDevices('bot_a');
  assert.equal(r.status, 'failed');
  assert.match(r.detail, /403/, 'the status is surfaced, not swallowed');
});

test('signOut: a transport fault mid-POST is AMBIGUOUS — the request may well have landed', async () => {
  const { svc } = svcWith(new StoreAmbiguousError('socket hang up'));
  const r = await svc.deauthorizeAllDevices('bot_a');
  assert.equal(r.status, 'ambiguous',
    'an interrupted POST cannot be distinguished from a completed one — never report it as failed');
});

test('signOut: a non-transport throw propagates rather than being classified', async () => {
  const { svc } = svcWith(new Error('vault locked'));
  await assert.rejects(() => svc.deauthorizeAllDevices('bot_a'), /vault locked/,
    'only StoreAmbiguousError is absorbed; a real bug must surface');
});
