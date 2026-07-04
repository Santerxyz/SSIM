# STABILITY_ISSUES.md — whole-app reliability & stability register (diagnosis only)

**Date:** 2026-07-04 · **Build:** v1.3.4 working tree (`fix/pricing-live-and-port-bind`, uncommitted remediation wave present) · **Mode:** DIAGNOSIS + PLAN ONLY — **nothing was changed, built, or run against real accounts.**
**Method:** Phase-0 lifecycle map (below) → five parallel read-only subsystem auditors (core/session/vault · trading/money · network/pricing/CSFloat · API/frontend · licensing/updater/boot + license server) → the lead re-verified every HIGH/CRITICAL claim and one load-bearing claim per auditor directly against the current source (marked **✔ lead-verified**).
**Labels:** PROVEN (mechanism certain from traced code) / HYPOTHESIS (plausible, depends on unverified runtime behaviour). **Companion reports (not duplicated here):** [BACKEND_RELIABILITY.md](BACKEND_RELIABILITY.md), [UPDATE_RELIABILITY.md](UPDATE_RELIABILITY.md), [REMEDIATION_LOG.md](REMEDIATION_LOG.md). This sweep reports **new** defects, corrections, and fresh defects in the uncommitted remediation code.

Scope on the known 0xC0000409 native fast-fail: nothing new was found that could produce an *unbounded* native-layer storm, and `_crashrepro/storm2.js` has now been run (`out3.txt`: `SOAK_OK`, 281 k login cycles, `destroyedForced===0`). R1's mechanism remains **PROVEN-occurrence / UNPROVEN-mechanism**; the WER LocalDump on a real recurrence stays the decisive instrument (see [BACKEND_RELIABILITY.md](BACKEND_RELIABILITY.md) F1 + `docs/WER_LOCALDUMPS.md`).

---

## FIELD CONFIRMATIONS — v1.3.4 live (2026-07-04)

Four symptoms reported from a running **shipped 1.3.4** build (commit `2fa570d`). Note: the shipped 1.3.4 predates the S1/S20 fix commits (`f5b5359`, `ef4ed78`), so those fixes exist in git but are **not in the running build** — they need a 1.3.5 release to reach the field.

- **"Open in Browser" → red toast "Missing or invalid capability token. Reload SSIM from its own window."** = **S1**, live-confirmed. `POST /api/accounts/<user>/open-browser` (`public/app.js:3947`) is a protected mutating call; in 1.3.4 the per-run token was delivered once and lost on any reload/renderer-recovery (and could miss first paint via the S1b race), so it 401s. **Fixed on branch** (sessionStorage stash + 3× post-navigate re-seed) — ship it. The advice in the toast ("Reload SSIM") is itself wrong — a reload cannot re-mint the token; only a full restart could, pre-fix.
- **"Live Logs doesn't work anymore"** = **S20**, live-confirmed. The launcher POSTs `/api/app/open-logs` with no token (`public/index.html:1538`); every `/api/` POST was capability-guarded → silent 401 → the shell never gets `SSIM_OPEN_LOGS`. **Fixed on branch** (exempt that read-only endpoint) — ship it.
- **"Price fetch loads 30 min without finishing"** = throttle-bound, **not a hang** — with residual defects **S2 / S13 / S19** making it worse. The background fill is single-IP, single-threaded at `FETCH_DELAY_MS = 3500` (≈17 names/min, `PricingService.ts:11`); a 500+-account cold cache with thousands of unique `market_hash_name`s legitimately takes **tens of minutes to hours**, and Steam 429s re-queue each name up to 6× at 60–80 s (`PricingService.ts:147-155`), stretching it further. The badge faithfully shows "Fetching prices…" the whole time (`app.js:786-808`) with no ETA, so *slow* reads as *stuck*. **Not yet fixed** (Wave 1/5). Real levers: fix S2 so transient errors don't burn names into 24 h `null`s; surface an ETA/"large inventory — this can take a while"; longer-term, route Steam price fetches through the per-account proxies to lift the single-IP ceiling.
- **"Things showing behind the live logs"** = **S68 (NEW)**, live-confirmed by the screenshot. The floating "Live Logs" button is `position:fixed; right:18px; bottom:18px; z-index:99999` (`public/index.html:1523-1524`); the toast stack is `fixed bottom-6 right-6 z-[60]` (`:1505`). Both occupy the bottom-right corner, and the button's absurd `z-index:99999` sits **above every toast, modal (z-30), the capability banner (z-50), and the update badge** — so toasts and any bottom-right panel render *under* the always-on-top button (exactly the overlap in the screenshot). **PROVEN, MEDIUM (cosmetic-but-obscures-alerts).** Fix direction: move the button to the bottom-**left**, and/or drop its z-index below the toast/modal layer (~z-40) and offset the toast stack clear of it. **Not yet fixed.**

**Status of the four:** S1 ✅ fixed-on-branch · S20 ✅ fixed-on-branch · pricing ⏳ unfixed (S2/S13/S19 + throughput) · S68 ⏳ new/unfixed. The two ✅ only help once a **1.3.5** is built and released; the running 1.3.4 keeps exhibiting all four until then.

---

## EXECUTIVE SUMMARY

### The systemic patterns (each recurs across ≥3 subsystems — fix the pattern, not just the instance)

- **P-A · "Partial or failed read committed as authoritative truth."** A read that half-succeeded is written as complete. This is the single most damaging theme because it silently corrupts derived state that the operator makes money decisions on. Instances: per-context inventory empty-coercion → **the item-state divergence field failure** (S4); a transient price fetch error cached as a 24 h authoritative "no price" that survives restart → **the "prices stale until restart" field failure** (S2); mass-sell reconcile relabelling a genuine failure as recovered (S28).
- **P-B · "The corrupt/empty copy overwrites the last good one."** The remediation wave hardened `TokenStore` + the CSFloat *delivered* store against this, but the same pattern remains live in ≥4 other stores. Instances: vault `.bak` clobbered by the corrupt main file during B33 recovery → **unrecoverable farm-credential loss** (S5); `CsFloatKeyStore` silent-reset + `.bak` clobber (S12); the license server answering `{status:'revoked'}` for an *empty* db → **fleet-wide teardown + token wipe** (S7); `DeliveredStore` write-failure → memory-only dedup → duplicate delivery (S39).
- **P-C · "An in-flight/ambiguous operation is treated as resolved."** The brand-new crash-dedup journal (B4) only protects against a *hard process kill*; every *thrown* network-ambiguous commit failure — the ECONNRESET-on-the-response-leg class that the field environment produces constantly — consumes the journal entry, so a retry double-spends (S3); the refuse-once guard is likewise consumed synchronously, so a double-click sails through (S15).
- **P-D · "A watcher/poller dies silently while the job keeps running."** Reproduces the stale-UI complaint independently of the pricing cache: the reprice watch's terminal 15-min stop (S19), the refresh/mass/sell pollers dying on the first transient error (S17), `watchPriceFill` against a dead backend (S42).
- **P-E · "An unbounded await on an external dependency, while holding a lock or the whole event loop."** `steam-totp getTimeOffset` with no timeout wedges every confirmation/money path and pins asset locks until restart (S6); `ensureLicensed` and the interactive "live" routes have no client timeout (S23, S32); the mid-session self-test freezes the entire event loop synchronously for 4–8 minutes (S8).
- **P-F · "The capability guard, added last, silently breaks callers written before it."** The per-run money-auth token is delivered exactly once by a webview `eval` that races the splash→dashboard navigation; any reload leaves the whole write surface 401-ing for the session (S1); the same guard killed the Live Logs button (S20).

### The single highest-leverage area to harden first

**The capability-token delivery (S1) is the highest-leverage *point* fix, and the data-integrity class P-A/P-B is the highest-leverage *theme*.**

