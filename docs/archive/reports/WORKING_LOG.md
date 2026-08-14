# SSIM Open-Beta Hardening — Working Log (append-only)

Branch: `hardening/open-beta` (off `feature/discord-bot` @ 6c4ea62). Mission: audit A→Z,
fix every beta-blocker (D/S/B/N/C/W classes), red→green test per fix, produce a GO release
build (NOT published).

---

## 2026-07-02 — Session start: plan

**Known-state absorbed:** INVARIANTS.md (27 invariants, banner says all 22 contradictions
HOLD post-Phase-3), CONTRADICTIONS.md (C1–C22 all ☑ fixed+tested), docs/REMEDIATION_LOG.md
(slices A–E + tail F–I + A-to-Z pass), package.json (v1.3.3, node --test harness, 17 test
files). docs/AUDIT_LEDGER.md (711 lines, 75 items, stale-marked-OPEN) needs re-triage.

**Baseline:** `npm test` running in background — must be green before any change.

**Ordered plan (per mission priority):**
1. **P1 Native crash class 0xC0000409** — SessionManager.destroySession teardown vs in-flight
   agent use; error-listener gap; uncapped post-trade fan-out (InventoryService ~L693);
   steam-user CM socket teardown. Design quiescent-teardown structure; build _crashrepro/
   into a real repro; soak test.
2. **P2 Resource safety** — listener pairings, growing Maps (sessions, localIpPool, caches),
   poller teardown/AbortSignal audit. Churn soak: flat RSS/handles.
3. **P3 Secrets at rest/motion** — mafiles/ plaintext post-import, proxy creds in plaintext
   stores, refresh_tokens.json(.bak), redaction coverage sweep, HWID pepper exposure check.
4. **P4 Data integrity/concurrency/migration** — single-instance lock (tasklist 4s timeout
   fail-open → OS-level lock fail-safe), atomicJson coverage sweep + fault injection,
   store version stamps + downgrade refusal (vault payload has NO version field).
5. **P5 Local API trust boundary** — boot capability token for money/vault routes; maFile
   import path containment; input bounds on money/trade endpoints.
6. **P6 Frontend state sync** — watchPriceFill bounded-90s → durable reconciler; stale-read
   audit after money ops (INV-E1/E3 in UI).
7. **P7 Rate/ban verification** — every Steam fan-out through bounded scheduler; app/context
   id regression tests. **P8 Confirmations** — id+creator match regression test; confirmed-
   on-phone race.
8. **P9 Ledger re-triage** (75 items → closed/open/n-a), docs updates, **P10 build gates**
   (build, build:protected, release) + RELEASE_READINESS_OPENBETA.md.

**Method:** Understand-phase fan-out (parallel subsystem readers) first to build the
threat-model map with file:line evidence; then fix subsystem-by-subsystem, one commit per
logical fix, suite green after each.

**Hard guards to preserve (regression tests to add where missing):** buy finalize re-POST
confirmation=creator; updater keep-current/fail-open + sigKind; clean-browser isolation;
vault AES-256-GCM + non-destructive import; license clock anchor.

---

## 2026-07-02 — P1 native-crash class: threat model + first structural fixes

**Threat model (500 accts, hostile network):** a fleet refresh under a proxy ECONNRESET
storm churns steam-user clients (new client per retry attempt, ≤5/account) and tears
sessions down while HTTP work may be in flight. Field crash 0xC0000409 = Windows
__fastfail/abort (any native CHECK/abort, not literally a stack smash) — bypasses ALL JS
handlers; the only breadcrumbs possible are native-level stderr + exit code, which the
Tauri shell DOES already capture (lib.rs: `backend stderr:` → shell.log, exit code on
Terminated). Forensic chain verified present.

**Load-bearing discovery (verified in node_modules):** `agent-base@6` (backs
https-proxy-agent@5 + socks-proxy-agent@6) has a **no-op `destroy()`** and pools NOTHING
(every request forced `Connection: close`; `freeSocket()` destroys the socket). So:
(a) `AgentFactory.destroyIfDisposable` never actually closed proxy sockets — the believed
leak-fix was a no-op (and, luckily, also not a source of in-flight socket destruction);
(b) the "agent.destroy() yanks live sockets" crash mechanism is DISPROVEN for proxy
agents. Residual native-churn suspects: steam-user CM teardown churn, request-level
destroys, TLS handshake storms. Exact native trigger remains HYPOTHESIS (no dump).

