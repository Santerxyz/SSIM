# SSIM Hardening — Remediation Log (live)

Companion to `AUDIT_LEDGER.md` (the static 75-item audit). This file records every
applied fix per Rule R3/R8: **what · why · blast radius · verification**. Scope:
all critical+high items, autonomous. `tsc --noEmit` is run green after each slice.
**Extended (operator request) to the medium/low tail — Tail F–I below.**

---

## Silent-crash forensics — crash sink + diagnostic report + refresh memory watch ✅ (build green · OOM + sync-sink verified)

**What** — three diagnostics so a "the window just vanished during Refresh" report leaves
evidence instead of nothing:
- **Synchronous crash sink** (`src/utils/crashlog.ts`, new) — `writeCrash()` does a BLOCKING
  `fs.appendFileSync` of the stack (+ RSS/heap tag) to `logs/crash-log.txt`, credential-redacted
  via the logger's `redactSecrets`. Wired into `index.ts` `uncaughtException`/`unhandledRejection`
  and the fast-exit paths (`bootstrap().catch`, the server-`error` 250 ms exit). The boot banner now
  prints the crash-log path.
- **Node diagnostic report** (`src/bootflags.ts`) — `process.report.reportOnFatalError = true`,
  `directory = logs/`. Captures the two killers that BYPASS JS handlers entirely: V8 out-of-memory
  and native crashes in `steam-user`/`steamcommunity`. `reportOnUncaughtException` left **OFF** on
  purpose so the owner's "survive a single stray throw" policy is preserved.
- **Refresh memory watch** (`src/core/InventoryService.ts`) — `runRefresh` samples RSS every 2 s and
  logs `RSS start→end · peak · N accounts`, so a climb toward the heap ceiling on a big fleet refresh
  is visible (a true OOM aborts mid-run → captured by the diagnostic report instead).

**Why** — the existing `uncaughtException` handler logs but DELIBERATELY does not exit, so a JS throw
during refresh cannot be the silent killer; and winston's File transport is async, so the last record
can be lost before a fast `process.exit`. The real suspects (OOM / native abort / log-losing exit) were
exactly the gaps not covered. `try/catch` was already per-account in `runRefresh` — not re-touched.

**Blast radius** — additive only: no concurrency/refresh control flow changed (worker pool, throttle,
retries untouched). New disk writes are `logs/crash-log.txt` (append, on death only) + occasional
`logs/report.*.json` (on a fatal). The mem sampler is `unref()`'d → never holds the process open.

**Verification** — `npm run build` exit 0 · sync sink proven: forced a throw on an immediate-exit path →
`crash-log.txt` written before exit, stack present, proxy creds masked `***:***` · diagnostic report
proven: forced a real heap OOM (`--max-old-space-size=32`) → `Node.js report completed`, JSON landed in
`logs/`. Test artifacts removed. Live full-app refresh observation pending operator.

---

## Portable Master Vault — architecture rewrite ✅ (build green · self-test OK · 3 review rounds)

Replaces the Slice-D per-field vault with a **single portable `data/vault.enc`** (AES-256-GCM,
scrypt KDF, salt/iv/tag + cost params in the header — no machine binding). Per owner spec:

- **Portability** — verified: encrypt on "VPS A" → decrypt on "VPS B" with only the password;
  proxy creds + maFile secrets intact; wrong password rejected (GCM auth fail).
- **CLI boot prompt** (masked) — empty = plaintext mode UNLESS `vault.enc` exists (then required);
  headless uses `SSIM_VAULT_PASSWORD`. Server starts only after unlock, so no browser unlock screen.
- **Non-destructive import/merge** — boot + "Import bots" scan `mafiles/` + `accounts.txt`, merge ONLY
  new usernames, NEVER delete a source file, loud notice when new ones land. Idempotent/re-runnable.
- **Vault is the base for everything** — `loadMaFile` + `buildLogOnOptions` read maFile + password from
  the vault → every login, 2FA confirmation, trade, and market sell uses vault data, not `mafiles/`.
