# REMEDIATION_LOG_2.md — S1–S67 stability remediation

Per-issue log for the autonomous remediation of `STABILITY_ISSUES.md` (S1–S67).
One entry per issue: **What / Why / Files / Tests / Status**. One commit per FIXED issue.

**Green baseline (HEAD = `bc25229`, branch `fix/reliability-remediation`):**
`npm run build` clean · client `npm test` = **197 pass / 0 fail** · `cargo check` clean ·
server `npm test` = **39 pass / 0 fail**.

Status legend: **FIXED** (committed + test + log) · **SKIPPED (already addressed / unconfirmed)** · **BLOCKED** (reverted + reason).

---

## Wave 0 — Unblock + see

### S1 — Capability token lost on any reload → whole write surface 401s — **FIXED**
- **What:** `capToken()` (public/app.js) now stashes `window.__SSIM_CAP__` into `sessionStorage`
  on first sight and falls back to it, so the per-run money/config token survives any in-webview
  reload for the process life (sessionStorage is per-origin → no stale token across runs/ports).
  `api()` renders a dedicated "restart required" banner on a `capabilityRequired` 401 instead of a
  bare toast. The shell (lib.rs) re-seeds the token twice (600 ms / 1800 ms) after `navigate` so it
  reliably lands in the committed dashboard document, closing the S1b pre-commit eval race. Guard
  error string changed from "Reload SSIM" → "Fully restart SSIM" (the register flags reload advice
  as harmful; a reload cannot re-mint the token).
- **Why:** the token existed only as an in-memory global set by a one-shot post-navigate eval; any
  reload (F5 / WebView2 renderer recovery / S23 `location.replace`) dropped it, 401ing every
  POST/PUT/PATCH/DELETE until a full restart while reads kept working (app looked healthy).
- **Deviation from fix direction:** the register suggested an `initialization_script` on the
  splash-built window, but the token is minted by the backend and arrives on stdout AFTER the splash
  window is built, so no token-bearing init script can be set at build time. Achieved the same goal
  (survive navigation + reload) via sessionStorage persistence + a post-commit re-eval instead.
- **Files:** `public/app.js` (`capToken`, `api`, `renderCapabilityBanner`), `src-tauri/src/lib.rs`
  (delayed re-seed), `src/api/capability.ts` (advice string).
- **Tests:** `test/capabilityTokenDelivery.test.ts` — extracts the shipped `capToken` and asserts
  stash-on-receipt, recover-after-reload (fails against the old one-liner), empty-when-absent, and
  private-mode-no-throw. Shell re-eval is runtime-shaped → `cargo check` + reasoned argument.
- **Status:** FIXED. build clean · 201 tests (+4) · cargo clean.

### S20 — "Live Logs" button dead in the packaged shell — **FIXED**
- **What:** Exempted the side-effect-trivial `POST /api/app/open-logs` from the capability guard
  (`isProtectedRequest`), so the Live Logs button reaches the handler (which signals the shell to
  open the logs window) without a token. `window.open` is blocked in the webview, so the fetch was
  the only working path and the guard was 401ing it.
- **Why:** the B26/P5 capability guard landed after this launcher was written; every `/api/` POST
  became protected, so the tokenless inline fetch 401'd and was swallowed → the operator's primary
  diagnostics surface was unreachable exactly during incidents. Exempting (vs. attaching the token)
  is correct: the endpoint only opens a READ-ONLY logs window (the stream is already public) and
  diagnostics must not depend on the token, which may be the thing that's missing.
- **Files:** `src/api/capability.ts` (`OPEN_POST_EXEMPT`).
- **Tests:** `test/capabilityToken.test.ts` — open-logs is unprotected + guard nexts it tokenless;
  `check-update` and a `open-logs-evil` lookalike stay protected (exact, no prefix bypass).
- **Status:** FIXED. build clean · 202 tests (+1) · guard behaviour otherwise unchanged.

### S30 — no global error hooks + null-unsafe render → one bad row breaks the table silently — **FIXED**
- **What:** (a) Coerced the name fields in the two crash sites — `compareItems` name sort
  (`(a.name||'').localeCompare(b.name||'')`) and the search filter (`(i.name||'')` /
  `(i.marketHashName||'')`). (b) Added global `window` `error` + `unhandledrejection` handlers
  (`reportUiError`) that toast the operator AND POST to a new `/api/app/client-error` sink (bounded,
  coalesced, never throws). (c) The sink logs via winston (`[ui] …`) so it shows in Live Logs /
  shell.log; exempted from the capability guard so it works while the UI is broken/capless.
- **Why:** the stores accept any JSON, so a corrupt/legacy row lacking `name`/`marketHashName` threw
  inside filter/sort mid-`renderTable`, escaped the DOM handler, and left a half-rendered view — and
  with no global hook (WebView2 has no visible console) the failure surfaced nowhere.
- **Files:** `public/app.js` (coercions + `reportUiError` + handlers), `src/api/server.ts`
  (`/api/app/client-error`), `src/api/capability.ts` (exemption).
- **Tests:** `test/renderNullSafety.test.ts` — extracts the shipped `compareItems`, proves the name
  sort tolerates missing names (throws on the old code) yet still orders normally;
  `test/capabilityToken.test.ts` — client-error sink is exempt + nexted tokenless, no substring bypass.
- **Status:** FIXED. build clean · 205 tests (+3).

**Wave 0 boundary re-check:** build clean · 205 tests · cargo clean (S1). ✔

---

## Wave 1 — Data integrity (never commit partial-as-truth / never clobber last-good)

### S2 — transient fetch errors cached as authoritative 24h "no price" that survives restart — **FIXED**
- **What:** Distinguished miss kinds. `SteamPriceSource` now THROWS `FETCH_FAILED_<status>` on a
  non-200 / missing-body / `success!==true` response (it previously returned null, conflating a
  fetch failure with an authoritative "no price"); it returns null ONLY for a genuine 200+success
  no-price. `PricingService` caches error-misses (429-exhaustion + any thrown fetch failure) with a
  `soft:true` flag and a short 10-min TTL (`ERROR_MISS_TTL_MS`), via a centralized `isFresh()` used
  by both `priceCents` and `enrich`; authoritative no-prices keep the 24h TTL. `PriceEntry.soft`
  round-trips through `prices.json`, so an old soft miss loaded after restart reads as stale → re-fetch.
- **Why:** any proxy RST / DNS-down / Steam 5xx wrote `{cents:null}` at the 24h TTL, persisted, so the
  item stayed unpriced and missing from totals for 24h AND across restart — the residual "v1.3.4
  staleness fix didn't work" path. CSFloat's source already threw on transport errors, so it's fixed
  for free by the caller change.
- **Files:** `src/pricing/sources/SteamPriceSource.ts`, `src/pricing/sources/PriceSource.ts` (doc),
  `src/pricing/PriceCache.ts` (`soft` field + `set` opts), `src/pricing/PricingService.ts`
  (`ERROR_MISS_TTL_MS`, `isFresh`, soft error-misses).
- **Tests:** `test/pricingErrorMiss.test.ts` — source throws on 5xx/success:false (was null), null only
  for authoritative no-price, soft miss expires in minutes while an authoritative null holds 24h, soft
  flag attaches only to a null miss. Existing pricing tests unchanged (2-arg `set` still valid).
- **Status:** FIXED. build clean · 209 tests (+4). Display-integrity only (mass-buy uses the wallet).

