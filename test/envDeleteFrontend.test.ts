import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import vm from 'vm';
import path from 'path';

// ═════════════════════════════════════════════════════════════════════════════════════════════════
//  The Accounts-module environment delete + "sign out of all devices" flows, exercised against the
//  REAL public/app.js source (extracted and run in a vm, the itemStateFrontend.test.ts idiom) —
//  not a reimplementation, so a rename or a logic change here fails the test rather than sliding by.
//
//  These two paths are the destructive ones the UI gained on 2026-08-25, and the claims that matter
//  are all about what reaches the wire:
//   • a NON-EMPTY environment must be gated behind a typed "DELETE" and must send ?cascade=1;
//   • an EMPTY one must NOT demand the typed word and must NOT send cascade (so the server's 409
//     guard still protects an environment that gained an account since the page last rendered);
//   • a declined confirm must issue NO request at all;
//   • sign-out must not report success when Steam's answer was ambiguous.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

interface ConfirmOpts { title: string; body: string; typedWord?: string | null; confirmLabel?: string }
interface ApiCall { path: string; opts?: { method?: string } }
interface Harness {
  deleteEnvironment: (id: string) => Promise<void>;
  signOutAllDevices: (u: string) => Promise<void>;
  state: Record<string, any>;
  confirms: ConfirmOpts[];
  calls: ApiCall[];
  toasts: Array<{ msg: string; kind: string }>;
  setConfirmAnswer: (v: boolean) => void;
  setApiResponse: (v: unknown) => void;
  setApiError: (e: Error | null) => void;
}

function loadFrontend(): Harness {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const grab = (re: RegExp, name: string): string => {
    const m = src.match(re);
    if (!m) throw new Error(`could not extract ${name} from public/app.js — did it get renamed?`);
    return m[0];
  };
  const parts = [
    grab(/function escapeHtml\([\s\S]*?\n\}/, 'escapeHtml'),
    grab(/^async function deleteEnvironment\(id\) \{[\s\S]*?\n\}/m, 'deleteEnvironment'),
    grab(/^async function signOutAllDevices\(u\) \{[\s\S]*?\n\}/m, 'signOutAllDevices'),
  ];

  const confirms: ConfirmOpts[] = [];
  const calls: ApiCall[] = [];
  const toasts: Array<{ msg: string; kind: string }> = [];
  let confirmAnswer = true;
  let apiResponse: unknown = { ok: true };
  let apiError: Error | null = null;

  const state: Record<string, any> = {
    nav: 'accounts',
    environments: [],
    allAccounts: [],
    globalEnvs: new Set<string>(),
    accEnv: null,
    accountsUser: null,
    accSel: new Set<string>(),
    activeEnv: null,
    activeUsername: null,
    invMode: 'account',
    tree: { folders: [], accounts: [] },
    accountsBusy: {} as Record<string, string | null>,
  };

  const ctx: Record<string, unknown> = {
    Date, Math, Number, String, JSON, Set, Promise, encodeURIComponent, console,
    state,
    ssimConfirm: async (o: ConfirmOpts) => { confirms.push(o); return confirmAnswer; },
    api: async (p: string, o?: { method?: string }) => {
      calls.push({ path: p, opts: o });
      if (apiError) throw apiError;
      return apiResponse;
    },
    toast: (msg: string, kind: string) => { toasts.push({ msg, kind }); },
    fmtCount: (n: number) => String(n),
    // Render/refresh side effects are not what these tests are about — stub them out, but keep
    // them as real callables so a missing one surfaces as a failure rather than passing silently.
    reloadAll: async () => undefined,
    invalidateStructureCaches: () => undefined,
    renderAccountsModule: () => undefined,
    renderDashboard: () => undefined,
    enterInventories: () => undefined,
    setAcctBusy: (u: string, k: string | null) => { state.accountsBusy[u] = k; },
  };
  vm.createContext(ctx);
  vm.runInContext(`${parts.join('\n')}\nglobalThis.API = { deleteEnvironment, signOutAllDevices };`, ctx);
  const api = ctx.API as { deleteEnvironment: (id: string) => Promise<void>; signOutAllDevices: (u: string) => Promise<void> };

  return {
    deleteEnvironment: api.deleteEnvironment,
    signOutAllDevices: api.signOutAllDevices,
    state, confirms, calls, toasts,
    setConfirmAnswer: (v) => { confirmAnswer = v; },
    setApiResponse: (v) => { apiResponse = v; },
    setApiError: (e) => { apiError = e; },
  };
}

