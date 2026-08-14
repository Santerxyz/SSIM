# SSIM Open-Beta — Blocker Ledger

Class: (D) data loss · (S) secret leak · (B) brick · (N) ban risk · (C) crash · (W) wrong money/trade.
Status: OPEN · FIXED (commit) · PARKED (needs human) · WONTFIX (justified). PROVEN vs HYPOTHESIS per finding.

Source: parallel subsystem audit 2026-07-02 (5 of 11 auditors returned before session-limit;
frontend/licensing/boot/pricing/csfloat/ledger auditors to re-run after reset). All findings
verified against current code before fixing.

---

## FIXED

| ID | Class | File:line | Summary | Commit | Test | Proven |
|----|-------|-----------|---------|--------|------|--------|
| B01 | C | SessionManager.destroySession | Agent destroyed while requests in flight (quiescent-retire) | 468609f | agentTeardown.test.ts | PROVEN |
| B02 | C | SessionManager.destroySession | No live 'error' listener if sweep throws → unhandled 'error' | 468609f | teardownQuiescence.test.ts | PROVEN |
| B03 | N | InventoryService.refreshAfterTrade | Unbounded fan-out, no throttle, no session release | 468609f | teardownQuiescence.test.ts | PROVEN |
| B04 | C | SessionManager.destroySession | Zombie steam-user client self-resurrects via _logonMsgTimeout → uncapped CM login storm (native-crash lead) | (zombie) | teardownQuiescence.test.ts | PROVEN |
| B10 | W | AccountTrader.createBuyOrder | Re-POST throw after placed → duplicate-order retry | (buy) | buyOrderMoneySafety.test.ts | PROVEN |
| B11 | W | MarketService.processBot | Non-EUR wallet lists ~99% underpriced | (sell) | sellCurrencyGuard.test.ts | PROVEN |
| B12 | W | AccountTrader.createBuyOrder | POST'0' throw → phantom order → double-order | (buy) | buyOrderMoneySafety.test.ts | PROVEN |
| B13 | W | server.ts MONEY_OP_ROUTE | Breaker missed CSFloat cash + confirmations | (breaker) | moneyBreakerPacing.test.ts | PROVEN |
| B15 | W | BuyService.buy | Partial baseline → wrong fill count | (b15) | buyPartialBaseline.test.ts | PROVEN |
| B17 | W | server.ts csfloat listings | 0/negative create-listing price | (breaker) | — | PROVEN |
| B23 | S | maFiles.resolveMaFilePath | maFile import path traversal | (vault) | maFilePathContainment.test.ts | PROVEN |
| B30 | D | AccountVault | No version validation → downgrade strips newer sections | (vault) | vaultHardening.test.ts | PROVEN |
| B33 | B | AccountVault | Corrupt vault.enc → WRONG_PASSWORD, no .bak fallback | (vault) | vaultHardening.test.ts | PROVEN |
| B20 | S | AccountManager/AccountVault | Env proxy creds plaintext in accounts.json | (vault) | vaultHardening.test.ts (round-trip) | PROVEN |
| B44 | N | TradeService.batchOfferAction | No inter-action pacing (Error-15) | (breaker) | moneyBreakerPacing.test.ts | PROVEN |
| B45 | N | MarketService | itemDelayMs:0 removes all pacing | (breaker) | — | PROVEN |
| B21 | S | vaultBoot | Plaintext token/key files kept after migration | (quar) | plaintextQuarantine.test.ts | PROVEN |
| B26 | S | server/capability | Local API unauthenticated to local processes | (cap) | capabilityToken.test.ts | PROVEN |
| P4/G5 | D | singleInstance | TOCTOU + fail-open double-run → store races | (lock) | singleInstanceLock.test.ts | PROVEN |
| B43 | N | SessionManager | ERROR session keeps polling on dead cookies | (sess) | — | PROVEN |
| B46 | C | SessionManager | MAX_LIVE ceiling TOCTOU overshoot | (sess) | — (race-free by construction) | PROVEN |
| B47 | C | server.hostnameOnly | IPv6 loopback Host 403'd a legit ::1 bind | (sess) | hostGuard.test.ts | PROVEN |
| B42 | N | AccountVault/PATCH | Token-only account proxy silently dropped | (proxy) | vaultHardening.test.ts | PROVEN |
| B31 | D | InventoryService.doRefreshOne | TF2/forceRefresh empty read wiped cache | (b31) | refreshEmptyReadGuard.test.ts | PROVEN |
| B40 | N | SessionManager idle reaper | Single-op sessions accumulate to 150 ceiling | (reaper) | idleReaper.test.ts | PROVEN |
| P6 | E | app.js/repriceReconciler | 90s cap → long price fill never reaches UI | (reprice) | repriceReconciler.test.ts | PROVEN |
| B24/B25 | S | server redaction | Error/legacy-format proxy creds leak | (redact) | proxyRedaction.test.ts | PROVEN |
| B32/34/35/36 | D/B | vault/vaultBoot | token sync-save/backup/ext-import/orphan-vault | (vault2) | vaultHardening,orphanVaultGuard | PROVEN |

