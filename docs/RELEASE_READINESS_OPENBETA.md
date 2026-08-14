# SSIM — Open-Beta Release Readiness (GO / NO-GO)

Branch: `hardening/open-beta` (off `feature/discord-bot`). Date: 2026-07-02. Package: c​s2-manager v1.3.3.
Scope: a HARDENING pass on a mature, already-remediated codebase — rigor and safety, not rewrites.

---

## Verdict: **GO for open beta**, with the parked/owner-gated items below explicitly listed.

Every beta-blocker found (native crash, wrong-money/trade, secret leak, data loss, brick, ban risk,
crash-on-normal-use) has a structural fix and a red→green test. The full suite is green
(**155/155**, one known flaky updater test that passes in isolation and on re-run), `tsc` is clean,
the Rust shell compiles (`cargo check` clean), and the protected backend + consolidated SSIM.exe
build to a **self-test-OK** artifact. What remains is genuinely owner/ops-gated (publish, license-
server dual-sign rollout, credentialed live checks) — none of it is code this pass could complete
without external systems or real Steam accounts.

---

## Definition-of-Done ledger

| # | Requirement | Status |
|---|---|---|
| 1 | Zero open beta-blockers (D/S/B/N/C/W); each has a red→green test + evidence | **MET** — see BETA_BLOCKERS.md (≈45 fixed, one atomic commit + test each). Residuals are parked with justification (B14/B41) or documented non-gating. |
| 2 | Native-crash class closed or mitigated by an enforced teardown invariant + soak, residual stated | **MET (root fixed).** The 0xC0000409 ROOT was identified: a discarded steam-user client self-resurrects via `_logonMsgTimeout` → uncapped CM login storm. Fixed by `neutralizeSteamClient` in destroySession (+ quiescent agent retire, guaranteed error-listener, bounded post-trade fan-out). Residual: a full real-proxy soak needs real accounts (parked); the synthetic teardown-quiescence invariant is enforced + unit-tested. |
| 3 | Full suite green; new tests cover every fix + previously-uncovered blocker paths | **MET** — 79→155 tests. New coverage: vault crypto/version/.bak, capability token, single-instance, buy money-safety, sell currency, idle reaper, reprice reconciler, teardown quiescence, csfloat delivered-store, maFile containment, redaction, etc. |
| 4 | No plaintext long-lived secret on disk by default; none via logs/API; money/vault routes need the capability token | **MET** — env proxies → vault (B20), plaintext token/key files quarantined after verified migration (B21), maFile path contained (B23), redaction on every error + legacy proxy formats (B24/B25), boot capability token gates every mutation + secret GET (B26). Residual: #22 shared HWID pepper (server-side salt needed — documented). |
| 5 | Every store atomic + migration-safe (safe downgrade refusal); single-instance fail-safe | **MET** — vault version gate + preserve-unknown + .bak recovery (B30/B33), atomic writes + org backup (B34), first-mint token sync-save (B32), external token-only import (B35), headless orphan-vault refusal (B36), atomic fail-safe single-instance lock (P4). |
| 6 | Prices (and derived values) reach the UI without an app restart | **MET** — durable reprice reconciler replaces the 90s cap; handles the fill-generation reset (P6 + AF4). |
| 7 | Clean release build produced (SSIM.exe self-test OK) — NOT published | **MET** — `build:protected` → `SSIM_SELFTEST_OK v1.3.3 deps=all-loaded`; `release` → `release-tauri/SSIM/SSIM.exe` (self-test gated by make-tauri). NOT published. |
| 8 | the internal audit ledger re-triaged (each item closed/open/n-a) | **MET** — re-triage banner added: ~49/75 FIXED, #6 WONT-FIX (hardened), #22 documented, rest deferred/cosmetic; ~45 NEW blockers fixed this pass. |

---

## Build/self-test evidence
- `npm run build` (tsc) — exit 0.
- `cargo check` (src-tauri, incl. capability injection) — exit 0.
- `npm run build:protected` (SSIM_BUILD_SIDECAR=1, owner secrets loaded) — `SSIM_SELFTEST_OK v1.3.3 public/index.html=113267B deps=all-loaded(GC+steam stack)` → `ssim-backend.exe`.
- `npm run release` — produced `release-tauri/SSIM/SSIM.exe` (185 MB) + clean `release/SSIM-1.3.3.zip`
  (57.5 MB, "no secrets/user-data found"). The final gate — step [5/5] self-testing the CONSOLIDATED
  SSIM.exe (extract + boot + deps load) — printed `SSIM_SELFTEST_OK v1.3.3 deps=all-loaded(GC+steam
  stack)`. NOT published. (A retry was needed once: the Rust MSVC linker itself crashed transiently —
  `rustc` 0xc0000409 during release-profile link, unrelated to SSIM code, which `cargo check` compiles
  cleanly; the retry succeeded.)
