# BACKEND_RELIABILITY.md — Stability & reliability defects, ranked (root-cause investigation)

**Date:** 2026-07-03 · **Scope:** backend lifecycle + hot paths (fleet refresh, login, market/trade, pricing, confirmations), the Tauri shell's supervision, all local logs, and the `_crashrepro` harnesses.
**Mode:** DIAGNOSIS ONLY — nothing changed. Labels: **PROVEN** / **HYPOTHESIS** / **REFUTED**. Companion report: [UPDATE_RELIABILITY.md](UPDATE_RELIABILITY.md).

---

## TOP 3 BACKEND STABILITY RISKS

1. **R1 — The 0xC0000409 native fast-fail under proxy-reset storms (root cause still unproven).** One PROVEN field occurrence (whole process dies below the JS layer mid-fleet-refresh; every JS-level recorder silent by construction); the two synthetic harnesses came back **clean**, and the purpose-built real-code harness `_crashrepro/storm2.js` **has never been run**. Combined with R2 this is a silent, total outage until a human relaunches.
2. **R2 — Fail-visible-but-dead recovery posture.** By owner directive the shell does NOT restart a crashed backend (`src-tauri/src/lib.rs:13-16, 490-505`) — correct for diagnosis, but today a crash on an unattended 24/7 operator machine means the fleet is down until someone looks, and **nothing phones home**. Visibility (not auto-restart) is the missing half.
3. **R3 — The stranded old fleet runs with known, since-fixed bricks.** Fresh-install boot brick (1.3.1–1.3.3), bare-403 license revocation tearing down sessions (≤1.3.3), 120 s update self-test budget (≤1.3.3): all fixed in v1.3.4 — but the update-strand documented in UPDATE_RELIABILITY.md means a portion of the field population keeps running the broken versions indefinitely.

---

## 1. Lifecycle map (verified against code)

**Boot chain** (`src/index.ts`):
`bootstrap()` (243-271): `migrateVaultDir()` → `acquireInstanceLock()` (fail → crash-log breadcrumb + lock screen + exit(1), 248-258) → `clearStalePortFile()` (261) → sidecar quit-listener → HWID → `gateAndRun()` (191-217): **license gate** (validate → activation portal → exit(1) if still invalid) → **auto-update** (206; see companion report) → **vault unlock** (portal or CLI, 210-214) → `startFullApp()` → **bind-then-announce** (`listenAndAnnounce` walks EADDRINUSE to a free port and announces only the real bound port, 103-126) → license heartbeat (216).

**Global safety net** (`src/index.ts:277-342`): `unhandledRejection`/`uncaughtException` → synchronous crash-log sink + logger + `ProcessHealth.recordUncaught()`; **process is kept alive**. SIGINT/SIGTERM → graceful `shutdown()` (294-315: stop workers, flush all stores, logout, close server, 3 s hard-exit fallback). SIGHUP/SIGBREAK → breadcrumb + exit 130 (324-330). `process.on('exit')` → `writeExit()` **exit-trace discriminator**: a missing exit-trace entry after a death proves an uncatchable external/native kill (334-342) — this instrument is what isolated R1.

**Shell supervision** (`src-tauri/src/lib.rs`): spawns the embedded backend hidden; one-shot port handshake with an **identity probe** (`GET /__ssim/health` must answer the SSIM marker — a foreign app on the port is never adopted; 99-135 per sweep); parses `SSIM_UPDATE_*`/`SSIM_UPDATING` markers (385-390, 484-488); captures backend stderr to `logs/shell.log` (52); on unexpected backend death shows a persistent "crashed" screen and does **not** respawn (13-16, 490-505); 8 s force-kill watchdog on shutdown (602-609).

**Verdict on the lifecycle:** the boot/port/handshake path as of v1.3.4 is sound — bind-before-announce plus the identity probe closes the historical EADDRINUSE/foreign-app class (see F6).

---

## 2. Findings, ranked by real-world impact

### F1 — Native fast-fail 0xC0000409 during fleet refresh under proxy ECONNRESET storms — **PROVEN occurrence, UNPROVEN mechanism** · CRITICAL

