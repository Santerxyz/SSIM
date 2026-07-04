# REMEDIATION_LOG.md — reliability remediation (update-strand + backend stability)

Implements the fixes specified against `UPDATE_RELIABILITY.md` + `BACKEND_RELIABILITY.md`. One entry per
work item: **What / Why / Files / Tests**. Nothing was published, deployed, or pushed — code + tests +
deploy notes only. Two repos: **client** = `CS2_Manager`, **server** = `ssim-license-server`.

**Gates:** `npm run build` (tsc) clean; client suite **197 tests green**; server suite **39 tests green**
(13 new + 26 pre-existing, all backward-compatible); `cargo check` (Tauri shell) clean. Constraints
grep-proofed (see bottom). The keep-current guard's property tests still hold in spirit — no code path
swaps on a failed/unproven self-test (`swapAndRelaunch` has ONE call site, reached only when
`selfTest.ok`).

---

## P0-CLIENT — the updater can no longer strand a machine (`src/licensing/Updater.ts`)

### C1 — Persist the verified download across boots (sha256-keyed)
- **What:** the staged exe is now named `ssim_update_<sha256>.exe`. `download()` reuses a byte-intact
  staged artifact (sha match) instead of re-fetching ~185 MB; a partial resumes across boots. The sweep
  keeps only the current offer's sha (cheap filename compare) and never touches the `selftest-state.json`
  sidecar. A **self-test failure now KEEPS** the artifact (previously it deleted it → re-download every
  boot). verify()-failures still delete (a corrupt/tampered file is worth re-fetching).
- **Why:** a stranded machine re-downloaded 172 MB every boot forever (`UPDATE_RELIABILITY.md` §6.4).
- **Files:** `Updater.ts` (`stagedArtifactPath`, `sha256File`, `sweepStaleStaged`, `download` reuse
  short-circuit, `runUpdate` no longer removes on self-test fail).
- **Tests:** `test/updaterReliability.test.ts` — C1 path determinism, sha pre-check, sweep-keeps-sidecar.

### C2 — Self-test timeout escalation ('timeout' is its own retryable kind)
- **What:** `classifySpawnError` classifies an execFileSync budget kill (`ETIMEDOUT` / `killed:true`) as
  `'timeout'` (distinct from `'lock'`/`'crash'`). `selfTestNewExe` retries a timeout **exactly once** at
  a 2× budget (240 s → 480 s), counted separately from the lock backoff, then keeps current. A
  self-inflicted fatal signal (`killed:false`, e.g. SIGSEGV) stays `'crash'`.
- **Why:** ≤1.3.3 hard-classified a legitimately-slow self-test's ETIMEDOUT as `crash` → permanent
  can't-update on slow/AV-heavy machines (`UPDATE_RELIABILITY.md` §3.3).
- **Files:** `Updater.ts` (`SelfTestOutcome` adds `'timeout'`; `classifySpawnError`; `runSelfTestOnce`
  takes an injected budget; `selfTestNewExe` escalation loop, now returns the `SelfTestOutcome`).
- **Tests:** `test/updaterEacces.test.ts` (timeout vs self-signal classification, updated 5 keep-current
  property tests to `.ok`); `test/updaterReliability.test.ts` — single-escalation, budget doubling,
  independent counters, persistent-timeout-keeps-current.

### C3 — Track consecutive self-test failures per sha256; never pin silently
- **What:** `data\updates\selftest-state.json` persists the failure streak per sha (survives reboots). A
  new sha resets it; a pass clears it. After **N=3** identical-sha failures a stable, greppable
  `SSIM_UPDATE_BLOCKED` marker is logged, a status field is exposed (`updateStatus`), the telemetry
  outcome is set (C4), and the boot/periodic path then SKIPS the ~200 s self-test (fast boot) while
  surfacing the block — a manual "check now" (C5, `force`) still re-attempts.
- **Why:** the old updater pinned silently forever (`UPDATE_RELIABILITY.md` §6.3).
- **Files:** `Updater.ts` (`SelfTestState`, `readSelfTestState`/`recordSelfTestFailure`/
  `clearSelfTestState`, `SELFTEST_BLOCK_THRESHOLD`, `surfaceBlockedUpdate`, `runUpdate` block-check);
  new `src/licensing/updateStatus.ts`.