S1 is PROVEN, fires on *every* in-webview reload (routine on a 24/7 operator machine — WebView2 renderer recovery, an accidental F5, or the app's own `ensureLicensed` redirect at S23), and silently disables **all** money/config/refresh operations until a full app restart — while reads keep working so the app *looks* healthy and the on-screen advice ("Reload SSIM from its own window") makes it worse. The fix is tiny and self-contained (stash the token in `sessionStorage`; attach it via a re-running `initialization_script` on the splash window). One change removes an entire class of "the app is alive but nothing works."

Immediately behind it, the P-A/P-B data-integrity class is where the two recurring field complaints (item-state divergence, prices-stale-until-restart) *and* the only irreversible losses (vault credentials, CSFloat keys, fleet-wide license wipe) all live. It is more work than S1 but retires the most field pain and the worst tail risk.

### Fix-first shortlist (the ordering the Remediation Plan expands)

1. **S1** cap-token delivery — unblocks the entire write surface (tiny).
2. **S2** pricing error-miss vs no-price — kills the recurring staleness complaint (small).
3. **S3** journal double-spend on ambiguous commit — the only *money-loss* defect (small, high-care).
4. **S4** inventory per-context coercion — the item-state divergence root (medium).
5. **S5 / S12 / S7** last-good-copy clobbers (vault / CSFloat keys / license server) — irreversible-loss tail (small each).

---

## RANKED ISSUE REGISTER

Ordered by real-world impact (frequency × damage). IDs are stable handles for the plan below. Severity is the frequency×damage tier; money-loss and unrecoverable-data-loss weigh heaviest.

---

### S1 — Capability token delivered exactly once; any reload permanently 401s every money/config op for the session — HIGH · PROVEN · ✔ lead-verified
**Location:** `src-tauri/src/lib.rs:543-551` (one-shot `w.eval(js)` after `w.navigate`), `src/api/server.ts:280` (sidecar index served clean), `public/app.js:412-431` (`awaitCap` gives up at 3 s, sends without header), `src/api/capability.ts:59-65` (401s).
**Mechanism:** In production the money-auth token exists only as `window.__SSIM_CAP__`, set by a single shell `eval` issued immediately after `navigate` — with no page-load synchronisation, so it can land in the *dying splash* document and be wiped on commit (the race, **S1b**), and even when it lands it is never persisted. `index.html` is deliberately served clean in sidecar mode, so there is no HTML-injection fallback. Nothing in `app.js` handles the returned `capabilityRequired` flag.
**Trigger:** Every boot has the race window (frequency unmeasured); *any* in-webview reload — Ctrl+R/F5, WebView2 renderer recovery, or the app's own `location.replace('/')` (S23) — deterministically drops the token thereafter.
**Blast radius:** Every POST/PUT/PATCH/DELETE (all money ops, refresh-all, settings, imports) fails with a toast; reads keep working so the app looks healthy; only a full process restart restores it. The race-free `initialization_script` path (`lib.rs:557-565`) is dead code because the splash window always exists first (`lib.rs:669`).
**Fix direction:** Stash the token in `sessionStorage` at first receipt and fall back to it in `capToken()`; have the shell attach it via `initialization_script` on the splash-built window (init scripts re-run on every navigation) *and* keep the eval; render a dedicated "restart required" banner when a response carries `capabilityRequired`.

### S2 — Transient fetch errors cached as authoritative 24 h "no price" misses that survive restart — HIGH · PROVEN · ✔ lead-verified
**Location:** `src/pricing/PricingService.ts:160-163` (non-429 throw → `cache.set(key, null)`), `:156-159` (429-exhaustion → same), `src/pricing/sources/SteamPriceSource.ts:22` (`status !== 200 || success !== true → return null`), consumed at `PricingService.ts:84-89`, `:103-105`.
**Mechanism:** `run()` conflates "Steam authoritatively has no price" with "the fetch failed." Any thrown transport error (proxy ECONNRESET/ETIMEDOUT, DNS-down, CSFloat transport error routed through a per-account proxy) *and* every Steam 5xx/403/non-success writes `{cents:null, fetchedAt:now}` into `PriceCache`, persisted to `prices.json`. `priceCents`/`enrich` then treat a fresh `null` as a real, fresh "no price" for the full 24 h TTL — item shows no price and is excluded from `totalValueUsd`.
**Trigger:** Any network blip / Steam outage / proxy RST storm overlapping a boot or refresh fill. A DNS-down boot burns the entire queue into nulls at 3.5 s/name.
**Blast radius:** Affected items are unpriced and missing from account/portfolio totals for 24 h; because `prices.json` persists, **restart does not fix it** — this is the residual "v1.3.4 staleness fix didn't work" path (the live-fill watch faithfully re-renders a poisoned cache). Display-integrity, not money-path (mass-buy uses the native wallet).
**Fix direction:** Distinguish miss kinds — cache `null` with the 24 h TTL only for a 200/success "no price"; give error-misses a short TTL (minutes) or don't cache them (the per-key retry bound already prevents hammering).

### S3 — MoneyOpJournal (B4) consumed on network-ambiguous commit failure → retry double-spends real money — CRITICAL · PROVEN · ✔ lead-verified
**Location:** `src/trading/BuyService.ts:294-296` (`finally { … journal.resolve(guardKey) }`), `src/trading/TradeService.ts:516-519` (same), record-on-success at `TradeService.ts:503`.
**Mechanism:** `resolve()` runs in `finally` on *every* exit, including a thrown transport-ambiguous failure where the buy order / trade offer may already exist on Steam. Failure classes: a `createbuyorder` response-leg ECONNRESET where the order landed but the resting-order probe (itself through the same broken proxy, and blind to an *instantly-filled* order — the normal at/above-ask case) throws `verifyBeforeRetry`; and `offer.send` succeeding on Steam while its response is lost — neither leaves a journal entry, because the `finally` consumed it. **Only a hard process death between `begin()` and the `finally` leaves an entry** — so the new cross-restart dedup protects against the *rarest* failure and not the common one it was motivated by.
**Trigger:** ECONNRESET/timeout on a buy/send commit's response leg (the documented field storm) + operator retry.
**Blast radius:** A second real buy order (double wallet spend — the retry's inventory diff looks normal because the baseline re-read absorbs item #1) or a duplicate real-asset offer. The UI-advisory `verifyBeforeRetry:true` 502 (`server.ts:1382`,`:1760`) is the only thing between the retry and the duplicate.
**Fix direction:** In the commit-step catch, classify transport-ambiguous errors (ECONNRESET / timeout / no-response / `verifyBeforeRetry`) and **skip** `resolve()` for them (or `record(…, 'unknown')`) so the next attempt hits the refuse-once gate. Do **not** touch `AccountTrader.createBuyOrder`/its finalize re-POST (owner constraint).

### S4 — Per-context "empty-coercion" commits a half-merged CS2 inventory as complete — the item-state-divergence mechanism — HIGH · PROVEN · ✔ lead-verified
**Location:** `src/core/InventoryManager.ts:141-148` (page-0 unusable body → `{assets:[], success:1}`), `src/core/InventoryService.ts:257` (both-empty retry) + `:327-337` (rawCount-combined guard).
**Mechanism:** `fetchRaw` converts *any* HTTP-200 page-0 response without assets (`null` body, `{success:false}` — which fails the `=== 0` check and falls through, an HTML error page) into a *successful empty inventory* (`success:1`). `doRefreshOneViaGc` fetches ctx2 (owned + market-holds) and ctx16 (trade-locked + listed) separately; the both-empty retry and the `rawCount===0` reconcile trip only when **both** contexts are zero. If **one** context is empty-coerced while the other has items, `rawCount > 0` → the merge is committed as authoritative with `partial:false`: every trade-locked (or every owned) item silently vanishes from the cache. The single-context TF2/quick path is protected (B31 `suspectEmpty`, `:519-525`); only the two-context CS2 path has the hole.
**Trigger:** One transient 200-with-garbage on one context — common under the documented proxy flakiness (541× `NoConnection` in field logs).
**Blast radius:** Cached owned/locked/listed state flaps per pass (the field "Locked↔Tradable instability / owned-locked divergence"); per the B31 note (`InventoryService.ts:517`) a missing cached stack also weakens the send-side trade-lock guard (`filterSendable` passes assets with no stack) until the next good refresh — i.e. a path toward sending an item that is actually locked.
**Fix direction:** Make `fetchRaw` return an explicit `ok:false`/throw for a coerced page-0 empty (distinguish "Steam said success, zero assets" from "unusable body"), and apply the reconcile-don't-commit guard **per context**, not only on the combined count.

### S5 — Vault `.bak` recovery clobbers the good backup with the corrupt main file before rewriting — a crash in the window destroys every farm credential — CRITICAL (rare × unrecoverable) · PROVEN · ✔ lead-verified
**Location:** `src/core/AccountVault.ts:160-165` (B33 recovery → `this.save()`), `:215` (`save()` uses `backup:true`), `src/utils/atomicJson.ts:29-30` (backup copies the *current* on-disk file first).
**Mechanism:** On a corrupt `vault.enc` with a healthy `vault.enc.bak`, recovery decrypts the `.bak`, then calls `save()` → `writeJsonAtomic(..., backup:true)`, which **first copies the still-corrupt `vault.enc` over the just-proven-good `.bak`**, then writes temp→fsync→rename. A crash / power-loss / AV-block between the copy and the rename leaves **both** files corrupt → next boot both fail GCM → reported as `WRONG_PASSWORD`; the vault has "NO recovery" by design → the operator's entire farm (passwords + maFiles + tokens) is gone. Even without a crash, `.bak` holds a worthless copy until the next scheduled save.
**Trigger:** Prior main-file corruption + a failure in the ms-window (low frequency).
**Blast radius:** Catastrophic and irreversible — total credential loss for the whole farm.
**Fix direction:** In the recovery branch, save with `backup:false` (or copy `.bak`→`vault.enc` first, or write the recovered payload to a temp name before touching `.bak`).

### S6 — No timeout on `steam-totp getTimeOffset`; one stalled QueryTime response wedges all money/confirmation paths and pins asset locks until restart — HIGH · PROVEN · ✔ lead-verified
**Location:** call sites `src/trading/AccountTrader.ts:927,1002,1048,1076` and `node_modules/steamcommunity/components/confirmations.js:164`; the raw `https.request` in `node_modules/steam-totp/index.js:106-146` has no `setTimeout`.
**Mechanism:** The QueryTime request has no timeout; a stalled response (connection open, no bytes — the adversarial case; also AV/captive-portal interception on the *direct* host egress, not the per-account proxy) never settles the callback. `off = offErr ? 0 : offset` handles an *error* but not a *hang*. Every confirmation entry point awaits it unbounded: buy-order 2FA, mass-sell listing 2FA, the SDA confirmations panel, and steamcommunity's trade-send confirm.
**Trigger:** A fully stalled QueryTime socket (low frequency, total impact).
**Blast radius:** `sendTrade` never reaches its `finally` → the in-flight guard **and MoneyOps asset claims are held until restart** (those assets refuse every sell/send with "busy in another money operation"); mass-send (concurrency 1) latches `running:true` → all future mass-sends refused; mass-sell wedges a worker; `busy()` stays true → the update scheduler permanently refuses installs.
**Fix direction:** Race every `SteamTotp.getTimeOffset` call site with a ~10 s timer falling back to `off = 0`, and cache the offset per process (also removes ~12 extra QueryTime round-trips per buy-confirm loop).

### S7 — License-server data loss → authoritative fleet-wide revocation: every client tears down sessions and clears its token — CRITICAL (rare × catastrophic) · PROVEN mechanism / HYPOTHESIS trigger · ✔ lead-verified (cross-repo)
**Location:** `ssim-license-server/src/store.js:26-30` (missing `db.json` → empty db), `src/licenses.js:69-78` (`seatStatus` → `not_found` for an unknown key), `src/server.js:113-116` (`/heartbeat` maps any non-`ok` to `403 {status:'revoked'}`; `/validate` `:105` likewise), trusted at `CS2_Manager/src/licensing/LicenseClient.ts:333-335`.
**Mechanism:** `store.load()` returns a fresh **empty** db when `db.json` is *missing* (misdeploy, `DATA_DIR` not on the persistent disk — the exact risk `config.js:10-11` warns about, e.g. a redeploy without the volume). Then every seat is `not_found` → the handlers answer with the authoritative body marker `{status:'revoked'}` — precisely the signal the v1.3.4 bare-403 fix now trusts → `handleRevoked` → `teardownFullApp` mid-operation + `clearToken()` **fleet-wide within one heartbeat interval**; re-activation then 404s (keys gone). A *corrupt* db.json is safe (`load()` throws → 500 → clients ride the 72 h grace); only the **valid-but-empty** case is fatal.
**Trigger:** Server misdeploy / persistent-disk detachment (rare, operator-controlled, but a single event hits the whole fleet).
**Blast radius:** Every client simultaneously logs out its Steam sessions and wipes its stored token; recovery requires re-provisioning keys server-side.
**Fix direction:** Distinguish "seat/key unknown" (non-authoritative → let clients ride grace) from an explicit revoked record; only ever send `{status:'revoked'}` for a record that *exists and is revoked*. Consider a server-side "db suspiciously empty" self-guard that refuses to serve revocations on a zero-seat store.

### S8 — Mid-session "Install now" freezes the whole backend event loop for 240–480 s (synchronous self-test in a live process) — HIGH · PROVEN · ✔ lead-verified
**Location:** `src/licensing/Updater.ts:446-449` (`execFileSync` self-test), `:215`/`:353` (two synchronous ~185 MB `readFileSync` hashes), reachable mid-session via `src/licensing/updateScheduler.ts:137-146` (`installNow` → `runUpdate`).
**Mechanism:** C5's `installNow()` runs the FULL `runUpdate` inside the live, session-carrying process, and `runSelfTestOnce` uses **synchronous** `execFileSync` — the event loop stops for the entire self-test (240 s base + a 480 s C2 escalation, re-run per lock retry), plus the two synchronous hashes. Harmless when the only caller was the pre-server boot path; C5 made it reachable while sessions are up.
**Trigger:** User confirms "Install now" with sessions live (the designed flow).
**Blast radius:** Every HTTP request, Steam CM keepalive, confirmation poll and timer freezes for minutes → Steam drops the resident fleet (~up to 150 sessions); if the self-test then *fails*, the process keeps running with a wounded fleet (no restart). Even on success the pre-exit freeze precedes the swap.
**Fix direction:** Async `execFile` (or run the self-test in a worker/child), or refuse a mid-session install and stage-for-next-boot instead.

### S9 — Persistent swap failure → infinite boot→self-test→swap→relaunch loop; nothing counts swap failures; the splash even claims success — HIGH · PROVEN mechanism / HYPOTHESIS trigger · ✔ lead-verified
**Location:** `src/licensing/Updater.ts:552-578` (`move /Y … && goto swapped` / `goto swapfail` → relaunch), `runUpdate:795-799` (clears the C3 streak + sets `ok` before the swap).
**Mechanism:** When `move /Y` fails (AV/EDR lock, or **Windows Controlled Folder Access — and this install lives on the Desktop**), the bat correctly relaunches the OLD exe (no brick). But the old client re-offers the update, C1 reuses the staged artifact, the self-test PASSES again (the C3 streak counts only *self-test* failures and was just cleared), and it swaps→exits again → forever. **No file/marker/counter records a swap failure.** `setUpdateOutcome('ok')` is set but the process exits before any heartbeat, so telemetry shows only a version pinned forever; the single-exe relaunch even passes `--ssim-updated`, so the shell shows an "Update installed" splash each failed cycle.
**Trigger:** Any persistent `move /Y` failure (AV / Controlled Folder Access on a Desktop/protected-folder install).
**Blast radius:** The machine cycles every ~1–5 min indefinitely, never usable, invisible remotely.
**Fix direction:** Have the bat write a swap-failure marker file that the next boot consumes into the C3 streak / a swap-block after N failures (surface it like `SSIM_UPDATE_BLOCKED`).

### S10 — `GET /api/inventory` deep-clones + enriches + stringifies the whole 500-account fleet synchronously, hammered ~every 2.5 s during a price fill — HIGH · PROVEN · ✔ lead-verified
**Location:** `src/api/server.ts:1141-1149` (`allCs2()` → clone-all + `enrich` + `res.json`), `src/core/InventoryStore.ts:148-151` (`cloneInventory` per record, over both stores), `public/app.js:772-787` (`watchPriceFill` repull on any `fetched` advance).
**Mechanism:** Each GET deep-clones every record of *both* CS2 stores, runs `pricing.enrich` over every item, then `res.json` stringifies the multi-MB map — all on the event loop. `watchPriceFill` re-pulls whenever `fetched` advanced; with the fill fetching ~1 name/3.5 s that is nearly every 2.5 s poll for the whole fill (minutes on a large fleet), each tick also re-running full `renderMain()`+`renderSidebar()` in the webview.
**Trigger:** Routine — boot fill, every refresh-all, every source switch at 537 accounts.
**Blast radius:** Repeated 100 ms+ event-loop stalls delaying in-flight trade/confirmation requests, GC churn, and sustained UI jank/DOM rebuild during fills (the hidden cost of the C5/live-fill feature).
**Fix direction:** Add a delta/ETag-304 to `/api/inventory`; bound the repull cadence (≥10 s); patch prices into existing frontend state instead of a full refetch+rerender.

---

### S11 — Post-login `disconnected` sessions become permanent zombies: never reaped, fill the 150-resident ceiling, keep trader pollers alive — MEDIUM · PROVEN · ✔ lead-verified
**Location:** `src/core/SessionManager.ts:154` (reaper `continue`s any non-`LOGGED_IN`), `:575-582` (`disconnected` handler only flips state), vs the teardown in the `error` handler `:569-571`.
**Mechanism:** A CM drop after a settled login (proxy blip → `disconnected`, no `error`; `autoRelogin:false`) leaves the session resident in `DISCONNECTED`. The B43 deferred-destroy fires only in the `error` handler; the idle reaper explicitly skips non-`LOGGED_IN`; nothing else destroys it — so it keeps its map slot (counted against `MAX_LIVE_SESSIONS`), its proxy agent, and its `TradeOfferManager` poller (`sessionDestroyed` never fires).
**Trigger:** Single-op sessions (manual refresh/send/trade-URL) whose proxy hiccups within the 30-min idle TTL — frequent at 537 accounts on residential proxies.
**Blast radius:** Zombies accumulate between fleet refreshes; at 150 residents every new login is refused ("live-session ceiling reached") until restart or until each zombie account is individually re-used. A full fleet refresh incidentally heals what it touches (bounds but does not eliminate it).
**Fix direction:** Reap `DISCONNECTED`/`ERROR` sessions too (idle-TTL or a deferred destroy mirroring B43 in the `disconnected` handler, with the same `sessions.get(key)===session` replacement guard).

### S12 — `CsFloatKeyStore` silently resets on a corrupt file, then clobbers both the file and its `.bak` — the B2/F8 pattern was not extended here — MEDIUM · PROVEN · ✔ lead-verified
**Location:** `src/csfloat/CsFloatKeyStore.ts:34` (corrupt → `return {version:1, keys:{}}`), `:38` (`save()` with `backup:true`), via `atomicJson.ts:29-31`.
**Mechanism:** A corrupt `csfloat_keys.json` (plaintext mode) silently loads empty; the next `set()`/`delete()` saves with `backup:true`, copying the corrupt file over the previous good `.bak` before writing the near-empty state — both recovery paths destroyed. `TokenStore` (B2) and `DeliveredStore` got a degraded mode for exactly this; this store did not.
**Trigger:** Crash/AV corrupting the file (the class that historically hit `csfloat_delivered.json`).
**Blast radius:** All CSFloat keys silently vanish → pricing falls back to Steam and the auto-accept worker silently skips every account (pending CSFloat sales sit undelivered) with no UI warning.
**Fix direction:** Mirror B2 — present-but-unreadable ⇒ degraded flag, no-op save, surface on the status endpoint.

### S13 — Price queued-name dedup set is poisoned when the effective source flips mid-fill → names become unfetchable until restart — MEDIUM · PROVEN
**Location:** `src/pricing/PricingService.ts:113-115` (enqueue key at insert time) vs `:139-140` (dequeue key rebuilt) + `:165` (`finally` deletes the rebuilt key); source flip at `src/csfloat/CsFloatService.ts:88-93`.
**Mechanism:** `ensureFilled` inserts into `this.queued` under a key built from the source active *at enqueue*; `run()` rebuilds the key *at dequeue*. `activeSource()` flips without `setSource()` (the only thing that clears `queued`) when the first CSFloat key is added or the last removed at runtime. After a flip the `finally` deletes the wrong key, leaving the old-source key in `queued` forever; when the source flips back, `ensureFilled` skips the name permanently.
**Trigger:** Operator adds/removes a CSFloat API key while a fill is queued (fills run for hours on a 537-account fleet).
**Blast radius:** Those names are never priced under that source for the process lifetime — permanent per-name staleness a UI watch cannot heal.
**Fix direction:** Store the cache key on the job at enqueue time (fetch and delete the same key), or purge `queue`/`queued` whenever the effective source id changes, not only in `setSource()`.

### S14 — Update-install busy-gate misses mass-sell / trade-up craft / casket moves, and is check-once (TOCTOU over minutes) — MEDIUM · PROVEN · ✔ lead-verified
**Location:** `src/index.ts:226` (`isBusy` = trades||buy||inventory only), `src/licensing/updateScheduler.ts:126-133` (checked once at the endpoint; `runUpdate` never re-checks before the swap).
**Mechanism:** `canInstallNow()` consults only Trade/Buy/Inventory `busy()`; `MarketService` mass-sell, `TradeUpService.execJob` (irreversible 10-item crafts), and `CasketService` moves have no `busy()` and aren't wired in. The gate is also evaluated once, minutes before the swap.
**Trigger:** Operator confirms "Install now" while a mass-sell/craft/casket runs, or starts one during the download/self-test window.
**Blast radius:** The swap hard-exits mid-listing (unconfirmed 2FA listings) or mid-craft (outcome unknown inside the 20 s confirm window) — violates C5's own contract. Bounded (no double-spend; listings recoverable) but real item ops interrupted.
**Fix direction:** Add `busy()` to MarketService/TradeUpService/CasketService, OR them into `isBusy`, and re-check immediately before spawning the swap script.

### S15 — Refuse-once is consumed synchronously → a double-click after a crash-restart burns the refusal on click 1 and click 2 fires the real op — MEDIUM · PROVEN · ✔ lead-verified
**Location:** `src/trading/TradeService.ts:491-497`, `src/trading/BuyService.ts:172-175` + `:294-296`.
**Mechanism:** The refusal path deletes the in-flight guard and consumes the journal entry synchronously *before* throwing, so the "check on Steam, then retry" pause is not enforced — the second request of a double-click (50–300 ms later) passes both guards and commits the possibly-duplicate op before the operator can read the warning. Refuse-once blocks a *deliberate sequential* retry, not a double-click.
**Trigger:** Crash mid-op → restart → double-click the same buy/send.
**Blast radius:** The exact duplicate the journal was built to stop, in its highest-risk scenario.
**Fix direction:** Keep the entry on refusal with a `refusedAt` stamp; only consume it after a minimum age (5–10 s) or on an explicit `force` retry flag.

### S16 — GC 60 s op cap vs. unbounded casket-move loop: big moves always "fail," the loop keeps running detached, and the per-account GC guard is released early — MEDIUM · PROVEN
**Location:** `src/trading/GcActionLayer.ts:193` (fixed `withTimeout(fn, 60_000)`) vs `:287-303` (per-item ~0.9–1.8 s move loop), mislabelled at `src/trading/CasketService.ts:85-88`.
**Mechanism:** A casket move costs ~0.9–1.8 s/item, so any move above ~50–80 items exceeds the fixed 60 s `withTimeout`, which rejects but cannot cancel `fn(go)`: the caller gets "timed out," the `finally` drops the GC session and clears `inFlight`, while the move loop keeps running detached for up to ~15 s × remaining items. A second GC op can then start on the same account and interleave with the zombie loop's remaining `addToCasket` sends. `runMove` files the timeout under "a pre-flight failure — nothing moved" although items *did* move.
**Trigger:** Any casket move above ~60 items.
**Blast radius:** Items are reversible (no money loss), but the "one GC op per account" and "honest partial reporting" invariants both break.
**Fix direction:** Scale the `withSession` budget by item count, or pass a deadline the loop checks each iteration and aborts cooperatively.

### S17 — Frontend refresh/mass/sell progress pollers die on the first transient error while the job keeps running; the completion re-pull never fires — MEDIUM · PROVEN · ✔ lead-verified
**Location:** `public/app.js:3361-3364` (refresh), `:4859-4862` (mass), `:5116-5119` (sell) — no reschedule; contrast the bounded `fbuyErr` retry at `:5613-5622`.
**Mechanism:** These setTimeout-chain pollers have no error retry: one failed status GET (a backend event-loop stall per S10, a socket blip, machine sleep) permanently stops polling; the completion path (`refreshActiveViewFromCache` / `watchPriceFill` / the failure panel) never runs, so inventories/balances silently stay pre-op.
**Trigger:** Any single status-fetch failure during a long fleet refresh/mass op.
**Blast radius:** Invisible running jobs + stale money-relevant views + a persistent error toast (feeds S22). An independent contributor to "stale until restart."
**Fix direction:** Give refresh/mass/sell the same bounded error-retry the fbuy poller already has.

### S18 — B36 orphaned-vault guard exists only on the headless path; the production sidecar unlock portal creates a fresh empty vault over an orphaned farm — MEDIUM · PROVEN · ✔ lead-verified
**Location:** `src/core/unlockPortal.ts:78` (`unlockOrCreate` with no orphan check) vs `src/core/vaultBoot.ts:97` (`looksLikeOrphanedVaultInstall()` gate, only in the `!isTTY` branch).
**Mechanism:** The orphan check (accounts.json with blanked passwords + missing `vault.enc`) gates creation only inside `unlockVault()`'s headless branch. The packaged app runs `IS_SIDECAR_MODE` → `runUnlockPortal()`, which calls `unlockOrCreate` with no such check; the interactive-CLI first-run branch also lacks it.
**Trigger:** `vault.enc` missing while `Vault/accounts.json` survives (partial restore, AV quarantine of `vault.enc`, unmounted drive) on the standard windowed install.
**Blast radius:** The portal shows "set a new password," the operator complies, an empty vault is created, and the whole farm appears credential-less with no signal that `vault.enc` was merely missing. Recoverable (the real `vault.enc` can be restored over the empty one; plaintext is never destroyed) but a silent farm-wide outage on the *primary* path.
**Fix direction:** Hoist the orphan check into `AccountVaultImpl.unlockOrCreate` (or call it from the portal/CLI create branches) with an explicit "create new empty vault anyway" confirmation.

### S19 — Reprice watch's no-progress stop is terminal and hides the indicator while the fill continues — MEDIUM · PROVEN
**Location:** `public/app.js:786-788` (mirror `src/pricing/repriceReconciler.ts:82`); progress counted only on success at `PricingService.ts:143-145`.
**Mechanism:** Progress is measured solely by `fetched`, which increments only on *successful* fetches; a name resolved via the error/429-exhaustion path advances the queue but not `fetched`. In a 429 storm each name can burn ~6–8 min of pauses, so two consecutive exhausted names exceed the 15-min budget while `busy` stays true → the watch stops permanently **and** dismisses the "Fetching prices…" badge though the backend fill is still running; nothing re-arms it.
**Trigger:** Sustained Steam 429/error storm >15 min during a large fill (the documented storm class).
**Blast radius:** UI shows stale/missing prices as final with no in-progress indicator — reproduces the original complaint on an unattended dashboard despite the fix.
**Fix direction:** Count error-resolved names as progress (a `processed` counter), and/or have the 30 s `watchSystemStatus` loop re-arm a dead watch when `/api/pricing/status` shows `running`.

### S20 — "Live Logs" button is dead in the packaged shell: the launcher POSTs `/api/app/open-logs` without the capability header — MEDIUM · PROVEN · ✔ lead-verified
**Location:** `public/index.html:1537-1538` (raw `fetch` + blocked `window.open`), `src/api/capability.ts:52` (every `/api/` POST is protected), `src/api/server.ts:298-301`.
**Mechanism:** `isProtectedRequest` returns true for the POST, so the inline fetch (no `X-SSIM-Cap`) 401s and is swallowed; `window.open` is blocked inside the Tauri webview. Neither path fires, so the shell never sees `SSIM_OPEN_LOGS` and no logs window opens. A fresh defect from the B26/P5 guard landing after this launcher was written.
**Trigger:** Clicking "Live Logs" in any packaged run — deterministic.
**Blast radius:** The operator's primary live-diagnostics surface is unreachable exactly during incidents, with zero feedback.
**Fix direction:** Exempt this side-effect-trivial endpoint from the capability guard, or send `window.__SSIM_CAP__` in the inline fetch.

### S21 — sig-fail deletes a sha-intact staged artifact and never blocks → 185 MB re-download every boot under a key-divergent/unsigned manifest — MEDIUM · PROVEN
**Location:** `src/licensing/Updater.ts:780-784` (`verify()` fail → `removeSync(file)`), C3 streak covers only self-test failures.
**Mechanism:** `verify()` conflates a digest mismatch (corrupt → delete is right) with sigKind absence/invalidity (byte-perfect file; re-downloading yields the identical failure). Because C3 only counts self-test failures, this class loops silently per boot forever.
**Trigger:** The §3.1-b stale-key landmine (the server S3 guard is **off by default**, `ssim-license-server/src/config.js:69`) or a manifest published without a valid sigKind.
**Blast radius:** 185 MB re-downloaded on every boot indefinitely; the version pins forever. (C4 telemetry does report `sig-fail`.)
**Fix direction:** Delete only on sha mismatch; keep the artifact on signature-only failure (the sha-keyed pre-check makes the next boot's re-verify network-free).

### S22 — Three undismissed error toasts permanently mute all subsequent notifications (unbounded queue) — MEDIUM · PROVEN
**Location:** `public/app.js:5673-5702` (`TOAST_MAX=3`; errors never auto-dismiss), emitters at `:4823-4827` (up to 5 at once), `:4740`/`:3274-3276` (routine "refresh already running").
**Mechanism:** Errors never auto-dismiss and occupy the 3 visible slots; every later toast — including buy/sell/trade confirmations — queues invisibly forever and `toastQueue` grows unbounded. Error bursts are routine.
**Trigger:** One overnight failure burst on a 24/7 machine.
**Blast radius:** The operator loses all subsequent op feedback until manually dismissing; slow memory growth.
**Fix direction:** Long TTL or de-dup/collapse for error toasts; cap the queue; downgrade the routine post-op 409 to a warn.

### S23 — `ensureLicensed`: a hung backend leaves a permanently blank UI; a transiently failing one triggers a reload loop that also wipes the capability token — MEDIUM · PROVEN · ✔ lead-verified
**Location:** `public/app.js:6117-6130` (no-timeout fetch; `location.replace('/')` on any failure), `public/index.html:16-17` (`ssim-locked` hides the app).
**Mechanism:** The status fetch has no `AbortSignal` — a backend that accepts but never answers keeps `init()` awaiting forever and the lock overlay never lifts: blank window, no message. On a *failed* fetch it redirects to `/`, which in sidecar mode is this same dashboard → a rapid reload loop, and each reload destroys `window.__SSIM_CAP__` (S1).
**Trigger:** Backend event-loop wedge (S8/S10) or brief unavailability at page load.
**Blast radius:** Blank app / reload spin; a capless session afterwards.
**Fix direction:** Timeout + a visible retry screen instead of `replace('/')`; distinguish "activation needed" (explicit `licensed:false`) from "unreachable."

### S24 — Vault-path token persist can throw inside steam-user's `refreshToken` emit → disk trouble during a fleet login becomes an uncaughtException burst that trips the money breaker — MEDIUM · PROVEN
**Location:** `src/core/SessionManager.ts:449-450` (`refreshToken` listener → `tokenStore.set`), `src/core/TokenStore.ts:104` + `src/core/AccountVault.ts:311-320` (first-mint synchronous `save()`).
**Mechanism:** The plaintext `TokenStore.save()` catches its own write errors, but the vault branch does not: `set` → `AccountVault.setToken` → synchronous `save()` → `writeJsonAtomic` throws (disk full, EACCES, AV lock) → the throw propagates out of the `refreshToken` listener through steam-user's internal `emit` → global `uncaughtException` → `ProcessHealth.recordUncaught`. During a mass first-login (fresh vault) with a disk problem, ≥3 in 60 s latches the money breaker until restart.
**Trigger:** Disk/AV trouble during a large first-login (fresh vault).
**Blast radius:** Money ops 503 until restart; the aborted emit can also stall that account's login.
**Fix direction:** try/catch inside `TokenStore.set`'s vault branch (or in `AccountVaultImpl.save()`), degrading to the plaintext path's warn-and-continue contract.

### S25 — `createdSession` ownership marker is one map keyed by account, shared across concurrent flows → can log out a session mid-fetch or leak one to the reaper — MEDIUM · PROVEN
**Location:** `src/core/InventoryService.ts:163,546-547,643-647,748-752`.
**Mechanism:** `runRefresh` and `refreshAfterTrade` both clear/set/read `createdSession[key]` for the same account with awaits in between; last-resume wins. Orderings exist where the post-trade worker reads the bulk worker's `true` and logs the shared session out while the bulk fetch is still paginating (fetch fails, account recorded failed), or `true` is overwritten by `false` so neither flow releases → the session leaks to the 30-min reaper (compounding S11).
**Trigger:** A trade completing (post-trade refresh of its two parties) while a fleet refresh passes the same accounts — routine.
**Blast radius:** Spurious per-account refresh failures + session churn; no data loss.
**Fix direction:** Return ownership through the call chain (a per-invocation local from `loginAccountOwned`) instead of a service-level map, or key the map by flow-id+account.

### S26 — `markOnline` stores the LOCAL clock as the rollback high-water mark → a forward-wrong clock while online permanently poisons offline grace — MEDIUM · PROVEN
**Location:** `src/licensing/LicenseClient.ts:151-154` (`nextClockMeta(readMeta(), Date.now(), true)`) vs `src/licensing/licenseClock.ts:44`.
**Mechanism:** C13 prevents anchor advance while *offline*, but a machine running with a clock years ahead **while heartbeats succeed** writes that future value into `maxSeenMs` on every beat. After the clock is fixed, an expired-token boot hits `now < maxSeenMs - skew → 'rollback-refused'` until real time catches up — the 72 h offline grace is dead for that machine (online activation still works → degraded, not bricked).
**Trigger:** A machine run with a badly-forward clock while online, then corrected.
**Blast radius:** Offline grace unavailable for that seat until wall-clock catches up.
**Fix direction:** Anchor to a server-reported timestamp in the heartbeat/validate response rather than the local clock.

### S27 — HWID drift via `firstMac()` interface-enumeration order → seat lockout needing owner intervention — MEDIUM · PROVEN
**Location:** `src/licensing/HwidService.ts:31-41`, server seat limit at `ssim-license-server/src/licenses.js:60`.
**Mechanism:** The first non-internal MAC changes when a VPN/hotspot/virtual adapter appears or NIC order shifts → HWID changes → stored token invalid → re-activate → the server sees a NEW hwid on a full seat → `seat_limit` 409 ("already bound to another machine") until the owner deletes the stale seat (admin-only). Same class when `machineIdSync` transiently fails (`'no-machine-id'` swaps a factor).
**Trigger:** Any adapter/order change on the operator machine.
**Blast radius:** Lockout requiring manual owner seat-deletion; no self-service.
**Fix direction:** Hash the *sorted set* of physical MACs (or drop MAC), and/or add a server-side seat-move flow.

### S28 — Mass-sell phantom-reconcile positional-index race across concurrent bots can silently relabel a genuine failure as recovered — MEDIUM · PROVEN
**Location:** `src/trading/MarketService.ts:465` (`idx: this.job.failed.length - 1`) + `:490-499` (reconcile writes through `f.idx`, then `filter`).
**Mechanism:** `failedHere` stores raw indices into the shared `this.job.failed`. With up to 25 concurrent `processBot` workers, bot A's reconcile filter reindexes the array while bot B awaits `getListedAssetIds()`; B then writes `__recovered__` through stale indices onto the wrong row, which the next filter drops — a genuine failure vanishes from the report and is counted as listed+recovered.
**Trigger:** Two bots with failed items finishing reconciliation near-simultaneously in a large mass-sell.
**Blast radius:** A dishonest mass-op report (the operator believes a failed listing exists / doesn't).
**Fix direction:** Mark recovered rows by identity (username+assetId), not positional index, or reconcile under a shared mutex.

### S29 — TF2 tab's first load queues a server-side price fill that nothing watches → TF2 prices stay "…" until an unrelated trigger — MEDIUM · PROVEN
**Location:** `public/app.js:463-477` (no `watchPriceFill` after the first `/api/inventory-tf2`), server enqueues at `src/api/server.ts:1224-1230`.
**Mechanism:** The GET enriches and calls `ensureFilled(missing)` server-side, but `setGame` never starts a watcher (boot/refresh/source-switch all do); with the boot fill drained there is no repull and not even the indicator.
**Trigger:** First CS2→TF2 toggle with a cold TF2 price cache.
**Blast radius:** Unpriced TF2 items and wrong worth totals until a TF2 refresh-all or restart.
**Fix direction:** `void watchPriceFill(refreshActiveViewFromCache)` after the first TF2 load, mirroring `init()`.

### S30 — No `window.onerror`/`onunhandledrejection`, and null-unsafe render paths: one malformed cached row silently breaks the table + search — MEDIUM · PROVEN (gap)
**Location:** `public/app.js` (no global handlers, grep-confirmed), null-unsafe derefs at `:2876`, `:386`.
**Mechanism:** An item record lacking `name`/`marketHashName` (a corrupt/legacy `inventories.json` entry survives load — the stores accept any JSON) throws inside filter/sort mid-`renderTable`; the exception escapes the DOM handler leaving a half-rendered view, and with no global error hook it surfaces nowhere (WebView2 has no visible console). Same class: an index.html/app.js id skew makes `bindStaticEvents` a silently dead app, and `init()`'s own rejection lands unhandled.
**Trigger:** One malformed cached row, or a markup/script skew after an edit.
**Blast radius:** Table/search unusable until the row is repaired; zero observability of the failure.
**Fix direction:** Add global `onerror`/`onunhandledrejection` → toast + POST to a backend log endpoint; coerce name fields in filter/sort.

### S31 — Server S3 key-guard pins only the PUBLIC key; a mismatched private/public pair boots "verified" and silently signs tokens no client accepts — MEDIUM · PROVEN
**Location:** `ssim-license-server/src/index.js:18-31` (fingerprint check), `src/keys.js:23-29`.
**Mechanism:** The fingerprint covers the public key's SPKI only; nothing at boot proves the loaded private key is its counterpart. Deploy production `public.pem` + a stale `private.pem`: S3 passes, S2 catches *manifests* at publish, but `token.sign` output fails the client-embedded key → activations fail and heartbeat token refreshes are silently discarded → seats decay to boot-time re-activation failures.
**Trigger:** A mismatched keypair deployed to the server.
**Blast radius:** Progressive fleet-wide activation/refresh failure that S2/S3 do not catch.
**Fix direction:** Boot self-check that signs+verifies a probe payload with the loaded pair.

### S32 — Interactive "live" single-account routes have no server or client timeout and queue behind a fleet refresh → indefinite modal spinners — MEDIUM · PROVEN (missing timeouts) / HYPOTHESIS (FIFO ordering)
**Location:** `src/api/server.ts:1774-1789,668-694,1901-1910,1251-1263` (await a live login), `public/app.js:423-439` (`api()` fetch has no `AbortSignal`).
**Mechanism:** orders/confirmations/trade-up-candidates/`?refresh=1` await a live login; per BACKEND_RELIABILITY §F7 the login gate is a FIFO semaphore (cap 25) shared with bulk refresh, so an interactive request lands behind hundreds of queued logins; with no client abort the spinner can sit for many minutes.
**Trigger:** Using a live feature during a fleet refresh.
**Blast radius:** Features look frozen; users re-click and enqueue more logins.
**Fix direction:** `AbortSignal.timeout` in `api()` + a fast 409/503-busy (or a priority lane) for interactive logins during a bulk refresh.

### S33 — `void`-launched installers/orchestrators have no rejection finalizer → an unexpected reject becomes an unhandledRejection (breaker tick) or latches `running:true` forever — MEDIUM · PROVEN (latent)
**Location:** `src/api/server.ts:2127` (`void installNow()`), `src/trading/TradeService.ts:546` / `BuyService.ts:333` / `MarketService.ts:235` (`void runMass…`), sink at `src/index.ts:297-304`.
**Mechanism:** `installNow` has only a `finally`; `runUpdate` can still throw from `verify()`/self-test spawn/`swapAndRelaunch`. The mass orchestrators, if they ever reject, never reach their trailing `running=false`. Either way the rejection escapes `void` → `writeCrash('UNHANDLED REJECTION')` + a `recordUncaught` tick (3 in 60 s latches the breaker), and a latched job type is refused until restart. No concrete trigger proven at HEAD (getSellInfo returns nulls, logoutAccount is async-catchable) — hardening.
**Blast radius:** Phantom crash-log entries polluting the R1 channel; worst case money ops 503 or a job-type wedged until restart — from an update button.
**Fix direction:** try/catch inside `installNow` (map to `setUpdateOutcome`); `.catch()` + finally-style finalization around each orchestrator body.

### S34 — Manual install is 202-then-silence: a failed install shows "installing…" forever and suppresses the update badge for the session — MEDIUM · PROVEN
**Location:** `public/app.js:798-806,816-819`; `src/api/server.ts:2122-2129`; `updateStatus.ts:98-105` (`updateStatusView` exists but is never wired to the status route).
**Mechanism:** The endpoint 202s before download/verify/self-test start; if the install keeps-current, nothing informs the page — `updateInstalling` never resets, and `/api/system/status` exposes no `lastUpdateOutcome`.
**Trigger:** Any failed user-confirmed install.
**Blast radius:** The operator believes an update is in flight; the update surface vanishes until reload; only server telemetry knows the truth.
**Fix direction:** Include `currentOutcome` in `/api/system/status`; reset `updateInstalling` when a later poll shows no ongoing install.

### S35 — B2 TokenStore degraded mode (new code): three residuals — no `.bak` restore attempted, false DEGRADED in vault installs, fresh tokens lost on restart — MEDIUM-LOW · PROVEN
**Location:** `src/core/TokenStore.ts:40-41,56-59,75-80,107-110`.
**Mechanism:** (a) Unlike the vault's B33, the degraded store never even *reads* `refresh_tokens.json.bak` — a valid backup sits beside the corrupt file while the operator is told to restore it by hand. (b) `load()` runs unconditionally even though production is mandatory-vault; a corrupt *leftover* plaintext file yields a permanent DEGRADED warning while persistence actually works via the vault (doubled by BanService's second instance). (c) Degraded `set()` keeps new tokens in-memory only → in plaintext/dev a token-only import while degraded loses its sole credential on restart.
**Trigger:** Corrupt/leftover `refresh_tokens.json`.
**Blast radius:** Operator-alarming false positive + an un-attempted risk-free recovery + (dev) token loss.
**Fix direction:** Attempt a read-only `.bak` parse before degrading; skip/soften the flag when `AccountVault.isEnabled()`; optionally side-write new tokens to a recovery file.

---

### LOW-severity register (grouped; each is a real defect with a location, lower frequency×damage)

**Data integrity / persistence**
- **S36 · `{ ...EMPTY }` shallow-spread aliases one shared `tokens` object** across every TokenStore that loads missing/degraded — cross-instance ghost tokens. `src/core/TokenStore.ts:16,50,59,71`. PROVEN (masked in vault mode). Fix: return a fresh `{version:1,tokens:{}}`.
- **S37 · `quarantinePlaintextFile` rewrites the kept-secrets file non-atomically** (`fsExtra.writeJsonSync`) in a module whose contract is "never delete the last copy." `src/core/vaultBoot.ts:293`. PROVEN. Fix: use `writeJsonAtomic`.
- **S38 · License `license.token` written non-atomically** (`writeFileSync`) while the unused `.json` sidecar is atomic → a power-cut during a heartbeat refresh corrupts the token → next offline boot locked out. `src/licensing/LicenseClient.ts:93-98`. PROVEN. Fix: temp+rename, or read the atomic sidecar first.
- **S39 · `DeliveredStore` write failure leaves dedup memory-only** → a crash then re-delivers a real Steam offer (the load-side gate doesn't cover write failure). `src/csfloat/CsFloatDeliveredStore.ts:64-68`. HYPOTHESIS. Fix: latch a persist-failing flag after N failures and pause delivery.
- **S40 · Server `version.json` written non-atomically on all three publish paths** → a crash mid-publish torn manifest → `/version` 500s → fleet silently stops updating. `ssim-license-server/src/admin.js:217,318,403`. PROVEN. Fix: temp+rename like `store.js`.
- **S41 · Wallet-event race resurfaces the funded→"—" tri-state symptom** for an account whose refresh commits before `'wallet'` fires (replaces the record without a wallet). `src/core/InventoryService.ts:307-312`. HYPOTHESIS. Fix: carry `prev?.wallet` forward when `session.wallet` is absent.

**Liveness / watchers / resources**
- **S42 · `watchPriceFill` against a dead backend polls forever with the "Fetching prices…" badge frozen** (the `continue` path skips the indicator; the no-progress clock only advances on success). `public/app.js:775,786`. PROVEN. Fix: count consecutive fetch failures toward the stop condition.
- **S43 · `PriceCache` rewrites the whole file (up to 100 k entries) every ~2 s for the duration of a fill** (each `set()` re-arms a 2 s debounce). `src/pricing/PriceCache.ts:75`. PROVEN. Fix: lengthen the debounce or flush every N sets.
- **S44 · FX refresh failure is not retried for 12 h** (single provider, no alternate) → the fallback/stale rate persists. `src/pricing/ExchangeRateService.ts:52-53,69-71`. PROVEN (display-only, provenance surfaced). Fix: short retry-with-backoff after a failed refresh.
- **S45 · `CsFloatClient` 429 retries hold the per-key single-flight slot** (retries run inside `limiter.schedule`, `maxConcurrent=1`) → interactive requests can't preempt background pricing during a storm. `src/csfloat/CsFloatClient.ts:148`. PROVEN. Fix: on 429, free the slot and re-schedule the retry as a new low-priority task.
- **S46 · `CsFloatAutoAcceptWorker.stop()` doesn't cancel the 5 s boot tick, and an in-flight pass races `teardownFullApp`** (a send can complete while shutdown proceeds, unwatched). `src/csfloat/CsFloatAutoAcceptWorker.ts:44,48`. PROVEN (no dedup violation). Fix: track/clear the boot timer; have `stop()` set a flag `runOnce` checks per account.
- **S47 · Unbounded diagnostic sinks** — `stderr-trace.log`, `crash-log.txt`, `exit-trace.log` are append-only with no cap/rotation (winston + mem-heartbeat *are* capped). `src/bootflags.ts:66-80`, `src/utils/crashlog.ts:50`. PROVEN. Fix: reuse memHeartbeat's `rollIfLarge`.

**Session / concurrency**
- **S48 · Re-license teardown doesn't await in-flight logins; `attemptLogin`'s retry loop re-inserts sessions into the discarded manager** → a late success parks an unmanaged live CM session + agent. `src/core/SessionManager.ts:646-650,339`. PROVEN (rare). Fix: a `shuttingDown` flag checked in `performLogin`, or await `loginsInFlight` in `logoutAll`.
- **S49 · B46 insertion-ceiling refusal is retried 5× inside `attemptLogin`** (~60 s backoff + 5 client/agent build-teardowns per refused login, holding a login slot) — a starvation amplifier exactly when the ceiling is saturated (compounds S11). `src/core/SessionManager.ts:409-417`. PROVEN. Fix: mark ceiling errors non-retryable within `attemptLogin`.
- **S50 · CS2 full refresh has no transient/429 retry layer** (parity gap vs the TF2/quick path's `REFRESH_RETRIES`) → one 429/blip fails the account for the whole pass → inflated `failed` counts at scale. `src/core/InventoryService.ts:247-248`. PROVEN. Fix: wrap the ctx2/ctx16 pair in the same bounded retry.

**Boot / updater / shell**
- **S51 · Shell death orphans the backend** — the backend reacts only to stdin `data`/`error`, never `end`; if the shell dies, the hidden backend keeps every Steam session + the CSFloat worker running while holding the port + single-instance lock → the next launch lock-screens with "already running" and nothing visible to close. `src/index.ts:68-76`. PROVEN. Fix: treat stdin `end`/EOF as a graceful-shutdown signal in sidecar mode.
- **S52 · A refused second instance deletes the LIVE instance's `data/ssim.port`** (every `exit` runs `clearStalePortFile()`). `src/index.ts:355-363`, `src/utils/serverPort.ts:35-37`. PROVEN (small: stdout handshake is primary). Fix: clear only if this process announced a port.
- **S53 · `check()` failure is reported as `up-to-date`** → the stranded-fleet histogram undercounts exactly the cohort it was built to find. `src/licensing/Updater.ts:110-117`. PROVEN. Fix: a distinct `check-fail` outcome.
- **S54 · `'lock'` (AV) failures count toward the permanent C3 block** (backoff ladder totals 7.2 s vs minute-scale AV scans) → three cold-AV boots ⇒ `SSIM_UPDATE_BLOCKED` for a condition the classifier itself calls transient. `src/licensing/Updater.ts:461,790-792`. PROVEN (mitigated by C1 reuse + force). Fix: exclude `'lock'` from the threshold or lengthen the ladder.
- **S55 · C2 worst-case boot delay** up to 240 s + 480 s self-test per boot for 3 boots before C3 blocks, splash frozen on one phase. `src/licensing/Updater.ts:427-428,499-508`. PROVEN (bounded; C1 preserves progress). UX note.
- **S56 · Shell self-test `.output()` has no own timeout** — a grandchild orphan that never exits can pin the shared self-test cache exe. `src-tauri/src/lib.rs:336-341`. PROVEN (mitigated by the updater's outer `execFileSync` timeout on the shell itself). Fix: bound the child.
- **S57 · Leftover 171 MB `.tmp` on a failed extraction rename** is not swept. `src-tauri/src/lib.rs:264-268`. PROVEN (minor disk). Fix: best-effort remove of stale `ssim-backend.exe.tmp*`.

**Licensing / server (low)**
- **S58 · `heartbeat()`/`validate()` call `readToken()` outside their try** → an AV-locked `license.token` turns a beat into an unhandledRejection (cadence can't trip the breaker; noise). `src/licensing/LicenseClient.ts:322-324`. PROVEN. Fix: move inside try.
- **S59 · `singleInstance` residual lockouts** — a recycled live PID whose image can't be determined (tasklist blocked/timeout → `''`) is refused fail-safe; the non-EEXIST IO retry loop has no sleep so its "bounded retries for a transient AV lock" all elapse in ms. `src/core/singleInstance.ts:50-54,76-87`. PROVEN (PID-reuse *false-reclaim* is correctly prevented). Fix: add a small sleep; soften the undetermined-image case.
- **S60 · Server write amplification** — every heartbeat/validate = full-DB parse + `.bak` copy + rewrite; fine single-process now, silent lost-update under any future multi-instance deploy. `ssim-license-server/src/licenses.js:83-96`. PROVEN. Fix: note the single-instance constraint; batch or lock before scaling out.

**Trading (low)**
- **S61 · Update badge installs-and-restarts on a single unconfirmed click**, bypassing the `ssimConfirm` convention. `public/app.js:823-825`. PROVEN. Fix: `ssimConfirm("SSIM will restart")` first.
- **S62 · `/api/app/check-update` is the only raw `async (req,res)` route** (no `asyncHandler`) — latent hanging-request/unhandledRejection class if `checkOnly` ever loses its self-catch. `src/api/server.ts:2122`. PROVEN (latent). Fix: wrap in `asyncHandler`.
- **S63 · `isAlreadyListed` German/substring overbreadth** (`aktiv|already|listed` as bare tokens) can classify a non-phantom rejection as "listed" → wrong Owned→Listed bucket. `src/trading/MarketService.ts:45-50`. PROVEN (no money movement). Fix: require compound matches.
- **S64 · Unknown wallet-currency code silently falls back to 2 decimals** → a 0-decimal currency mis-scales per-item price 100×. `src/pricing/currencies.ts:74-76` + `src/trading/BuyService.ts:444-445`. HYPOTHESIS (bounded by wallet balance + ceiling; EUR-region fleet). Fix: fail closed when `STEAM_CURRENCIES[code]` is absent on any money path.
- **S65 · `cleanBrowser` relay is an unauthenticated loopback open-proxy** carrying the account's proxy credentials while the window is open. `src/trading/cleanBrowser.ts:173-175,236`. PROVEN (local-trust only; the *known field failure* — domain-cookie logout + missing proxy auth — is FIXED at HEAD, `:42,:121-127`, live-verify pending). Fix: per-launch secret token or PID-pin the relay client.
- **S66 · Non-USD/EUR wallets contribute 0 to the worth-history curve** (FX covers only USD↔EUR). `src/core/ValueHistoryService.ts:189-193`. PROVEN (display trend only). Fix: convert via a rate table or mark the point partial.
- **S67 · Worth-curve points recorded mid-fill permanently capture undercounted totals** (snapshot on refresh completion, before the price fill drains). `src/core/ValueHistoryService.ts:177-178`. PROVEN (cosmetic chart dips). Fix: snapshot/coalesce when the fill drains.

---

## PRIORITIZED REMEDIATION PLAN

Ordered by reliability impact per unit effort, grouped into waves. A later pass implements; this only sequences. Each wave is independently shippable and testable. **Preserve the owner constraints throughout:** no auto-restart band-aids, keep-current update-guard semantics, the money-path never-throw-after-placement contract, and the buy finalize re-POST (do-not-touch).

### Wave 0 — Unblock + see (tiny changes, highest coverage, do first)
1. **S1 cap-token delivery** — `sessionStorage` stash + `capToken()` fallback; attach via `initialization_script` on the splash window in addition to the eval; render a "restart required" banner on `capabilityRequired`. *Removes a total-write-outage-on-reload class.*
2. **S20 Live Logs** — exempt `/api/app/open-logs` from the capability guard (or attach the token in the inline fetch). *Restores the primary diagnostics surface.*
3. **S30 global error hooks** — add `window.onerror`/`onunhandledrejection` → toast + backend log endpoint; coerce name fields in filter/sort. *Prerequisite for seeing everything else in the field.*

### Wave 1 — Data integrity: never commit partial-as-truth, never clobber the last good copy (P-A / P-B)
4. **S2 pricing error-miss vs no-price** — short-TTL (or no-cache) for error/429-exhaustion misses; 24 h only for a 200/success no-price. *Retires the recurring staleness complaint.*
5. **S4 inventory per-context coercion** — `fetchRaw` returns explicit `ok:false` for a coerced-empty page-0; apply the reconcile-don't-commit guard per context. *Retires the item-state-divergence field failure.*
6. **S5 vault `.bak` clobber** — save with `backup:false` in the B33 recovery branch. **S12 CsFloatKeyStore** + **S39 DeliveredStore-write** + **S35 TokenStore `.bak`-restore** — extend the present-but-unreadable ⇒ degraded/no-clobber pattern to every remaining store; add a one-time repo-wide audit that every `writeJsonAtomic(..., backup:true)` caller cannot be reached with a known-bad in-memory state.
7. **S7 license-server revocation** — only send `{status:'revoked'}` for a record that exists and is revoked; treat `not_found`/empty-db as non-authoritative (clients ride grace); add a zero-seat self-guard. *(server repo)*

### Wave 2 — Money-path correctness (highest damage per event)
8. **S3 journal double-spend** — classify transport-ambiguous commit errors and skip `resolve()` (or `record('unknown')`) so the retry hits refuse-once. **S15 refuse-once** — keep the entry with a min-age / explicit `force` before consuming.
9. **S6 steam-totp hang** — timeout every `getTimeOffset` call site (~10 s → `off=0`) and cache the offset per process.
10. **S14 install busy-gate** — add `busy()` to Market/TradeUp/Casket, OR into `isBusy`, and re-check before the swap. **S16 GC casket budget** — scale by item count / cooperative deadline. **S28 mass-sell reconcile** — match by identity, not positional index.

### Wave 3 — Liveness, watchers, and event-loop cost (P-D / P-E / S10)
11. **S10 `/api/inventory`** — ETag/304 or delta; bound the repull cadence (≥10 s); patch prices into existing state instead of full refetch+rerender.
12. **S17 / S19 / S29 / S42 watchers** — bounded error-retry for refresh/mass/sell pollers; count error-resolved names as progress and re-arm a dead watch from status; start a watcher on first TF2 load; fail the price-fill badge on repeated backend failure.
13. **S23 ensureLicensed / S32 interactive routes / S33 void-launched** — client-side `AbortSignal.timeout` + a visible retry screen; interactive fast-fail during bulk refresh; try/catch + finalizers around `installNow` and the mass orchestrators.
14. **S22 toasts** — error TTL/dedup + queue cap; downgrade the routine post-op 409 to warn.
15. **S11 zombie sessions** — reap `DISCONNECTED`/`ERROR` with the replacement guard (also relieves S49). **S24 vault token emit** — try/catch the vault `save()` path. **S25 createdSession** — thread ownership through the call chain.

### Wave 4 — Updater / boot / license resilience
16. **S8 mid-session install freeze** — async `execFile`/worker, or stage-for-next-boot. **S9 swap-fail loop** — swap-failure marker → counter → block + surface. **S21 sig-fail** — keep the sha-intact artifact; don't re-download.
17. **S26 clock anchor** — anchor offline grace to a server timestamp. **S27 HWID** — sorted MAC set + a server seat-move flow. **S31 server keypair probe** — sign+verify at boot. **S34 install status** — expose `lastUpdateOutcome` on `/api/system/status`.
18. **S51 shell-death orphan** — treat stdin EOF as graceful shutdown in sidecar mode.

### Wave 5 — Long tail (batch as capacity allows)
19. The remaining LOW items (S36–S67 not already pulled forward): atomic-write hygiene (S37/S38/S40), diagnostic-log rotation (S47), FX/rate-limit/cache-churn polish (S43/S44/S45/S46), boot/lock edge cases (S52/S53/S54/S56/S57/S58/S59/S60), and the trading LOWs (S61/S62/S63/S64/S65/S66/S67). Group by file to minimise churn.

### Not a code fix — keep on the standing list
- **R1 (0xC0000409):** WER LocalDumps on the production machine remains the decisive instrument; nothing in this sweep reclassifies it. Do not add a restart wrapper.
- **R2 (visibility):** the C4 telemetry rider + B1 crash marker land the missing half; S34/S53 make update outcomes actually measurable.

---

## SUBSYSTEM COVERAGE CHECKLIST

| Subsystem | Depth | Notes |
|---|---|---|
| Tauri/Rust shell (`src-tauri/src/lib.rs`) | **Deep (lead)** | Full read: cap-injection race (S1), shell-death orphan (S51), self-test child (S56), `.tmp` leftover (S57), extraction/crash/handshake paths. |
| Boot / lifecycle / shutdown (`src/index.ts`, `serverPort`, `singleInstance`, `bootflags`) | **Deep** | Boot chain, port bind-then-announce, safety nets, teardown, exit-trace verified; S51/S52/S59/S47. |
| SessionManager / LoginFlow | **Deep** | Login semaphore, ceiling, reaper, zombie class (S11), retry amplifier (S49), teardown race (S48). |
| Inventory (Manager/Service/Store) | **Deep** | Per-context coercion (S4), createdSession race (S25), wallet tri-state (S41), CS2 retry gap (S50); merge/partial guards verified. |
| Vault / TokenStore / vaultBoot / AccountManager / import | **Deep** | `.bak` clobber (S5), orphan-guard bypass (S18), token-emit throw (S24), degraded residuals (S35), `{...EMPTY}` alias (S36), quarantine atomicity (S37); migration idempotency verified. |
| Trading — Trade/Buy/Market/MoneyOps/AccountTrader-around/confirmations/GC/Casket/TradeUp/Ban/cleanBrowser | **Deep** | Journal blind-spot (S3), refuse-once (S15), totp hang (S6), GC budget (S16), mass-sell race (S28), busy-gate (S14); createBuyOrder audited-around per constraint. |
| Pricing (Service/Cache/sources/FX/reprice) | **Deep** | Poison-miss (S2), source-flip queue poison (S13), reprice terminal stop (S19), cache churn (S43), FX retry (S44). |
| CSFloat (Client/Service/RateLimiter/Worker/DeliveredStore/KeyStore) | **Deep** | KeyStore clobber (S12), DeliveredStore write-fail (S39), worker stop gaps (S46), 429 slot-hold (S45). |
| Network (AgentFactory / LocalIpThrottle) | **Deep** | Quiescent-retire invariant re-verified (matches `storm2` clean); no new leak. |
| API server (`src/api/server.ts`, originGuard, capability) | **Deep (money/inventory/status/new-banner + guards); Partial (full route-by-route)** | asyncHandler coverage, SSE, breaker gating verified; `/api/inventory` cost (S10), Live Logs (S20), check-update raw route (S62). |
| Frontend (`public/app.js` + html) | **Deep** | Cap handling (S1/S23), pollers (S17/S19/S29/S42), toasts (S22), render safety (S30), install UX (S34/S61); `index.html` static modal markup only grep-sampled. |
| Auto-updater (`Updater.ts` + scheduler + status) | **Deep** | New C1/C2/C3/C5 code: freeze (S8), swap loop (S9), sig-fail (S21), lock-block (S54), C2 delay (S55), check-fail outcome (S53), scheduler races HELD. |
| Licensing (LicenseClient/licenseClock/config/HwidService/Activation/unlockPortal) | **Deep** | Revocation-body trust (S7 client side), clock anchor (S26), HWID drift (S27), token atomicity (S38), readToken placement (S58). |
| License server (`ssim-license-server`) | **Deep** | Empty-db revocation (S7), keypair probe (S31), version.json atomicity (S40), write amplification (S60); S1/S2/S4 new code HELD except these. |
| Observability (logger/crashlog/memHeartbeat/exit-trace) | **Deep** | winston rotation OK; unbounded sync sinks (S47); telemetry rider verified. |

## NOT REACHED (and why)
- **`src/api/server.ts` full route-by-route (~2100 lines):** money, inventory, status, and new-banner routes were deep-read + the async-handler/guard middleware verified; the remaining CSFloat/confirmations-panel/admin routes were sampled, not line-audited. Residual risk is bounded by the verified global error middleware + capability/breaker gates.
- **`public/index.html` lines ~24–1505 (static modal markup):** audited via targeted greps only; an id/markup↔app.js skew would surface as the S30 silent-death class.
- **Vendor internals** (`steam-user`, `steamcommunity`, `steam-tradeoffer-manager`, `https-proxy-agent@5`, `socks-proxy-agent@6`): checked only at the specific call/timeout paths cited (S6 totp, request timeouts); not a full dependency audit.
- **License server `admin-auth.js` / `bot-api.js` / brute-force posture:** security-scope, out of this reliability sweep.
- **0xC0000409 native mechanism:** unchanged — needs a WER LocalDump on a real recurrence; `storm2.js` is now clean, so no in-code reproduction exists to audit further.
- **Live behaviour** (real Steam one-order-per-item semantics used to scope S3's blast radius; the cleanBrowser HEAD fix in S65) is from domain knowledge / code state, not runtime-verified — flagged inline where it matters.
