import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { CsFloatDeliveredStore } from '../src/csfloat/CsFloatDeliveredStore';
import { isValidDeliveryTarget } from '../src/csfloat/CsFloatAutoAcceptWorker';

// C6 / INV-F1 — delivered ids must survive a restart, or a sale re-delivers (double send).
test('CsFloatDeliveredStore: delivered ids survive a "restart"', () => {
  const file = path.join(os.tmpdir(), `ssim-delivered-${process.pid}-${Date.now()}.json`);
  try {
    const a = new CsFloatDeliveredStore(file);
    assert.equal(a.has('trade-1'), false);
    a.add('trade-1');
    // Simulate a process bounce: a brand-new instance reads the SAME file.
    const b = new CsFloatDeliveredStore(file);
    assert.equal(b.has('trade-1'), true, 'a new process sees the prior delivery and will not re-send');
    assert.equal(b.has('trade-2'), false);
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* best-effort cleanup */ }
  }
});

// S39 — a RUNTIME persist failure must eventually pause delivery. The load-side degraded gate only
// covers a boot-time corrupt file; if add()'s write keeps failing, the delivered ids live in memory
// only and a crash re-delivers them. After N consecutive failures the store latches DEGRADED.
function withWriteFailing(fn: () => void): void {
  const atomic = require('../src/utils/atomicJson');
  const orig = atomic.writeJsonAtomic;
  atomic.writeJsonAtomic = () => { throw new Error('EACCES (simulated disk/AV lock)'); };
  try { fn(); } finally { atomic.writeJsonAtomic = orig; }
}

function freshDeliveredPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-delv-')), 'csfloat_delivered.json');
}

test('S39: N consecutive persist failures latch DEGRADED (auto-delivery paused)', () => {
  const store = new CsFloatDeliveredStore(freshDeliveredPath());
  assert.equal(store.isDegraded(), false, 'a missing file is not degraded');
  withWriteFailing(() => {
    store.add('id-1'); assert.equal(store.isDegraded(), false, '1 failure tolerated');
    store.add('id-2'); assert.equal(store.isDegraded(), false, '2 failures tolerated');
    store.add('id-3'); // 3rd consecutive failure → latch
  });
  assert.equal(store.isDegraded(), true, 'auto-delivery disabled after N persist failures');
});

test('S39: a successful write resets the failure streak (a transient blip self-heals)', () => {
  const file = freshDeliveredPath();
  const store = new CsFloatDeliveredStore(file);
  withWriteFailing(() => { store.add('a'); store.add('b'); }); // 2 failures (in-memory only)
  store.add('c');                                              // succeeds → persists a,b,c AND resets streak
  assert.equal(store.isDegraded(), false);
  withWriteFailing(() => { store.add('d'); store.add('e'); }); // 2 more, but the streak was reset
  assert.equal(store.isDegraded(), false, 'a mid-streak success prevents the latch');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).ids.sort(), ['a', 'b', 'c'],
    'the successful write persisted the ids buffered during the blip');
});

// S39 residue / INV-F1 — the in-memory latch is lost on the very crash it defends against (the last-good
// file lacks the buffered ids), so a fresh boot would resume delivery and re-send them. A sidecar marker
// makes the degraded state SURVIVE a restart until an operator clears the fault.
test('S39: a persist-failure latch survives a restart (marker keeps delivery paused)', () => {
  const file = freshDeliveredPath();
  const marker = `${file}.persist_failed`;
  const store = new CsFloatDeliveredStore(file);
  withWriteFailing(() => {
    store.add('id-1'); store.add('id-2'); store.add('id-3'); // 3rd consecutive failure → latch + marker
  });
  assert.equal(store.isDegraded(), true, 'auto-delivery disabled after N persist failures');
  assert.equal(fs.existsSync(marker), true, 'the latch wrote a durable marker sidecar');
  // Simulate a process bounce: a brand-new instance reads the SAME (last-good, id-less) file + the marker.
  const rebooted = new CsFloatDeliveredStore(file);
  assert.equal(rebooted.isDegraded(), true, 'a fresh boot stays paused while the marker is present');
});

test('S39: a self-healed write clears the marker so a later boot is not falsely stranded', () => {
  const file = freshDeliveredPath();
  const marker = `${file}.persist_failed`;
  const store = new CsFloatDeliveredStore(file);
  withWriteFailing(() => { store.add('a'); store.add('b'); store.add('c'); }); // latch + marker
  assert.equal(fs.existsSync(marker), true);
  store.add('d'); // writable now → persists the FULL list and clears the marker
  assert.equal(fs.existsSync(marker), false, 'a successful persist clears the marker');
  assert.equal(store.isDegraded(), true, 'the current instance stays latched (in-memory) for this run');
  const rebooted = new CsFloatDeliveredStore(file); // marker gone → a fresh boot is not degraded
  assert.equal(rebooted.isDegraded(), false, 'a fresh boot after self-heal resumes normally');
});

// F-2 / INV-F1 — never send to an unverified destination (undocumented CSFloat payload).
test('isValidDeliveryTarget: accepts valid steamID/trade-URL, rejects malformed', () => {
  assert.equal(isValidDeliveryTarget({ assetId: '123', partnerSteamId: '76561198000000000' }), true);
  assert.equal(isValidDeliveryTarget({ assetId: '123', tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=12345&token=AbC-dE1' }), true);
  assert.equal(isValidDeliveryTarget({ assetId: '123', partnerSteamId: 'not-a-steamid' }), false);
  assert.equal(isValidDeliveryTarget({ assetId: 'abc', partnerSteamId: '76561198000000000' }), false); // non-numeric asset
  assert.equal(isValidDeliveryTarget({ assetId: '123' }), false);                                     // no destination
  assert.equal(isValidDeliveryTarget({ assetId: '123', tradeUrl: 'https://evil.example/steal' }), false);
});