- **Tests:** `test/updaterReliability.test.ts` — streak accumulation + threshold, new-sha reset, clear,
  corrupt-state-reads-undefined.

### C4 — Update-outcome + health telemetry rider on the heartbeat
- **What:** the `/heartbeat` (and the boot-time `/validate` recheck) body now carries
  `{ clientVersion, lastUpdateOutcome, lastExitClass, moneyOpsBreakerTripped }`. Optional fields are
  omitted when unset (no nulls on the wire). `lastExitClass` derives from the shell's crash marker (B1);
  the breaker flag from `ProcessHealth`.
- **Why:** stranding + fleet-version were unmeasurable (`BACKEND_RELIABILITY.md` F10 /
  `UPDATE_RELIABILITY.md` §6.6). Backward compatible both ways — the server destructures only
  `{hwid,token}` and ignores the rest (verified in the server map).
- **Files:** `LicenseClient.ts` (`telemetryRider`, attached to heartbeat + validate); `updateStatus.ts`;
  new `src/utils/crashMarker.ts`; `index.ts` (consume marker on boot → set exit class).
- **Tests:** `test/heartbeatTelemetry.test.ts` (rider always carries version+breaker, omits/includes
  optionals, reflects a tripped breaker); `test/crashMarker.test.ts`.

### C5 — Periodic (6 h) + manual update checks, idle-gated swap
- **What:** new `updateScheduler.ts`: a 6 h **CHECK-ONLY** tick (IS_PACKAGED-only, skipped while a money
  op is in flight) that refreshes "update available" + telemetry and NEVER auto-swaps mid-session. A new
  authenticated `POST /api/app/check-update` does a manual check or, with `{install:true}`, a
  user-CONFIRMED install — refused while any trade/buy/refresh is in flight (a swap exits the process).
  Boot-time auto-update is unchanged. `busy()` accessors added to Trade/Buy/Inventory services gate it.
- **Why:** 24/7 operator machines only ever checked once per launch (`UPDATE_RELIABILITY.md` §6.10); a
  mid-session swap must never interrupt live trades.
- **Files:** `updateScheduler.ts`; `index.ts` (start/stop); `api/server.ts` (endpoint + status fields);
  `TradeService`/`BuyService`/`InventoryService` `busy()`; `public/app.js` (update indicator + action).
- **Tests:** `test/updateScheduler.test.ts` — `currentView` mapping (blocks only the matching version),
  dev-build install refusal, not-ready refusal.

### C6 — Fast self-test path (profile + stable-cache extraction) — `src-tauri/src/lib.rs`
- **What:** the shell's `run_backend_selftest` now (a) extracts the backend to a STABLE per-stamp cache
  (`%TEMP%\ssim-selftest-runtime`) instead of the updater's throwaway per-invocation home, so a repeated
  self-test (C2 escalation, C1 cross-boot reuse, C3 re-check) SKIPS the 171 MB re-extraction and reuses
  AV's already-warm scan of that path; (b) emits an `SSIM_SELFTEST_PROFILE extract=…ms boot=…ms total=…`
  line (to shell.log + the file report + stdout) so the extract-vs-boot split is measurable on a real
  slow/AV machine.
- **Why:** the random per-run temp path went AV-cold every time — a large part of why slow machines blew
  the budget (`UPDATE_RELIABILITY.md` §3.3). The cold FIRST-run floor is AV-scan-on-execute + pkg-VFS
  bound (an AV exclusion was declined previously — see the build-pkg-hang note); the profile gives the
  owner real numbers, and the stable cache cuts every REPEAT self-test.
- **Files:** `lib.rs` (`ensure_backend_extracted_to`, `selftest_runtime_dir`, profiled
  `run_backend_selftest`). Verified by `cargo check`.

### C7 — Shell stdout marker (investigation, ~1 h) — `src-tauri/src/lib.rs`
- **Result: CONFIRMED — already implemented; no code change needed beyond a clarifying comment.** The
  shell already writes the backend's stdout (which carries `SSIM_SELFTEST_OK`) to its OWN inherited
  stdout handle (`std::io::stdout().write_all(&o.stdout)`). A GUI-subsystem process CAN write to a
  parent-provided pipe handle — the Windows subsystem controls console ALLOCATION, not std-handle
  inheritance, so when the ≤1.2.2 updater's `execFileSync` provides a stdout pipe, `GetStdHandle` returns
  it and the write reaches the parent. Therefore a v1.2.0–1.2.2 **stdout-only** self-test CAN see the
  marker via the new artifact — provided it (a) completes the all-or-nothing download and (b) the boot
  fits its 60 s budget (which the C6 stable cache widens). Added the profile line to the same stdout
  write. Documented in the code comment + here.