- **Decisions applied** — org (env/folders) stays in `accounts.json` (secrets blanked); existing accounts
  auto-migrate on first unlock; refresh tokens consolidated into the vault.
- New: `AccountVault.ts`, `vaultBoot.ts`, `maFiles.ts`. Removed: `SecretVault.ts`, `vaultMigrate.ts`,
  browser unlock modal, old `/api/vault/{setup,unlock,lock,migrate}` routes.

**Adversarial verification — 3 rounds (real-money credential core):**
- R1 (4 reviewers) → 7 issues incl. **1 CRITICAL** (a failed maFile load would blank a non-vaulted
  account's password) → all fixed.
- R2 (fixes review) → 2 more HIGH data-loss paths (broken-maFile re-vault via the looser lister; PATCH
  self-heal writing a blank password) → fixed with a single choke point (`importAccount` rejects any
  record without `shared_secret`/password) + a login fallback (blank vault pw never masks plaintext).
- R3 (convergence, dedicated to the invariant) → **safe: true, zero real issues.**

The non-destructive guarantee now holds even when a maFile is corrupt: an account is blanked in
accounts.json ONLY once it has a USABLE secret in the vault; otherwise its plaintext stays recoverable.

Verification: `npm run build` exit 0 · `SSIM_SELFTEST_OK v1.0.7` · standalone crypto round-trip OK ·
no `data/vault.enc` created by tests (your boot is unaffected until you set a password).

---

## Auto-import eradication — consent-strict import routing ✅ (typecheck + build green)

**What** — `vaultBoot.importIntoVault()` did three jobs in one boot-time call (`index.ts` →
`startFullApp`): (1) migrate accounts already in `accounts.json`, (2) **scan the `mafiles/` drop
zone and auto-import every loose maFile** into the vault + `accounts.json`, (3) migrate refresh
tokens. Job 2 ran on EVERY start with no env/folder, so it dumped loose maFiles into the root of
the first environment **without consent** — and the `/api/mafiles/import` vault branch reused the
same function, so it **ignored the operator's checkbox selection and imported all** drop-zone files.

**Fix** — split the one function in two with a hard consent boundary:
- `migrateAccountsIntoVault(accounts)` — BOOT-ONLY (the legitimate upgrade-from-no-vault path).
  Absorbs only accounts ALREADY registered in `accounts.json` + legacy refresh tokens. **Never
  scans `mafiles/`.** `index.ts:105` now calls this.
- `importDropZoneIntoVault(accounts, envId, folderId, selectedFiles)` — EXPLICIT UI-only. Requires
  an env and a non-empty selection; imports ONLY the ticked filenames (basename-guarded) into the
  chosen env/folder. `/api/mafiles/import` now requires `files` non-empty in BOTH vault + plaintext
  modes and forwards the selection.
- Removed the `defaultEnvironmentId()` fallback from `importCsvIntoVault` + `importExternalVault`
  (env is now a required, route-validated param) — no more "guess a target" on any import path.

**Blast radius** — boot no longer writes to the vault/`accounts.json` from loose files; only the
three explicit routes (`/api/mafiles/import`, `/api/import/csv`, `/api/import/vault`) do, each with
an explicit env + folder. Scenario-1 upgrade migration (existing `accounts.json` records) preserved.

**Verification** — `tsc --noEmit` green · `npm run build` green · `dist/` confirms `importIntoVault`
removed and the two split functions emitted. Live boot-with-loose-maFiles smoke test pending operator.

---

## Tail F–I — medium/low backlog ✅ (build green · self-test OK)

Conservative around the owner-protected buy/re-POST path (#6) and the build pipeline; large
refactors and untestable changes are DOCUMENTED, not shipped (see "Deliberately deferred").

**Reliability / money correctness**
- **#18 FIXED** — atomic-write temp filename now `pid.<seq><rand>` (was PID-only) → two writes to
  the same target can't collide. `atomicJson.ts`.
- **#32 FIXED** — `parseEurCents` delegates to the robust separator-detecting `parseSteamMoney(s,2)`
  (was a rigid heuristic that mis-scaled a format deviation 100×). `MarketPricing.ts`.
- **#39 FIXED** — `verifyToken` now runtime-validates the payload shape (hwid/key strings, finite
  exp/iat) before use → a signed-but-malformed token is rejected, not cast to NaN-grace. `LicenseClient.ts`.
- **#12 FIXED** — a genuine page-cap inventory truncation is now logged at ERROR as PARTIAL (was a
  silent warn) and detected precisely (`hitPageCap`). `InventoryManager.ts`.