**Fixes shipped (red→green proven, 8/9 red on old code, 79/79 green after):**
1. `AgentFactory.destroyIfDisposable` → quiescent **retire** reaper: an agent is never
   destroy()ed with busy sockets/queued requests; destroyed on drain; 120s hard backstop;
   `teardownStats()` instrumentation proves "no destroy under in-flight work" in soaks.
   (Future-proofs proxy-agent upgrades where destroy() is real; fixes the real in-flight
   destroy for native non-pooled Agents.) Test: test/agentTeardown.test.ts (incl. real
   in-flight-request-survives-teardown proof).
2. `SessionManager.destroySession`: a live no-op 'error' listener is guaranteed at EVERY
   instant of teardown (attach before logOff; re-attach in its OWN try after the sweep —
   a vendor throw in removeAllListeners used to leave 0 error listeners → unhandled
   'error' throw). Test: test/teardownQuiescence.test.ts.
3. `InventoryService.refreshAfterTrade`: was `Promise.allSettled(targets.map(refreshOne))`
   — unbounded fan-out, NO LocalIpThrottle (ban risk), NEVER released created sessions
   (accumulation). Now: scaleConcurrency worker pool + refreshMaybeThrottled routing +
   release-only-created (same ownership discipline as runRefresh). Currently only called
   with 2 targets (server.ts:1314) so today's blast radius was small — fixed as the class.
   Tests: test/teardownQuiescence.test.ts (bound ≤25, release-only-created, dedup).

**Next:** repro harness v2 driving the REAL compiled SessionManager/InventoryManager
against a local RST-storm proxy at concurrency 25–40, sustained soak; then P2 sweeps.

---

## 2026-07-02 — Parallel subsystem audit returned; native-crash root + money blockers

**Audit:** 11 subagents; 5 returned before a session-usage limit (session-teardown,
inventory-refresh, trading-money, secrets-vault, api-surface); 6 parked to re-run after
1pm Berlin reset (frontend, licensing-updater, boot-lifecycle, pricing-fx,
csfloat-cleanbrowser, ledger-parse). All findings captured in BETA_BLOCKERS.md (B01–B48),
verified against current code before any fix.

**Native-crash ROOT identified + fixed (B04):** the session-teardown auditor traced
0xC0000409 to a **zombie steam-user resurrection** — logOff() doesn't clear
_logonMsgTimeout, so a teardown mid-handshake (the 15s-timeout / retry teardown a storm
fires hundreds of times) leaves a 5s timer that fires logOn(true) and revives a discarded
client: an uncapped CM login storm outside MAX_CONCURRENT_LOGINS / MAX_LIVE_SESSIONS. Also
confirmed the feared "socket-write-into-destroyed-agent" is NOT reachable today
(agent-base@6 destroy() is a no-op, proxy agents pool nothing) — my quiescent-retire is
belt-and-suspenders + future-proofing, and the ZOMBIE is the real killer. Fixed with
neutralizeSteamClient() in destroySession.

**Money-path W-blockers fixed (red→green each):**
- B10/B12 (commit): createbuyorder network errors made money-safe — re-POST throw after
  confirm → report placed+confirmed (never rethrow past the barrier); POST'0' throw →
  probe getMarketOrders for a matching resting order (placed) else verifyBeforeRetry.
  Owner-protected re-POST shape unchanged (one POST'0', at most one re-POST=creator).
- B11 (commit): sell fails closed on a KNOWN non-EUR wallet (prices are EUR cents; Steam
  reads them as wallet-currency → ~99% underprice). Unknown wallet keeps the EUR path.
- B13/B17/B44/B45 (commit): MONEY_OP breaker now covers CSFloat cash ops + confirmations/
  respond (extracted+tested MONEY_OP_ROUTE); csfloat create-listing price floor ≥1;
  batchOfferAction now paced by a shared jittered dispatch throttle (Error-15 guard);
  mass-sell itemDelayMs floored ≥500ms (a client 0 removed all pacing).

**Still open (this queue):** B14 op-journal (assess scope), B15 partial-baseline, B16 sell
appId, B18 0-decimal wallets (hypothesis), B19 confirmed-on-phone; then secrets (B20–B26),
data/brick (B30–B36), ban/crash (B40–B47).

---

## 2026-07-02 — Blocker sweep complete (23 commits); build gates

Fixed + red→green tested, one atomic commit each (suite grew 79→150):
- **Money/W:** B10/B12 buy network-error safety (probe + placed, no blind retry; owner
  re-POST shape untouched), B11 sell non-EUR fail-closed, B13 breaker covers CSFloat+confirm,
  B15 partial-baseline unverified, B17 csfloat price floor, B44/B45 pacing floors.