const withEnv = (h: Harness, id: string, name: string, usernames: string[]) => {
  h.state.environments = [{ id, name }];
  h.state.allAccounts = usernames.map((u) => ({ username: u, environmentId: id }));
};

// ── Environment delete ───────────────────────────────────────────────────────

test('EMPTY environment: plain confirm, no typed word, NO cascade on the wire', async () => {
  const h = loadFrontend();
  withEnv(h, 'env-1', 'Spare', []);
  await h.deleteEnvironment('env-1');

  assert.equal(h.confirms.length, 1);
  assert.equal(h.confirms[0].typedWord ?? null, null, 'an empty environment must not demand a typed word');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, '/api/environments/env-1',
    'no ?cascade=1 — so the server 409s if the environment gained an account since this page rendered');
  assert.equal(h.calls[0].opts?.method, 'DELETE');
});

test('NON-EMPTY environment: typed DELETE gate and ?cascade=1', async () => {
  const h = loadFrontend();
  withEnv(h, 'env-1', 'Farm', ['bot_a', 'bot_b', 'bot_c']);
  await h.deleteEnvironment('env-1');

  assert.equal(h.confirms[0].typedWord, 'DELETE', 'the irreversible path is typed-word gated');
  assert.equal(h.calls[0].path, '/api/environments/env-1?cascade=1');
  assert.equal(h.calls[0].opts?.method, 'DELETE');
});

test('the confirm names the accounts and the exact count', async () => {
  const h = loadFrontend();
  withEnv(h, 'env-1', 'Farm', ['bot_a', 'bot_b', 'bot_c']);
  await h.deleteEnvironment('env-1');

  const { body, confirmLabel } = h.confirms[0];
  assert.match(body, /3 accounts/, 'the count is stated');
  for (const u of ['bot_a', 'bot_b', 'bot_c']) assert.ok(body.includes(u), `${u} is named in the dialog`);
  assert.match(body, /for good/i, 'irreversibility is stated');
  assert.match(String(confirmLabel), /3/, 'the confirm button carries the count too');
});

test('a long account list is truncated with an explicit remainder (no silent omission)', async () => {
  const h = loadFrontend();
  withEnv(h, 'env-1', 'Farm', Array.from({ length: 20 }, (_, i) => `bot_${i}`));
  await h.deleteEnvironment('env-1');

  const body = h.confirms[0].body;
  assert.match(body, /and 14 more/, '6 shown + 14 more = the full 20 is accounted for');
  assert.match(body, /20 accounts/);
});

test('DECLINING the confirm issues NO request', async () => {
  const h = loadFrontend();
  withEnv(h, 'env-1', 'Farm', ['bot_a']);
  h.setConfirmAnswer(false);
  await h.deleteEnvironment('env-1');

  assert.equal(h.confirms.length, 1, 'the dialog was shown');
  assert.equal(h.calls.length, 0, 'and nothing was deleted');
});

test('an unknown environment id never reaches the wire', async () => {
  const h = loadFrontend();
  withEnv(h, 'env-1', 'Farm', []);
  await h.deleteEnvironment('does-not-exist');

  assert.equal(h.calls.length, 0);
  assert.equal(h.confirms.length, 0, 'no confirm for something that is not there');
  assert.equal(h.toasts[0]?.kind, 'error');
});

test('local state pointing at the deleted environment is cleared', async () => {
  const h = loadFrontend();
  withEnv(h, 'env-1', 'Farm', ['bot_a']);
  h.state.globalEnvs.add('env-1');
  h.state.accEnv = 'env-1';
  h.state.accountsUser = 'bot_a';
  h.state.accSel.add('bot_a');
  h.state.activeEnv = 'env-1';
  h.state.activeUsername = 'bot_a';
  h.state.invMode = 'env-master';

  await h.deleteEnvironment('env-1');

  assert.equal(h.state.globalEnvs.has('env-1'), false, 'dropped from the global-master selection');
  assert.equal(h.state.accEnv, null, 'the Accounts module leaves the environment');
  assert.equal(h.state.accountsUser, null);
  assert.equal(h.state.accSel.size, 0);
  assert.equal(h.state.activeEnv, null, 'the Inventories drill-down is reset');
  assert.equal(h.state.activeUsername, null);
  assert.equal(h.state.invMode, 'account');
  // Asserted structurally, not with deepEqual: the object is constructed inside the vm realm, so a
  // strict deep-compare would fail on the prototype alone. What matters is that it is a non-null
  // object with EMPTY folders/accounts arrays — renderNodes/findFolderNode dereference both unguarded.
  assert.ok(h.state.tree && typeof h.state.tree === 'object', 'tree must never be null');
  assert.equal(h.state.tree.folders.length, 0, 'tree.folders is an empty array');
  assert.equal(h.state.tree.accounts.length, 0, 'tree.accounts is an empty array');
});