- **#33 FIXED** — silent web-session cookie renewal now runs on ANY page (was page-0-only), so a
  mid-pagination cookie expiry recovers instead of discarding every fetched page. `InventoryManager.ts`.
- **#34 FIXED** — an unparseable "Tradable After" notice now fails SAFE (treated as locked, 7-day
  rolling placeholder) instead of defaulting to TRADABLE. `InventoryManager.ts`.
- **#44 FIXED** — buy re-POST result no longer reports contradictory `confirmed:true + needsConfirmation:true`
  (`confirmed = !stillNeeds`). The re-POST mechanism itself is untouched (#6). `AccountTrader.ts`.
- **#13 FIXED** — `InventoryStore.set` won't let an older concurrent fetch clobber a newer snapshot
  (newest `fetchedAt` wins). `InventoryStore.ts`.

**Lifecycle / defensive parsing**
- **#30 FIXED** — `refreshWebSession` dedups concurrent webLogOn via a per-session in-flight promise;
  the proactive 20-min timer now routes through it → no mismatched-listener race. `SessionManager.ts`, `session.ts`.
- **#17 FIXED** — pricing rate-limit retries are now bounded (6/name) with ±20s jitter (was unbounded,
  fixed 60s). `PricingService.ts`.
- **#40 FIXED** — the TOTP-retry timer is guarded by `settled` + unref'd → never fires on a torn-down
  client. `SessionManager.ts`.
- **#37 FIXED** — `TokenStore` load validates shape (string→non-empty); `refreshToken` event guarded.
  `TokenStore.ts`, `SessionManager.ts`.
- **#38 FIXED** — single-instance lock released on `process.on('exit')` (covers normal + post-fatal exits).
  `index.ts`.
- **#35 FIXED** — `MarketListings` skips entries with no usable name (no garbage into the priced bucket).
- **#68 OK** — already correct (resolution uses `paint_index != null && !== 0`; the `212` use is cosmetic).

**Security / UX**
- **#26 FIXED (partial)** — anti-CSRF Origin/Referer guard rejects foreign-origin mutating requests
  (defense-in-depth atop the Host allow-list). Full per-LOCAL-process auth (boot-token cookie) is the
  documented next step. `server.ts`.
- **#65 FIXED** — the 500 catch-all returns a generic message (logs the detail) — no internal leak. `server.ts`.
- **#48 FIXED** — a token issued for a different stored license key is rejected → fresh activation. `LicenseClient.ts`.
- **#74 FIXED** — `serve-website.js` path-traversal guard now requires ROOT or ROOT+sep (was a sibling-
  prefix-bypassable `startsWith`).
- **#52 FIXED** — license-denied now also writes + opens a styled HTML page (a double-clicked exe shows
  something, not just an invisible console). `lockscreen.ts`.
- **#70 FIXED** — `ExchangeRateService` tracks last-success time + `getInfo()` (fallback/age); surfaced in
  `/api/health.fx`. `ExchangeRateService.ts`, `server.ts`.
- **#46 FIXED** — buy-success is `Number(r.filled) > 0` (defensive coercion). `app.js`.

### Deliberately deferred / documented (with rationale)
- **#6, #20, #7, #14** — buy/re-POST path: owner-tested, "do not touch". #6 WONT-FIX; #20 (creator-match)
  left as-is (already id-strict, no "newest" fallback); #7/#14 mitigated by the wallet/inventory diff +
  buy()'s own fresh-funds re-check. Touching the confirmation/spend logic risks the tested flow.
