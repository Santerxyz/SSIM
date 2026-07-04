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