- **Occurrence (PROVEN):** captured 2026-06-26 on the production operation: exit code `0xC0000409` (STATUS_STACK_BUFFER_OVERRUN) ~24 s into a 537-account fleet refresh through a flaky proxy ECONNRESET storm, on a v1.3.1-era build, with the 25-cap login gate active. All JS-layer recorders (crash-log, exit-trace, WER defaults) were silent — expected, because `0xC0000409` is the generic Windows `__fastfail` code raised below anything JS can catch; per Microsoft it long ago stopped meaning a literal stack-buffer overrun ([The Old New Thing](https://devblogs.microsoft.com/oldnewthing/20190108-00/?p=100655)). `--report-on-fatalerror` also produced nothing → the fast-fail bypassed even V8's fatal-error hook.
- **What the local evidence adds (PROVEN):** the synthetic repro `_crashrepro/storm.js` (RST-storming CONNECT proxy; agent churn with destroy-under-load; steam-user CM logins through the storm) ran clean twice — `out.txt`: 14,734 agent cycles, exit 0, `jsErr=0`; `out2.txt`: 30,325 cycles + 925 CM logins, exit 0. **The naive "proxy-agent use-after-destroy" hypothesis did not reproduce in isolation.**
- **Open hypothesis space (HYPOTHESIS):** Node 24 core native path (TLS/socket teardown) — Node has documented ECONNRESET/TLSWrap error-path fragility (e.g. [nodejs/node#42154](https://github.com/nodejs/node/issues/42154); a TLSSocket/nghttp2 ECONNRESET mishandling class summarized by [Endor Labs](https://www.endorlabs.com/learn/eight-for-one-multiple-vulnerabilities-fixed-in-the-node-js-runtime)) — vs. a V8-external OOM/abort in native code. The runtime is pure-JS (no native addons after the GC stack removal), which points at Node core itself.
- **The proof instrument already exists but was never fired (PROVEN):** `_crashrepro/storm2.js` drives the REAL compiled `SessionManager` + `InventoryManager` + `AgentFactory` under the same RST storm with a teardown invariant (`destroyedForced === 0`), exit 3 on violation — **no output file exists in `_crashrepro/`; it has not been run.**
- **Blast radius:** entire backend process dies instantly mid-refresh; with R2, the app stays down and (headless operator) nobody is told.
- **Recommended proof path (not applied):** (1) enable WER LocalDumps for `ssim-backend.exe`/`SSIM.exe` on the owner's machine and wait for one recurrence — the dump names the faulting native frame definitively; (2) run `storm2.js` (600 s, 120 accounts) as designed; (3) if the dump implicates Node core TLS teardown, bisect by soaking the same build on the previous Node LTS line before any code workaround. Avoid restart-wrapper band-aids per the standing directive.

### F2 — Crash recovery = "stay down, show a screen" with zero remote visibility — **PROVEN (deliberate)** · HIGH

- lib.rs:13-16, 490-505: unexpected backend death → record code/signal + stderr to `logs/shell.log`, persistent crash screen, **no respawn** (auto-restart removed by owner directive after it masked the June crash for 2 days — the no-band-aid rule is respected here).
- **Gap, not the policy:** nothing notifies the operator/owner. On an unattended machine the fleet is simply offline. **Recommendation:** keep no-restart; add crash *notification* (e.g. the Discord bot webhook fired by the shell from the crash screen, carrying `shell.log` tail + exit code) and a "crashed at <time>" marker the UI shows on next manual launch. Visibility is diagnosis-compatible.

### F3 — Keep-alive-on-uncaught + latched money-ops breaker — **PROVEN (deliberate trade-off)** · MEDIUM-HIGH

- `uncaughtException`/`unhandledRejection` log + keep the process alive (index.ts:277-291) so a stray vendor-callback throw can't kill hundreds of live sessions; a **burst** (≥3 uncaught in a rolling 60 s, `ProcessHealth.ts:17-34`) trips the money-ops breaker: all new buy/sell/send refused **until restart** (latched, `ProcessHealth.ts:27-28,42`).
- Residual risks accepted by design: (i) after any single uncaught, non-money subsystem state is undefined-but-running; (ii) on an unattended machine a tripped breaker means money ops silently 503 for days.
- **Recommendation:** surface breaker state prominently in the UI/status endpoint + include it in any future telemetry; consider auto-clearing ONLY via clean restart (already the case) — do not weaken.
- Log corroboration: the only uncaught exceptions in ~3 weeks of local logs are 3× `listen EADDRINUSE` on Jun 12 (ssim.log:792-802) — the net has been quiet since.

### F4 — Boot bricks fixed in v1.3.4 but alive in the stranded field — **PROVEN** · HIGH (for old-version users)

- **Fresh-install brick (1.3.1–1.3.3):** `acquireInstanceLock` threw ENOENT when `data\` didn't exist yet and the fail-safe read it as "lock IO error → refuse to start" → *every first launch of a fresh install bricked* (commit `3aad540`; fix = ensure lock dir first, `src/core/singleInstance.ts:71-78`).
- **Bare-403 license revocation (≤1.3.3):** any intermediary HTTP 403 (WAF/captive portal) was treated as revocation → sessions torn down, token cleared, forced re-activation (commit `3aad540` diff in `LicenseClient.ts`; now requires the authoritative `{status:'revoked'}` body).
- **Why it matters here:** both are fixed at HEAD, but the update-strand (companion report) keeps a cohort on 1.3.1–1.3.3 indefinitely; expect continuing field reports of exactly these two signatures from old installs. Blast radius: per-machine hard failure (brick) / fleet-wide session teardown (403).

### F5 — Money-path idempotency — **largely SOLID (verified), two residuals** · MEDIUM

- **Verified guards:** identical-send in-flight guard keyed by account+destination+item-set (`TradeService.ts:462-470`) + cross-op asset lock (`:479`); mass-send counts failures, **never auto-resends**, and reports `sent/confirmed/unconfirmed` explicitly (`TradeService.ts:140-143, 590, 613`); BuyService **never throws after order placement** — a post-placement verify failure is reported as `verifyFailed`, "NOT retrying", with a 5-minute per-item in-flight guard (BuyService.ts:157-162, 214-256); the buy finalize re-POST is the live-tested money path and is a do-not-touch invariant. CSFloat re-delivery dedup got a DEGRADED-mode guard when its state file is corrupt (commit `3aad540`) — an unreadable dedup store no longer silently resets to "deliver everything again".
- **Residual 1 (HYPOTHESIS):** the in-flight guards are in-memory — after a crash/restart mid-operation, a user-initiated retry has no server-side dedup; the Steam-side offer/order may already exist. Mitigated by the post-send inventory re-pull added in `3aad540` (sent items stop showing as sendable) but not eliminated.
- **Residual 2 (UX):** a `verifyFailed:true` buy answer relies on the caller not retrying; nothing structurally prevents a second click from placing a second order after the 5-min window. **Recommendation:** persist a short-lived operation journal (sha of op params → outcome) across restarts for buy/send.

### F6 — Port bind & single instance — **historical class CLOSED at HEAD; PROVEN** · LOW (current) 

- History: 3× `UNCAUGHT EXCEPTION (server kept alive): listen EADDRINUSE 127.0.0.1:3000` (ssim.log:792-802, 2026-06-12), 7× lockfile aborts, 4× "port 3000 busy – using 3001". One `EXIT code=1 up=2s` (exit-trace.log, 2026-06-29 12:44) is consistent with the `SERVER LISTEN ERROR` exit path (index.ts:113-122) — plausible correlation, HYPOTHESIS.
- Current: port-walk + bind-before-announce + shell identity probe (index.ts:103-126; commits `0c320dd`, `75277f2`) and stale-lock liveness handling + exit-time release (index.ts:331-342). No open defect found at HEAD.

### F7 — External-dependency resilience (proxies / Steam / license server) — **degrades gracefully; PROVEN via logs + code** · LOW-MEDIUM

- Field evidence of storms absorbed without process harm: 541× Steam `NoConnection`, 237× login timeouts (15 s/90 s), 7× "token login failed after 5 attempts – token PRESERVED, aborting this round" (logs/error.log, Jun 10–29).
- Verified controls: inventory fetch timeout 15 s ("FAIL FAST: a dead proxy releases the slot in 15s", `InventoryManager.ts:98`); global login semaphore 25 + FIFO queue + per-account dedup cleared in `finally` (`SessionManager.ts:28-36, 118-131, 224-230`); hard resident-session ceiling ~150 + idle reaper (`SessionManager.ts:149-157, 205-207`); agent retirement force-destroys leaked agents after a bounded 120 s (`AgentFactory.ts:84, 123-167`); license-server outage → heartbeat failures swallowed + 72 h offline grace (`LicenseClient`, `config.ts:56-57`). License heartbeat has no backoff (same cadence against a dead server) — cosmetic load only, grace covers the user.
- The un-mitigated representative of this class is F1 (the native layer under the same storm).

### F8 — Persistence & corruption — **pattern risk; partially fixed** · MEDIUM

- Writes are atomic (temp + fsync best-effort + rename, `atomicJson.ts:20-49`); all stores tolerate a corrupt file at boot by loading an **empty default** — that "silent reset" is exactly the failure class that caused the CSFloat mass re-delivery bug (fixed with a DEGRADED mode for that store only, commit `3aad540`).
- **HYPOTHESIS (unproven, plausible):** the same silent-reset pattern on `refresh_tokens.json` (`TokenStore` load-catch → empty) would drop every stored refresh token → fleet-wide re-login/2FA storm on next refresh. A `.bak` generation exists (`data/refresh_tokens.json.bak`) but no degraded-mode gate. **Recommendation:** extend the CSFloat degraded-mode pattern (present-but-unreadable ⇒ refuse-and-surface, never silently reset) to `refresh_tokens.json` and the vault-adjacent stores.

### F9 — Memory / handles — **no leak in evidence** · LOW

- `mem-heartbeat.log`: sessions peak ~300 MB RSS / ≤227 MB heap; active-session growth ~0.8 MB/min with GC release afterwards; no monotonic growth across sessions. Under the synthetic RST storm (extreme churn) RSS reached 504 MB over 45 s with bounded handle counts (53–111) and clean exit — churn cost, not a leak. Watch item only.

### F10 — Observability — **strong locally, zero remotely** · MEDIUM

- Local instruments (PROVEN good): synchronous crash-log sink, exit-trace discriminator (internal vs. external death, index.ts:334-342), mem-heartbeat, stderr tee, shell capture of backend last-words. This toolchain is what pinned R1's exit code.
- Gap: none of it leaves the machine. A silent death, tripped breaker, stranded updater, or brick on a user machine is invisible to the owner. **Recommendation:** minimal telemetry rider on the existing license heartbeat (version, uptime, last exit class, breaker state, last update outcome) — also the prerequisite for retiring the legacy update signature (companion report §6).

---

## 3. What was audited and HELD (explicitly re-verified, no defect)

- `InventoryManager.fetchRaw` **has** a 15 s fail-fast timeout (`InventoryManager.ts:98`) — an earlier sweep claim of a missing timeout is **REFUTED**.
- `loginsInFlight` dedup **is** cleared in `finally` (`SessionManager.ts:224-230`) — stuck-login-map claim **REFUTED**.
- Mass-op orchestrators use fixed worker pools (cap 25) pulling from queues — no per-item unbounded `Promise.all` fan-out on refresh/buy/sell paths.
- Version compare, manifest parsing, signature verification: see companion report (REFUTED as defects).

## 4. Recommended next actions (diagnosis-compatible, none applied)

1. **Close R1:** WER LocalDumps on the production machine + run `_crashrepro/storm2.js` as designed; only then decide between a Node-version pin and an upstream report with the dump.
2. **Crash visibility (R2):** shell → Discord webhook on the crash screen; UI banner on next launch.
3. **Fleet rescue for R3/F4:** the manual-reinstall path + fast self-test artifact from UPDATE_RELIABILITY.md §6.
4. **Telemetry rider (F10/F5):** heartbeat carries version + exit/breaker/update-outcome.
5. **Degraded-mode for token store (F8).**
6. Keep: no-restart policy, keep-current update guard semantics, the money-path never-throw-after-placement contract, and the buy finalize re-POST (do-not-touch).