test('an environment the operator is NOT standing in leaves the current view alone', async () => {
  const h = loadFrontend();
  h.state.environments = [{ id: 'env-1', name: 'Farm' }, { id: 'env-2', name: 'Other' }];
  h.state.allAccounts = [{ username: 'bot_a', environmentId: 'env-1' }];
  h.state.accEnv = 'env-2';
  h.state.activeEnv = 'env-2';

  await h.deleteEnvironment('env-1');

  assert.equal(h.state.accEnv, 'env-2', 'still in env-2');
  assert.equal(h.state.activeEnv, 'env-2');
});

test('a server refusal surfaces as an error and does NOT clear local state', async () => {
  const h = loadFrontend();
  withEnv(h, 'env-1', 'Farm', ['bot_a']);
  h.state.accEnv = 'env-1';
  h.setApiError(new Error('Environment still holds 1 account(s) – move them out first'));

  await h.deleteEnvironment('env-1');

  assert.equal(h.toasts.at(-1)?.kind, 'error');
  assert.match(h.toasts.at(-1)!.msg, /still holds/);
  assert.equal(h.state.accEnv, 'env-1', 'the view must not pretend the environment is gone');
});

// ── Sign out of all devices ──────────────────────────────────────────────────

test('sign-out is confirm-gated and posts to the right route', async () => {
  const h = loadFrontend();
  h.setApiResponse({ status: 'done', detail: 'ok' });
  await h.signOutAllDevices('bot_a');

  assert.equal(h.confirms.length, 1);
  assert.match(h.confirms[0].body, /every/i, 'the dialog states the blast radius');
  assert.equal(h.calls[0].path, '/api/steam/bot_a/signout-all-devices');
  assert.equal(h.calls[0].opts?.method, 'POST');
  assert.equal(h.toasts.at(-1)?.kind, 'success');
});

test('sign-out: DECLINING issues no request', async () => {
  const h = loadFrontend();
  h.setConfirmAnswer(false);
  await h.signOutAllDevices('bot_a');
  assert.equal(h.calls.length, 0);
});

test('sign-out: an AMBIGUOUS outcome is reported as unknown, never as success', async () => {
  const h = loadFrontend();
  h.setApiResponse({ status: 'ambiguous', detail: 'Steam returned the page instead of confirming' });
  await h.signOutAllDevices('bot_a');

  const last = h.toasts.at(-1)!;
  assert.equal(last.kind, 'warn', 'not a success toast');
  assert.match(last.msg, /did not confirm/i, 'and says Steam never confirmed it');
});

test('sign-out: the busy flag is always released, success or failure', async () => {
  const ok = loadFrontend();
  ok.setApiResponse({ status: 'done' });
  await ok.signOutAllDevices('bot_a');
  assert.equal(ok.state.accountsBusy['bot_a'], null, 'released after success');

  const bad = loadFrontend();
  bad.setApiError(new Error('409 refused'));
  await bad.signOutAllDevices('bot_b');
  assert.equal(bad.state.accountsBusy['bot_b'], null, 'released after failure — no permanently stuck spinner');
  assert.equal(bad.toasts.at(-1)?.kind, 'error');
});

test('sign-out: a server refusal (token-only account) surfaces its reason verbatim', async () => {
  const h = loadFrontend();
  h.setApiError(new Error('No maFile or password saved for this account, so its refresh token is the only way SSIM can log in. Signing out would kill it and lock SSIM out for good. Add them first.'));
  await h.signOutAllDevices('bot_limited');

  assert.equal(h.toasts.at(-1)?.kind, 'error');
  assert.match(h.toasts.at(-1)!.msg, /lock SSIM out/,
    'the operator must see WHY it was refused, not a generic failure');
});
