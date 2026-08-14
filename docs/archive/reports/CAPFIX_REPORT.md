# Capability-token loss — root cause & fix (v1.4.0, branch `release/1.4.0`)

**Symptom (owner report):** mid-session, every money/settings/vault action fails with
"Missing or invalid capability token …" / the "This session lost its authorization" banner,
while reads keep working. Only a full restart helps — and on the next boot it breaks again.

## Root cause (proven live against the shipped v1.4.0 exe)

The dashboard **never receives the capability token on any vault-protected boot** — i.e. on
every real install. It is not "lost mid-session"; the session is capless from the start, and
the failure only *surfaces* at the first write action.

Chain:

1. The backend mints the per-run token and prints `SSIM_CAP=` + `SSIM_PORT=` when the **first**
   server binds the UI port ([serverPort.ts:99-107](src/utils/serverPort.ts:99)). On a real boot
   that first server is the **vault-unlock portal** (or the activation portal on first launch) —
   not the dashboard ([index.ts:290](src/index.ts:290), [unlockPortal.ts:179](src/core/unlockPortal.ts:179)).
2. The shell's port latch is one-shot per backend spawn ([lib.rs](src-tauri/src/lib.rs) `handled_port`).
   It navigates the window once and delivered the token via a navigate-time `eval` plus two timed
   re-seeds at 600/1800 ms. All of these land in the **portal document**, because the operator
   spends far longer than 1.8 s typing the Master Password.
3. `unlock.html` has no `__SSIM_CAP__` handling — it neither uses nor persists the token. When the
   vault opens, the portal swaps itself for the dashboard via `location.replace('/')`, which wipes
   `window.__SSIM_CAP__` with the portal document. In sidecar mode `index.html` is served clean
   (by design), the shell never re-injects, so the dashboard has no token and nothing in
   `sessionStorage` → every POST/PUT/PATCH/DELETE and secret-GET 401s for the whole process life.
4. The earlier S1 fix (sessionStorage stash in `capToken()`, commit `f5b5359`) only ever worked for
   **portal-less** boots (dev runs with `SSIM_VAULT_PASSWORD` set — which is why self-tests and dev
   sessions never reproduced it). The stash never ran because the dashboard never saw the token.

## Live repro (shipped `release-tauri\SSIM\SSIM.exe`, isolated `SSIM_HOME`, CDP into the webview)

Before the fix:

| Where | `window.__SSIM_CAP__` | `sessionStorage ssim_cap` | app's own `api()` probe |
|---|---|---|---|
| Unlock-portal document | SET (64 hex) | — (page never stashes) | — |
| Dashboard after unlock | **undefined** | **null** | **401 `capabilityRequired:true`**, banner `#capability-banner` rendered |

That reproduces all three owner toasts (per-action toast, "Could not load the saved proxy: …",
and the authorization-lost banner) from one mechanism.

## Fix (root cause, security model unchanged)

Delivery is now **page-load-driven instead of timing-driven**. The main window's existing
`on_page_load` hook ([lib.rs](src-tauri/src/lib.rs), setup()) re-injects the token on **every
finished page load whose origin is exactly `http://127.0.0.1:<announced port>`** — the portal
pages, the dashboard the portal swaps in, F5 reloads, and WebView2 recovery. A new
`should_inject_capability(url, port)` gate (unit-tested) ensures the token can never be evaluated
into the splash (tauri asset origin) or any foreign document. The racy 600/1800 ms re-seeds were
removed; the immediate post-navigate eval stays as a harmless fast path.

- Same channel as before: token travels shell↔backend over the stdout pipe and enters the page
  only via webview-internal `eval` — never over HTTP, never on disk, never into `index.html`.
- The guard (`capabilityGuard`), the protected-route set, and the frontend stash are untouched.
- No retry/reload wrappers; the "restart" banner logic stays (it should simply never fire now).

Files: `src-tauri/src/lib.rs` only (+ this report). New Rust test:
`capability_injects_only_into_backend_origin` (`cargo test`: 5 pass).

## AFTER — live verification on the rebuilt exe (2026-07-08, all legs pass)

Same flow (fresh isolated `SSIM_HOME`, shipped-style boot through the unlock portal, CDP into
the webview; the probe is the app's own `api()` on the protected secret-GET
`/api/accounts/<nonexistent>/proxy` — 401 = guard rejected, 404 = guard passed, handler reached):

| Leg | `window.__SSIM_CAP__` | sessionStorage stash | `api()` probe | banner |
|---|---|---|---|---|
| Unlock-portal document | SET (64 hex) | — | — | — |
| Dashboard after portal swap | **SET** | **stashed** | **404** (authorized) | none |
| Dashboard after hard `location.reload()` | **SET** | **stashed** | **404** (authorized) | none |

Identical flow on the pre-fix exe gave `undefined` / `null` / **401 capabilityRequired** + banner.

Builds & tests: `cargo test` 5/5 (incl. new origin-gate test) · `npm test` 1043 pass / 0 fail
(baseline unchanged) · `npm run build:tauri` → `release-tauri\SSIM\SSIM.exe` 177.1 MB,
`SSIM_SELFTEST_OK v1.4.0`.

## Rollback

One line: `git revert <capfix commit>` on `release/1.4.0`, then `npm run build:tauri`.
(A byte-copy of the pre-fix exe is parked in the session scratchpad as `SSIM.exe.v140-pre-capfix.bak`.)