### S4 — per-context empty-coercion commits a half-merged CS2 inventory as complete — **FIXED**
- **What:** `InventoryManager.fetchRaw` now distinguishes an AUTHORITATIVE empty inventory (Steam
  answered `success:1` with zero assets) from an UNUSABLE page-0 body (null / HTML error page /
  `{success:false}` / `{success:0}` / `{}`). On page 0 an unusable body THROWS a fetch failure
  instead of coercing to a "successful empty inventory". Later-page behaviour is unchanged (a break
  still preserves already-fetched pages, #33).
- **Why:** `doRefreshOneViaGc` fetches ctx2 (owned) and ctx16 (trade-locked/listed) separately; the
  both-empty retry and rawCount reconcile only trip when BOTH are zero. A coerced-empty on ONE context
  (while the other had items) left rawCount>0 → the merge committed as authoritative, silently dropping
  every trade-locked/listed item — the item-state divergence, and it weakened the send-side trade-lock
  guard. Throwing makes a per-context failure fail the whole pass (caller records it, cache preserved) —
  strictly safer than the silent empty. This IS the "reconcile-don't-commit per context" guard: an
  unusable context can never become a zero-length context that merges silently.
- **Care:** touches inventory correctness feeding the send-side lock guard. Verified callers are
  throw-aware (`job.failed.push` at the bulk level; the quick/TF2 path already handles fetchRaw throws
  for 403/429/5xx). A legit-empty account returns `success:1` → still returns empty (no throw). A
  private/errored context now surfaces as failed instead of silently empty — more correct.
- **Files:** `src/core/InventoryManager.ts`.
- **Tests:** `test/inventoryPerContextCoercion.test.ts` — unusable page-0 bodies throw; success:1+zero
  returns authoritative empty; populated response still returns assets. Existing B31/refresh guard tests
  (mock above fetchRaw) unaffected.
- **Status:** FIXED. build clean · 212 tests (+3). (Build gate caught a `success===true` type error —
  Steam's `success` is numeric — corrected to `===1`.)

### S5 — vault .bak recovery clobbers the good backup with the corrupt main → total credential loss — **FIXED**
- **What:** `save()` gained an optional `{ backup?: boolean }` (default true, all existing callers
  unchanged). The B33 recovery branch now calls `this.save({ backup: false })`, so it writes the
  recovered healthy `vault.enc` atomically WITHOUT first copying the still-corrupt `vault.enc` over the
  proven-good `vault.enc.bak`.
- **Why:** the default `backup:true` copies the CURRENT on-disk file (still corrupt during recovery)
  over `.bak` before the temp→rename; a crash / power-loss / AV-block in that window left BOTH files
  corrupt → next boot both fail GCM → `WRONG_PASSWORD` → the whole farm's passwords + maFiles + tokens
  gone (vault has no recovery by design). With `backup:false` the good `.bak` is untouched: a crash
  mid-recovery leaves `vault.enc` corrupt but `.bak` good → the next boot re-recovers. No window.
- **Care:** irreversible-loss path — verified the fix by reintroducing the bug (`backup:true`) and
  confirming the new S5 test FAILS, then restored. All other `save()` calls keep the one-generation
  backup.
- **Files:** `src/core/AccountVault.ts`.
- **Tests:** `test/vaultHardening.test.ts` (S5) — after recovering from `.bak`, the `.bak` still
  decrypts to the good credentials (reads it as a primary vault); fails against the old `backup:true`.
- **Status:** FIXED. build clean · 213 tests (+1).

### S12 — CsFloatKeyStore silently resets on corrupt file, then clobbers file + .bak — **FIXED**
- **What:** Mirrored the B2 TokenStore degraded pattern in `CsFloatKeyStore`: a PRESENT-but-unreadable
  or wrong-shape `csfloat_keys.json` now sets a `degraded` flag, `save()` becomes a no-op (never
  clobbers the file or its `.bak`), the path is injectable for tests, and `isDegraded()` is masked in
  vault mode (keys read from the vault → a corrupt leftover file is irrelevant). Surfaced via
  `CsFloatService.isKeyStoreDegraded()` → `csfloatKeyStoreDegraded` on `/api/system/status` →
  `renderCsFloatKeyStoreWarning` banner.
- **Why:** the old `catch → return empty` silently reset the store; the next `set()/delete()` saved
  with `backup:true`, copying the corrupt file over the good `.bak` then writing the near-empty state —
  both recovery paths destroyed. All CSFloat keys vanish → pricing falls back to Steam and the
  auto-accept worker silently skips every account.
- **Files:** `src/csfloat/CsFloatKeyStore.ts`, `src/csfloat/CsFloatService.ts`, `src/api/server.ts`
  (status), `public/app.js` (warning + `watchSystemStatus` wiring).
- **Tests:** `test/csfloatKeyStoreDegraded.test.ts` — corrupt/wrong-shape → degraded, missing/empty-valid
  → not, valid loads, degraded set() leaves the file+`.bak` untouched, healthy persists. (7 tests.)
- **Status:** FIXED. build clean · 220 tests (+7).

> **Note — flaky test FIXED (test-hygiene, not an S-item):** `updaterEacces.test.ts:51` "pipeToFile …
> KEEPS the partial file" raced the async write-stream open against a nextTick source-destroy, so `dest`
> was sometimes not yet created when checked. Fixed by seeding a prior-attempt partial on disk so the
> "not deleted" assertion is deterministic (still catches a real delete-on-error regression). Verified
> 5/5 stable. Committed separately from the S-series.

### S39 — DeliveredStore write failure leaves dedup memory-only → crash re-delivers a real offer — **FIXED**
- **What:** `add()` now counts consecutive persist failures and latches `degraded=true` after N=3, so
  the worker's existing per-pass `isDegraded()` gate PAUSES auto-delivery. A successful write resets the
  streak (a `writeJsonAtomic` re-persists the FULL id list, so a transient blip self-heals).
- **Why:** the load-side degraded gate only covered a boot-time corrupt file. A RUNTIME write failure
  (disk full / EACCES / AV lock) left the just-delivered id in memory only; a crash + restart then
  reloaded a file missing that id → `isDegraded()` false → the sale got a SECOND real Steam offer.
  Latching after N bounds how many un-persisted deliveries can accumulate before delivery halts.
- **Care:** money-adjacent (real Steam offers). The offer is already sent when `add()` runs, so the
  latch can't un-expose ids already delivered-but-unpersisted this run — it caps the count and stops
  further exposure, which is the achievable guarantee (matches the register's "after N failures").
- **Files:** `src/csfloat/CsFloatDeliveredStore.ts`.
- **Tests:** `test/csfloatDelivery.test.ts` (S39) — 3 consecutive failures latch degraded; a mid-streak
  success resets it and persists the buffered ids.
- **Status:** FIXED. build clean · 222 tests (+2).

### S35 — TokenStore degraded-mode residuals (no .bak recovery / false vault-mode DEGRADED / dev loss) — **FIXED**
- **What:** (a) `load()` now attempts a read of `refresh_tokens.json.bak` before degrading — if the
  backup is a valid token file it recovers those tokens AND repairs the corrupt main from it, writing
  with `backup:false` so the corrupt main is never copied over the good `.bak` (reusing the S5 lesson).
  Only a missing/invalid `.bak` (or a failed repair write) degrades. (b) `isDegraded()` is masked in
  vault mode (`&& !AccountVault.isEnabled()`), killing the false DEGRADED warning from a corrupt leftover
  plaintext file (and silencing BanService's 2nd instance).
- **Why:** the degraded store never read the `.bak` sitting right next to the corrupt file (manual
  recovery for something the vault auto-recovers in B33); and it raised a permanent DEGRADED alarm in
  vault mode where persistence actually works via the vault.
- **Scoped out (optional):** residual (c) — side-writing new tokens to a recovery file during degraded
  PLAINTEXT mode so a token-only import isn't lost on restart. The register marks it optional and it is
  dev/plaintext-only (production is mandatory-vault). Left as a noted, low-value follow-up.
- **Files:** `src/core/TokenStore.ts`.
- **Tests:** `test/tokenStoreDegraded.test.ts` (S35a/b) — corrupt main + valid .bak recovers & repairs
  (bak intact); corrupt main + corrupt .bak degrades; vault mode masks the flag. All B2 tests still pass.
- **Status:** FIXED. build clean · 225 tests (+3).

### S7 — license-server empty/unknown store → authoritative fleet-wide revocation — **FIXED** *(server repo)*
- **What:** *(ssim-license-server, branch `fix/reliability-remediation`, commit `3941f2e`)* `seatStatus`
  now returns `indeterminate` for a zero-license store (misdeploy self-guard) and `not_found` for an
  unknown key OR a missing activation record — both NON-authoritative. `/heartbeat` and `/validate` send
  the authoritative `{status:'revoked'}` marker ONLY for a real revocation (`lic.status==='revoked'`,
  `act.revoked`) or expiry; every non-authoritative result answers **503** with no marker.
- **Why:** a misdeploy / detached persistent disk yields a valid-but-EMPTY `db.json` → every seat
  `not_found` → the handlers answered `{status:'revoked'}` → the client's `handleRevoked` tore down all
  Steam sessions + `clearToken()` **fleet-wide within one heartbeat interval**. The client already treats
  `{status:'revoked'}` as the ONLY teardown trigger and rides the 72h offline grace on any non-200/503,
  so a **server-only** fix suffices — NO client change (kept S7 purely server-side per its classification).
- **Care:** cross-repo, catastrophic. Explicit admin revocation (`revokeKey`/`revokeSeat`) stays instant
  and authoritative; only data-loss artifacts (unknown key / gone activation / empty store) became
  non-authoritative. A deleted activation becomes a grace-window (delayed) kick rather than instant —
  acceptable, and the explicit `revoked=true` kick remains instant.
- **Files:** `ssim-license-server/src/licenses.js`, `src/server.js`.
- **Tests:** `ssim-license-server/test/reliability.test.js` — S7 unit ×5 (unknown key / missing
  activation → not_found; explicit license + machine revocation stay authoritative; empty store →
  indeterminate) + an **e2e**: activate → empty the store → `/heartbeat` returns **503**, not 403/revoked.
- **Status:** FIXED. server `npm test` = **45 pass / 0 fail** (+6). Client untouched.

**Wave 1 boundary re-check:** client build clean · client 225 tests · cargo clean · server 45 tests. ✔

> **Field confirmations (user, 2026-07-04):** running 1.3.4 live-confirmed **S1** ("Open in Browser" →
> "Missing/invalid capability token") and **S20** ("Live Logs doesn't work") — both fixed on this branch,
> need a 1.3.5 release to reach the field. Pricing slowness = throttle-bound + S2/S13/S19. New **S68**
> added to the register: the floating Live Logs button (`z-index:99999`) renders above toasts/modals/the
> capability banner — obscures alerts (incl. my S1/S12 banners). Queued for Wave 5.

---

## Wave 2 — Money-path correctness

### S3 — MoneyOpJournal consumed on a network-ambiguous commit failure → retry double-spends — **FIXED**
- **What:** New `src/trading/commitAmbiguity.ts` `isAmbiguousCommitFailure(err)` classifies a commit
  failure as transport-ambiguous (the order/offer may already be on Steam) — `verifyBeforeRetry` (buy),
  or a transport signal (ECONNRESET/timeout/socket hang up/EPIPE/aborted) with NO `eresult`. `BuyService`
  (`createBuyOrder().catch`) and `TradeService` (inner `sendTrade` catch) set a `commitMayHaveLanded`
  flag on such a failure, and the `finally` SKIPS `journal.resolve` when it is set → the entry lingers →
  the next attempt hits the refuse-once gate instead of firing a second real order/offer.
- **Why:** `resolve()` ran in the `finally` on EVERY exit, so a thrown transport-ambiguous commit failure
  (the common field storm — ECONNRESET on the response leg where the order landed but the probe threw
  `verifyBeforeRetry`) consumed the entry → a retry double-spent real money. Only a hard process death
  left an entry, so the dedup protected the rarest case, not the common one.
- **Constraint:** `AccountTrader.ts` is NOT in the diff (grep-proven) — the classifier only READS the
  error `createBuyOrder`/`sendTrade` already throw; the finalize re-POST is untouched. The never-throw
  -after-placement contract is preserved (the `.catch` re-throws pre-placement failures only; once
  `order.placed`/`record('placed')`, the post-order block still never throws out). Bias = when unsure,
  ambiguous (a false "check Steam then retry" is cheap; a false "safe" double-spends).
- **Files:** `src/trading/commitAmbiguity.ts` (new), `src/trading/BuyService.ts`, `src/trading/TradeService.ts`.
- **Tests:** `test/commitAmbiguity.test.ts` (classifier: verifyBeforeRetry/transport → ambiguous, eresult
  / plain rejection / null → not); `test/moneyOpJournalWiring.test.ts` (S3: ambiguous commit KEEPS the
  entry, verifyBeforeRetry keeps it, a definite eresult rejection resolves it).
- **Status:** FIXED. build clean · 232 tests (+7).

### S15 — refuse-once consumed synchronously → a double-click after crash-restart double-fires — **FIXED**
- **What:** New `MoneyOpJournal.consultRefusal(op, {force?, minRefuseMs?})` replaces the refusal-path
  `findUnresolved`+`resolve`. It REFUSES a lingering entry and KEEPS it (stamping `refusedAt` on the
  first refusal); a re-fire within an 8 s min-age (a double-click) is refused AGAIN; a deliberate retry
  after the pause — or `force` — is allowed and consumes the entry. `BuyService` sets a `refused` flag
  so its `finally` doesn't resolve the kept entry; `TradeService` (refusal is pre-try) just drops its
  synchronous `resolve`.
- **Why:** the refusal path consumed the journal entry synchronously before throwing, so the 2nd request
  of a double-click (50–300 ms later, after a crash-restart) found no entry and committed the possibly
  -duplicate op. Refuse-once only blocked a *deliberate sequential* retry, not the double-click it was
  built to stop.
- **Constraint:** `AccountTrader.ts` NOT in the diff (grep-proven). Composes with S3: `finally` resolves
  only when `!commitMayHaveLanded && !refused`.
- **Files:** `src/core/MoneyOpJournal.ts` (`consultRefusal`, `refusedAt`), `src/trading/BuyService.ts`,
  `src/trading/TradeService.ts`.
- **Tests:** `test/moneyOpJournal.test.ts` (S15 unit: first refusal keeps+stamps, rapid re-fire refused
  again, paused retry consumes, force consumes, no-entry allows); `test/moneyOpJournalWiring.test.ts`
  (S15 wiring: double-click refused + entry kept; deliberate retry after the pause reaches the commit
  path). **Updated** the B4 wiring test (entry is now KEPT not consumed on refusal — documented
  behavior change) and added `consultRefusal` to `buyPartialBaseline.test.ts`'s no-op journal mock.
- **Status:** FIXED. build clean · 237 tests (+5).

### S6 — no timeout on steam-totp getTimeOffset wedges all confirmation/money paths — **FIXED**
- **What:** New `src/trading/steamTotpTimeout.ts`. `installSteamTotpTimeout()` (called first in
  `bootstrap()`) patches `SteamTotp.getTimeOffset` PROCESS-WIDE with `makeTimeoutGetOffset`: a ~10s
  timeout that falls back to the last-known offset (or 0 — the same fallback callers already use on
  error) so a stalled QueryTime can't hang, plus a per-process cache of the (clock-stable) offset so
  only the FIRST call touches the network.
- **Why:** steam-totp's `getTimeOffset` issues a raw `https.request` with NO timeout; a stalled response
  never settles the callback, so every confirmation entry point that awaits it (buy-order 2FA, mass-sell
  2FA, the SDA panel, and steamcommunity's OWN trade-send confirm) hangs until restart — pinning the
  in-flight guard + MoneyOps asset claims and latching mass-op running flags.
- **Approach:** patched the shared module (both our 4 AccountTrader call sites AND the steamcommunity
  vendor call site resolve `getTimeOffset` from the same cached module) rather than editing call sites —
  so the vendor's trade-send confirm is covered too, and **`AccountTrader.ts` stays out of the diff**
  (grep-proven). Not a band-aid: bounds an unbounded await, uses the documented fallback, no retry/restart.
- **Files:** `src/trading/steamTotpTimeout.ts` (new), `src/index.ts` (install at boot).
- **Tests:** `test/steamTotpTimeout.test.ts` — stall → 0 within timeout (no hang); success cached (2nd
  call no network); error not cached (re-attempt); cache TTL expiry; sync throw degrades to 0.
- **Status:** FIXED. build clean · 242 tests (+5).

### S14 — install busy-gate misses mass-sell/trade-up/casket + is check-once (TOCTOU) — **FIXED**
- **What:** Added `busy()` to `MarketService`/`TradeUpService`/`CasketService` (each returns its job's
  `running` flag) and OR'd them into the `isBusy` gate in `index.ts`. Added a TOCTOU RE-CHECK: `runUpdate`
  takes an optional `isBusy` and, immediately before the swap (AFTER the `selfTest.ok` gate), defers with
  a new `deferred-busy` outcome instead of swapping if a money/item op started during the download/self
  -test window. `installNow` passes `deps.isBusy`.
- **Why:** `canInstallNow` consulted only Trade/Buy/Inventory `busy()`, so a swap could hard-exit mid
  mass-sell (unconfirmed 2FA listings), mid-craft (irreversible 10-item outcome unknown), or mid-casket
  -move; and the gate was evaluated once, minutes before the swap.
- **Constraint:** `AccountTrader.ts` NOT in the diff (grep-proven). Keep-current guard intact:
  `swapAndRelaunch` still has ONE call site, still reached only after `selfTest.ok` — the busy re-check
  is an ADDITIONAL early-return placed after that gate, never a bypass.
- **Files:** `src/trading/{MarketService,TradeUpService,CasketService}.ts`, `src/index.ts` (isBusy),
  `src/licensing/Updater.ts` (re-check), `src/licensing/updateScheduler.ts` (pass isBusy),
  `src/licensing/updateStatus.ts` (`deferred-busy` outcome).
- **Tests:** `test/updateBusyGate.test.ts` — each service's `busy()` reflects its running state (the
  building block the gate ORs). The gate OR-ing / re-check wiring is verified by tsc + the reasoned
  argument (the `canInstallNow` isBusy branch is unreachable in a non-packaged test build, and the
  runUpdate re-check sits behind network+spawn — both trivial guards).
- **Status:** FIXED. build clean · 245 tests (+3).

### S16 — GC 60s cap vs unbounded casket-move loop (false timeout + detached zombie) — **FIXED**
- **What:** `withSession` takes an optional `timeoutMs` (default 60s, other callers unchanged).
  `moveCasketItems` scales the backstop by item count (`20s + 3s×count + 20s margin`) AND gives the loop
  its OWN deadline (`20s + 3s×count`, measured post-connect) checked each iteration — so the loop aborts
  COOPERATIVELY with a partial `{moved, unconfirmed, failed}` before the backstop can fire (the 20s margin
  > the 15s per-item verify timeout, so the loop always self-aborts first).
- **Why:** the fixed 60s `withTimeout` false-"timed out" any move above ~50–80 items, and since it can't
  cancel `fn(go)`, the move loop kept running DETACHED (a 2nd GC op could interleave on the same account)
  while the caller got a timeout — which `runMove` then mislabelled as "nothing moved" though items DID
  move. The cooperative deadline stops the loop itself (no detached zombie) and RETURNS the real partial
  counts (so `runMove`'s success path records them — the mislabel is fixed by prevention; its catch now
  only handles genuine pre-flight failures, for which "nothing moved" is accurate).
- **Constraint:** `AccountTrader.ts` NOT in the diff (grep-proven).
- **Files:** `src/trading/GcActionLayer.ts`.
- **Tests:** `test/casketMoveBudget.test.ts` — backstop scales with count (3→49s, 100→340s, ≫ the old
  60s); with the clock jumped past the deadline the loop self-aborts to a partial result (< all items).
- **Status:** FIXED. build clean · 247 tests (+2).

### S28 — mass-sell reconcile positional-index race relabels a genuine failure as recovered — **FIXED**
- **What:** `failedHere` is now a `Set<string>` of assetIds (not `{assetId, idx}`). Extracted the
  reconcile into `reconcilePhantoms(user, failedAssetIds, finalListed)`, which removes recovered rows
  from `this.job.failed` by IDENTITY (`f.username === user && recoveredIds.has(f.assetId)`) instead of
  writing a `__recovered__` sentinel through a stored positional index and filtering it.
- **Why:** with up to 25 concurrent `processBot` workers sharing `this.job.failed`, bot A's reconcile
  `filter` reindexed the array while bot B awaited `getListedAssetIds()`; B then wrote `__recovered__`
  through STALE indices onto the wrong row, which the next filter dropped — a genuine failure vanished
  from the report. Identity-matching is race-safe: the read-filter-assign is synchronous (can't
  interleave), and each bot only removes its own user's recovered ids.
- **Constraint:** `AccountTrader.ts` NOT in the diff (grep-proven).
- **Files:** `src/trading/MarketService.ts`.
- **Tests:** `test/massSellReconcile.test.ts` — recovering botA's phantoms leaves botB's genuine failure
  intact; identity includes the username (a same-assetId row of another bot is untouched); nothing
  listed → no recovery.
- **Status:** FIXED. build clean · 250 tests (+3).

**Wave 2 boundary re-check:** client build clean · 250 tests · cargo clean (unchanged) · server 45. ✔
(The recurring `updaterEacces.test.ts:51` pipeToFile flake — since de-flaked in a separate commit.)

---

## Wave 3 — Liveness, watchers, event-loop cost

### S10 — `/api/inventory` deep-clone+enrich+stringify hammered ~every 2.5s during a fill — **FIXED**
- **What:** `watchPriceFill` now coalesces the whole-fleet re-pull to at most once per 10s
  (`REPRICE_MIN_REPULL_MS`) via a testable `shouldRepullFill(progressed, busy, since, min)`; the final
  drain still pulls immediately. Cuts the re-pull + full `renderMain/renderSidebar` frequency ~4×.
- **Deviation:** did NOT add the register's ETag/304 — `/api/inventory` merges two stores and overlays
  manual-lock/category state no store-version captures, so a version-ETag would risk serving STALE
  trade-gating data (and can't 304 mid-fill anyway, since the payload changes each pull). The cadence
  bound removes the hammering symptom with zero staleness risk; client-side price patching left as a
  deeper follow-up.
- **Files:** `public/app.js`.
- **Tests:** `test/priceFillCadence.test.ts` — drain always pulls; mid-fill only progressed+cadence pulls;
  3 fast advances coalesce to ≤1 pull.
- **Status:** FIXED. build clean · 253 tests (+3).

### S17 — refresh/mass/sell pollers die on the first transient error → completion never fires — **FIXED**
- **What:** Gave `pollRefresh`/`pollMass`/`pollSell` the same bounded error-retry the `fbuy` poller has:
  each `catch` now `if (!pollerStalled('<name>Err', 0)) { poll…(); return; }` (retry) and only gives up
  after `POLL_STALL_MS` (3 min) of continuous errors; a successful poll `resetPoller('<name>Err')`.
- **Why:** their `catch` just toasted + hid the progress bar with no reschedule, so one failed status GET
  (an S10 event-loop stall, a socket blip, machine sleep) permanently stopped polling while the job kept
  running server-side — the completion re-pull / failure panel never ran, leaving inventories/balances
  stale + a persistent error toast.
- **Files:** `public/app.js` (three pollers).
- **Tests:** `test/pollerErrorRetry.test.ts` — the extracted `pollerStalled`/`resetPoller` give a bounded
  retry-then-give-up window (clock-controlled); all three pollers wire the retry + reset (source-presence,
  fails against the old catch).
- **Status:** FIXED. build clean · 255 tests (+2).

### S19 — reprice watch's no-progress stop is terminal + hides the indicator mid-fill — **FIXED**
- **What:** Added a `processedThisRun` counter to `PricingService` (bumped in the run() finally on EVERY
  terminal resolution — success OR error/429-exhaustion) and exposed it as `status().processed`. The
  no-progress clock (frontend `watchPriceFill` + the pure `repriceDecision`) now advances on `processed`
  progress, not just `fetched`; `fetched` still drives the re-pull (only new prices need a re-pull).
- **Why:** progress was measured solely by `fetched`, which increments only on a SUCCESSFUL fetch. In a
  429/error storm names resolve via the error path (advancing the queue, not `fetched`), so `fetched`
  stalls while the fill is alive → after 15 min the watch terminally stopped AND hid the "Fetching
  prices…" badge though the backend was still filling. A TRUE wedge (neither signal advances) still stops.
- **Files:** `src/pricing/PricingService.ts`, `src/pricing/repriceReconciler.ts`, `public/app.js`.
- **Tests:** `test/repriceReconciler.test.ts` (S19: processed-only progress → no false stop; true wedge →
  still stops); `test/pricingErrorMiss.test.ts` (S19: an error-resolved name bumps `processed`, not
  `fetched`). Existing reprice/priceFillIndicator/auditFollowups tests still green.
- **Status:** FIXED. build clean · 258 tests (+3).


### S29 — TF2 first-load queues a fill nothing watches → TF2 prices stay "…" — **FIXED**
- **What:** `setGame`'s first-TF2-load branch now `void watchPriceFill(refreshActiveViewFromCache)` after
  the initial `/api/inventory-tf2` load, mirroring `init()`.
- **Why:** the GET enriches + `ensureFilled(missing)` server-side, but `setGame` started no watcher
  (boot/refresh/source-switch all do), so a cold TF2 cache showed "…" prices + wrong totals until a TF2
  refresh-all or restart.
- **Files:** `public/app.js` (`setGame`).
- **Tests:** `test/tf2FillWatch.test.ts` — the shipped `setGame` first-load branch starts watchPriceFill
  (source-presence; fails against the old code). watchPriceFill itself is covered by S10/S19.
- **Status:** FIXED. build clean · 259 tests (+1).

### S42 — watchPriceFill against a dead backend polls forever with the badge frozen — **FIXED**
- **What:** The status-fetch `catch` now counts consecutive failures and STOPS after `MAX_CONSEC_ERRORS`
  (24 → ~1 min at the 2.5s poll), hiding the badge; a successful poll resets the streak.
- **Why:** a dead backend fails every `/api/pricing/status` poll → the old `catch { continue }` spun
  forever with the "Fetching prices…" badge frozen.
- **Files:** `public/app.js` (`watchPriceFill`).
- **Tests:** `test/priceFillDeadBackend.test.ts` — the shipped loop bounds consecutive errors + resets on
  success (source-presence; fails against the old unbounded continue).
- **Status:** FIXED. build clean · 260 tests (+1).

### S23 — ensureLicensed: hung backend blanks the UI forever; failure → reload loop — **FIXED**
- **What:** Added a `timeoutSignal(ms)` helper (feature-detected `AbortSignal.timeout` + fallback) and
  bounded the boot `/api/system/status` probe (8s). `ensureLicensed` now distinguishes an EXPLICIT
  unlicensed answer (`licensed:false` / 403 → activation redirect) from UNREACHABLE/timeout/ambiguous-5xx
  → a visible `showBackendUnreachableScreen()` that gently re-probes and reloads ONCE the backend is up
  (deliberate, non-looping), instead of the automatic `location.replace('/')`.
- **Why:** the no-timeout fetch let a backend that accepts-but-never-answers hang `init()` forever (the
  `ssim-locked` overlay never lifted → blank window); and `replace('/')` in sidecar mode targets this same
  dashboard → a reload loop that also churned the session (S1). 
- **Files:** `public/app.js` (`timeoutSignal`, `ensureLicensed`, `showBackendUnreachableScreen`).
- **Tests:** `test/ensureLicensed.test.ts` — runs the shipped functions over mocked fetch/document/window:
  licensed→proceed; licensed:false/403→redirect; unreachable/5xx→retry screen, NEVER a redirect.
- **Status:** FIXED. build clean · 265 tests (+5).

### S32 — interactive routes have no client timeout → indefinite modal spinners — **FIXED**
- **What:** `api()` now bounds every call with `timeoutSignal(opts.timeoutMs ?? 120000)`; a timeout/abort
  is surfaced as a clear `timedOut` error ("the backend may be busy…") instead of a silent hang. A caller
  can override or disable (`timeoutMs: 0`) for a known-long call.
- **Why:** interactive "live" routes (orders/confirmations/trade-up-candidates/`?refresh=1`) await a live
  login on a FIFO semaphore shared with bulk refresh; with no client `AbortSignal` the modal spinner sat
  for many minutes. A 2-min bound converts "indefinite" into "fails with a retry-able message".
- **Scope:** did the PROVEN client-timeout half. The register's server-side priority lane / fast-409 for
  interactive logins during a bulk refresh is the HYPOTHESIS-FIFO half — a larger change left as a
  follow-up; the client timeout already removes the indefinite-spinner symptom.
- **Files:** `public/app.js` (`api`).
- **Tests:** `test/apiTimeout.test.ts` — a hanging fetch aborts as `timedOut`; `timeoutMs:0` disables it;
  a fast response is unaffected. (Reuses the S23 `timeoutSignal`.)
- **Status:** FIXED. build clean · 268 tests (+3).

### S33 — void-launched installers/orchestrators have no rejection finalizer — **FIXED**
- **What:** Each `void this.runMass…()` launch (MarketService/TradeService/BuyService) now has a `.catch`
  that resets its `running` flag + logs; `installNow` gained an internal `catch` that maps a `runUpdate`
  throw to a returned failure result instead of rejecting.
- **Why:** an unexpected rejection escaped `void` → `writeCrash('UNHANDLED REJECTION')` + a
  `recordUncaught` tick (3/60s latches the money breaker), and the orchestrator never reached its trailing
  `running=false` → the job type refused until restart. (PROVEN-latent hardening — no trigger proven at
  HEAD, but a real risk.)
- **Files:** `src/trading/{MarketService,TradeService,BuyService}.ts`, `src/licensing/updateScheduler.ts`.
- **Tests:** `test/voidOrchestratorFinalize.test.ts` (a crashed mass-sell releases the job; the other two
  void launches finalize); `test/updateScheduler.test.ts` (installNow catches a runUpdate throw → resolves
  a failure, never rejects). AccountTrader untouched.
- **Status:** FIXED. build clean · 271 tests (+3).

### S22 — three undismissed error toasts permanently mute all later toasts (unbounded queue) — **FIXED**
- **What:** Error toasts now auto-dismiss after a LONG `ERROR_TOAST_TTL_MS` (20s) instead of never;
  duplicate toasts collapse (an `activeToastKeys` de-dup set keyed by `type|message`); the pending queue
  is capped (`TOAST_QUEUE_CAP=50`, drop-oldest). The routine post-op 409 downgrade is subsumed — a 409
  error now auto-clears + de-dups rather than sticking.
- **Why:** errors never auto-dismissed, so three unread ones filled all 3 visible slots forever and every
  later toast (buy/sell/trade confirmations) queued invisibly in an unbounded `toastQueue` → the operator
  lost all op feedback + slow memory growth.
- **Files:** `public/app.js` (`toast`, `drainToasts`, `showOneToast`).
- **Tests:** `test/toastQueue.test.ts` — identical toasts collapse to one; a flood behind 3 stuck errors
  is queued+capped (not unbounded); errors use the long TTL (source-presence, never-dismiss path gone).
- **Status:** FIXED. build clean · 274 tests (+3).

### S11 — post-login DISCONNECTED sessions become permanent zombies (fill the 150 ceiling) — **FIXED**
- **What:** Added the B43 deferred-destroy (with the `sessions.get(key)===session` replacement guard) to
  the `disconnected` handler, mirroring the `error` handler — so a settled-then-dropped session tears
  itself down (`sessionDestroyed` fires; slot/agent/TradeOfferManager poller released). Also made the idle
  reaper a BACKSTOP: it now reaps `DISCONNECTED`/`ERROR` sessions on the idle-TTL too (not only
  `LOGGED_IN`), catching any zombie that slipped past the event-time destroy.
- **Why:** a post-settle CM drop (proxy blip → `disconnected`, no `error`; `autoRelogin:false`) left the
  session resident in DISCONNECTED — counted against `MAX_LIVE_SESSIONS`, holding its proxy agent + a live
  20s poller — and NOTHING reaped it (the B43 destroy fired only on `error`; the reaper skipped
  non-LOGGED_IN). Zombies accumulated to the 150 ceiling → new logins refused until restart.
- **Files:** `src/core/SessionManager.ts` (disconnected handler + reaper).
- **Tests:** `test/idleReaper.test.ts` (S11) — an idle DISCONNECTED/ERROR session is reaped; a recently
  -disconnected one is not (idle-TTL respected); LOGGING_IN is still never reaped. B40 tests still green.
- **Status:** FIXED. build clean · 277 tests (+3).

### S24 — vault token persist can throw inside steam-user's refreshToken emit → breaker trip — **FIXED**
- **What:** Wrapped the vault branch of `TokenStore.set` (`AccountVault.setToken`) in try/catch,
  degrading a persist failure to a warn-and-continue (token live this session, not persisted this
  attempt) — matching the plaintext path's contract.
- **Why:** the vault `setToken → synchronous save() → writeJsonAtomic` can throw (disk full/EACCES/AV
  lock); it runs INSIDE steam-user's `refreshToken` emit, so an escaping throw became a global
  uncaughtException → `ProcessHealth.recordUncaught`; during a mass first-login (fresh vault) with a disk
  problem, ≥3 in 60s latched the money breaker until restart. Scoped to the token path (not
  `AccountVault.save()`) so account writes still surface their errors.
- **Files:** `src/core/TokenStore.ts`.
- **Tests:** `test/tokenStoreDegraded.test.ts` (S24) — a throwing vault `setToken` does not escape `set`.
- **Status:** FIXED. build clean · 278 tests (+1).

### S25 — createdSession ownership map shared across flows → mid-fetch logout / reaper leak — **FIXED**
- **What:** Replaced the service-level `createdSession` Map (keyed by account) with an
  `AsyncLocalStorage<{createdByCall?}>` (`ownershipCtx`). Each per-account refresh runs inside
  `ownershipCtx.run(store, …)`; `ensureSession` records ownership into the CALLER'S store; the worker
  reads its OWN `store` for the release decision. No shared key for concurrent flows to clobber.
- **Why:** `runRefresh` and `refreshAfterTrade` both set/read `createdSession[account]` with awaits
  between; a trade's post-refresh running concurrently with a fleet refresh of the same account could log
  the shared session out mid-fetch (spurious failure) or leave it unreleased (leaked to the reaper).
- **Files:** `src/core/InventoryService.ts`.
- **Tests:** `test/sessionOwnership.test.ts` — two interleaved same-account `ensureSession` flows keep
  isolated ownership (creator=true / reuser=false); no store leaks outside a `run()`. **Updated**
  `test/teardownQuiescence.test.ts` to simulate ownership via `ownershipCtx.getStore()` (documented
  mechanism change) — its "releases ONLY created sessions" assertion still holds.
- **Status:** FIXED. build clean · 280 tests (+2 net; +2 new − 0, teardown test updated in place).

**Wave 3 boundary re-check:** client build clean · 280 tests · cargo clean (unchanged) · server 45. ✔

---

## Wave 4 — Updater / boot / license resilience

### S8 — mid-session install freezes the event loop 240–480s (sync self-test + 185 MB hashes) — **FIXED**
- **What:** Made the anti-brick self-test ASYNC — `runSelfTestOnce` uses `execFile` (promisified) instead
  of `execFileSync`; `selfTestNewExe` `await`s the (now async-or-sync) `runOnce`. Made the sha256 hashes
  streaming/async — `sha256File` streams the file (not a 185 MB `readFileSync`) and returns a Promise;
  `verify` is async and awaits it; `download`'s reuse pre-check + `runUpdate`'s verify call await.
  `classifySpawnError` normalized to handle BOTH error shapes (sync exit on `.status`, async exit on
  `.code`-as-number) → identical crash/timeout/lock classification.
- **Why:** C5's `installNow` runs the full `runUpdate` in the LIVE, session-carrying process; the sync
  self-test (240s + a 480s C2 escalation, re-run per retry) plus two 185 MB `readFileSync` hashes froze
  the event loop for minutes → every HTTP request, Steam CM keepalive and confirmation poll stalled →
  the resident fleet (~150 sessions) dropped.
- **Constraint:** keep-current guard intact — `swapAndRelaunch` still has ONE call site, still reached
  only after `selfTest.ok` (the async change is `await`, not a new path). Classification outcomes are
  byte-identical for the existing sync error shapes.
- **Files:** `src/licensing/Updater.ts`.
- **Tests:** `test/updaterEacces.test.ts` (S8: classifier handles the async error shape + sync unchanged;
  `selfTestNewExe` awaits an async `runOnce`); `test/updaterReliability.test.ts` (sha256File awaited).
  All existing selfTest/classify/keep-current property tests still green.
- **Status:** FIXED. build clean · 282 tests (+2).

### S9 — persistent swap failure loops boot→swap→relaunch forever; splash claims success — **FIXED**
- **What:** The swap bat now RECORDS a per-sha swap-failure marker on the `:swapfail` path (a failed
  `move /Y`) and relaunches the OLD exe WITHOUT `--ssim-updated` (no false "Update installed"); the
  SUCCESS path keeps the flag. New `consumeSwapFailureMarker` folds the marker into a per-sha streak at
  boot; `runUpdate` BLOCKS the swap (logs the stable `SSIM_UPDATE_BLOCKED` marker + `setBlockedUpdate` +
  `swap-blocked` outcome) after `SWAP_BLOCK_THRESHOLD=3` — `force` overrides; a new sha / up-to-date
  resets it.
- **Why:** when `move /Y` fails (AV/EDR lock, or Controlled Folder Access on a Desktop install), the bat
  correctly relaunches the old exe, but the old client re-offered the update, C1 reused the artifact, the
  self-test passed again, and it swapped→failed→relaunched forever — nothing counted the swap failure,
  and it even showed the "Update installed" splash each cycle.
- **Constraint:** keep-current guard intact — the swap-block is an ADDED early-return; `swapAndRelaunch`
  is still the single call site reached only after `selfTest.ok`.
- **Files:** `src/licensing/Updater.ts`, `src/licensing/updateStatus.ts` (`swap-blocked` outcome).
- **Tests:** `test/updaterSwapFail.test.ts` — the bat writes the marker on failure + drops the false
  updated-flag (and keeps it on success); marker absent when no path given; `consumeSwapFailureMarker`
  counts per-sha, resets on a new sha, survives a no-marker boot, clears. Existing buildSwapScript test green.
- **Status:** FIXED. build clean · 285 tests (+3).

### S21 — sig-fail deletes a sha-intact artifact → 185 MB re-download every boot — **FIXED**
- **What:** `verify()` now returns `{ ok, shaOk }`; `runUpdate` deletes the staged artifact ONLY on a
  sha MISMATCH (`!shaOk`), and KEEPS it on a signature-only failure (sha intact) — logging a warning to
  check the server signing key / manifest.
- **Why:** `verify` conflated a digest mismatch (corrupt → delete right) with a sigKind absence/invalidity
  on byte-perfect bytes. Deleting a sha-intact artifact forced a fresh 185 MB download that produced the
  identical failure → a re-download every boot forever (C3 only counts self-test failures). Keeping it lets
  the sha-keyed pre-check reuse it → the re-verify is network-free (and `sig-fail` telemetry already surfaces it).
- **Files:** `src/licensing/Updater.ts` (exported `verify`).
- **Tests:** `test/updaterSigKeep.test.ts` — sha mismatch → shaOk:false (delete); sha-intact + no sigKind
  → shaOk:true (keep); sha-intact + invalid signature → shaOk:true (keep).
- **Status:** FIXED. build clean · 288 tests (+3).

### S26 — markOnline anchors the rollback clock to the LOCAL clock → forward-wrong clock poisons grace — **FIXED** *(client + server)*
- **What:** `markOnline(serverTimeMs?)` now anchors `maxSeenMs` to the SERVER'S reported time (falling
  back to the local clock only if none is sent — old-server safe). The heartbeat/validate/activate call
  sites pass `res.data.serverTime`. Server: `activate`/`heartbeat`/`validate` success responses now
  include `serverTime: Date.now()` *(ssim-license-server commit `f7f6b68`)*.
- **Why:** a machine with a forward-wrong clock WHILE ONLINE wrote that future value into `maxSeenMs` on
  every beat (C13 only stopped OFFLINE poisoning); after the clock was corrected, an expired-token boot hit
  `now < maxSeenMs - skew → rollback-refused` — offline grace dead until real time caught up.
- **Files:** `src/licensing/LicenseClient.ts`; server `src/server.js`.
- **Tests:** `test/licenseUpdate.test.ts` (S26 — a server-time anchor vs a forward-wrong local one: the
  latter locks out a corrected clock, the former does not); server `test/reliability.test.js` (the three
  responses carry `serverTime`). `nextClockMeta`/`offlineGraceDecision` are already pure-tested.
- **Status:** FIXED. client build clean · 289 tests (+1) · server 46 (+1). Client change is old-server-safe.

### S27 — HWID drift via firstMac() enumeration order → seat lockout — **FIXED**
- **What:** `getHwid()` now PINS its result to `data/hwid.pin` on first computation and reads that pin
  on every later boot. Only a HEALTHY fingerprint (real machineId AND MAC) is pinned, so a transient
  failure never pins a bad id (a later good boot pins the correct one).
- **Why:** the hwid drifted whenever `firstMac()` changed (a VPN/hotspot/virtual adapter appears, NIC
  order shifts) or `machineIdSync` transiently failed → the stored token went invalid → re-activation
  hit `seat_limit` (409) needing the OWNER to delete the stale seat.
- **DEVIATION from fix direction (justified):** the register suggested hashing the sorted MAC set /
  dropping MAC (client) or a server seat-move flow. But ANY change to the hwid COMPUTATION changes it for
  EVERY deployed machine → a mass `seat_limit` lockout the moment they update. Pinning the FIRST computed
  value is byte-identical to the legacy hwid, so deployed seats are untouched, and it stops all future
  drift with NO server change and NO fleet break. A `data/` wipe (which also loses the token → forces
  re-activation anyway) recomputes. The server seat-move flow remains a possible future enhancement.
- **Files:** `src/licensing/HwidService.ts`.
- **Tests:** `test/hwidPin.test.ts` — getHwid returns 64-hex + pins it; a pinned id wins even when live
  factors would differ (drift-proof); a missing/malformed pin is rejected (recompute, never a false id).
- **Status:** FIXED. build clean · 292 tests (+3).

### S31 — server key-guard pins only the public key → a mismatched pair signs unaccepted tokens — **FIXED** *(server repo)*
- **What:** *(ssim-license-server commit `b86f5cc`)* Added `keys.verifyKeypair()` (Ed25519: sign a random
  probe with the loaded PRIVATE key, verify with the loaded PUBLIC key) and an UNCONDITIONAL boot
  self-check in `index.js` that refuses to start on a mismatch — independent of the pinned `EXPECTED_PUBKEY_FPR`.
- **Why:** the S3 fingerprint guard pins only the PUBLIC key; a correct `public.pem` + a stale
  `private.pem` passed it yet `token.sign` produced tokens the client-embedded public key rejects →
  progressive fleet-wide activation + heartbeat-token-refresh failure that S2/S3 don't catch.
- **Files:** `ssim-license-server/src/keys.js`, `src/index.js`.
- **Tests:** server `test/reliability.test.js` (S31 — verifyKeypair true for the matching pair; a
  mismatched pair fails the Ed25519 probe).
- **Status:** FIXED. server `npm test` = **48 pass** (+2). Client untouched.

### S34 — manual install is 202-then-silence: "installing…" forever + suppresses the badge — **FIXED**
- **What:** `/api/system/status`'s `update` field now exposes `currentOutcome` (from the existing
  `getUpdateOutcome`) AND `installing` (new `isUpdateOpInFlight()` on the scheduler). The dashboard's
  `watchSystemStatus` clears `updateInstalling` (and re-shows the badge + toasts the outcome) once the
  server reports `update.installing === false`.
- **Why:** the endpoint 202s before download/verify/self-test start; a KEPT-CURRENT install just returned,
  so `updateInstalling` never reset → "installing…" forever and the update badge suppressed for the
  session (only a successful swap, which exits + reloads, cleared it). `updateStatusView` had the outcome
  but was never wired to the route.
- **Files:** `src/licensing/updateScheduler.ts` (`isUpdateOpInFlight`), `src/api/server.ts` (status),
  `public/app.js` (`watchSystemStatus` reset).
- **Tests:** `test/updateScheduler.test.ts` (S34 — `isUpdateOpInFlight` true during an install, false after
  a kept-current one → the exact signal the dashboard uses to reset).
- **Status:** FIXED. build clean · 293 tests (+1).

### S51 — shell death orphans the backend (holds the port + single-instance lock) — **FIXED**
- **What:** `listenForShellQuit` (sidecar-only) now treats stdin `end` (EOF) as a graceful-shutdown
  signal — a clean logout that releases the UI port + single-instance lock — in addition to the existing
  `data`-'quit'. `shutdown` gained a `shuttingDown` idempotency guard so the now-multiple triggers
  (SIGINT/SIGTERM/stdin-quit/stdin-EOF) can't double-teardown.
- **Why:** the backend reacted only to stdin `data`/`error`, never `end`; if the shell died, the hidden
  backend kept every Steam session + the CSFloat worker running while holding the port + lock → the next
  launch lock-screened with "already running" and nothing visible to close.
- **Constraint:** NOT a respawn — the EOF handler exits gracefully (owner directive: no auto-restart).
- **Files:** `src/index.ts`.
- **Tests:** `test/shellDeathShutdown.test.ts` — EOF→shutdown wired, shutdown idempotent, EOF handler
  doesn't respawn. (Runtime/process-lifecycle shaped — `shutdown()` schedules `process.exit` and index.ts
  self-bootstraps, so it is untestable in-process; source-presence locks the wiring + `tsc` verifies it.)
- **Status:** FIXED. build clean · 296 tests (+3).

**Wave 4 boundary re-check:** (below)
client build clean · 296 tests · cargo clean · server 48 tests. ✔

---

## Wave 5 — Long tail

### S13 — price dedup set poisoned when the effective source flips mid-fill — **FIXED**
- **What:** Each queued job now carries its ENQUEUE-time `key` + `sourceId`; `run()` processes it under
  those (not the CURRENT `activeSource()`), so the `finally` deletes the SAME key that was added to
  `queued`.
- **Why:** `ensureFilled` inserted under the enqueue-time key but `run()` rebuilt the key at dequeue; when
  `activeSource()` flipped (a CSFloat key added/removed at runtime), the `finally` deleted the wrong key →
  the enqueue key lingered in `queued` forever → that name became permanently unfetchable.
- **Files:** `src/pricing/PricingService.ts`.
- **Tests:** `test/pricingErrorMiss.test.ts` (S13 — a job de-queues its enqueue key even when activeSource
  differs at dequeue).
- **Status:** FIXED. build clean · 297 tests (+1).

### S37 — quarantinePlaintextFile rewrites the kept-secrets file non-atomically — **FIXED**
- **What:** `vaultBoot.quarantinePlaintextFile` now uses `writeJsonAtomic` (temp→fsync→rename, mode 600)
  instead of `fsExtra.writeJsonSync`.
- **Why:** the module's contract is "never delete the last copy"; a non-atomic rewrite could tear the
  kept-secrets file on a power-cut.
- **Files:** `src/core/vaultBoot.ts`. **Tests:** build-verified (mechanical swap to the tested `writeJsonAtomic`).
- **Status:** FIXED. build clean · 299 tests.

### S38 — license.token written non-atomically → power-cut torn token → offline lockout — **FIXED**
- **What:** `storeToken` writes the MAIN `license.token` via temp→rename (atomic) too (the `.json` sidecar
  was already atomic); `readToken` falls back to the atomic sidecar for a pre-existing torn/empty main file.
- **Why:** a power-cut during a heartbeat token refresh left a torn `license.token` → the next OFFLINE boot
  was locked out.
- **Files:** `src/licensing/LicenseClient.ts`.
- **Tests:** `test/tokenAtomicWrite.test.ts` — round-trips main+sidecar; recovers from a torn main via the sidecar.
- **Status:** FIXED. build clean · 299 tests (+2).

### S40 — server version.json published non-atomically (torn manifest strands the fleet) — **FIXED** (server repo)
- **What:** added `writeVersionFile()` (temp→rename, like `store.js`/`writeHistory`) and routed all THREE
  publish paths + the S2 rollback through it, replacing `fs.writeFileSync(VERSION_FILE, …)`.
- **Why:** a crash mid-publish left a torn `version.json` → `GET /version` 500s → the whole fleet silently
  stops updating (no client can see a new release).
- **Files:** `ssim-license-server/src/admin.js` (server branch `fix/reliability-remediation`, commit 0d3e62f).
- **Tests:** `ssim-license-server/test/reliability.test.js` — publish leaves no `version.json.*.tmp`
  fragment and the manifest parses. 50/50 server tests.
- **Status:** FIXED.

### S36 — TokenStore `{ ...EMPTY }` shallow-spread aliased the shared tokens map — **FIXED**
- **What:** replaced the module singleton `EMPTY` + its two `{ ...EMPTY }` shallow copies with a factory
  `emptyFile()` that returns a brand-new `{ version:1, tokens:{} }` each time.
- **Why:** `{ ...EMPTY }` copied only the top level — every fresh-install/degraded load shared the SAME
  `EMPTY.tokens` object, so the first plaintext `set()` mutated the process-wide singleton and leaked that
  token into every later TokenStore (two live instances: SessionManager + BanService).
- **Files:** `src/core/TokenStore.ts`.
- **Tests:** `test/tokenStoreDegraded.test.ts` — a fresh store doesn't inherit another instance's token
  (teeth-verified: fails when the shared-alias is reintroduced).
- **Status:** FIXED. Not covered by S35 (S35 refactored `readTokens`; the alias survived).

### S50 — CS2 full-refresh had no transient/429 retry layer (parity gap vs TF2/quick) — **FIXED**
- **What:** added `fetchRawRetrying()` wrapping each CS2 web-inventory context (2 + 16) in the SAME bounded
  `REFRESH_RETRIES` transient/429 loop the TF2/quick path already used; added an overridable `pause()` seam.
- **Why:** one 429/proxy blip on either context threw straight out → the whole account failed the pass →
  inflated `failed` counts at fleet scale.
- **Files:** `src/core/InventoryService.ts`. **Tests:** `test/inventoryCs2RefreshRetry.test.ts`
  (transient → retried; non-transient → fails fast). +2 tests.
- **Status:** FIXED. A non-transient error (auth/private) still fails immediately (no wasted retries).

### S41 — wallet-event race resurfaced the funded→"—" tri-state — **FIXED**
- **What:** when `session.wallet` is absent on a pass, both refresh paths now carry the last-known wallet
  forward (`getCached(username, game)?.wallet`) instead of writing a walletless record.
- **Why:** a refresh whose inventory read commits before the `'wallet'` event fires replaced the record
  without a wallet → a funded account flickered back to "—" every such pass.
- **Files:** `src/core/InventoryService.ts` (GC path + quick/TF2 path).
- **Tests:** `test/inventoryWalletCarryForward.test.ts` — carry-forward on no-event; live event still wins;
  never-funded stays walletless (teeth-verified). +3 tests.
- **Status:** FIXED.

### S43 — PriceCache rewrote the whole prices.json every ~2s for the duration of a fill — **FIXED**
- **What:** replaced the 2s flush window with a 30s max-delay coalescing window + a 250-set burst cap
  (`FLUSH_MAX_DELAY_MS`/`FLUSH_EVERY_N`); the dirty counter resets on every flush attempt.
- **Why:** the 2s window was shorter than the ~3.5s inter-fetch delay, so each fetched price landed after
  its own window and rewrote the entire file (up to 100k entries) once per fetch.
- **Files:** `src/pricing/PriceCache.ts`. **Tests:** `test/priceCacheFlush.test.ts` (coalesced small runs;
  burst cap forces a synchronous flush; updates still persist). +3 tests.
- **Status:** FIXED. Prices are non-sensitive/re-fetchable, so a few tens of seconds at risk is acceptable.

### S44 — FX refresh failure not retried for 12h — **FIXED**
- **What:** on a failed refresh, arm a bounded exponential-backoff short retry (5/10/20/40 min, MAX_RETRIES=4);
  a 200-with-no-rate now counts as failure; a success clears the pending retry and resets the budget; the
  12h tick resets the budget per cycle.
- **Why:** a single provider blip left the fallback/stale rate in place for half a day.
- **Files:** `src/pricing/ExchangeRateService.ts`. **Tests:** `test/exchangeRateRetry.test.ts` (retry armed;
  garbage-200 retried; success clears+resets; bounded at cap). +4 tests. **Status:** FIXED (display-only).

### S45 — CsFloatClient 429 retries held the per-key single-flight slot — **FIXED**
- **What:** on a 429 the scheduled task now throws an internal `RateLimitRetry` sentinel (resolving the task
  → freeing the slot); the backoff `delay()` + re-schedule happen in a `.catch` OUTSIDE the limiter slot.
- **Why:** the backoff ran inside `limiter.schedule` (maxConcurrent=1), so a background pricing 429 storm
  held the slot and interactive requests couldn't preempt.
- **Files:** `src/csfloat/CsFloatClient.ts`. **Tests:** `test/csfloatRateLimitSlot.test.ts` — an interactive
  request completes DURING a background 429 backoff (teeth-verified: fails with the in-slot hold). +1 test.
- **Status:** FIXED. Retry count/limit (≤3, 1/2/3s) and error surfacing preserved.

### S46 — CsFloatAutoAcceptWorker.stop() left the boot tick armed + couldn't halt an in-flight pass — **FIXED**
- **What:** track the 5s boot `setTimeout` in `bootTimer` and clear it in `stop()`; add a `stopped` flag
  set by `stop()` that `runOnce()` checks up front and the per-account loop checks before each delivery.
- **Why:** the boot tick could fire a pass 5s into teardown (an unwatched send during shutdown), and a
  running pass had no stop signal.
- **Files:** `src/csfloat/CsFloatAutoAcceptWorker.ts`. **Tests:** `test/csfloatAutoAcceptStop.test.ts`
  (stop cancels both timers; runOnce no-ops when stopped; in-flight pass halts after the first delivery). +3.
- **Status:** FIXED. Dedup/idempotency unchanged (a send already in flight completes; new ones don't start).

### S47 — unbounded diagnostic log sinks — **FIXED**
- **What:** new `src/utils/rollLog.ts` (`rollIfLarge` + `SINK_MAX_BYTES=5MB`, roll-to-`.1`); wired into the
  two rare sinks (`crash-log.txt`, `exit-trace.log`) and the hot `stderr-trace.log` tee (in-process byte
  counter seeded from on-disk size → no statSync per write).
- **Why:** the three raw `fs.appendFileSync` sinks were append-only with no cap (winston's own files ARE
  capped); a spewing vendor library or a long-lived install could grow them without bound.
- **Files:** `src/utils/rollLog.ts` (new), `src/utils/crashlog.ts`, `src/bootflags.ts`.
- **Tests:** `test/rollLog.test.ts` — roll/no-roll/absent + writeCrash rolls at the cap. +4 tests.
- **Status:** FIXED. One generation of history (`.1`) — enough for a diagnostic, still bounded.