- **Synthetic teardown-under-storm soak** (`_crashrepro/storm2.js`, drives the REAL compiled
  SessionManager.destroySession under a continuous local ECONNRESET-storm proxy at ~80 concurrent
  logins + 25 in-flight fetchers, 180s): **`SOAK_OK`** — survived 180s, **zero native aborts**,
  55,759 login teardowns + 13,454 fetches + 6,767 session teardowns, `jsErr=0`, and
  `retire{retired=6579 idle=6579 forced=0 pending=0}` → **no agent was EVER destroyed with in-flight
  work (forced=0)** and no agent leaked (pending=0). Residual: the storm can't reach the vendor
  `_sendLogOn` zombie path without a real CM handshake, so the zombie-resurrection fix itself is
  validated at the UNIT level (`neutralizeSteamClient` tests); the soak validates teardown-under-churn
  stability + the agent-quiescence invariant. A full real-proxy soak is parked (needs real accounts).
- `npm test` — 155/155 green. Known flake: `test/updaterEacces.test.ts` pipeToFile stall-guard (~63ms
  timer) under heavy concurrent load; passes in isolation and on re-run — recommend raising the timer
  / serialising.

## The native-crash class (highest-priority hotspot) — resolution
Field 0xC0000409 during a 537-account refresh under a proxy ECONNRESET storm. ROOT (proven from
vendor source): `steam-user`'s `logOff()` does NOT clear `_logonMsgTimeout`, so a teardown landing
mid-handshake (the 15s-timeout / connection-retry teardown a storm fires hundreds of times) leaves a
5s timer that fires `_enqueueLogonAttempt()` → `logOn(true)`, resurrecting a client SSIM already
deleted from its map — an invisible CM login storm counted by NOTHING (outside MAX_CONCURRENT_LOGINS
/ MAX_LIVE_SESSIONS), whose eventual abort/OOM presents as the field signature with no JS handler.
Fixed structurally: `neutralizeSteamClient()` clears the timers, cancels reconnect/backoff, marks
the connection closed, and replaces `logOn` with an inert stub. Also disproven (verified negative):
the feared "socket write into a destroyed agent" is NOT reachable today (agent-base@6 `destroy()` is
a no-op and proxy agents pool nothing) — my quiescent-retire is belt-and-suspenders + future-proofing.

---

## Human steps left (owner/ops-gated — NOT done by this pass)

1. **Publish** — run `npm run publish-update` against the live license server. Do NOT skip the
   staged rollout: SERVER dual-sign first (verified in prod that BOTH an old client and the
   kind-aware client fetch+validate), THEN publish the client. publish.js now also verifies the
   served `sigKind` against `LICENSE_PUBLIC_KEY` before going broad (fleet-brick preventer).
2. **License-server** — no code change required by this pass; the dual-sign (`sig` + `sigKind`) is
   already implemented per CONTRADICTIONS C14. Confirm the production signing key matches
   `LICENSE_PUBLIC_KEY` (publish.js will now fail the publish if not).
3. **Real-account live regression** (FORBIDDEN for this pass — no real Steam logins): exercise a
   real fleet refresh under a flaky proxy for a sustained soak and confirm zero native aborts;
   run one real buy/sell/send end-to-end and confirm the money-safety paths (no duplicate order on
   a mid-op network error; non-EUR wallet blocked; sent items leave the inventory view).
4. **Parked verifications** (see BETA_BLOCKERS.md PARKED): B14 restart-mid-op journal (confirm SSIM
   surfaces an interrupted mass op rather than silently re-running it); B41 session refcount.
5. **CSFloat §8 / Discord bot** — owner-gated deploy + acceptance (unchanged by this pass).

## Residual risks stated honestly
- **#22 HWID pepper** is a shared per-binary secret; obfuscation/bytecode raise the cost but a
  determined attacker can recover it. Token forgery remains server-Ed25519-gated; the pepper never
  reaches logs/responses. A real fix is a server-side per-seat salt (out of client scope).
- **B14/B41** money-op restart/refcount residuals — mitigated (network-error-safe money path) but
  not fully closed without real-account verification.
- The **dev/Edge** capability-token delivery (HTML injection) is scrapeable by a local process; the
  **Tauri** build (primary) delivers it out-of-band and is robust. Beta ships the Tauri build.