- **#58** — central string layer: project deliberately REMOVED its i18n layer (v1.0.5, English-only);
  reintroducing one is churn with no language benefit. All German already eradicated.
- **#59** — list virtualization: a large frontend rendering refactor with real regression risk that I
  can't run-test here. Recommended (windowing the tree + tables) but deferred to a supervised pass.
- **#26 (process auth), #49/#50/#51 (update retry/min-version/temp perms), #60 (central outbound scheduler),
  #72 (pin pkg / drop shell:true)** — touch the license/update/build pipeline the operator compiles &
  ships; documented designs left for a supervised change to avoid breaking the one final compile.
- **#31, #36, #41, #42, #43, #45, #47, #62, #64, #67, #71, #73, #75** — low-severity; already mitigated by
  existing guards (WeakMap GC, `Number()||0` coercion, post-license construction, idempotent cancel) or a
  cosmetic/build-host concern. Listed in `AUDIT_LEDGER.md` for a future pass.

**Tail verification round (3 reviewers + confirmation pass) — 3 real issues found, all fixed:**
- **[HIGH] #26 regression** — the new CSRF Origin guard rejected the dashboard's OWN origin under a
  `HOST=<LAN-IP>` opt-in (LAN dashboard POSTs would 403). FIX: allow `boundHost` in addition to loopback. `server.ts`.
- **[LOW] #17a** — `rlAttempts` leaked a stale retry count on the non-rate-limit error branch. FIX below.
- **[LOW] #17b** — the `queued` dedup was released during the retry pause (the `continue` ran `finally`),
  letting a concurrent `ensureFilled` push a duplicate job. FIX: release the dedup mark + retry budget ONLY
  on a TERMINAL outcome (`requeued` flag); a re-queued job keeps both for its whole retry lifetime. `PricingService.ts`.

Verification: `npm run build` exit 0 · `SSIM_SELFTEST_OK v1.0.7` · `node --check app.js` OK.

---

## Slice A — Money-path idempotency & safe-failure (backend) ✅

- **#1 FIXED** — `TradeService.sendTrade` now holds a per-`(account|destination|item-set)`
  in-flight `Set` (mirrors `BuyService`). A duplicate concurrent send throws; `/api/trade/send`
  maps it to **HTTP 409** instead of firing a second real offer.
  Files: `src/trading/TradeService.ts`, `src/api/server.ts`.
- **#4 FIXED** — `AccountTrader.confirmOffer` now delegates to the previously-dead 4×-backoff
  `acceptConfirmationForObject` wrapper → trade-confirm + auto-accept get retry on transient
  mobile-conf 5xx. File: `src/trading/AccountTrader.ts`.
- **#5 FIXED** — `sendTrade` never throws after `offer.send()` resolves; a confirm failure
  returns `status:'unconfirmed'` + `offerId` (HTTP 200). The route classifies pre-placement
  failures as 409/400/502+`verifyBeforeRetry`, never a retryable 500. Added `unconfirmed` to
  `SendTradeResult` and `MassTradeJob`. Files: `AccountTrader.ts`, `TradeService.ts`, `server.ts`.
- **#6 WONT-FIX** — buy finalize re-POST left exactly as-is per owner directive (required +
  live-tested). Residual risk accepted; surrounding guards (BuyService in-flight Set + wallet/
  inventory diff) unchanged.
- **#28 (UI part)** — deferred to the frontend pass; consumes the new `unconfirmed` /
  `verifyBeforeRetry` signals.

Verification: `tsc --noEmit` → exit 0.

---

## Verification round — adversarial review (5 reviewers + per-issue confirmation) ✅

5 independent skeptics tried to refute each slice. Slices A, B, D were confirmed correct & complete.
6 issues raised → 5 confirmed real → all fixed:

