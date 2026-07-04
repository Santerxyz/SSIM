# UPDATE_RELIABILITY.md — Why older versions don't update (root-cause investigation)

**Date:** 2026-07-03 · **Scope:** auto-update path, client `src/licensing/Updater.ts` (all shipped generations) + license server (`ssim-license-server`) + the LIVE served manifest.
**Mode:** DIAGNOSIS ONLY — nothing was changed. Every claim cites `file:line`, a commit, a log line, or the live manifest. Findings are labeled **PROVEN** / **HYPOTHESIS** / **REFUTED**.

---

## EXECUTIVE SUMMARY

### The single most likely confirmed reason older versions don't update — confidence HIGH (~85%)

**The anti-brick self-test is a one-way valve that pins old clients to their version forever.**
Every client from v1.2.0 through v1.3.3 runs a boot-time self-test of the downloaded new exe and, on ANY failure, invokes the keep-current guard ("not swapping"). Three version-specific defects make that self-test fail *deterministically per machine*, and — this is the trap — **the fix for each defect ships inside the very update the old client refuses to install.** The self-test is executed by the OLD client's code; no server-side change can reach past it. The result is a self-selecting stranded fleet: every machine that *could* pass the old self-test has already updated; every machine still on an old version is one where a failure class repeats identically on every boot.

The three failure classes, by client generation:

| Generation | Defect in ITS OWN updater | Fixed in | Verdict |
|---|---|---|---|
| v1.2.0–1.2.2 | Self-test accepts **stdout marker only** — the single-exe GUI artifact reports via file, never stdout → *structurally cannot pass*; plus a 60 s budget | v1.2.4-era (dual channel) | **PROVEN** (code) |
| v1.2.4–1.3.2 | One-shot self-test of an exe staged in **%TEMP%**, no retry, no EACCES classification, no MOTW strip → `spawnSync … EACCES` → keep current | v1.3.3 | **PROVEN** (field log + code) |
| v1.2.4–1.3.3 | Self-test **timeout 120 s** (60 s before 1.2.4) vs. a real artifact self-test that legitimately needs ~180–200 s on slow/AV-heavy machines → `ETIMEDOUT` classified `crash` → keep current | v1.3.4 | **PROVEN** (code + commit 3aad540) |

Direct field proof: the seed log line `update self-test failed (non-zero exit / crash) – not swapping: spawnSync <Temp>\ssim_update_….exe EACCES` matches the v1.3.1 code **verbatim** — that exact message text + `%TEMP%` staging path exist only in the ≤1.3.2 generation (`Updater.ts` @ commit `8c64b13`, lines 120, 277).

### What was REFUTED (checked directly, not assumed)

- **Signature/key migration break (the prime suspect): REFUTED as the active cause.** The live manifest (fetched 2026-07-03) carries **both** a valid legacy `sig` and a valid `sigKind`; both verify under the client-embedded public key (verified computationally — see §3.1).
- **Version comparison bugs: REFUTED** — numeric 3-part compare, identical in every generation; `1.3.10 > 1.3.9` correct.
- **Endpoint death / schema break: REFUTED** — the old `ssim-lizenz.duckdns.org` domain is alive and serves the identical manifest; every client generation parses the manifest loosely (extra fields harmless).

### Standing risks that WILL strand the fleet if triggered (not yet active)

1. **Key divergence landmine:** `ssim-license-server/keys/public.pem` in the repo is a **different key** than production signs with. Deploying the repo's `keys/` to the server would instantly strand *every* client (§3.1-b).
2. **Legacy-`sig` removal** before the fleet is fully ≥1.3.1 strands every pre-C14 client (§3.1-c).
3. **`/release/rollback` to a pre-C14 manifest** (e.g. the archived 1.3.0 manifest: no `sigKind`, `kind:'single-exe'`) would make every v1.3.1+ client refuse updates and would re-arm the destructive migration swap-shape (§3.4-c).

### Amplifiers (make the strand worse / invisible)

