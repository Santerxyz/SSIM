import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─────────────────────────────────────────────────────────────────────────────
//  H-TRD-006 — a landed-but-response-lost 2FA accept must not be reported as
//  'unconfirmed'. acceptConfirmationForObject retries the accept 4×; if attempt 1's
//  ajaxop LANDED on Steam but its response was lost (timeout/RST), attempts 2–4 find
//  no confirmation for the object and the loop throws — although the offer is already
//  cleared. confirmOffer now disambiguates via the offer's STATE before propagating,
//  with a per-kind cleared-predicate:
//    kind 'sent'     → cleared ⇔ state !== CreatedNeedsConfirmation (9)
//    kind 'accepted' → cleared ⇔ state === Accepted (3)
//  An accept-side confirmation still pending leaves the offer Active (2), so the two
//  paths MUST use different predicates. On a not-cleared state — or if the probe
//  itself throws — the original error rethrows (status stays 'unconfirmed').
//
//  confirmOffer reads only this.acceptConfirmationForObject, this.getOfferById and
//  this.username; Object.create + stubbed collaborators exercises the shipped logic.
// ─────────────────────────────────────────────────────────────────────────────

const CONF_FAIL = 'trade 42: 2FA confirmation failed after retries (HTTP 503)';

function traderWithState(state: number | undefined): any {
  const { AccountTrader } = require('../src/trading/AccountTrader');
  const t: any = Object.create(AccountTrader.prototype);
  t.username = 'bob';
  // The bounded retry loop exhausted (a lost-response accept looks identical to this).
  t.acceptConfirmationForObject = async () => { throw new Error(CONF_FAIL); };
  t.getOfferById = async () => ({ state });
  return t;
}

test('H-TRD-006: kind "sent" + state 2 (Active) → resolves (confirmation cleared)', async () => {
  const t = traderWithState(2);
  await t.confirmOffer('42', 'sent');   // must NOT throw
});

test('H-TRD-006: kind "sent" + state 3 (Accepted) → resolves', async () => {
  const t = traderWithState(3);
  await t.confirmOffer('42', 'sent');
});

test('H-TRD-006: kind "sent" + state 9 (CreatedNeedsConfirmation) → rejects (still unconfirmed)', async () => {
  const t = traderWithState(9);
  await assert.rejects(t.confirmOffer('42', 'sent'), /2FA confirmation failed after retries/,
    'a genuinely-unconfirmed sent offer still throws');
});

test('H-TRD-006: kind "accepted" + state 3 (Accepted) → resolves', async () => {
  const t = traderWithState(3);
  await t.confirmOffer('42', 'accepted');
});

test('H-TRD-006: kind "accepted" + state 2 (Active) → rejects (accept-side conf still pending)', async () => {
  const t = traderWithState(2);
  await assert.rejects(t.confirmOffer('42', 'accepted'), /2FA confirmation failed after retries/,
    'Active is NOT cleared for the accept path (the sent predicate would falsely pass)');
});

test('H-TRD-006: getOfferById rejection → rethrows the original error for BOTH kinds', async () => {
  for (const kind of ['sent', 'accepted'] as const) {
    const { AccountTrader } = require('../src/trading/AccountTrader');
    const t: any = Object.create(AccountTrader.prototype);
    t.username = 'bob';
    t.acceptConfirmationForObject = async () => { throw new Error(CONF_FAIL); };
    t.getOfferById = async () => { throw new Error('offer #42 not found'); };
    await assert.rejects(t.confirmOffer('42', kind), /2FA confirmation failed after retries/,
      `an unprovable state (${kind}) never claims success`);
  }
});

test('H-TRD-006: sendTrade reports "confirmed" when a lost-response send is cleared (state 2)', async () => {
  const { AccountTrader } = require('../src/trading/AccountTrader');
  const t: any = Object.create(AccountTrader.prototype);
  t.username = 'bob';
  t.cookiesReady = true;
  t.acceptConfirmationForObject = async () => { throw new Error(CONF_FAIL); };
  t.getOfferById = async () => ({ state: 2 });   // sent offer cleared to Active
  t.manager = {
    createOffer: () => ({
      id: '42',
      addMyItems() {},
      addTheirItems() {},
      setMessage() {},
      send: (cb: (err: Error | null, s: string) => void) => cb(null, 'pending'),
    }),
  };

  const res = await t.sendTrade({ partnerSteamId: '7656', myItems: [{ assetId: '1', appId: 730, contextId: '2' }] });
  assert.equal(res.status, 'confirmed', 'a lost-response send verified via state is confirmed, not unconfirmed');
});

test('H-TRD-006: sendTrade still reports "unconfirmed" when the offer is genuinely NeedsConfirmation (state 9)', async () => {
  const { AccountTrader } = require('../src/trading/AccountTrader');
  const t: any = Object.create(AccountTrader.prototype);
  t.username = 'bob';
  t.cookiesReady = true;
  t.acceptConfirmationForObject = async () => { throw new Error(CONF_FAIL); };
  t.getOfferById = async () => ({ state: 9 });   // still awaiting confirmation
  t.manager = {
    createOffer: () => ({
      id: '42',
      addMyItems() {},
      addTheirItems() {},
      setMessage() {},
      send: (cb: (err: Error | null, s: string) => void) => cb(null, 'pending'),
    }),
  };

  const res = await t.sendTrade({ partnerSteamId: '7656', myItems: [{ assetId: '1', appId: 730, contextId: '2' }] });
  assert.equal(res.status, 'unconfirmed', 'a genuinely-unconfirmed send stays unconfirmed');
});