---

## P0-SERVER — never publish/restore a fleet-stranding manifest (`ssim-license-server`)

### S1 — `/release/rollback` guard (verify-or-re-sign + single-exe confirm) — `src/admin.js`
- **What:** rollback now (a) refuses to restore a `kind:'single-exe'` manifest unless
  `confirmSingleExe:true` (it re-arms the destructive migration swap-shape), and (b) verifies the
  manifest under the LIVE public key; if it fails (a pre-C14 manifest with no `sigKind`, or a wrong-key
  one), it **re-signs** it with the live key and re-verifies before writing — closing the
  "rollback-to-archived-1.3.0 strands every ≥1.3.1 client" landmine (`UPDATE_RELIABILITY.md` §3.4-c).
- **Files:** `admin.js` (rollback handler); `signing.js` (`verifyManifest`, `manifestSigPayload` moved
  here as the single home).
- **Tests:** `test/reliability.test.js` — single-exe requires confirm, pre-C14 manifest re-signed +
  verifies, no-manifest → 404, plus `verifyManifest` unit cases.

### S2 — Publish-time self-check + `/health` signature detail — `src/admin.js`, `src/server.js`
- **What:** BOTH publish paths (legacy `POST /version` + dual-format `/release/finalize`) re-read the
  written `version.json` and verify `sig`+`sigKind`(+`filesSig`) under the server's own public key; on
  failure they ROLL BACK the write (restore the prior bytes) and return 500. `GET /health` now reports
  `{ versionFilePresent, publishedLatest, signaturesVerify, publicKeyFpr }` (no secrets).
- **Why:** a wrong signing key is caught at publish time, not when the fleet stops updating
  (`UPDATE_RELIABILITY.md` §6.7).
- **Tests:** `test/reliability.test.js` — a normal finalize passes + `/version` verifies; `/health`
  exposes the verified state + fingerprint; `verifyManifest` rejects a different-key manifest.

### S3 — Key-divergence boot guard + `docs/KEYS_RUNBOOK.md`
- **What:** optional `EXPECTED_PUBKEY_FPR` env (hex OR base64url of the public key's SPKI-DER SHA-256).
  If set and the loaded public key's fingerprint mismatches, the server REFUSES TO BOOT with a loud
  message. `keys.js` gains `fingerprint()` + `matchesFingerprint()`. Runbook documents: which key prod
  uses, that the repo's `keys/` is a STALE dev pair that must never deploy, private-key backup, and the
  dual-key rotation procedure (new pubkey ships in clients first; sign with both during transition).
- **Why:** deploying the repo's stale `keys/` would strand the entire fleet (`UPDATE_RELIABILITY.md`
  §3.1-b). Guard is off by default (nothing changes for existing deploys until pinned).
- **Files:** `config.js`, `keys.js`, `index.js`, `docs/KEYS_RUNBOOK.md`.
- **Tests:** `test/reliability.test.js` — `matchesFingerprint` accepts hex+base64url, rejects wrong/empty.

### S4 — Telemetry storage + admin panel + version histogram
- **What:** `/heartbeat` + `/validate` now persist the sanitised C4 rider onto the seat's activation
  record (`clientVersion`, `lastUpdateOutcome`, `lastExitClass`, `moneyOpsBreakerTripped`, `telemetryAt`);
  it flows to the browser automatically via `withMeta`. New `GET /admin/api/telemetry` returns a version
  histogram + update-outcome histogram + tripped-breaker count. The admin panel shows per-seat chips + a
  "Flotten-Telemetrie" panel. **Legacy `sig` is NOT removed** (per directive) — the histogram makes "has
  the fleet migrated?" answerable first.
- **Files:** `licenses.js` (`touch` extended, `telemetrySummary`), `server.js` (`readTelemetry`, wired to
  both endpoints, `versionFileHealth`), `admin.js` (`/telemetry`), `public/admin.js` + `admin.html`.
