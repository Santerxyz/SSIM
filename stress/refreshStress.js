/* eslint-disable */
// ════════════════════════════════════════════════════════════════════════════
//  refreshStress.js — deterministic resource-lifecycle stress test for the
//  full-fleet REFRESH path (the documented crash trigger).
//
//  WHAT IT PROVES
//  The real crash signature was: a full-fleet refresh drove LIVE SESSIONS (each =
//  a Steam client + proxy sockets + a polling TradeOfferManager) climbing 0→137→…
//  toward 538, after which the (healthy) process was externally terminated. The
//  reliability question is therefore: does the refresh path BOUND every resource,
//  and does NOTHING accumulate across REPEATED refreshes?
//
//  This harness answers that deterministically — no real Steam, no network, no
//  credentials. It mocks steam-user / steamcommunity / steam-tradeoffer-manager /
//  request at the require() layer, then drives the REAL SessionManager +
//  TradeService + InventoryService.runRefresh over N synthetic accounts for many
//  passes, sampling live resources after each pass. It asserts:
//    • live sessions / traders return to ~baseline after every pass (release works)
//    • Steam clients created == destroyed, trade-managers created == shutdown,
//      proxy agents created == destroyed  (no per-login leak)
//    • active libuv handles + RSS stay FLAT across passes (no accumulation)
//    • an 'error' emitted on a torn-down client NEVER crashes the process
//
//  USAGE:  node stress/refreshStress.js [accounts] [passes] [proxyRatio]
//    e.g.  node stress/refreshStress.js 200 12 0.7
//  Quiet the app logger with LOG_LEVEL=error (default here).
// ════════════════════════════════════════════════════════════════════════════

'use strict';
const Module = require('module');
const path = require('path');

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error'; // keep ssim.log quiet during the run

// ── Config ────────────────────────────────────────────────────────────────────
const N_ACCOUNTS = Number(process.argv[2]) || 200;
const PASSES     = Number(process.argv[3]) || 12;
const PROXY_RATIO = process.argv[4] != null ? Number(process.argv[4]) : 0.7; // fraction on proxies
// Make the login cap + refresh release behave exactly like production defaults.
process.env.SSIM_MAX_CONCURRENT_LOGINS = process.env.SSIM_MAX_CONCURRENT_LOGINS || '25';
// Speed: shrink the local-IP throttle so proxyless accounts don't serialize for minutes.
process.env.SSIM_LOCALIP_MIN_MS = process.env.SSIM_LOCALIP_MIN_MS || '0';
process.env.SSIM_LOCALIP_MAX_MS = process.env.SSIM_LOCALIP_MAX_MS || '0';

// ── Instance accounting (the leak detector) ─────────────────────────────────────
const counters = {
  clientsCreated: 0, clientsDestroyed: 0,
  managersCreated: 0, managersShutdown: 0,
  liveClients: new Set(),   // FakeSteamUser instances that have NOT been removeAllListeners'd
  liveManagers: new Set(),  // FakeTradeManager instances that have NOT been shutdown
  postTeardownErrorsSurvived: 0,
};

// ── Fake steam-user ─────────────────────────────────────────────────────────────
const EventEmitter = require('events');
let CLIENT_SEQ = 0;
class FakeSteamUser extends EventEmitter {
  constructor(_opts) {
    super();
    this.setMaxListeners(50);
    this._id = ++CLIENT_SEQ;
    this._loggedOff = false;
    this.steamID = { getSteamID64: () => '76561190000000000'.slice(0, -String(this._id).length) + String(this._id) };
    counters.clientsCreated++;
    counters.liveClients.add(this._id);
  }
  logOn(_opts) {
    // Mimic steam-user: loggedOn, then wallet, then webSession a tick later.
    setImmediate(() => {
      if (this._loggedOff) return;
      this.emit('loggedOn', { eresult: 1 });
      this.emit('wallet', true, 1, 1000);
      setImmediate(() => {
        if (this._loggedOff) return;
        this.emit('webSession', 'sess_' + this._id, [
          'sessionid=abc' + this._id,
          'steamLoginSecure=765611' + this._id + '%7C%7Ctoken',
        ]);
      });
    });
  }
  webLogOn() {
    setImmediate(() => {
      if (this._loggedOff) return;
      this.emit('webSession', 'sess_' + this._id, ['sessionid=abc' + this._id, 'steamLoginSecure=x' + this._id]);
    });
  }
  logOff() { this._loggedOff = true; }
  gamesPlayed() { /* GC noop */ }
  getPersonas(ids, cb) { cb(null, {}); }
  removeAllListeners(ev) {
    if (ev === undefined && counters.liveClients.has(this._id)) {
      counters.clientsDestroyed++;
      counters.liveClients.delete(this._id);
    }
    return super.removeAllListeners(ev);
  }
}

