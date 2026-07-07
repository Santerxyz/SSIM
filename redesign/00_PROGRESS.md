# SSIM Frontend Redesign — Progress Tracker

Branch: `redesign/frontend-v2` (off `fix/reliability-remediation` = the hardened v1.3.5 line + all P1/P2/P3 fixes).
Goal: ship the **masterpiece design** as the real, functional app frontend, then compile the exe. Owner is all-in.

## RELEASE VERSION → **1.4.0** (owner-set for the new frontend)
Bump 1.3.5 → **1.4.0** as part of the **Compile** step, BEFORE `build:tauri`, in exactly two files:
- `package.json:3` `"version"` — the SINGLE SOURCE OF TRUTH (`src/index.ts:27` reads `pkg.version`; the backend serves it; the UI footer shows it at runtime).
- `src-tauri/tauri.conf.json:4` `"version"` — the exe/window metadata. (NOTE: this file has pre-existing uncommitted edits — set version to 1.4.0 without disturbing them.)
Invariant to preserve in the new UI: the footer version is read from the API/`data.version` (legacy `app.js:6527`), NEVER hardcoded — so it auto-shows v1.4.0. Do the bump at compile time (not during dev). Publishing the 1.4.0 update manifest is the owner's separate web-panel step — compile only, do not publish.

## RESUME PROTOCOL
At the start of any session (incl. after compaction): read this file, continue at the first unfinished item; never rebuild finished views. Resume phrase: *"Continue the redesign per redesign/00_PROGRESS.md."* Work is on branch `redesign/frontend-v2`; commit per view/milestone. The live app frontend (`public/`) is only cut over at the very end after verification — the immutable legacy copy in `redesign/legacy_public/` is the rollback (see ROLLBACK.md).

