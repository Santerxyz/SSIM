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
