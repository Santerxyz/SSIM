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
- [ ] Phase 1 — extraction contracts: `API_CONTRACT.md` (every backend call), `PARITY.md` (every user-facing capability w/ legacy refs), `DESIGN_SYSTEM.md` (masterpiece tokens/components/IA/view layouts), `PORT_PLAN.md` (view-by-view build order mapping function→design)
- [ ] Phase 2 — design system + primitives in new `public/` (tokens, buttons, inputs, tables, modals, toasts, badges, tabs, tooltips, confirm, skeletons, the Live Logs launcher + layering)
- [ ] Phase 3 — views wired to backend, riskiest-data first: app shell/nav → master/fleet → account detail + inventory grid → pricing → market & orders → trade-offers → mass-buy → ban checker → casket/trade-up → CSFloat → import → settings → Live Logs (logs.html) → unlock.html → license.html → splash.html
- [ ] Phase 4 — verification: contract audit (API_CONTRACT row-by-row), parity audit (PARITY row-by-row), invariant audit (VERIFICATION.md), live run against the backend (NO money actions — those go to LIVE_TEST_CHECKLIST.md), perf sanity at 500+ accounts
- [ ] Cutover — replace `public/` with the new frontend (legacy_public/ = rollback), `npm run build && npm test`, smoke-test the live app
- [ ] Compile — **bump version 1.3.5 → 1.4.0** (package.json + src-tauri/tauri.conf.json; see RELEASE VERSION above), then `npm run build:tauri` → SSIM.exe (needs secrets.local.bat for the fail-closed bake; present). Do NOT publish (owner's web-panel step).

## DELIVERABLES (redesign/)
`00_PROGRESS.md`, `API_CONTRACT.md`, `PARITY.md`, `DESIGN_SYSTEM.md`, `PORT_PLAN.md`, `CHANGES.md` (deliberate flow changes), `VERIFICATION.md`, `LIVE_TEST_CHECKLIST.md`, `OWNER_NOTES.md`, `ROLLBACK.md`, `legacy_public/` (untouched), `design_source.html`.

## Session log
- 2026-07-06 · Phase 0 done: branched redesign/frontend-v2, legacy backed up, masterpiece = design_source.html, strategy = re-skin/preserve-function. Phase 1 extraction launched.