### SECOND-WAVE (audit round 2: licensing/boot/pricing/csfloat/frontend) — FIXED
| AF1 | B | singleInstance:73 | **Fresh-install brick** (ENOENT + fail-safe refuse) — REGRESSION from P4 | (audit) | auditFollowups.test.ts | PROVEN |
| AF2 | B | LicenseClient heartbeat | Bare 403 (WAF/portal) = revocation → license torn down | (audit) | — (contract-verified) | PROVEN |
| AF3 | B | Updater self-test 120s | < build budget 180-200s → slow machine can't-update brick | (audit) | — | PROVEN |
| AF4 | E | repriceReconciler | fetched-reset broke the reconciler → new fill ignored | (audit) | auditFollowups.test.ts | PROVEN |
| AF5 | W | app.js submitTrade | Single send never re-pulled → sent items shown owned | (audit) | — | PROVEN |
| AF6 | W | CsFloatDeliveredStore | Corrupt file → mass re-delivery (2nd offer per sale) | (audit) | auditFollowups.test.ts | PROVEN |
| AF7 | S | app.js csfImg | CSFloat icon bypassed host allow-list (IP beacon) | (audit) | — | PROVEN |
| AF8 | B | build/publish.js | Post-publish never verified served manifest sig | (pubsig) | — (owner-run) | PROVEN |
| AF9 | W | index unhandledRejection | Money breaker blind to async rejection bursts | (audit) | — | PROVEN |

## OPEN — ordered by severity