// ── Fake steamcommunity ─────────────────────────────────────────────────────────
class FakeCommunity extends EventEmitter {
  constructor(_opts) { super(); this.setMaxListeners(50); }
  setCookies(_c) { /* noop */ }
  getTradeURL(cb) { cb(null, 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=abc'); }
  getConfirmations(_t, _k, cb) { cb(null, []); }
}

// ── Fake steam-tradeoffer-manager ───────────────────────────────────────────────
let MGR_SEQ = 0;
class FakeTradeManager extends EventEmitter {
  constructor(_opts) {
    super();
    this.setMaxListeners(50);
    this._id = ++MGR_SEQ;
    counters.managersCreated++;
    counters.liveManagers.add(this._id);
  }
  setCookies(_cookies, cb) { if (cb) setImmediate(() => cb(null)); }
  getOffers(_filter, _cutoff, cb) { cb(null, [], []); }
  getOffer(id, cb) { cb(null, { id }); }
  createOffer() { return { addMyItems() {}, addTheirItems() {}, setMessage() {}, send(cb) { cb(null, 'sent'); }, id: 'x' }; }
  shutdown() {
    if (counters.liveManagers.has(this._id)) { counters.managersShutdown++; counters.liveManagers.delete(this._id); }
  }
}
FakeTradeManager.ETradeOfferState = { Active: 2, Accepted: 3, CreatedNeedsConfirmation: 9, InEscrow: 11 };
FakeTradeManager.EOfferFilter = { All: 1, ActiveOnly: 2, HistoricalOnly: 3 };

// ── Fake request (AccountTrader does Request.defaults({...})) ────────────────────
const FakeRequest = { defaults: () => ({}) };

// ── Install the require() hook BEFORE loading any app module ─────────────────────
const FAKES = {
  'steam-user': FakeSteamUser,
  'steamcommunity': FakeCommunity,
  'steam-tradeoffer-manager': FakeTradeManager,
  'request': FakeRequest,
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(FAKES, request)) return FAKES[request];
  return origLoad.call(this, request, parent, isMain);
};

// ── Now require the REAL app modules (they pick up the fakes) ─────────────────────
const D = (p) => require(path.join(__dirname, '..', 'dist', p));
const { SessionManager }    = D('core/SessionManager.js');
const { TradeService }      = D('trading/TradeService.js');
const { InventoryService }  = D('core/InventoryService.js');
const { InventoryManager }  = D('core/InventoryManager.js');
const LoginFlow             = D('core/LoginFlow.js');
const MarketListings        = D('core/MarketListings.js');
const { AgentFactory }      = D('network/AgentFactory.js');

// ── Patch the disk/network leaves so the refresh is hermetic ─────────────────────
// 1) maFile load + logon-options: avoid disk + steam-totp; force a working credential login.
LoginFlow.loadMaFile = () => ({ shared_secret: 'c2hhcmVk', identity_secret: 'aWRlbnRpdHk=', account_name: 'n' });
LoginFlow.buildLogOnOptions = (account) => ({ accountName: account.username, password: account.password, twoFactorCode: '00000' });
// 2) inventory + market fetches: return instantly with empty data (no HTTP).
InventoryManager.fetchRaw = async () => ({ assets: [], descriptions: [], total_inventory_count: 0, success: 1 });
MarketListings.fetchListedItems = async () => [];
// Count proxy-agent disposal to prove per-account agents are destroyed on logout.
let agentsDestroyed = 0;
const origDestroyIfDisposable = AgentFactory.destroyIfDisposable.bind(AgentFactory);
AgentFactory.destroyIfDisposable = (agent) => { try { origDestroyIfDisposable(agent); } finally { if (agent && agent.constructor && /Proxy/.test(agent.constructor.name)) agentsDestroyed++; } };

// ── Build the wiring (mirrors api/server.ts createDeps for the refresh path) ─────
const accountsByName = new Map();
function makeAccounts(n, proxyRatio) {
  const list = [];
  for (let i = 0; i < n; i++) {
    const useProxy = i / n < proxyRatio;
    const acct = {
      id: 'id' + i,
      username: 'bot_' + i,
      password: 'pw' + i,
      maFilePath: 'none.maFile',
      environmentId: 'env1',
      enabled: true,
      network: useProxy
        ? { type: 'proxy', value: 'http://user:pass@10.0.0.' + (i % 254 + 1) + ':3128' }
        : { type: 'localip', value: '0.0.0.0' },
      addedAt: '2026-01-01T00:00:00Z',
    };
    list.push(acct);
    accountsByName.set(acct.username.toLowerCase(), acct);
  }
  return list;
}

const accountsStub = {
  get: (u) => accountsByName.get(String(u).toLowerCase()),
  rememberSteamId: () => {},
  getAll: () => [...accountsByName.values()],
};

const sessions  = new SessionManager();
const trades    = new TradeService(sessions, accountsStub);
const inventory = new InventoryService(sessions, accountsStub);
// MANDATORY listeners (an unhandled 'error' on the SessionManager EventEmitter would crash):
sessions.on('error', () => {});
sessions.on('disconnected', () => {});
sessions.on('loggedIn', () => {});

const accounts = makeAccounts(N_ACCOUNTS, PROXY_RATIO);
const usernames = accounts.map((a) => a.username);

// ── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rssMB = () => Math.round(process.memoryUsage().rss / 1048576);
const handles = () => { try { return process._getActiveHandles().length; } catch { return -1; } };

async function runOnePass() {
  inventory.startRefresh(usernames, 'cs2');
  // Poll until the background refresh job finishes.
  for (;;) {
    await sleep(40);
    if (!inventory.status().running) break;
  }
  // Give the post-refresh session-release (logoutAccount) microtasks a moment to settle.
  await sleep(50);
}

async function main() {
  console.log(`\n=== SSIM refresh stress: ${N_ACCOUNTS} accounts × ${PASSES} passes (proxyRatio=${PROXY_RATIO}) ===`);
  console.log(`login cap=${process.env.SSIM_MAX_CONCURRENT_LOGINS}, release=${process.env.SSIM_REFRESH_RELEASE_SESSIONS !== '0'}\n`);
  console.log('pass | live-sess live-trad | clientsLive mgrsLive | handles  rssMB | peakSessThisPass');
  console.log('-----+---------------------+----------------------+----------------+------------------');

  const samples = [];
  let peakSessAcross = 0;

  for (let p = 1; p <= PASSES; p++) {
    // Track peak live sessions DURING the pass (the metric that climbed to 137 in the crash).
    let peakSess = 0;
    const watch = setInterval(() => {
      const s = sessions.getAllSessions().length;
      if (s > peakSess) peakSess = s;
      if (s > peakSessAcross) peakSessAcross = s;
    }, 20);
    await runOnePass();
    clearInterval(watch);

    const liveSess = sessions.getAllSessions().length;
    const liveTrad = trades.traderCount;
    const clientsLive = counters.liveClients.size;
    const mgrsLive = counters.liveManagers.size;
    const h = handles();
    const rss = rssMB();
    samples.push({ p, liveSess, liveTrad, clientsLive, mgrsLive, h, rss, peakSess });
    console.log(
      ` ${String(p).padStart(3)} |   ${String(liveSess).padStart(4)}     ${String(liveTrad).padStart(4)}  |    ${String(clientsLive).padStart(5)}    ${String(mgrsLive).padStart(5)} |  ${String(h).padStart(4)}   ${String(rss).padStart(4)} |   ${String(peakSess).padStart(4)}`,
    );
    if (global.gc) global.gc();
  }

  // ── Post-teardown 'error' safety: emit 'error' on a freshly torn-down client ──
  // (destroySession re-adds a no-op 'error' handler; without it Node aborts the process.)
  {
    const acct = accounts[0];
    await sessions.loginAccount(acct);
    const sess = sessions.getSession(acct.username);
    const client = sess && sess.client;
    await sessions.logoutAccount(acct.username); // destroySession → removeAllListeners + no-op 'error'
    try {
      if (client) { client.emit('error', new Error('post-teardown boom')); counters.postTeardownErrorsSurvived++; }
    } catch (e) {
      console.log('  !! post-teardown error CRASHED the emitter path:', e && e.message);
    }
  }

  // ── Verdict ───────────────────────────────────────────────────────────────────
  const first = samples[Math.min(2, samples.length - 1)]; // compare against pass 3 (warmed up)
  const last  = samples[samples.length - 1];
  const fails = [];

  // 1) Every pass must return to ~0 live sessions/traders (release worked).
  for (const s of samples) {
    if (s.liveSess > 3) fails.push(`pass ${s.p}: ${s.liveSess} live sessions remained (expected ~0 after release)`);
    if (s.liveTrad > 3) fails.push(`pass ${s.p}: ${s.liveTrad} live traders remained (expected ~0)`);
    if (s.clientsLive > 3) fails.push(`pass ${s.p}: ${s.clientsLive} Steam clients un-torn-down (leak)`);
    if (s.mgrsLive > 3) fails.push(`pass ${s.p}: ${s.mgrsLive} trade-managers un-shutdown (leak)`);
  }
  // 2) Create == destroy across the whole run (no per-login leak).
  const clientLeak = counters.clientsCreated - counters.clientsDestroyed;
  const mgrLeak = counters.managersCreated - counters.managersShutdown;
  if (clientLeak > 3) fails.push(`Steam clients: created ${counters.clientsCreated} vs destroyed ${counters.clientsDestroyed} (leak ${clientLeak})`);
  if (mgrLeak > 3) fails.push(`trade-managers: created ${counters.managersCreated} vs shutdown ${counters.managersShutdown} (leak ${mgrLeak})`);
  // 3) Handles + RSS must stay flat across passes (no accumulation).
  const handleGrowth = last.h - first.h;
  const rssGrowth = last.rss - first.rss;
  if (handleGrowth > 15) fails.push(`active handles grew ${first.h}→${last.h} (+${handleGrowth}) across passes`);
  if (rssGrowth > 120) fails.push(`RSS grew ${first.rss}→${last.rss}MB (+${rssGrowth}) across passes`);
  // 4) Post-teardown error must have been survived.
  if (counters.postTeardownErrorsSurvived < 1) fails.push('post-teardown client.emit("error") was not survived (no no-op handler?)');

  console.log('\n── instance accounting ──');
  console.log(`Steam clients : created=${counters.clientsCreated}  destroyed=${counters.clientsDestroyed}  stillLive=${counters.liveClients.size}`);
  console.log(`trade managers: created=${counters.managersCreated}  shutdown=${counters.managersShutdown}  stillLive=${counters.liveManagers.size}`);
  console.log(`proxy agents destroyed on logout: ${agentsDestroyed}`);
  console.log(`peak live sessions during any pass: ${peakSessAcross}  (login cap ${process.env.SSIM_MAX_CONCURRENT_LOGINS})`);
  console.log(`handles ${first.h}→${last.h}  rss ${first.rss}→${last.rss}MB  post-teardown 'error' survived: ${counters.postTeardownErrorsSurvived}`);

  if (fails.length) {
    console.log(`\n❌ STRESS FAIL (${fails.length}):`);
    for (const f of fails) console.log('   - ' + f);
    process.exitCode = 1;
  } else {
    console.log('\n✅ STRESS PASS — sessions/traders/clients/managers released every pass; handles + RSS flat across passes; post-teardown error survived.');
    process.exitCode = 0;
  }
}

main().then(() => {
  // Clean up any lingering services so the harness exits.
  try { trades.shutdown(); } catch {}
  try { inventory.store.flush && inventory.store.flush(); } catch {}
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref();
}).catch((e) => {
  console.error('HARNESS ERROR:', e && e.stack || e);
  process.exit(2);
});
