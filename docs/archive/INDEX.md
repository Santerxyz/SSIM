# Archive

Historical working documents, moved out of the repo root on 2026-07-31. Nothing here is
consumed by the build, the app, or the release scripts — it is kept for provenance only.
All of it describes work that has already shipped or been superseded.

Live docs that stayed at the root: `README.md`, `RELEASE_NOTES.md`, `PROJECT_MAP.md`,
`FEATURES.md`, `INVARIANTS.md`. Current per-topic docs remain in `docs/`.

## reports/ — completed audits and root-cause write-ups

| File | What it covers |
| --- | --- |
| `STABILITY_ISSUES.md` | 67 ranked reliability findings (sweep of 2026-07-04) |
| `BACKEND_RELIABILITY.md` / `UPDATE_RELIABILITY.md` | Backend + updater reliability analyses |
| `REMEDIATION_LOG.md` / `REMEDIATION_LOG_2.md` | Fix ledgers for the remediation passes |
| `LOGIC_AUDIT.md` / `CONTRADICTIONS.md` | Logic audit and contradiction catalogue |
| `BETA_BLOCKERS.md` / `PHASE4_VERIFICATION.md` | Open-beta gate lists, since cleared |
| `CRASH_ROOT_CAUSE.md` / `CAPFIX_REPORT.md` | `0xC0000409` silent-crash and capability-token fixes |
| `ARM_CRASH_DUMP.ps1` / `CAPTURE_CRASH_PROCDUMP.ps1` | WER/procdump capture helpers for that crash |
| `RATELIMIT_ROOT_CAUSE_fable5.md` | Per-IP Steam budget theory — **superseded** |
| `DEEPTHINK_ratelimit_root_fable5.md` | Deep-dive behind the above |
| `HEADER_FIX_AND_REGRESSION_REVIEW_fable5.md` | The **current** 429 explanation: Steam bot-detection on non-browser headers, fixed via a Chromium fingerprint in `src/network/steamHeaders.ts` |
| `PROXY_RULES_IMPLEMENTATION_REPORT.md` | Proxy-rules module build + the 10 defects the follow-up review found |

## prompts/ — one-shot session prompts and handoffs

Instructions written for individual AI sessions whose work has since landed: the frontend
redesign, the hardening campaign (442/442 resolved), P4, onboarding, the website pass, the
1.3.5 release, and the paysafecard/proxy handoffs. Useful as a record of what was asked
for; not intended to be re-run.

## campaigns/ — multi-wave project folders

| Folder | Status |
| --- | --- |
| `hardening/` | 5-pillar hardening campaign ledgers — complete |
| `redesign/` | Frontend V2 design system, parity and port plans — shipped |
| `Version 1.4.1/` | Wave-by-wave module spec — implemented |

## mockups/ — static design artifacts

Standalone HTML mockups from the redesign, an early screenshot, and the root copy of the
logo. The logo the app actually serves is `public/assets/image-Photoroom.png`.