### W (wrong money/trade)
- **B10 · W · blocker · AccountTrader.ts:838** — buy-order finalize re-POST can THROW after the
  order is placed+confirmed (axios network error on `await post(creator)`), escaping the
  never-throw-after-placed barrier → route returns 502 → operator retry places a SECOND real
  buy order (resting orders don't debit wallet, so the balance check passes). Fix: wrap the
  re-POST in try/catch, return placed:true on a network throw (does NOT alter the re-POST shape
  — strengthens the never-throw intent). Owner-protected path: preserve one-re-POST-with-
  confirmation=creator exactly. PROVEN.
- **B11 · W · major · MarketService.ts:407 / AccountTrader.ts:683** — sell path has NO wallet-
  currency guard: prices computed in EUR (MarketPricing hardcodes currency=3) but Steam
  interprets the `price` field in the SELLER's wallet currency → a non-EUR-wallet account lists
  ~99% underpriced and sells instantly. Fix: fail closed (or convert) when trader.walletCurrency
  known and !== 3. PROVEN.
- **B12 · W · major · AccountTrader.ts:789** — no phantom-order reconciliation on buy path: a
  network throw on POST#1 (`await post('0')`) → order may exist but reported as clean failure →
  retry double-orders. Sell side probes getListedAssetIds; buy side never checks getMarketOrders.
  Fix: on network throw, query getMarketOrders for a matching resting order, return placed:true.
  PROVEN.
- **B13 · W · major · server.ts:305** — MONEY_OP breaker regex omits ALL csfloat money routes
  (buy/listings/buy-orders) and confirmations/respond → while quarantined for corrupt state, a
  real-cash CSFloat buy or a mobile-confirmation approval still executes. Fix: extend regex /
  per-route MONEY flag. PROVEN.
- **B14 · W · major · MoneyOps.ts:14** — all idempotency is process-memory only; no persisted op
  journal, no boot reconciliation → a kill between POST and verification + operator re-run
  duplicates the committed money/asset action. Fix: append-only op journal + boot cross-check.
  PROVEN. (Larger; assess scope.)
- **B15 · W · minor · BuyService.ts:171** — FIXED (commit b15). post-buy fill verification ignored
  a PARTIAL baseline read (C11 fix asymmetric). Now `baselinePartial → verifyFailed=true`. Test:
  buyPartialBaseline.test.ts.
- **B16 · W · minor · AccountTrader.ts:683 — NON-BLOCKER (CS2-only by construction).** sellOnMarket
  hardcodes 730/2, but `/api/market/sell` accepts only `{username,assetId,marketHashName}` (no
  appId) and MassSellGroup carries none — the sell path is CS2-only and a TF2 asset cannot be
  routed here with a TF2 appId. The theoretical assetId-collision requires manually feeding a TF2
  id as CS2, which the UI never does. Parameterizing an unexposed path is gold-plating; documented.
- **B17 · W · minor · server.ts:746** — POST csfloat listing accepts 0/negative price (PATCH edit
  rejects <1). Fix: same `price>=1` + upper-bound validation. PROVEN.
- **B18 · W · minor · MarketPricing.ts:150** — 0-decimal wallet currencies (JPY/KRW/…) likely
  mis-scale buy prices 100x (safe direction — order never fills). HYPOTHESIS (needs live check).
- **B19 · W · info · AccountTrader.ts:639** — offer confirmed-on-phone mid-poll → reported
  'unconfirmed' (status lie, NO duplicate action). Fix: re-fetch getOffer before labeling. PROVEN.

### S (secret leak)
- **B20 · S · major · AccountManager.ts:122** — environment proxy creds (user:pass) written
  PLAINTEXT to Vault/accounts.json even in vault mode (only per-account fields blanked). Fix:
  vault envProxies section + blank Environment.proxy in the written copy. PROVEN.
- **B21 · S · major · vaultBoot.ts:171** — refresh_tokens.json(.bak) + csfloat_keys.json(.bak)
  left plaintext FOREVER after vault migration (C18/INV-A3 residual). Fix: verified-import
  quarantine (re-read+decrypt vault, string-equal check, then remove). PROVEN.
- **B22 · S · minor · vaultBoot.ts:252** — mafiles/ plaintext maFiles + accounts.txt never removed
  after verified import (by design; console NOTICE only). Fix: opt-in verified-import quarantine
  MOVE (never auto-delete; LoginFlow still disk-falls-back for non-vaulted). PROVEN.
- **B23 · S · minor · maFiles.ts:16** — maFile import path has NO containment: absolute + ../
  traversal accepted on single-account add/attach/patch (bulk path uses basename). Error echoes
  the absolute path. Fix: resolve+basename+containment, generic error. PROVEN.
- **B24 · S · minor · logger.ts:22** — legacy non-URL proxy formats bypass redactSecrets +
  redactProxyCredentials → creds visible in GET /api/environments list. HYPOTHESIS (all current
  writers normalize; only pre-normalize on-disk values at risk). Fix: normalize at load / teach
  redactors the legacy forms.
- **B25 · S · minor · server.ts:1307** — money-route error handlers echo raw err.message without
  redactSecrets (only proxy-check route redacts). HYPOTHESIS (depends on message containing proxy
  URL). Fix: route client-facing/logged errors on proxied paths through redactSecrets.
- **B26 · S · info · server.ts:206 (P5)** — FIXED (commit cap). Boot capability token: backend
  generates a per-run secret (src/api/capability.ts), emits SSIM_CAP on stdout (sidecar) →
  Tauri shell injects window.__SSIM_CAP__ out-of-band (curl can't read the pipe/webview); dev/
  Edge injects into index.html. capabilityGuard 401s every mutation + secret GET without a valid
  token; app.js api() attaches X-SSIM-Cap and awaits it for mutations. Tests:
  capabilityToken.test.ts (guard blocks forged-origin, exact-match, ?cap= query, open reads).
  NOTE: dev/Edge HTML-injection is the weaker documented path (scrapeable); Tauri is robust.

### D (data loss) / B (brick)
- **B30 · D · major · AccountVault.ts:242** — no vault version validation: newer-format vault.enc
  opened by older binary (downgrade) → normalizePayload strips unknown sections on next boot-save
  (unrecoverable after 2 saves); envelope change → misreported WRONG_PASSWORD. Fix: reject v>1
  with distinct error, preserve unknown keys, versioned .bak. PROVEN.
- **B31 · D · minor · InventoryService.ts:512** — doRefreshOne (TF2 + CS2 forceRefresh) lacks the
  empty-read/page-cap guards that doRefreshOneViaGc has → a transient empty read WIPES the cached
  backpack, silently disabling the send-side lock guard for TF2. Fix: port the guards. PROVEN.
- **B32 · D · minor · AccountVault.ts:141** — refresh token persisted via 1.5s debounced unref'd
  save → kill in the window strands a just-imported token-only LIMITED account (no login path).
  Fix: synchronous save on first-mint. PROVEN.
- **B33 · B · minor · AccountVault.ts:106** — corrupt vault.enc reported as WRONG_PASSWORD; no
  automatic .bak fallback → operator thinks they forgot the password (soft brick of all creds).
  Fix: on GCM fail, retry against vault.enc.bak; only WRONG_PASSWORD if both fail. PROVEN.
- **B34 · D · minor · AccountManager.ts:127** — no accounts.json backup in vault mode → a single
  bad write/hand-edit loses the whole 500-account org structure (secrets survive in vault). Fix:
  backup:true once the file is provably secret-free. PROVEN.
- **B35 · D · minor · vaultBoot.ts:349** — importExternalVault silently drops the source farm's
  token-only LIMITED accounts (iterates ext.accounts only). Fix: also iterate ext.tokens. PROVEN.
- **B36 · B · minor · vaultBoot.ts:75** — headless boot silently CREATES a new empty vault when
  vault.enc is missing (mis-set SSIM_HOME / partial restore) → 500 accounts with no creds, no
  signal. Fix: refuse in headless when accounts.json has blank-password accounts but no vault.enc.
  PROVEN.

### N (ban) / C (crash)
- **B40 · N · major · InventoryService.ts:690** — single-send / getTradeUrl / manual refresh /
  refreshAfterTrade never release sessions + no idle reaper → residents accumulate to
  MAX_LIVE_SESSIONS(150), then ALL new-account logins refused; each resident also carries a
  polling TradeOfferManager. Fix: idle-session reaper or release discipline on single ops. PROVEN.
- **B41 · W · major · InventoryService.ts:625** — no session refcount: bulk/mass release logs out
  a session a concurrently-started money op borrowed → in-flight createBuyOrder dies ECONNRESET →
  retry double-order. Fix: refcount session usage / veto logout when a money op holds the account.
  PROVEN.
- **B42 · N · major · server.ts:885** — PATCH proxy silently dropped for token-only (LIMITED)
  accounts in vault mode → next login goes out over the wrong egress IP (env proxy / raw local
  IP) → ban risk. Fix: 400 on unstorable proxy, or dedicated vault map for token-only proxies.
  PROVEN.
- **B43 · N · minor · SessionManager.ts:484** — post-settle fatal 'error' leaves an ERROR-state
  session resident: TradeOfferManager keeps polling on dead cookies forever (isLive false → bulk
  release skips it). Fix: schedule destroySession on post-settle fatal. PROVEN.
- **B44 · N · minor · TradeService.ts:322** — batchOfferAction streams accept/decline/cancel with
  ZERO inter-action pacing (mass-send floors 1-2s for exactly this Error-15 reason). Fix: reuse
  the jittered dispatch throttle. PROVEN.
- **B45 · N · minor · server.ts:1559** — mass-sell forwards client itemDelayMs with no floor
  (0 ?? 1200 === 0 removes pacing fleet-wide). Fix: Math.max(MIN, …). PROVEN.
- **B46 · C · major · SessionManager.ts:157** — MAX_LIVE_SESSIONS ceiling is TOCTOU (checked
  before acquireLoginSlot, inserted after; removed during backoff) → a burst admitted while size
  momentarily low overshoots the budget. Fix: re-check after slot acquire / atomic admitted
  counter. PROVEN.
- **B47 · C · minor · server.ts:195** — inline Host allow-list mishandles IPv6 loopback
  (split(':')[0] on '[::1]:port' → '[') → 403s a legitimate ::1 bind (disagrees with originGuard).
  Fix: parse Host with the shared regex. PROVEN (edge case: HOST=::1 only).
- **B48 · info · InventoryService.ts:608** — createdSession ownership map cross-op clobber (leak-
  only). Partially mitigated by B03's per-op discipline; revisit with B40/B41.

### Correctness asymmetries (non-blocker, log)
- MarketListings.ts:69 later-page fetch failure truncates listed superset silently (heals next
  refresh). listingsOk=false double-counts ctx16-listed assets. refreshAfterTrade always CS2 even
  after TF2 send. markListed revertible by stale-data refresh (fetchedAt at construction). BanService
  docstring claims a nonexistent test + 20/50 comment drift.

---

## PARKED (needs external human/server action or real Steam accounts)
- **B14 · W · money-op restart journal** — a process KILL between a money POST and its local
  verify/log, followed by a manual re-run of the SAME op, can double-act. The network-error
  variant is already closed (B10/B12: probe/verifyBeforeRetry, never a blind retry). The full fix
  (persist op-intent before commit + boot-reconcile against Steam's open orders / sent offers)
  needs REAL Steam accounts to verify the reconcile. PARKED. *Human verification:* on restart after
  a killed mass-buy/send, confirm SSIM surfaces the interrupted op and does not silently re-run it.
- **B41 · W · session refcount** — a bulk/mass release can log out a session a concurrently-started
  money op borrowed. Harm (mid-buy teardown → duplicate on retry) is mitigated by B10/B12
  (network-error-safe) + B40 markUsed (an in-use session isn't reaped). Full acquire/release
  refcount DEFERRED (higher regression risk than residual value now the money path is safe).
- **#22 HWID pepper** — shared per-binary secret; a true fix is a server-side per-seat salt
  (license-server change). Client-side confirmed: never in logs/responses. Residual risk stated.
- **CSFloat live §8 / license-server dual-sign rollout / real-account regression** — owner-gated
  (deploy + credentialed live checks). See RELEASE_READINESS_OPENBETA.md "Human steps left".

## NON-GATING (logged, not beta-blockers)
Second-wave minors kept but not gating: licensing #migration-relaunch (existing two-file fleet only,
not new single-exe installs) + tmpdir cross-volume swap (unproven); boot writeCrash sync-write on
death (unproven) + shell 40s wait_for_port (unproven); csfloat delivered-id persisted-after-send
(single-sale race; mass case fixed by AF6) + clean-browser teardown-under-live-window (unproven);
frontend modal onModalClose leak / buy-modal per-keystroke wallet fetch / poller-abort-on-transient
/ casket panel staleness (UX); csfloat key-store mode-switch key visibility (F-4, VIOLABLE; cleartext
file leak fixed by B21). Ledger tail #31,36,41–43,45,47,49–51,58–60,62,64,67,71–73,75 (UX/build/cosmetic).

## Guard test-coverage gaps to close (load-bearing, currently untested)
buy-order finalize re-POST (createBuyOrder — ZERO coverage), strict buy-confirmation match,
MAX_CONCURRENT_LOGINS / MAX_LIVE_SESSIONS, clampConcurrency/scaleConcurrency, LocalIpThrottle,
InventoryStore newest-wins, reconcilePartialRead / truncated / listingsOk carry-forward, markListed,
runRefresh release wiring, AccountVault crypto round-trip + non-destructive import + addMany,
redactSecrets / sanitizeAccount, originGuard, MONEY_OP regex route-set.