- **Tests:** `test/reliability.test.js` — telemetry stored per seat + aggregated; a no-rider beat only
  bumps `lastSeen` (old-client compatible).

---

## P1 — backend visibility & data-integrity hardening

### B1 — Crash visibility (marker + next-launch banner + optional webhook, NO restart)
- **What:** on an UNEXPECTED backend death the shell (a) writes `logs/last-crash.json`
  `{at, code, signal, version, logTail}`, (b) the backend consumes it on the next boot → a dismissible
  "SSIM crashed last run" dashboard banner + the C4 `lastExitClass`, and (c) if `SSIM_CRASH_WEBHOOK` is
  set (OFF by default) POSTs a minimal notice via the built-in `curl.exe` (no new crate). **Nothing is
  respawned** — the crash branch still only records + shows the screen.
- **Files:** `lib.rs` (`write_crash_marker`, `shell_log_tail`, `maybe_post_crash_webhook`, crash branch);
  `src/utils/crashMarker.ts`; `updateStatus.ts` (`PriorCrash`); `index.ts`; `api/server.ts` (status);
  `public/app.js` (banner). `cargo check` clean.
- **Tests:** `test/crashMarker.test.ts` — read-once/consume, missing = no-op, corrupt = dropped, shape
  guard.

### B2 — TokenStore degraded mode (`refresh_tokens.json`)
- **What:** a PRESENT-but-unreadable/malformed refresh-token file now marks the store DEGRADED (mirrors
  the CSFloat pattern): `isDegraded()`, a `logger.error`, and `save()` becomes a no-op so the corrupt
  file + its `.bak` are never clobbered — instead of silently resetting to empty and mass-re-authing the
  fleet (`BACKEND_RELIABILITY.md` F8). Surfaced on the status endpoint + a UI warning. Path is injectable
  for tests; a MISSING file (fresh install) is NOT degraded.
- **Files:** `core/TokenStore.ts`, `core/SessionManager.ts` (`isTokenStoreDegraded`), `api/server.ts`
  (status), `public/app.js` (warning).
- **Tests:** `test/tokenStoreDegraded.test.ts` — corrupt/malformed → degraded, missing → not, valid →
  loaded, degraded set() doesn't clobber the file/.bak, healthy persists.

### B3 — Surface the money-ops breaker (status endpoint + UI)
- **What:** `/api/system/status` now mirrors `/api/health`'s `stable`/`quarantineReason` as
  `moneyOpsStable` (+ `quarantineReason`), and the dashboard shows a persistent "Money operations paused"
  banner. Latch semantics unchanged.
- **Files:** `api/server.ts` (status), `public/app.js` (`renderBreakerIndicator`).
- **Tests:** the breaker state is the already-tested `ProcessHealth` (moneyBreakerPacing.test) surfaced
  as a projection; the C4 rider test asserts a tripped breaker is reflected.

### B4 — Money-op journal (bounded, cross-restart dedup)
- **What:** new `core/MoneyOpJournal.ts` — `begin()` before a buy/send commit, `resolve()` in the finally
  on ANY clean resolution (so a cleanly-completed op leaves NO trace → legitimate repeats unaffected).
  Only a HARD crash between them leaves a lingering entry; on the next run a retry with the same op-hash
  is refused ONCE ("verify on Steam") and the entry consumed so a deliberate second attempt proceeds.
  TTL ~1 h, atomic writes, never throws. Wired at the SERVICE layer (`TradeService.sendTrade`,
  `BuyService.buy`) using the EXISTING in-flight guard keys — **`AccountTrader.createBuyOrder` and its
  finalize re-POST are untouched** (constraint 3). Services default to a no-op journal (tests never
  contend on a shared file); `createDeps` wires ONE shared enabled journal.
- **Files:** `core/MoneyOpJournal.ts`; `trading/TradeService.ts` + `trading/BuyService.ts` (guard wiring);
  `api/server.ts` (`createDeps` shared instance).
- **Tests:** `test/moneyOpJournal.test.ts` — clean-completion leaves no trace, crash-interrupted caught +
  consumed, phase, TTL sweep, no-collision, never-throws; `test/moneyOpJournalWiring.test.ts` — `buy()`
  refuses on a lingering entry before committing, then consumes it.