- Update check runs **once per process launch only** — no periodic re-check, no manual trigger wired (§2, step 0).
- **License gate runs before the update check** — a licensing failure blocks updating; clients ≤1.3.3 carry the *bare-403 = revocation* bug that clears the token on a WAF/proxy 403 (§3.6).
- Every failed cycle **re-downloads the full ~172 MB artifact on every boot** (staged file is deleted on self-test failure) — bandwidth burn on the client and server, forever.
- **Zero telemetry:** update failures are logged only to the client's local disk; the server records only `lastSeen` per seat (`licenses.js:58-83`). Nobody can currently see how many machines are stranded or on which version.

---

## 1. Update path, end-to-end (current client v1.3.4)

All references are to the working tree (= v1.3.4) unless a commit is named.

**Client side** (`src/index.ts`, `src/licensing/Updater.ts`):

0. **Trigger:** `bootstrap()` → `gateAndRun()` ([index.ts:191-217](src/index.ts#L191)). License validated FIRST; *"Only licensed clients update"* (index.ts:204-206). `maybeAutoUpdate()` (index.ts:172-184) runs only `IS_PACKAGED`, **fails open** (any error → keep running current). This is the ONLY call site — one check per launch, no interval, no UI trigger.
1. **Check:** `check()` GETs `${LICENSE_API_URL}/version` (Updater.ts:103-113); any non-200/network error → `null` = "no update" (silent, local `logger.warn` only).
2. **Compare:** `isNewer()` — numeric `major.minor.patch`, strictly newer (Updater.ts:93-100).
3. **Download:** resumable Range hops into `dataDir('updates')` (NOT %TEMP%; Updater.ts:188-196, 221-289), 40 attempts, 30 s idle-stall guard, partial kept between hops. `pipeToFile` resolves **only after fsync + fd close** (Updater.ts:132-174) — the v1.3.3 EACCES fix.
4. **Verify:** sha256, then **`sigKind` REQUIRED** — Ed25519 over `latest:sha256:(kind??'backend')` (Updater.ts:299-335). A manifest without `sigKind` is refused (line 328-330). Legacy `sig` is *not* checked by ≥1.3.1 clients.
5. **Self-test (anti-brick):** spawn the downloaded exe with `SSIM_SELFTEST=1` in an isolated home; accept `SSIM_SELFTEST_OK` via stdout **or** the `<home>/.ssim-selftest.out` file report; **240 s budget** (Updater.ts:388-409). `classifySpawnError` (352-361): spawn-level `EACCES/EBUSY/EPERM/ETXTBSY/UNKNOWN` = retryable `lock` (backoff 300/900/2000/4000 ms + MOTW strip, 411-455); numeric exit, `ETIMEDOUT`, or no-marker = `crash`/`no-marker` → **keep current, never swap** (439-442).
6. **Swap:** detached VBS→bat waits for PIDs, `move /Y`, relaunch; orphan-delete only after confirmed move (buildSwapScript, 467-507); four swap shapes chosen at runtime (514-554): single-exe / migration (needs manifest `kind:'single-exe'`) / two-file backend / standalone.

**Server side** (`ssim-license-server`):

- `GET /version` serves `data/version.json` verbatim (server.js:83-88); **unauthenticated** (no license gate on check/download — good). If the file is missing it returns `{latest:'0.0.0', …}` → every client silently sees "up to date".
- Publish paths (admin.js): legacy `POST /admin/api/version` (single file) and `POST /release/stage`+`/release/finalize` (dual-format) — both **dual-sign** since C14 (`releaseSignatures` in signing.js:36-40 emits `sig` AND `sigKind`; admin.js:183-185, 262-268). Downgrade guard: refuses non-strictly-newer publishes (admin.js:271-279). `POST /release/rollback` restores an archived manifest **verbatim**, bypassing the guard (admin.js:313-340).

---

## 2. The generation matrix (what each shipped version actually runs)

Reconstructed from git (`git log --follow src/licensing/Updater.ts`; release↔commit mapping via `package.json` bump history). Untagged releases (1.2.4, 1.3.2) were built from working trees adjacent to the named commits; their updater behavior is bracketed by the commits on both sides.

| Shipped | Code basis (commit, date) | Verifier requires | Staging dir | Download | Self-test | Strand verdict vs. today's manifest |
|---|---|---|---|---|---|---|
| ≤1.1.5 | `44ffaf4` Jun 20 | legacy `sig` | %TEMP% | all-or-nothing GET | **none** | sig passes → **swaps with NO self-test**; for a two-file install the consolidated artifact lands as `ssim-backend.exe` = wrong-shape swap (§3.4). Big GET rarely completes on flaky links (in-code: *"exactly what stranded the fleet"*, Updater.ts:214-217) |
| 1.2.0–1.2.2 | `0c4a1bd` Jun 20 | legacy `sig` | %TEMP% | all-or-nothing GET | 60 s, **stdout-only**, one-shot | **STRANDED — deterministic.** GUI artifact never prints the marker; this code never reads the file report (extract @0c4a1bd:196-214) |
| 1.2.4/1.2.5, 1.3.0 | `b58aeb7` Jun 23 / `f978a31` | legacy `sig` | %TEMP% | resumable (40 hops) | 120 s, dual-channel, **one-shot** | **STRAND-PRONE:** EACCES class + 120 s budget class |
| 1.3.1, 1.3.2 | `8c64b13` Jun 24 (C14 in `0e0b571`/`86f4397`) | **`sigKind`** | %TEMP% (@8c64b13:120) | resumable | 120 s, dual-channel, one-shot (@8c64b13:259-282) | **STRAND-PRONE — field-proven** (seed log matches @8c64b13:277 verbatim) |
| 1.3.3 | `3bf5f2b` Jun 30 | `sigKind` | `data\updates` | resumable | **120 s** (@3bf5f2b:389), classify+retry locks, MOTW strip | EACCES fixed; **remaining strand: machines whose self-test takes >120 s** → `ETIMEDOUT` → `crash` → keep current |
| 1.3.4 | `2fa570d`/`3aad540` Jul 3 | `sigKind` | `data\updates` | resumable | **240 s** + lock-retry | current |

Key timing fact: the self-test of the real artifact (Tauri shell extracts the ~185 MB embedded runtime, boots the backend, writes the report) legitimately needs **~180–200 s** on slow or AV-heavy machines — stated by the fix itself (commit `3aad540`: *"client self-test timeout (120s) was below the build/publish budget (~180-200s), so a slow/AV-heavy machine that built fine could never pass the update self-test → permanent can't-update"*; and Updater.ts:395-397).

---

## 3. Failure classes — verdicts with evidence

### 3.1 Signature / key migration break — REFUTED as active cause; TWO live landmines found

**(a) The live manifest still serves a VALID legacy `sig` for the latest version — PROVEN.**
Fetched 2026-07-03 from `https://license.ssim.dev/version`: `latest=1.3.4` with both `sig` and `sigKind` present. Local `crypto.verify` (Ed25519) against the client-embedded public key (`secrets.local.bat` → baked via `build/pack.js` into `src/licensing/config.ts:47-53`):

```
legacy sig  over "1.3.4:30a80f22…ac75"          vs CLIENT-embedded key: VERIFIES ✔
sigKind     over "1.3.4:30a80f22…ac75:backend"  vs CLIENT-embedded key: VERIFIES ✔
```
So pre-C14 clients (≤1.3.0) pass their `sig` check and C14 clients (≥1.3.1) pass `sigKind`. Signature verification is NOT what stops anyone today. (Field corroboration: the seed-evidence v1.3.1 client got past verify to the self-test.)

**(b) LANDMINE — the server repo's key does NOT match production. PROVEN.**
`ssim-license-server/keys/public.pem` (`…H6kJDodFONCeuaP0Jr2cfcH/QBmAIaejJkRRB7b2quM=`) ≠ the client-embedded key (`…lZtkREWxSz4Mt9WZVChTdJU+eonO3eCTGFVz/1akAMk=`). Both live signatures **FAIL** under the repo key (same verification run). Production signs with the client key's private counterpart; the repo's `keys/` is a stale/dev pair. Consequence: deploying the repo (or "restoring" keys from it) onto the server would make every future publish unverifiable by **every client ever shipped** — a total, silent fleet strand ("update signature invalid – possible tampering" on all clients). Nothing currently guards against this.

**(c) Deferred risk confirmed still deferred:** dual-signing is explicitly transitional (signing.js:5-9: *"MUST keep being emitted for the whole transition window"*). With zero version telemetry (§3.6) there is no way to know when the fleet has migrated — do not remove `sig` on a guess.

**(d) Historical `sigKind` gap — harmless by luck.** The archived production manifest `_backup/version.json` (v1.3.0, publishedAt 2026-06-23T15:59) has **no `sigKind`** (pre-C14 server) and carries `kind:'single-exe'`. The first `sigKind`-requiring clients were 1.3.1 (Jun 24); by their first possible offer (1.3.2) the server dual-signed (proven by the seed log passing verify). Had a 1.3.1 client been offered the 1.3.0-era manifest, it would have refused it (Updater.ts@8c64b13:237-240) — the ordering "server rollout ships BEFORE this client" (Updater.ts:326-327) held.

### 3.2 Version comparison — REFUTED

`isNewer` is numeric per component, identical in all generations (current Updater.ts:93-100; baseline `44ffaf4`:46-53): `1.3.10` vs `1.3.9` → `10>9` correct; equal versions → false (so an equal-version re-sign never reaches clients — matches the server-side note, admin.js:272); non-numeric tags would yield NaN→false but the server enforces `X.Y.Z` on publish (admin.js:223,241). The server's own downgrade guard (admin.js:271-279) only blocks *publishes*, not clients. No off-by, no lexicographic compare, no downgrade-guard interaction that could read "newer" as "not newer".

### 3.3 Self-test failure — PROVEN (the #1 cause); sub-mechanism ranked

**The observed failure (seed evidence, v1.3.1 machine):** `check ✓ → download ✓ → sha256 ✓ → sigKind ✓ → execFileSync EACCES → catch → "update self-test failed (non-zero exit / crash) – not swapping" → keep current`. Code correspondence is exact: message text @8c64b13:277, `%TEMP%` staging @8c64b13:120, one-shot spawn @8c64b13:259-282 (no retry, no classification, no MOTW strip).

**Why EACCES fires on that machine every boot — three candidate mechanisms (all fixed together in 1.3.3):**

1. **%TEMP% execution policy / AV interference — HYPOTHESIS, ranked most likely.** AppLocker/SRP/Attachment-Manager rules commonly block `CreateProcess` from `%LOCALAPPDATA%\Temp` → `ERROR_ACCESS_DENIED` = EACCES, *permanently on that machine*. Third-party AV can also hold a fresh 172 MB exe exclusively during scan-on-close (transient seconds — but the old code spawns exactly once, immediately). This is precisely what the v1.3.3 fix targeted by moving staging to the app data dir (Updater.ts:177-186 rationale) and adding lock-retry.
2. **Self-inflicted open write handle — HYPOTHESIS, plausible but weaker than the fix comment asserts.** ≤1.3.2 resolved the download on `'finish'` (fd not yet closed; @8c64b13:177). The v1.3.3 fix comment (Updater.ts:117-127) attributes the field EACCES to this. However, between `finish` and the spawn, `verify()` synchronously reads + hashes ~172 MB (≥ hundreds of ms), while libuv closes the fd on a worker thread that does not need the blocked JS thread — the handle is near-certainly closed before `execFileSync`. The race is real in principle (and the fix is correct hygiene) but unlikely to be the dominant field mechanism.
3. **Mark-of-the-Web/SmartScreen — HYPOTHESIS, least likely** (files written by `fs` carry no MOTW; the 1.3.3 strip is defense-in-depth, Updater.ts:364-377).

Whichever sub-mechanism a given machine has, the sequence is identical and repeats every boot: fresh download (new random filename → AV caches never warm; @8c64b13:120) → one-shot spawn fails → `keep current` → file deleted (@8c64b13:420-422) → next boot repeats with another 172 MB download. **Deterministic per machine, permanent, self-repairing never.**

**The second, independent self-test strand: the timeout budget — PROVEN (code).**
Generations 1.2.4–1.3.3 cap the self-test at **120 s** (1.2.0–1.2.2: **60 s**), while the artifact's legitimate self-test needs up to ~180–200 s on slow/AV-heavy machines (§2). On such machines `execFileSync` kills the child → error `ETIMEDOUT`, no numeric `status` → v1.3.3's `classifySpawnError` returns `crash` (ETIMEDOUT is not in the retryable-lock list, Updater.ts:357) → **not retried, keep current**. This is the *remaining* strand vector for v1.3.3 clients after the EACCES fixes, and it is why "even 1.3.3 machines" can fail to reach 1.3.4. Fixed only by 1.3.4's 240 s budget (`3aad540`).

**The third: stdout-only marker (v1.2.0–1.2.2) — PROVEN (code).**
The first self-test generation accepts only `SSIM_SELFTEST_OK` on stdout (@0c4a1bd:196-214). The single-exe GUI artifact reports via `<home>/.ssim-selftest.out` (its stdout is unusable — see Updater.ts:380-387); the file-report channel was added later. A v1.2.0–1.2.2 client that somehow completes the all-or-nothing 172 MB GET and spawns the artifact successfully still concludes "did not pass – not swapping". **Structurally stranded regardless of machine.**

**Chicken-and-egg (the core of the mystery):** all three defects live in the OLD client's updater — the component that gatekeeps its own replacement. v1.3.3/1.3.4 fixed them, but a stranded machine never executes the fixed code. No publish can rescue them through the normal path.

### 3.4 Channel / kind / migration — PARTIALLY PROVEN

- The current live manifest has **no `kind` field** (fetched 2026-07-03). The two-file→single-exe migration swap-shape triggers only on `kind:'single-exe'` (Updater.ts:531). The only known production manifest carrying it was v1.3.0 (archived `_backup/version.json`, Jun 23). **Any two-file install that missed that window can never migrate — PROVEN by manifest + code.**
- What happens to a two-file straggler instead: manifest kind-less → mode (3) "two-file backend swap" (Updater.ts:539-546) → it would replace `ssim-backend.exe` with the consolidated GUI `SSIM.exe` artifact — a wrong-shape swap. Reaching that point requires passing the self-test first (dual-channel generations could pass; ≤1.1.5 has **no self-test and swaps unconditionally after sig** — worst case). Blast radius: broken install (old shell respawns a GUI shell as its sidecar; no `SSIM_PORT` handshake). **HYPOTHESIS for population size** — no telemetry says whether any two-file installs remain; the code paths are proven.
- The dual-format manifest's `files[]`/`filesSig` (admin.js:66-75, 268): no extracted client generation parses either field — they are dead weight (tolerated; see 3.5). Not a failure vector.
- **Rollback landmine — PROVEN mechanism:** `/release/rollback` writes an archived manifest verbatim (admin.js:319-340) and only requires `sig` to be present (line 328). Rolling back to the archived 1.3.0 manifest would serve `kind:'single-exe'` + **no `sigKind`**: every ≥1.3.1 client refuses updates ("no kind-inclusive signature", Updater.ts:328-330) until the next proper publish, and any surviving pre-C14 two-file client would re-trigger the destructive migration shape.

### 3.5 Endpoint / schema compatibility — REFUTED

- **Old domain alive:** `https://ssim-lizenz.duckdns.org/version` (the URL in the v1.0.1 publish record, `data/version-history.json`) fetched 2026-07-03 returns the **byte-identical** current manifest (latest 1.3.4, same sigs, download URL on `license.ssim.dev`). Pre-1.0.6 clients still reach a live, current endpoint.
- **Schema:** every generation reads the manifest via a loose cast (`res.data as VersionInfo`; e.g. @44ffaf4:96-106, current:103-113) and touches only the fields it knows; the additions (`sigKind`, `kind`, `files`, `filesSig`, `notes`, `publishedAt`) are ignored by older parsers (explicitly noted, Updater.ts:58-61). No old parser errors on the new shape.
- Caveat (server-side single point): if `data/version.json` is missing/unreadable the server answers `latest:'0.0.0'` or 500 (server.js:85-87) → all clients silently see "no update"/check-failed. Monitoring-worthy, not currently the cause (file is present and valid).

### 3.6 Silent check failure / license coupling — PARTIAL (real amplifier, not the primary strand)

- `check()` swallows every failure as "no update" with only a local `logger.warn` (Updater.ts:109-112) — a client behind a broken proxy/TLS interceptor never updates and never tells anyone. **HYPOTHESIS for population; code PROVEN.**
- **License-gate ordering:** update runs only after a passed license gate (index.ts:204-206). Consequences: (i) unlicensed/expired seats never update; (ii) clients ≤1.3.3 carry the **bare-403 heartbeat bug** — any WAF/captive-portal/proxy 403 was treated as revocation, tearing down sessions, **clearing the token** and forcing re-activation (fixed in `3aad540`; see the diff: revocation now requires the authoritative `{status:'revoked'}` body). A stranded-at-activation machine is also stranded for updates. **PROVEN (code + commit), population unknown.**
- `/version` and `/download/:file` themselves are unauthenticated (server.js:83-107) — the check does not require a valid license *token*, only that the client's boot sequence reaches it.

---

## 4. Concrete failure sequences (exact, per cohort)

**A. The seed machine (v1.3.1, observed):**
1. Boot → license OK → `check()` → `1.3.1 → 1.3.2` offered.
2. Resumable download to `%TEMP%\ssim_update_<ts>_<pid>_<rand>.exe` (@8c64b13:120) — ~172 MB.
3. sha256 ✓, `sigKind` ✓ (@8c64b13:227-244).
4. `execFileSync(tmp)` → Windows refuses CreateProcess (%TEMP% policy / AV lock) → `EACCES` → caught @8c64b13:276-278 → *"update self-test failed (non-zero exit / crash) – not swapping: spawnSync …EACCES"*.
5. `fsExtra.removeSync(file)` (@8c64b13:420-422) → returns "kept the current version" → app continues on 1.3.1.
6. Next boot: goto 1 (now offered 1.3.2/1.3.3/1.3.4 — same result each time). **Permanent, ~172 MB wasted per boot.**

**B. A v1.2.2 machine:** all-or-nothing GET must survive ~172 MB without a single reset (@0c4a1bd:72-90); if it ever completes → self-test spawns GUI artifact → 60 s budget and stdout-only marker → *"did not pass – not swapping"* → keep current. **Two independent dead-ends; structurally stranded.**

**C. A v1.3.3 slow/AV-heavy machine:** download to `data\updates` ✓, sigKind ✓, EACCES-class handled (retries, MOTW strip) — but the self-test needs >120 s → `ETIMEDOUT` → `classifySpawnError` = `crash` (@3bf5f2b, list excludes ETIMEDOUT) → *"not swapping"* → pinned on 1.3.3 despite 1.3.4 fixing exactly this.

---

## 5. How to confirm at runtime (per class, on a real user machine)

1. **Read the client's `logs/ssim.log` / `logs/error.log`** for the generation fingerprints:
   - ≤1.3.2 EACCES class: `update self-test failed (non-zero exit / crash) – not swapping: spawnSync` + a `%TEMP%` path.
   - 1.3.3 timeout class: `update self-test failed – not swapping [crash]: ETIMEDOUT…` (staged path under `…\data\updates`).
   - 1.2.0–1.2.2 marker class: `update self-test did not pass – not swapping:` (empty output excerpt).
   - Signature class (would-be): `update signature invalid` / `manifest has no kind-inclusive signature`.
2. **Time the self-test manually** on the machine: run the downloaded `SSIM-1.3.4.exe` with `SSIM_SELFTEST=1` + a scratch `SSIM_HOME` and measure wall time vs. that client's budget (60/120 s).
3. **Check %TEMP% execution policy**: AppLocker/SRP effective policy; try launching any small exe from `%TEMP%`; check AV quarantine/scan logs around the update timestamps.
4. **Verify what the machine's network serves**: `curl https://license.ssim.dev/version` from that network and confirm `sig`+`sigKind` are intact (corporate MITM proxies can mangle it).
5. **Server-side sizing (currently impossible):** the server would need clients to report version+update outcome; today only `lastSeen` exists (licenses.js:58-83). Until then the stranded population can only be sized machine-by-machine.

---

## 6. Recommendations (NOT applied — written proposals only)

**Rescue the stranded fleet (no server publish can do it through the old updaters):**
1. **Manual-reinstall rescue path** as the official remedy for stranded machines: a one-file download of the current `SSIM.exe` replaced over the install (data dir is preserved by design). Announce via the Discord channel; add a website "repair" page with exact steps. This is the only remedy that bypasses the old self-test valve.
2. **Make the next artifact's self-test cheap** (target: comfortably < 60 s cold on a slow disk): a dedicated fast-path for `SSIM_SELFTEST=1` that skips full runtime extraction where possible — this widens the pass window even for old 60/120 s clients whose *only* problem is the budget (rescues cohort C without touching their code).

**Prevent recurrence (client, next releases):**
3. **Never let the self-test pin silently forever:** after N consecutive self-test failures of the *same* sha256, surface a persistent UI prompt ("update ready but blocked — click to install / see why") instead of an infinite silent keep-current loop; log the failure *to the server* (see 6).
4. **Persist the verified download** across boots (it already lives in `data\updates`): re-downloading 172 MB per boot after a self-test failure is pure waste — keep the artifact keyed by sha256 and only re-download on mismatch.
5. **Classify `ETIMEDOUT` as retryable-with-longer-budget** (one escalation retry at 2× budget) rather than a hard `crash`.

**Visibility (server + client):**
6. **Update-outcome telemetry:** include `clientVersion` and last update outcome (`ok/self-test-fail/EACCES/timeout/sig-fail`) in the existing heartbeat POST; store per seat next to `lastSeen`. This makes stranding measurable and answers "has the fleet migrated?" for (7).
7. **Keep dual-signing until telemetry proves the fleet ≥1.3.1**; add a publish-time self-check that refuses to write a manifest missing `sig`, `sigKind`, or valid signatures (protects against a future signing.js regression).
8. **Reconcile the signing key NOW:** document which keypair production uses; fix or delete the mismatched `ssim-license-server/keys/*.pem` in the repo; back up the production private key out-of-band. Any future rotation must be dual-key (ship new pubkey in clients first, sign with both during transition).
9. **Harden `/release/rollback`:** refuse to restore a manifest lacking `sigKind` (or re-sign it at rollback time); warn loudly when restoring one that carries `kind:'single-exe'`.
10. **Periodic + manual update checks:** re-run `Updater.check()` on an interval (e.g. every 6–12 h) and expose a "Check for updates" action — 24/7 operator machines currently only check at relaunch.
11. **Architectural (longer term):** move the swap/self-test policy into a tiny, rarely-changing updater helper so the update gatekeeper is no longer embedded in the artifact it gates — this removes the entire chicken-and-egg class.
