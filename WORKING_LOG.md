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