---

## P2 — diagnosis follow-through (no production changes)

### D1 — Ran the real-code storm harness → `_crashrepro/out3.txt`
- **What:** `npm run build`, then `DURATION_MS=600000 ACCOUNTS=120 FETCHERS=30 node _crashrepro/storm2.js`.
- **Result — CLEAN. `SOAK_OK`, survived the full 600s (exit 0).** Over 10 min against the RST-storm
  proxy: **281,402 logins** (all failed as designed — every connect dies at 127.0.0.1), **52,931 fetches**,
  **26,475 mid-flight teardowns**, **`jsErr=0`**. The teardown invariant HELD:
  `retire{retired=25910 idle=25910 forced=0 pending=0}` — **`destroyedForced === 0`** (no agent was
  force-destroyed while busy; the quiescent-retire guard holds under sustained destroy-under-load). RSS
  peaked ~467 MB and stayed bounded (no leak — corroborates `BACKEND_RELIABILITY.md` F9). **No native
  abort** — a `0xC0000409` fast-fail bypasses the JS sinks and would leave NO `SOAK_OK` line; it printed,
  so the fast-fail did NOT reproduce in this isolated run. This matches the report: the synthetic +
  real-code harnesses come back clean, so R1 remains PROVEN-occurrence / UNPROVEN-mechanism — the WER
  LocalDump on a real recurrence (D2) is the next lever. Per instruction, nothing was "fixed" from this
  run (no evidence of a defect).

### D2 — `docs/WER_LOCALDUMPS.md`
- Owner-run `.reg` + PowerShell to enable WER LocalDumps (full, DumpType=2) for `SSIM.exe` +
  `ssim-backend.exe`, where dumps land, and exactly what to send back. NOT applied to this machine.

### D3 — `docs/STRANDED_FLEET_RESCUE.md`
- The manual one-file reinstall (download current `SSIM.exe`, close, replace over the old exe, `data\`/
  `Vault\` preserved) for single-exe AND two-file layouts, + a copy-paste Discord announcement.

---

## Constraint grep-proof (verification gate)

- **No auto-restart / respawn added:** the only new `.spawn()` is the off-by-default crash **webhook**
  (curl.exe, a notification); every "respawn" string in the diff is a comment AFFIRMING no respawn.
- **Buy finalize re-POST untouched:** `git diff --name-only` does NOT include `AccountTrader.ts`.
- **Legacy `sig` still emitted by both publish paths:** `releaseSignatures(...)` at `admin.js` (legacy
  `/version`) and (finalize) both return `{ sig, sigKind }`; rollback re-sign also emits both.
- **Keep-current guard intact:** `swapAndRelaunch` has a single call site, reached only after
  `selfTestNewExe` returns `ok:true`.

---

## Deploy notes for the OWNER (nothing below was done)

Rollout order matters (server BEFORE clients, per the transition design):

1. **Server first.** Deploy `ssim-license-server` (`git`-review the 9-file diff). Set
   `EXPECTED_PUBKEY_FPR` to the PRODUCTION public key's fingerprint (get it from `GET /health` →
   `version.publicKeyFpr`, or the one-liner in `docs/KEYS_RUNBOOK.md`) — do NOT deploy the repo's `keys/`.
   Confirm boot prints the fingerprint-match line and `/health` shows `signaturesVerify:true`. `npm test`
   (39 green) before deploy.
2. **Client build.** Build v1.3.5 (`build/make-tauri.js` → the single `SSIM.exe`), then the self-test
   gate + `publish.js` as usual — needs `secrets.local.bat` (parse the set-lines into `process.env`; do
   NOT `cmd /c "call … && npm run …"` — the PEM breaks arg parsing).
3. **Publish** the new client the routine way (`publish-update -- --verify-download`; the two-file
   migration is done — no `--legacy-backend`/`--migrate`). Then post the `STRANDED_FLEET_RESCUE` Discord
   note for machines that still can't auto-update, and enable `WER_LOCALDUMPS` on the crash machine.
4. **Watch** the new admin "Flotten-Telemetrie" histogram to see the fleet migrate; keep the legacy `sig`
   until it proves ≥1.3.1 everywhere.
