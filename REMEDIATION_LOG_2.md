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

> **Note — known flaky test (pre-existing, NOT a regression):** `updaterEacces.test.ts:51`
> "pipeToFile … KEEPS the partial file" is an intermittent filesystem-timing flake — it failed once
> then passed on an immediate re-run with no code change in its path. Watch for it at gate checks; a
> single retry clears it. Out of scope for the current issue.

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

