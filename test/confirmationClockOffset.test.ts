import { test } from 'node:test';
import assert from 'node:assert/strict';
import SteamTotp from 'steam-totp';
import { AccountTrader } from '../src/trading/AccountTrader';
import { installSteamTotpTimeout, getSteamTotpOffsetSeconds } from '../src/trading/steamTotpTimeout';

// ─────────────────────────────────────────────────────────────────────────────
//  v1.4.4 (owner issue 2: "SDA and confirmations are completely not functioning")
//
//  A confirmation key is signed against STEAM's clock. rawFetchConfirmationList fell
//  back to offset 0 — the RAW LOCAL clock — whenever QueryTime errored. On a host whose
//  clock has drifted, every key is then signed at the wrong time and Steam rejects the
//  whole confirmation list. The login path already prefers the last REAL offset the S6
//  layer learned; the confirmation path did not. These pin the aligned behaviour.
//
//  This does not claim to BE the owner's root cause (that needs a live session) — it
//  removes one silent way the whole confirmation surface can fail, and makes it loud.
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTrader = any;

/** Drive rawFetchConfirmationList with a stubbed community + a chosen getTimeOffset outcome. */
function runRawFetch(opts: { offErr: Error | null; offset: number }): Promise<{ off: number; signedTime: number }> {
  const t: AnyTrader = Object.create(AccountTrader.prototype);
  Object.defineProperty(t, 'username', { value: 'bot', writable: true });
  t.session = { maFile: { identity_secret: 'c2VjcmV0c2VjcmV0c2VjcmV0c2U=' } };
  let signedTime = -1;
  t.community = {
    getConfirmations(time: number, _key: unknown, cb: (e: Error | null, c: unknown[]) => void) {
      signedTime = time;
      cb(null, []);
    },
  };
  const real = SteamTotp.getTimeOffset;
  (SteamTotp as unknown as { getTimeOffset: (cb: (e: Error | null, o: number) => void) => void })
    .getTimeOffset = (cb) => cb(opts.offErr, opts.offset);
  return t.rawFetchConfirmationList()
    .then((r: { off: number }) => ({ off: r.off, signedTime }))
    .finally(() => { (SteamTotp as unknown as { getTimeOffset: unknown }).getTimeOffset = real; });
}

test('a successful QueryTime signs with the REAL Steam offset', async () => {
  const r = await runRawFetch({ offErr: null, offset: 42 });
  assert.equal(r.off, 42, 'the live offset is used verbatim');
  assert.equal(r.signedTime, SteamTotp.time(42), 'the getlist is signed against Steam time, not local time');
});

test('a FAILED QueryTime falls back to the last known real offset, not a bare 0', async () => {
  // Teach the S6 layer a real offset the way a successful QueryTime would.
  installSteamTotpTimeout({ timeoutMs: 50 });
  const learned = getSteamTotpOffsetSeconds();

  const r = await runRawFetch({ offErr: new Error('QueryTime failed'), offset: 0 });
  assert.equal(r.off, learned, 'the error path reuses the mirrored offset (0 only when none was ever learned)');
  assert.equal(r.signedTime, SteamTotp.time(learned), 'the signed time follows that same offset');
});

test('with no offset ever learned the fallback is byte-identical to the old behaviour (0)', async () => {
  // getSteamTotpOffsetSeconds() is 0 until a real offset is learned, so a machine that never reached
  // Steam's QueryTime signs exactly as it did before this change — no behavioural change, no new risk.
  const mirrored = getSteamTotpOffsetSeconds();
  if (mirrored !== 0) return; // an offset was learned in this process; the assertion above already covers it
  const r = await runRawFetch({ offErr: new Error('offline'), offset: 0 });
  assert.equal(r.off, 0, 'cold fallback stays 0');
});