## STRATEGY (decided)
**Re-skin, preserve function.** The design source of truth is `redesign/design_source.html` (the owner's masterpiece — a design prototype: gorgeous markup/CSS, but ZERO backend wiring / mock data). The functional source of truth is the legacy `redesign/legacy_public/app.js` (6,788 lines) + `index.html` (1,552) — proven backend wiring, capability-token reload survival, polling, virtualization, all handlers.
The port keeps the legacy **function** (API calls, state, handlers, invariants) and replaces the **form** (DOM markup + CSS) with the masterpiece design. We do NOT rewrite proven logic from scratch; we re-emit the new markup from the existing render functions and swap the stylesheet/shell. Backend (`src/`, `src-tauri/`, `build/`) is FROZEN — bind to the API exactly as-is.

## SACRED INVARIANTS (never regress — each verified in VERIFICATION.md at Phase 4)
1. Balance tri-state: never-refreshed "—" / refreshed-empty (hasWallet=false) "0,00" / funded value. Never gate wallet display on truthiness.
2. One refresh button (full pipeline); the quick ctx2 buy-verify stays where legacy puts it. No second refresh affordance.
3. `ssimConfirm` on every money action — zero native confirm()/alert().
4. Layering law (S68): alerts/toasts topmost; the Live Logs launcher (bottom-left) + ambient elements never occlude alerts/modals. One documented z-scale.
5. Pricing honesty (S2/S13): long fills show progress + ETA; a failed fetch looks distinct from "no price".
6. Reload survival (S1): after a hard UI reload, all writes still work — recreate the capability-token re-delivery faithfully.
7. Fleet scale: 500+ accounts / thousands of items stay smooth — virtualization + event delegation preserved.
8. Brand: English-only, "Santer", accent #9333ea; the masterpiece's design system/tokens are authoritative.
9. Capability ceiling = legacy exactly. No native sign-in, no GC features. Nothing added that was cut.

## PHASES
- [x] Phase 0 — setup: branch, `redesign/legacy_public/` (rollback), `redesign/design_source.html`, this tracker, ROLLBACK.md
- [x] Phase 1 — extraction contracts: API_CONTRACT (100 endpoints, 11 polls), PARITY (~636 rows / 26+ 💰), DESIGN_SYSTEM (69 tokens, ~60 components, 25 overlays), PORT_PLAN (713 lines — re-skin strategy, cap-token preserved verbatim). Committed 1b34a4d.
- [ ] Phase 2 — design system + primitives in new `public/` (tokens, buttons, inputs, tables, modals, toasts, badges, tabs, tooltips, confirm, skeletons, the Live Logs launcher + layering)
- [~] Phase 2 — DS + app shell + portals ✅ (V1, V20–V23) committed dce6517: index.html re-skinned, 292 ids preserved, offline, app.js untouched.
- [~] Phase 3 — re-skin view render functions V2–V19 in new_public/app.js (serial, idempotent via `_P3_DONE.md`, node --check gate per view). **DONE: V2 V3 V4 V5 V6 V7 V8💰 V9💰 V10💰 V11💰 V12💰 V13💰 V14💰 V15💰 V16💰 V17.** Remaining: V18 import → V19 settings.
- [ ] Phase 4 — verification: contract audit (API_CONTRACT row-by-row), parity audit (PARITY row-by-row), invariant audit (VERIFICATION.md), live run against the backend (NO money actions — those go to LIVE_TEST_CHECKLIST.md), perf sanity at 500+ accounts
- [ ] Cutover — replace `public/` with the new frontend (legacy_public/ = rollback), `npm run build && npm test`, smoke-test the live app
- [ ] Compile — **bump version 1.3.5 → 1.4.0** (package.json + src-tauri/tauri.conf.json; see RELEASE VERSION above), then `npm run build:tauri` → SSIM.exe (needs secrets.local.bat for the fail-closed bake; present). Do NOT publish (owner's web-panel step).

## DELIVERABLES (redesign/)
`00_PROGRESS.md`, `API_CONTRACT.md`, `PARITY.md`, `DESIGN_SYSTEM.md`, `PORT_PLAN.md`, `CHANGES.md` (deliberate flow changes), `VERIFICATION.md`, `LIVE_TEST_CHECKLIST.md`, `OWNER_NOTES.md`, `ROLLBACK.md`, `legacy_public/` (untouched), `design_source.html`.

## PAUSED at V4 (2026-07-06) — quota; shipping hardened v1.3.6 this week instead
Owner hit 99% weekly quota. Phase 3 re-skinned **V2, V3, V4** (committed c498059/0ee7d3d/14fab0c) before pause; V5–V19 pending. `new_public/` is a HALF-skin (new shell+portals+V2–V4, old markup for V5–V19) — NOT shippable. Decision: **compile the COMPLETE hardened build (fix/reliability-remediation) as v1.3.6 and ship this week** (old design, all 281 P1/P2/P3 fixes, 946 tests green). The new design (this branch) **resumes next quota window** and ships as **v1.4.0**.
**RESUME next window:** `git checkout redesign/frontend-v2`, then relaunch Phase 3 (idempotency via `_P3_DONE.md` skips V2–V4) → V5…V19 → Phase 4 verify → cutover → compile v1.4.0. Rollback unaffected (legacy_public/ + fix/reliability-remediation).

## Session log
- 2026-07-06 · Phase 0 done: branched redesign/frontend-v2, legacy backed up, masterpiece = design_source.html, strategy = re-skin/preserve-function. Phase 1 extraction launched.
- 2026-07-06 · Phases 1–2 done (contracts + DS/shell/portals). Phase 3 started, reached V4/18, then PAUSED at 99% quota. Shipping hardened v1.3.6 this week; redesign resumes as v1.4.0 next window.
- 2026-07-07 · RESUMED in isolated worktree `../SSIM_redesign` (parallel to P4 polish on fix/hardening-p4, which is NOT merged). Re-baselined onto shipped hardened line: `git merge fix/reliability-remediation` (clean; package.json→1.3.6, tauri.conf.json→1.3.6). **V5 done** — fleet masters re-skinned (folder/selection/env/global headers + global env-filter → DS pattern; all id/data-genv hooks + handlers preserved; markup-only diff; node --check clean). Continuing V6…V19.