- **Secrets/S:** B20 env proxy → vault, B21 plaintext token/key quarantine (verify-gated),
  B23 maFile path containment, B24/B25 error+legacy-format redaction, B26/P5 capability token
  (backend guard + stdout→shell inject + app.js header).
- **Data/Brick/D,B:** B30 vault version refusal + preserve-unknown, B33 .bak recovery, B31
  doRefreshOne empty-read guard, B32 first-mint token sync-save, B34 org backup, B35 external
  token-only import, B36 headless orphan-vault refusal, P4 atomic fail-safe single-instance.
- **Crash/Ban/C,N:** B01–B04 teardown quiescence + zombie-resurrection (native-crash ROOT) +
  bounded post-trade refresh, B40 idle reaper, B42 token-only proxy, B43 destroy ERROR
  sessions, B46 MAX_LIVE re-check, B47 IPv6 Host.
- **Frontend/E:** P6 durable price reconciler (no 90s cap → long fills reach the UI).

**Non-blockers documented (not gating):** B16 (sell CS2-only by construction), B18 (0-decimal
wallet, hypothesis — needs live check), B19 (confirmed-on-phone status lie, no dup action),
B22 (mafiles manual-delete notice = the warned opt-in; auto-quarantine risks LoginFlow disk
fallback for non-vaulted accounts).

**Parked:** B14 (money-op journal for restart-mid-op double-run) — the network-error variant is
already closed by B10/B12; the full fix (persist intent + boot reconcile against Steam's open
orders/sent offers) needs REAL Steam accounts to verify, so it's parked with the design below.
B41 (session refcount vs release) — its double-order harm is mitigated by B10/B12 (a torn-down
buy's network error → verifyBeforeRetry/probe, never a blind retry); the idle reaper (B40) +
markUsed keep an in-use session from being reaped. Full refcount deferred (higher risk than
its residual value now that the money path is network-error-safe).

**Build gates:** `npm run build` (tsc) exit 0; `cargo check` (Rust shell incl. capability
inject) exit 0. `npm run build:protected` + `npm run release` running/next.

**Known test flake:** test/updaterEacces.test.ts pipeToFile stall-guard (~63ms timer) fails
intermittently only under heavy concurrent full-suite load; passes in isolation and on re-run
(150/150). To stabilise (raise the timer / serialise) — not a code defect.

---

## 2026-07-02 — Second audit wave + FINAL build/soak (GO)

Re-ran the 6 remaining subsystem audits (frontend/licensing/boot/pricing/csfloat/ledger).
Surfaced + fixed a batch including a **critical regression I'd introduced**: the atomic
single-instance lock threw ENOENT on a fresh install (data/ absent) and the fail-safe refused
to start → first-launch brick (AF1). Plus heartbeat-403-as-revocation (AF2), updater self-test
budget < build budget (AF3), reconciler fetched-reset (AF4), single-trade no re-pull (AF5),
csfloat corrupt-store mass re-delivery (AF6), csfloat icon allow-list bypass (AF7), publish.js
served-signature gate (AF8), breaker-blind-to-rejections (AF9). Suite 155/155.

**Ledger re-triage:** AUDIT_LEDGER.md 75 items — ~49 FIXED, #6 WONT-FIX (hardened), #22
documented, rest deferred/cosmetic; ~45 NEW blockers fixed this pass (BETA_BLOCKERS.md).

**FINAL GATES (all green):**
- `npm run build` (tsc) exit 0; `cargo check` exit 0; `npm test` 155/155.
- `npm run build:protected` → `SSIM_SELFTEST_OK v1.3.3 deps=all-loaded` → ssim-backend.exe.
- `npm run release` → `release-tauri/SSIM/SSIM.exe` (185MB) + `release/SSIM-1.3.3.zip` (clean);
  consolidated-exe self-test [5/5] `SSIM_SELFTEST_OK`. (One transient rustc-linker 0xc0000409
  during release link; retry succeeded — toolchain, not SSIM.)
- **Teardown soak** (real SessionManager, 180s ECONNRESET storm, ~80 logins + 25 fetchers):
  `SOAK_OK` — 0 native aborts, 6767 teardowns, forced=0 (no busy-agent destroy), pending=0,
  jsErr=0.

**Verdict: GO for open beta.** 20 atomic commits on hardening/open-beta. Parked (owner/real-
account): publish-update, license-server dual-sign rollout confirmation, real-fleet live
regression, B14 op-journal, B41 refcount, #22 server-side pepper salt. See
docs/RELEASE_READINESS_OPENBETA.md.
