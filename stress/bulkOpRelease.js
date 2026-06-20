/* eslint-disable */
// ════════════════════════════════════════════════════════════════════════════
//  bulkOpRelease.js — proves the NON-refresh fleet-wide login fan-outs RELEASE the
//  sessions they create (so none of them can leave the whole fleet resident — the
//  resident-session storm that lets the process be externally killed).
//
//  Covers:  TradeService.getOffersForAccounts (the global Trade-Offers view) and
//           TradeService.startMassSend (mass-send) — both now release via the shared
//           releaseCreatedSessions() helper, exactly like InventoryService.runRefresh.
//  Also verifies the wasLiveBefore SNAPSHOT: a session that was ALREADY live before the
//  op (e.g. one the user is trading with) is PRESERVED, never torn down.
//
//  USAGE:  node stress/bulkOpRelease.js [accounts] [passes]
// ════════════════════════════════════════════════════════════════════════════
'use strict';
const Module = require('module');
const path = require('path');
const EventEmitter = require('events');
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const N = Number(process.argv[2]) || 150;
const PASSES = Number(process.argv[3]) || 4;
const PRELIVE = 5; // accounts we log in FIRST → must be PRESERVED by the release

// ── Minimal Steam mocks (login succeeds instantly; nothing hits the network) ────
const counters = { clientsCreated: 0, clientsDestroyed: 0, liveClients: new Set() };
let CSEQ = 0;
class FakeSteamUser extends EventEmitter {
  constructor() { super(); this.setMaxListeners(50); this._id = ++CSEQ; this.steamID = { getSteamID64: () => '7656119800000' + String(1000 + this._id) }; counters.clientsCreated++; counters.liveClients.add(this._id); }
  logOn() { setImmediate(() => { this.emit('loggedOn', { eresult: 1 }); this.emit('wallet', true, 1, 500); setImmediate(() => this.emit('webSession', 's' + this._id, ['sessionid=a' + this._id, 'steamLoginSecure=x' + this._id])); }); }
  webLogOn() { setImmediate(() => this.emit('webSession', 's' + this._id, ['sessionid=a' + this._id, 'steamLoginSecure=x' + this._id])); }
  logOff() {} gamesPlayed() {} getPersonas(ids, cb) { cb(null, {}); }
  removeAllListeners(ev) { if (ev === undefined && counters.liveClients.has(this._id)) { counters.clientsDestroyed++; counters.liveClients.delete(this._id); } return super.removeAllListeners(ev); }
}
class FakeCommunity extends EventEmitter { constructor() { super(); this.setMaxListeners(50); } setCookies() {} getTradeURL(cb) { cb(null, 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=t'); } getConfirmations(_t, _k, cb) { cb(null, []); } }
class FakeTradeManager extends EventEmitter {
  constructor() { super(); this.setMaxListeners(50); }
  setCookies(_c, cb) { if (cb) setImmediate(() => cb(null)); }
  getOffers(_f, _c, cb) { cb(null, [], []); } getOffer(id, cb) { cb(null, { id }); }
  createOffer() { return { addMyItems() {}, addTheirItems() {}, setMessage() {}, send(cb) { setImmediate(() => cb(null, 'sent')); }, id: 'o1' }; }
  shutdown() {}
}
FakeTradeManager.ETradeOfferState = { Active: 2, Accepted: 3, CreatedNeedsConfirmation: 9, InEscrow: 11 };
FakeTradeManager.EOfferFilter = { All: 1 };
const FAKES = { 'steam-user': FakeSteamUser, 'steamcommunity': FakeCommunity, 'steam-tradeoffer-manager': FakeTradeManager, 'request': { defaults: () => ({}) } };
const origLoad = Module._load;
Module._load = function (req, parent, isMain) { return Object.prototype.hasOwnProperty.call(FAKES, req) ? FAKES[req] : origLoad.call(this, req, parent, isMain); };

const D = (p) => require(path.join(__dirname, '..', 'dist', p));
const { SessionManager } = D('core/SessionManager.js');
const { TradeService } = D('trading/TradeService.js');
const LoginFlow = D('core/LoginFlow.js');
LoginFlow.loadMaFile = () => ({ shared_secret: 'c2hhcmVk', identity_secret: 'aWQ=', account_name: 'n' });
LoginFlow.buildLogOnOptions = (a) => ({ accountName: a.username, password: a.password, twoFactorCode: '00000' });

const accountsByName = new Map();
for (let i = 0; i < N; i++) {
  const a = { id: 'i' + i, username: 'bot_' + i, password: 'p' + i, maFilePath: 'n.maFile', environmentId: 'e', enabled: true,
    network: i % 3 === 0 ? { type: 'localip', value: '0.0.0.0' } : { type: 'proxy', value: 'http://u:p@10.0.0.' + (i % 250 + 1) + ':3128' }, addedAt: '2026-01-01T00:00:00Z' };
  accountsByName.set(a.username.toLowerCase(), a);
}
const accountsStub = { get: (u) => accountsByName.get(String(u).toLowerCase()), rememberSteamId: () => {}, getAll: () => [...accountsByName.values()] };
const sessions = new SessionManager();
const trades = new TradeService(sessions, accountsStub);
sessions.on('error', () => {}); sessions.on('disconnected', () => {}); sessions.on('loggedIn', () => {});

const usernames = [...accountsByName.keys()].map((k) => accountsByName.get(k).username);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const live = () => sessions.getAllSessions().length;

async function main() {
  console.log(`\n=== bulk-op release: ${N} accounts × ${PASSES} passes, ${PRELIVE} pre-live (must be preserved) ===\n`);
  const fails = [];

  // Pre-log-in PRELIVE accounts → they must be PRESERVED by every bulk op's release.
  const preliveUsers = usernames.slice(0, PRELIVE);
  for (const u of preliveUsers) await sessions.loginAccount(accountsByName.get(u.toLowerCase()));
  console.log(`pre-live established: ${live()} (expected ${PRELIVE})`);

  console.log('\npass | op         | live-after | expected | clientsLive');
  console.log('-----+------------+------------+----------+------------');
  for (let p = 1; p <= PASSES; p++) {
    // ── A) global Trade-Offers view across the WHOLE fleet ──
    await trades.getOffersForAccounts(usernames);
    let after = live();
    console.log(` ${String(p).padStart(3)} | offers     |    ${String(after).padStart(5)}   |   ${String(PRELIVE).padStart(4)}   |   ${String(counters.liveClients.size).padStart(5)}`);
    if (after !== PRELIVE) fails.push(`pass ${p} offers: ${after} live after (expected ${PRELIVE} pre-live preserved, rest released)`);

    // ── B) mass-send across a small set of senders (paced; keep it short) ──
    const senders = usernames.slice(PRELIVE, PRELIVE + 6);
    const groups = senders.map((u) => ({ username: u, assetIds: ['a1'] }));
    trades.startMassSend(groups, 'https://steamcommunity.com/tradeoffer/new/?partner=99&token=z', { delayMs: 0 });
    for (;;) { await sleep(50); if (!trades.massStatus().running) break; }
    await sleep(50);
    after = live();
    console.log(` ${String(p).padStart(3)} | mass-send  |    ${String(after).padStart(5)}   |   ${String(PRELIVE).padStart(4)}   |   ${String(counters.liveClients.size).padStart(5)}`);
    if (after !== PRELIVE) fails.push(`pass ${p} mass-send: ${after} live after (expected ${PRELIVE} preserved)`);
  }

  // The pre-live accounts must STILL be live + intact (never torn down by a bulk op's release).
  const preserved = preliveUsers.filter((u) => sessions.isLive(u)).length;
  console.log(`\npre-live preserved at end: ${preserved}/${PRELIVE}`);
  if (preserved !== PRELIVE) fails.push(`pre-live preservation: ${preserved}/${PRELIVE} survived (a bulk op tore down a user's existing session!)`);

  if (fails.length) { console.log(`\n❌ BULK-RELEASE FAIL (${fails.length}):`); for (const f of fails) console.log('   - ' + f); process.exitCode = 1; }
  else console.log('\n✅ BULK-RELEASE PASS — offers + mass-send return the fleet to the pre-op baseline every pass; pre-existing live sessions preserved.');
}
main().then(() => { try { trades.shutdown(); } catch {} setTimeout(() => process.exit(process.exitCode || 0), 150).unref(); })
  .catch((e) => { console.error('HARNESS ERROR:', e && e.stack || e); process.exit(2); });
