# SSIM Frontend Redesign — Owner Notes

Practical, owner-facing notes from the redesign port. Read alongside `CHANGES.md` (deliberate
flow decisions) and `00_PROGRESS.md` (phase status).

## Brand logo — `image-Photoroom.png` is now the app logo (V19)

Per the operator's brand directive (invariant 8), the new logo `image-Photoroom.png` (a 236×218
PNG, git-tracked at the worktree root) was copied into `redesign/new_public/assets/` and wired as
the app logo everywhere the old `logo.png` was referenced:

- `index.html` — apple-touch-icon link + sidebar brand `<img>`
- `splash.html` — boot-splash logo (+ code comment)
- `unlock.html` — vault-unlock portal logo
- `license.html` — activation portal logo

The old `assets/logo.png` file is left in place but is **no longer referenced by any markup**.
You may delete `assets/logo.png` if you want; it is dead weight only. (The unrelated
`assets/logos/` folder — steam / csfloat source logos — was NOT touched.)

## Acceptable cosmetic residuals (Phase-4 completeness audit)
The re-skin is behavior-preserving and DS-consistent. A few interactive loci intentionally keep
legacy Tailwind utility classes (all byte-identical to the previous build — nothing broken):
- **Price-source / currency split control** (`#src-btn` / `#cur-btn` + `#src-menu` / `#cur-menu`):
  kept as a custom DS-tokened control rather than the masterpiece `.seg`, because `.seg` clips
  dropdown popovers (`overflow:hidden`). The JS contract (logo `.src` swap + menu toggles) requires
  this structure. Renders on-brand.
- **Decorative hover states** on non-button elements (folder/account row hovers, toolbar separators,
  count/qty pills, the CSFloat skeleton): still on shared Tailwind utilities. Cosmetic only.
These can be upgraded later if desired; none affects behavior, hooks, or the money paths.