- **[HIGH] Stale `dist/` — fixes weren't in the runnable artifact.** I had only run `tsc --noEmit`
  (emits nothing); `npm start`/`start.bat`/`ssim.exe` run `dist/`. **FIX: ran `npm run build`** → `dist/`
  rebuilt (exit 0); verified ProcessHealth/SecretVault/vaultMigrate emitted + all key changes present;
  `SSIM_SELFTEST_OK` smoke test passes. ⚠️ The packaged **`ssim.exe` is still the old build** — run
  `npm run build:protected` (needs `secrets.local.bat`) to re-pack it for distribution.
- **[MED] MONEY_OP breaker bypassable via mixed-case path** — Express routing is case-insensitive, so
  `POST /api/market/BUY` reached the handler but skipped the case-sensitive regex. FIX: added `i` flag
  (the `(\/|$)` anchor still excludes `buy-price`/`search`). File: `server.ts`.
- **[MED] `pollerStalled()` cross-run false-trip** — a stall record left over from a prior run (esp. via an
  error-path leak) could immediately trip a new, progressing job. FIX: `resetPoller(key)` at the START of
  every job (refresh/gc-refresh/mass-send/sell/folder-buy). File: `app.js`.
- **[LOW] #21 clock-rollback only partially closed** — absent integrity meta fell back to the token's `iat`
  (the original bypass). FIX: absent meta now fails closed (refuses grace → forces online). File: `LicenseClient.ts`.
- **[LOW] #28 trade-send UI didn't consume the new signals** — the deferred frontend item: `submitTrade`
  treated any 200 as success and dropped `verifyBeforeRetry`. FIX: `api()` now attaches `data`/`status` to
  thrown errors; `submitTrade` warns on `unconfirmed` (don't resend) and on `verifyBeforeRetry` (refresh +
  verify before retry), mirroring the buy path. File: `app.js`.

Final verification: `tsc` build exit 0 · `node --check app.js` OK · `SSIM_SELFTEST_OK v1.0.7` · German grep 0 hits.

---

## Slice E — Frontend hardening + English-only ✅

- **#53 + #54/#55/#56/#57 FIXED** — eradicated every German user-facing/log string: `app.js`
  (hide toggle, refresh-complete, hide/show, move label, sell total, maFile import, buy flow
  `Kaufe…`/`Gekauft`/`Buy Order platziert`/`Kein Marktpreis`, `ab`→`from`), `MarketService` mass-sell
  error, `MarketPricing` `[Preis-Modul]`→`[price]`, `start.bat` warning, `account.ts` comment.
  Verified: German-token grep over `src/`+`public/`+`*.bat` → 0 hits. (Exception: the documented
  Steam-localized error-match regex `bereits/vorhanden/aktiv` in `MarketService.ts:28-29` is functional,
  not user-facing — left intentionally.) A centralized string layer (#58, medium) was NOT added — the
  project deliberately removed its i18n layer in v1.0.5 (English-only); reintroducing one is out of the
  critical+high scope.
- **#27 FIXED** — `pollRefresh`/`pollMass`/`pollSell`/`pollFolderBuy` now stop after 3 min of zero
  progress while a job still reports `running` (wedged-job stall guard) and the folder-buy error loop is
  bounded the same way — no more infinite hot-loop / lying progress bar. File: `public/app.js`.
- **#28 FIXED** — a failed buy POST no longer implies a clean retry: it refreshes the buyer's inventory
  and tells the operator to verify before re-buying (a timed-out POST may have placed the order). The
  trade path already returns `unconfirmed`/`verifyBeforeRetry` from Slice A. File: `public/app.js`.
- **#29 FIXED** — item-icon `<img src>` (orders, inventory, buy/folder-buy search) now passes through a
  `safeIconUrl()` host allow-list (Steam CDNs + https only); a non-Steam URL renders no request, closing
  the IP-beacon vector. File: `public/app.js`.
- **Vault unlock UI** — `ensureVaultUnlocked()` blocks the dashboard behind a master-password prompt
  when the vault is configured-but-locked (completes the #2/#23 UX). No-op when unconfigured. File: `public/app.js`.

Verification: `node --check app.js` OK · `tsc --noEmit` exit 0 · German grep 0 hits.

---

## Slice D — Security at-rest & secrets ✅ (backend; frontend unlock UI in Slice E)

- **#2 + #23 FIXED (mechanism) — master-password encryption at rest.** New `src/core/SecretVault.ts`
  (scrypt KDF → AES-256-GCM, self-describing `ssimv1:` envelope, in-memory key only). Integrated
  decrypt-at-use / encrypt-on-write into `TokenStore` (refresh tokens), `LoginFlow`
  (password + maFile), `AccountManager` (passwords). **Non-breaking + opt-in:** when the vault is
  unconfigured/locked, `encryptField`/`decryptField` are passthroughs → an existing PLAINTEXT install
  is byte-for-byte unchanged (verified: `sanitizeAccount` strips password, so no API change). Secrets
  decrypt only at point-of-use (login), so boot/load never needs the key. API: `/api/vault/status|setup|
  unlock|lock|migrate`. `vaultMigrate.ts` encrypts existing secrets backup-first (maFiles → verified
  `*.plain.bak` before rewrite). Files: `SecretVault.ts`, `vaultMigrate.ts` (new), `TokenStore.ts`,
  `LoginFlow.ts`, `AccountManager.ts`, `SessionManager.ts`, `server.ts`.
  ⚠️ **Operator action required to ACTIVATE** (untested against the live 262-maFile fleet): set a master
  password → migrate → confirm unlock → securely delete `*.plain.bak`. Frontend unlock UI ships in Slice E.
- **#21 FIXED** — offline grace re-anchored from `payload.iat` to the LAST SERVER CONTACT
  (HMAC-protected `license.meta.json`) plus a clock high-water mark; a clock rollback below the
  highest-seen time now REFUSES grace. `markOnline()` on activate/recheck/heartbeat. File: `LicenseClient.ts`.
- **#24 FIXED** — `logger` gained a `redactSecrets()` format step (masks `scheme://user:pass@host`)
  on message + stack across both transports; the proxy-check route now redacts the error it returns
  to the client. Files: `src/utils/logger.ts`, `server.ts`.
- **#25 FIXED** — new `tsconfig.build.json` (no sourceMap/declarationMap/declaration); `build:protected`
  + `release` scripts now compile with it, so the prod `dist/` carries no readable pre-obfuscation source
  of the licensing/HWID surface. Files: `tsconfig.build.json` (new), `package.json`.
- **#22 DOCUMENTED** — the shared HWID pepper is a single client secret that bytecode/obfuscation only
  raise the cost of; documented the threat model + the explicit limit in `config.ts` (true fix is a
  server-side per-seat salt — out of client scope). Not a client-side code fix by nature.

Verification: `tsc --noEmit` → exit 0. Non-breaking confirmed (passthrough when vault unconfigured).

---

## Slice C — Process/session/resource lifecycle ✅

- **#11 FIXED** — `SessionManager.attemptLogin` now `destroySession()`s before throwing on an auth
  failure (the connection branch already did); a wrong-password/2FA-mismatch no longer leaks an
  ERROR session + live SteamUser client (open CM/proxy socket + listeners). File: `SessionManager.ts`.
- **#15 + #61 FIXED** — `PricingService` gained a `stopped` flag + `shutdown()`; `run()` is now
  `while (queue && !stopped)` wrapped in try/finally so it exits promptly on teardown and always
  resets `running`/flushes even on an escaped rejection. Wired into `index.ts` teardown + SIGINT
  (`pricing.flush()`→`pricing.shutdown()`). Files: `PricingService.ts`, `index.ts`.
- **#16 FIXED** — new `ProcessHealth` money-ops circuit breaker: `uncaughtException` records into a
  rolling window; a BURST (≥3/60s) quarantines new money POSTs (`/api/trade|market/...`) with a 503,
  surfaced via `/api/health.stable`. A one-off stray throw still survives (owner's never-exit design
  preserved). Files: `src/core/ProcessHealth.ts` (new), `index.ts`, `server.ts`.
- **#8 FIXED** — per-account logs route is now async and reads only the 512 KB tail via `readFileTail`
  (was sync `readFileSync` of the whole file, blocking the event loop). File: `server.ts`.
- **#63 FIXED** — winston File transports now rotate (`maxsize` 10 MB, `maxFiles` 5/3, `tailable`),
  bounding previously-unbounded log growth. File: `src/utils/logger.ts`.

Verification: `tsc --noEmit` → exit 0.

---

## Slice B — Inventory state integrity ✅

- **#3 FIXED** — `InventoryStore.get()`/`all()` now return deep `structuredClone` copies, so
  the API read-time overlays (`applyManualLock`/`tagCategories`/`enrichInv`, `ValueHistoryService`)
  can no longer write back into the persisted cache. `InventoryService.doRefreshOne`/
  `doRefreshOneViaGc` now return the cache's clone (not the object handed to `set()`), closing the
  refresh-then-enrich aliasing path too. `structuredClone` preserves the `Date` fields a JSON clone
  would corrupt. Files: `src/core/InventoryStore.ts`, `src/core/InventoryService.ts`.
  *Blast radius:* every inventory read; master-view `allCs2()` clones the fleet per poll — accepted
  correctness>micro-perf tradeoff (virtualization tracked as #59).
- **#9 FIXED** — `GcInventoryManager.connect` now subscribes to `disconnectedFromGC` (was absent),
  making a GC drop traceable; the existing `haveGCSession` guard re-handshakes. File: `GcInventoryManager.ts`.
- **#10 FIXED** — two layers: `fetchInventory` re-checks an empty GC backpack up to 3× (1.5s apart)
  before trusting a real zero; `doRefreshOneViaGc` refuses to overwrite a known non-empty GC cache
  with a 0-owned read (keeps the cached record, logs a suspected partial read). Files:
  `GcInventoryManager.ts`, `InventoryService.ts`.

Verification: `tsc --noEmit` → exit 0.

---

## Slice C — Trade safety, import folder routing & batch UX (2026-06-17) ✅

Six surgical fixes from live testing (Steam Error 15 on mass trade, import folder ignored,
missing batch ops). No architectural changes.

- **#1 Batch Move / Delete (multi-select)** — the multi-select master toolbar now exposes
  **"Move Selected"** and **"Delete Selected"** alongside Mass Buy / Refresh. Both reuse the
  exact single-account flows looped over the selection: `openMoveModal()` accepts an array and
  POSTs `/api/accounts/:u/move` per account; `batchDeleteAccounts()` confirms once then DELETEs
  each. Files: `public/app.js` (`renderSelectionMaster`, `openMoveModal`/`submitMove`/
  `closeMoveModal`, new `batchDeleteAccounts`, `state.moveUsernames`).

- **#2 Import ignored the selected folder** — `folderId` is now threaded end-to-end for ALL
  import paths (previously only the non-vault drop-zone honoured it). Backend: new
  `resolveTargetFolder()` validates the folder belongs to the target env (else → root, never
  orphaned); `importCsvIntoVault`, `importIntoVault` (vault drop-zone) and `importExternalVault`
  take a `targetFolderId`. For vault import an explicit folder WINS over the recreated source
  structure. Routes `/api/import/csv`, `/api/import/vault`, `/api/mafiles/import` pass it through.
  Frontend: CSV + vault handlers now send `el.bulkFolder.value`. Files: `src/core/vaultBoot.ts`,
  `src/api/server.ts`, `public/app.js`.

- **#3 Inventory search-bar "gap" (real root cause)** — NOT a margin issue. The `#toolbar`
  (search) was `position: sticky; top:0` with a SEMI-TRANSPARENT bg, and the `<thead>` was sticky
  at `top: var(--ssim-stick-top)` (toolbar height). While the list scrolled, the search bar floated
  OVER the rows with items bleeding around/through it → the "disjointed" look (confirmed by user
  screenshot: an item row above the search, headers + rows below). A first fix (toolbar non-sticky,
  headers sticky at `top:0`) surfaced a SECOND symptom: the scroll section's top padding (`p-8`)
  created a strip ABOVE the pinned header through which the first row peeked, half-clipped — looked
  like a "missing item". FINAL fix: BOTH the search toolbar AND the column headers are now
  NON-sticky — the whole table (search → headers → rows) scrolls as one clean block, so nothing
  floats over the list and no row is ever clipped behind a pinned header. Margins also tightened
  (toolbar `mb-5→mb-2`, facet/gc bars `mb-4→mb-2`); header keeps its opaque bg + bottom hairline.
  Trade-off: column headers no longer stay visible while scrolling a long list (acceptable; can be
  restored as a single opaque pinned block if desired). The dead `--ssim-stick-top` setter in
  app.js is left in place (harmless, unread). File: `public/index.html`.

- **#4 MAX_CONCURRENCY ceiling 50 → 25** — dynamic scaler upper bound lowered for local hardware /
  proxy stability; scaling logic unchanged. File: `src/utils/concurrency.ts`.

- **#5 / #6 Mass Trade "Error 15" (Access Denied)** — mass-send is now DECOUPLED from the global
  dynamic scaler (`scaleConcurrency` import removed from `TradeService`). Concurrency is HARDCODED
  to `TRADE_MAX_CONCURRENCY = 1` — offers go out fully serial, one-at-a-time (an explicit
  opts.concurrency may only lower it, never raise). A shared, jittered **global dispatch throttle**
  (`TRADE_MIN_DELAY_MS`=1000 → `TRADE_MAX_DELAY_MS`=2000, reserved time-slots so the gap is between
  ANY two offers) paces every offer's creation, preventing the per-recipient burst that trips
  Steam Error 15. File:
  `src/trading/TradeService.ts`.

Verification: `tsc --noEmit` → exit 0; `tsc` emit → dist rebuilt and grep-verified.

- **#7 Accurate Steam trade-error parsing (no secondary fetches)** — new
  `src/utils/steamTradeError.ts` (`parseSteamTradeError`) reads ONLY what Steam returned on a
  failed send: the `strError` text, the embedded `eresult` code, and the trade-offer lib's
  recognised `cause`. Priority: a full-RECEIVER-inventory message → its own explicit warning
  ("The recipient's inventory is full…"); a recognised cause → its friendly explanation;
  a known `eresult` → "Steam Error 15: Access Denied"; otherwise Steam's exact text passes through.
  NO follow-up request is made (we never fetch the receiver's inventory to "confirm" fullness).
  `TradeService.sendTrade` now rethrows the clean reason (with `eresult`/`cause`/`inventoryFull`
  attached) for BOTH single + mass sends; the frontend `surfaceTradeFailures()` groups identical
  reasons into persistent error toasts so one full inventory across many bots reads as a single
  clear warning. Files: `src/utils/steamTradeError.ts`, `src/trading/TradeService.ts`,
  `public/app.js`.

- **#8 "End Task" — safe, confirmed cancellation of any running mass action** — every mass job
  (Mass Buy, Sell, Trade, Refresh) gained a co-operative cancel: a `cancel*()` method sets a flag,
  the worker loops break BEFORE pulling the next account (the in-flight account/offer/order
  finishes its money-safe path — never interrupted), and the job ends normally with
  `cancelling`/`cancelled` status fields. Endpoints: `POST /api/{trade/mass-cancel,
  market/sell-cancel, market/folder-buy-cancel, inventory/refresh-cancel}` (all deliberately
  outside the MONEY_OP breaker regex so cancel always works). The UI shows an **End task** button
  whenever a run is live; clicking it requires an `ssimConfirm` ("Are you sure you want to end this
  task?") — NO instant kill — then POSTs the cancel and the existing poller reports the wind-down
  ("Cancelling…" → "ended"). Files: `src/trading/TradeService.ts`, `src/trading/BuyService.ts`,
  `src/trading/MarketService.ts`, `src/core/InventoryService.ts`, `src/api/server.ts`,
  `public/index.html`, `public/app.js`.
