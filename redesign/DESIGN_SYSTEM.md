# SSIM — DESIGN SYSTEM

> The design language of `redesign/design_source.html` (2004 lines) — the owner's
> "Merged Masterpiece" prototype. This is the **visual + structural source of truth**
> for the frontend redesign. The backend (`src/`) and the legacy functional frontend
> (`redesign/legacy_public/`) are FROZEN; this document tells you how to re-skin the
> legacy DOM contract in this language without touching backend wiring.
>
> Motto baked into the CSS header comment (`design_source.html:70-72`):
> **"Flat data, rich frame."** — canonical palette only · Inter · tabular numerics · soft corners.
>
> The prototype ships mock data + a "prototype harness" chrome (proto-bar, portal
> state-switchers). Those are META-CHROME and must be DROPPED on port — see §6.

---

## 0. Foundations & mental model

- **Dark-only.** `:root` is `color-scheme: dark`; `<html class="dark">` (`:2`). No light theme.
- **Tailwind Play + a hand-written `<style>` design-system layer.** The prototype loads
  Tailwind via CDN and extends its theme (`design_source.html:24-61`) so class-driven
  A-markup (`bg-brand`, `rounded-2xl`, `text-slate-400`) maps to the token channels.
  In production this ports to the app's existing Tailwind config; the `<style>` block
  (`:68-438`) is the portable DS layer and can ship as-is.
- **Channel-based color.** Every color token is stored as an `R G B` triple (space-separated,
  no `rgb()`), so it composes with `/ <alpha-value>` in Tailwind and `rgb(var(--x) / .5)`
  in CSS. This is DS-01 (`:74`) — the single palette source. NEVER hardcode a hex outside
  the token list except CS2 item-rarity colors (which are item DATA, not chrome — `:345-353`).
- **Two visual registers** (the whole system is built on this split):
  - **FLAT data surfaces** — opaque fills, hairline borders, violet only on hover/active.
    Used for tables, rows, stat cards, fields, panels. Never gradients/glow.
  - **RICH frame** — gradient + soft shadow + glow, purple edge-light. Used for the
    environment tiles, top-level cards, value-history, modal frames, portals, primary CTA.
    "Never on data rows" (`:257`).
- **Fonts:** Inter (400/500/600/700/800) for text; `ui-monospace/SFMono/Menlo` for numerics.
  All numbers use tabular figures (`.num`, `.font-mono` → `font-variant-numeric: tabular-nums`,
  `:148`) so money columns align.
- **Brand asset:** the real SSIM shield PNG, embedded once as two CSS vars
  `--ssim-logo` / `--ssim-logo-app` (`:14-18`), referenced via `.ssim-logo` /
  `.ssim-logo-app` background classes. Used **as-is** — no recolor, no knockout, no
  circular crop (would clip the shield corners) — see the DS logo panel `:655-670`.

---

## 1. TOKENS

All defined in `:root` at `design_source.html:75-133` (plus Tailwind theme mirror at `:27-58`).
Values are the literal channel triples / lengths from the file.

### 1.1 Brand (canonical purple — the ONLY purple)
| Token | Value | Meaning |
|---|---|---|
| `--brand-rgb` | `147 51 234` (#9333ea) | primary |
| `--brand-d-rgb` | `126 34 206` (#7e22ce) | deep / hover |
| `--brand-l-rgb` | `192 132 252` (#c084fc) | light / edge-light / text-on-tint |

> Hard rule from the comments: never `#a855f7` (`:98`) and never `#8847ff` (`:347`);
> the only "off-palette" restricted purple allowed is `#7c5cff` for the CS2 *Restricted*
> rarity bar, deliberately chosen so it doesn't read as brand.

### 1.2 Slate scale (surfaces + text) — `:80-83`
| Token | Value | Hex | Typical role |
|---|---|---|---|
| `--slate-50` | `247 247 250` | #f7f7fa | heading text |
| `--slate-100` | `238 237 243` | | strong text |
| `--slate-200` | `221 219 230` | #dddbe6 | body text (`body` default) |
| `--slate-300` | `194 191 208` | | secondary text |
| `--slate-400` | `146 141 163` | #928da3 | muted / labels |
| `--slate-500` | `107 102 120` | | faint / captions |
| `--slate-600` | `70 66 79` | #6b6678 | finest / placeholder |
| `--slate-700` | `44 41 55` | #2c2937 | hairline border (`--border-1`) |
| `--slate-800` | `30 28 41` | #1e1c29 | control resting fill |
| `--slate-900` | `18 17 25` | #121119 | card / row resting |
| `--slate-950` | `10 10 15` | #0a0a0f | canvas |

Companions: `--bg-2: 13 12 20` (#0d0c14 sunken), `--raised-rgb: 30 28 41` (#1e1c29 raised),
`--border-strong: 70 66 79` (#46424f).

### 1.3 Semantic accents — `:86-96`
| Token | Value | Hex | Meaning |
|---|---|---|---|
| `--success-rgb` | `52 211 153` | #34d399 | success / sell |
| `--balance-rgb` | `16 185 129` | #10b981 | wallet balance |
| `--warn-rgb` | `245 158 11` | #f59e0b | warn / LTD / trade-locked |
| `--listed-rgb` | `56 189 248` | #38bdf8 | listed on market |
| `--danger-rgb` | `244 63 94` | #f43f5e | danger / VAC |
| `--buy-rgb` | `20 184 166` | #14b8a6 | buy |
| `--locked-rgb` | → `--warn-rgb` | | alias |
| `--neutral-rgb` | → `--slate-500` | | alias |
| `--success-d-rgb` | `5 150 105` | | filled sell-btn resting |
| `--buy-d-rgb` | `13 148 136` | | filled buy-btn resting |
| `--danger-d-rgb` | `225 29 72` | | filled danger-btn resting |

> Pattern: filled accent buttons rest on the `-d` (dark) companion and brighten to the
> base token on hover (`:204-209`). Pills/chips use the base token at low alpha.

### 1.4 Gradients & glows — `:98-103`
- `--grad-brand: linear-gradient(135deg, brand, brand-d)` — primary button / rich accents.
- `--grad-brand-soft: linear-gradient(180deg, brand/.16, brand/.04)`.
- `--edge-light: rgb(brand-l)` — 1px top edge on rich frames.
- `--glow-sm: 0 0 14px -4px brand/.55`, `--glow-md: 0 0 24px -6px brand/.60` (also mirrored as
  Tailwind `shadow-glow-sm/glow`, `:53-54`).

### 1.5 Borders / surface fills — `:105-111`
`--border-1` (slate-700 hairline) · `--border-2` (border-strong interactive) ·
`--surface-0` (slate-950 canvas) · `--surface-1` (slate-900 card) · `--surface-2` (raised
control) · `--surface-sunken` (bg-2 insets/fields).

### 1.6 Glass (OVERLAYS ONLY — modals, popovers, sticky header) — `:113-116`
`--glass-bg: color-mix(in srgb, slate-900 78%, transparent)` ·
`--glass-border: rgb(slate-700 / .7)` · `--glass-blur: blur(18px) saturate(1.3)`.

### 1.7 Elevation — `:118-121`
`--elev-1: 0 1px 2px black/.40` · `--elev-2: 0 8px 24px -10px black/.60` ·
`--elev-3: 0 28px 80px -24px brand/.32, 0 12px 40px black/.62` (top-tier gets a violet tint).

### 1.8 Focus & motion — `:123-125`
`--ring-soft: rgb(brand / .5)` (field focus halo) · `--dur-fast: 120ms` · `--dur: 160ms` ·
`--dur-slow: 240ms` · `--ease: cubic-bezier(.2,.8,.2,1)`.

### 1.9 Radii (SOFT corners — "Design B language") — `:127-129`
`--r-input: 10px` · `--r-chip: 10px` · `--r-row: 10px` · `--r-btn: 12px` ·
`--r-card: 16px` · `--r-tile: 16px` · `--r-modal: 16px` · `--r-avatar: 10px`.
Tailwind scale re-pointed to match (`:51`): `md 8 / lg 10 / xl 12 / 2xl 16 / 3xl 16`.

### 1.10 Type scale (one clean scale — no half-steps) — `:131-132`, mirror `:58`
`--fs-10:10 --fs-11:11 --fs-12:12 --fs-13:13 --fs-14:14 --fs-16:16 --fs-20:20 --fs-28:28`.
Helper classes `.t10 … .t28` (`:153-155`). Tailwind names: `3xs/2xs/xs/13/sm/base/xl/28`.
Roles: **28** display/page title · **20** section/KPI value · **16** card title · **14** body
(default control/row) · **13** dense table body (10k rows legible) · **12** labels ·
**11** UPPERCASE micro-label · **10** finest caption.

### 1.11 Z-scale (layering law) — cited throughout, canonicalized `:1374-1386`
| z | Layer |
|---|---|
| default | dashboard content |
| **20** | Live Logs launcher (bottom-left FAB) — above dashboard, below every overlay |
| **30** | Ban Checker overlay (`#ban-overlay`, `:1289`) |
| **40** | modals / `.modal-overlay` (`:281`) + all `[id$="-overlay"]` |
| **[55]** | styled confirm (`#confirm-overlay`, `:1310`) |
| **[60]** | toast stack (`#toast-stack`, `:1386`) |
| **80** | portals (splash / unlock / license, `.portal`, `:380`) |
| **90** | proto-bar harness (`.proto-bar`, `:416`) — **DROP on port** |

> S68 layering law (`:1374-1378`): the Live Logs launcher sits bottom-LEFT and toasts
> bottom-RIGHT so a notification never stacks above/below the launcher; z-20 keeps the
> launcher above the dashboard but below every alert/toast/modal.

### 1.12 Other stateful vars
- `--stat-accent` (`:250`) — per-stat-card top-accent color, set inline
  (e.g. `style="--stat-accent:rgb(var(--warn-rgb))"`).
- CS2 rarity colors are NOT tokens — flat hex in `.rar-*` (bar) and `.rn-*` (name text),
  `:349-353`. Treat as item data.

**Token count: 69 CSS custom properties** (plus the 2 logo-asset vars = 71 total `--`
definitions; the type/color/radius set also mirrored into the Tailwind theme).

---

## 2. PRIMITIVES / COMPONENTS

Every reusable class in the `<style>` block, with markup pattern + states. Cite ranges.

### 2.1 Buttons — one system: `.btn` + size + variant (`:183-230`)
Base `.btn` (`:187`): inline-flex, centered, `gap .5rem`, `padding .625/1rem`,
`radius --r-btn`, `font 14/700`, transitions on bg/border/color/shadow/transform.
- States: `:active:not(:disabled)` → `translateY(1px) scale(.99)` (`:191`); `:disabled` →
  `opacity .5; not-allowed` (`:192`).
- **Sizes:** `.btn-sm` (12px, tighter, radius 10), `.btn-lg`, `.btn-icon` (2.25rem square),
  `.btn-icon-sm` (1.75rem, radius 9) (`:193-196`).
- **Variants:**
  - `.btn-primary` — RICH: `--grad-brand` + inset top edge + `--glow-sm` + `--elev-1`;
    hover brightens + `--glow-md` + `--elev-2` (`:199-201`).
  - `.btn-sell` (success-d→balance), `.btn-buy` (buy-d→buy), `.btn-danger` (danger-d→danger)
    — flat filled accents with a subtle 180° white sheen + `--elev-1`, **no glow** (`:204-210`).
  - `.btn-secondary` (slate-800→700 neutral), `.btn-ghost` (transparent→slate-800),
    `.btn-soft` (brand tint text+fill+border) (`:213-218`).
- **Auto-upgrade of A-markup** (`:220-230`): legacy `button.bg-brand` (not inside `.seg`)
  is force-styled to the rich gradient primary; `button.bg-emerald-600/.bg-teal-600/
  .bg-rose-600` get the accent sheen. **This is why the legacy DOM ports with zero edits.**
- Markup: `<button class="btn btn-primary"><i class="fa-solid fa-plus"></i>Label</button>`.
  Live demo gallery at `:695-715`.

### 2.2 Fields (`:232-240`)
`.field` — full-width, `padding .625/.75`, `radius --r-input`, `surface-0` bg, `--border-2`.
- States: `::placeholder` slate-600; `:hover:not(:focus)` → slate-600 border;
  `:focus` → brand border + `0 0 0 2px --ring-soft` halo (`:238`).
- Context override: inside `.surface`/`.modal-card`, field bg → `--surface-sunken` (`:239`).
- `.field-label` — block, 12/600, slate-400, `mb .375rem` (`:240`).
- Markup: `<label class="field-label">X</label><input class="field" />`. Also used for
  `<select class="field">` and search inputs (prepend a `fa-magnifying-glass` absolutely
  positioned + `pl-8/9`, pattern repeated e.g. `:531-534`, `:612-614`).

### 2.3 Flat data surfaces (`:242-253`)
- `.surface` — slate-900 + `--border-1` + `--r-card`. `.surface-sunken` — bg-2 variant.
- `.panel-head` — flex row, `.75/1rem`, bottom hairline. `.panel-title` — 11/600 UPPERCASE
  tracked slate-400. (Panel = a `.surface` with a `.panel-head`.)
- `.stat-card` (KPI tile) — opaque slate-900, hairline, a 2px gradient top-accent via
  `::before` reading `--stat-accent` (`:250`). `.stat-label` (11 uppercase slate-400) +
  `.stat-value` (20/700). Markup `:590-593`.

### 2.4 Rich frame (`:255-278`)
- `.card-rich` — layered slate gradient over slate-900 + `--elev-2` + a 1px brand-light
  top edge via `::before` (`:259-265`). Container for DS panels, value-history, portals.
- `.env-tile` — the premium environment stat-card (`:268-278`): radial brand glow +
  slate gradient + `--elev-1`; hover lifts `-4px`, brand border, big brand shadow.
  Sub-parts: `.env-tile__glow` (2px gradient top strip), `.env-tile__actions`
  (absolute top-right edit/delete, revealed on hover/focus-within). Inner 2×2 stats use
  `.env-stat` (FLAT sunken cells with `.k`/`.v`, `:410-413`). Rendered by `renderEnvTiles()`.

### 2.5 Modal frame (`:280-292`)
- `.modal-overlay` — fixed inset-0, z-40, `display:none` → `.is-open` flex; scrim
  `black/.62` + `blur(6px)` (`:281-283`).
- `.modal-card` — glass (`--glass-bg` + `--glass-blur`), `--glass-border`, `--r-modal`,
  `--elev-3` (`:284`).
- **Frozen contract adapter** (`:286-289`): `div[id$="-overlay"] > div` is force-converted
  to the glass card, and `div[id$="-overlay"] .sticky.bg-slate-900` gets glass-blur — so the
  **legacy JS-built overlays convert automatically**. In the prototype the actual overlay
  markup still uses Tailwind (`bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl`,
  e.g. `:847`); the adapter upgrades it. Keep the `id$="-overlay"` + inner-`<div>` contract.
- `.modal-x` — 2rem close button, slate-500 → white/slate-800 on hover (`:290-292`).
  Markup: `<button data-close aria-label="Close" class="modal-x"><i class="fa-solid fa-xmark"></i></button>`.

### 2.6 Pills (status, read-only) & chips (toggle) (`:294-313`)
- `.pill` — rounded-full 11/600, colored variants at `/.12–.18` fill + `/.35–.4` border:
  `--brand --proxy/--success --wallet --warn/--ltd --danger --listed --buy --local/--neutral`.
  Markup `<span class="pill pill--proxy"><i…>Proxy</span>`. Gallery `:736-744`.
- `.chip` — interactive toggle, `[aria-pressed]` drives active fill. Base + `--success/
  --warn/--listed` pressed variants (`:310-313`). Used for facets, category tabs, CSFloat
  tabs, global-env aggregate. Markup `<button class="chip chip--warn" aria-pressed="false">`.

### 2.7 Session dots & avatars (`:315-325`) — "status via dot, not avatar hue" (rule 5)
- `.dot` (8px, ring shadow) + `.dot--online` (success + glow) / `--offline` (slate-600) /
  `--error` (danger + glow).
- `.avatar` — neutral slate icon-tile, `--r-avatar`, `.avatar--lg`. **No per-account color.**
  Pattern: avatar with an absolutely-positioned status dot at bottom-right (`:758`, `:1564`).

### 2.8 Empty state (`:327-332`)
`.empty` (centered column, `3rem/1rem`) + `.empty-icon` (5rem tile) + `.empty-title`
(slate-400/500) + `.empty-sub` (slate-600/14). Markup `:635-638`, `:576-579`.

### 2.9 Data table (`:334-343`) — the core `.items-table`
- `.items-wrap` — `--border-1`, `--r-card`, `overflow hidden`, slate-900/.5.
- `.items-table` — `border-collapse`, 13px. `thead th` — **sticky top**, slate-950 bg,
  11 uppercase slate-400, inset bottom hairline. `tbody tr` — bottom hairline,
  `content-visibility:auto` + `contain-intrinsic-size:auto 52px` (row virtualization hint),
  hover → `brand/.06`, `.is-selected` → `brand/.10`. `td` — `.5/.75rem`.
- `.item-icon` — drop-shadow on the item glyph.
- **Rarity** (item data, not chrome): `.rar` (3px accent bar) with `.rar-consumer…-gold`;
  `.rn-*` name-text colors (`:345-353`).
- Rendered + windowed by `applyAndRenderTable()` + `mountWindowed()` (see §5).

### 2.10 Sidebar (`:355-365`)
- `.app-sidebar` — vertical slate gradient. `.account-row` (virtualized, 56px hint) +
  `.account-btn` (`.is-active` → brand tint fill + 3px glowing left rail via `::before`).
- `.row-actions` — hidden (`opacity 0`), revealed on row hover/focus-within (`:362-363`).
- `.tree-line` — folder indent border. `.frosted` — backdrop blur (used on screen headers).

### 2.11 Segmented control (`:372-377`) — `.seg`
Bordered inline-flex, rounded, `overflow hidden`; child `<button>` slate-800/400,
`.is-on` → brand fill + white. `.split` — 1px divider. Used for game toggle (CS2/TF2),
price-source (Steam/CSFloat), currency (EUR/USD), login tabs (QR/credentials).
`.seg` children are explicitly EXEMPT from the `bg-brand` auto-upgrade (`:224`).

### 2.12 Value-history chart classes (`:367-370`)
`.hist-grid/-axis/-line-items/-line-wallet/-area-items/-dot-items/-dot-wallet` — SVG stroke/
fill colors (SVG can't read `var()` in presentation attrs). Rendered by `renderHistory()`.

### 2.13 Portals (splash / unlock / license) (`:379-403`)
- `.portal` — fixed z-80, radial brand backdrop, `display:none`→`.is-open` flex.
- `.portal-card` — 400px rich gradient card + `--glass-border` + `--elev-3` + top edge-light.
- `.portal-logo-wrap` (+`.loading`), `.portal-halo` (spinner ring when loading; pulsing halo
  when idle via `@keyframes halo`), `.portal-logo` (the shield). `.portal-cap` (micro-label),
  `.portal .sub`, `.portal-msg` (+`.err/.ok/.info`), `.portal-warn`, `.portal-track`+`.portal-bar`
  (progress), `.spin` (inline button spinner).

### 2.14 Live Logs launcher (`:1379-1383`)
An ambient bottom-left rounded-full FAB, `z-index:20`, `--grad-brand` fill + brand shadow.
`<button id="livelogs-launcher" data-modal="livelogs">…Live Logs</button>` — opens
`#livelogs-overlay` via the shared `data-modal` handler.

### 2.15 Toasts (`:1385-1386`)
`#toast-stack` — fixed bottom-right, z-[60], flex-col-end, `gap 2`. (Container only in the
prototype; the stacking-toast component exists in legacy `ssimConfirm`/toast infra — feed it
from real events.)

### 2.16 Animations & utilities (`:171-181`, `:135-169`)
`.fade-in` (modal/section entrance), `.cs2-spin` (loading spinner), `.pulse-dot`
(connection dot), `.skel` + shimmer (skeleton loaders), `@keyframes halo/lspin/shimmer/
fadeIn/cs2-spin/pdot`. Base: custom scrollbar (`:157-160`), `::selection` brand tint,
`:focus-visible` brand ring (fields keep the halo instead), `body.no-motion` kill-switch,
`@media (prefers-reduced-motion)` (`:431-437`).

**Component/class count: ~60 reusable DS classes** (buttons ×11 incl. sizes/variants,
fields ×2, surfaces ×5, rich-frame ×2 + env-tile parts, modal ×3, pills ×9, chips ×4,
dots ×4, avatar ×2, empty ×4, table + rarity, sidebar ×5, seg ×4, portal ×13, launcher,
toast, plus animation/utility helpers).

---

## 3. INFORMATION ARCHITECTURE

### 3.1 App shell (`:477-787`)
`#app-shell` = **sidebar** + drag-resizer + **main**. (In the prototype the shell is
inset below the 44px proto-bar via `.app-shell{ inset:44px 0 0 0 }`, `:426` — on port the
shell fills the window.)

**Sidebar** (`#app-sidebar`, `:480-551`), fixed 288px, resizable 240–420px
(`initResizer()`, `:1994-2000`):
- Brand lockup (logo + "SSIM" + full name), `:482-488`.
- `#sidebar-nav` — "All environments" back button (`:490-493`).
- `#env-context` — current env name/proxy card, "Master (environment)", "Account"+"Folder"
  add buttons, "Refresh all" (`:496-507`).
- `#refresh-progress` — inline progress bar + "End task" (`:510-514`; driven by
  `simulateRefresh()`).
- `#refresh-failed` — collapsible failed-accounts amber panel (`:517-523`; `fillFailed()`).
- `#accounts-label` + `#account-count` (`:525-528`).
- `#account-tools` — search + filter (all/has/empty) + sort (default/balance) (`:530-539`).
- `#account-list` — the scrolled account tree (`renderAccountList()`), `:541`.
- `#btn-toggle-hidden` — show/hide hidden accounts (`:543`).
- Footer — connection dot + `#footer-status` version string (`:545-550`).

These sidebar blocks (`#sidebar-nav, #env-context, #accounts-label, #account-tools`, the
`MID` array `:1548`) are **hidden in "home" mode** and shown in "env" mode by
`updateSidebar(mode)` (`:1549-1556`).

### 3.2 Screens vs views (the key distinction)
There are **3 physical `data-screen` sections** (`:429`, `[data-screen]{display:none}` →
`.is-on` flex), toggled by `showScreen(name)` (`:1823-1825`):

1. **`environments`** (home) — `:561-581`. Env-tile grid (`#env-tiles`) + empty state.
2. **`inventory`** — `:584-645`. The **one** screen that hosts FIVE logical views + orders.
3. **`designsys`** — `:648-785`. A living style-guide (logo/palette/type/buttons/fields/
   chips/dots/balance-states/component-states). **Reference only — DROP or keep behind a
   dev route.**

The `inventory` screen is **data-driven**: `renderView(v)` (`:1663-1691`) reconfigures the
same header + toolbar + table for the current view `v ∈ {account, env-master, folder-master,
global-master, selection-master, orders}`.

**The six inventory views** (dispatched via `selectScreen` `:1889-1899` / `renderView`):
| View `v` | Title | Scope pill | Data source | Notes |
|---|---|---|---|---|
| `account` | (account name) | Proxy/Local + Full/Limited | `genItems(184)` | game toggle + Buy + src/cur + Refresh + category tabs visible |
| `env-master` | Environment Master | `Portfolio · <env>` | `genItems(1400,master)` | value-history shown |
| `folder-master` | Folder-Master | `Folder · High value` | `genItems(640,master)` | Mass Buy action; value-filter |
| `global-master` | Global Master | `Cross-environment` | `genItems(10000,master)` lazy | env-aggregate filter + history |
| `selection-master` | Selection Master | `N account(s)` | `genItems(280,master)` | Mass Buy/Move/Delete; value-filter |
| `orders` | `<acct> · Active Orders` | — | generated buy/sell orders | separate `#orders-wrap` |

**Master views** (`isMaster` = ends with `-master`, `:1607`) add an "Accounts" column and
drop per-item Exterior/Status columns; account view is the only one with the CS2 category
tabs (Owned/Locked/Listed) and the game toggle.

### 3.3 Inventory screen anatomy (`:584-645`)
Header (`frosted`): `#breadcrumb` (`breadcrumb(v)`, `:1615-1627`) → `#main-header`
(`headerCluster(v)`, `:1628-1660`) → `#stat-bar` with 4 `#stat-*` KPI cards + game toggle
(`#game-toggle`) + Buy (`#btn-buy-market`) + source/currency seg (`#src-cur`) + Refresh
(`#btn-load`). Body: `#global-filter` (global-master only) · `#history-wrap` (env/global) ·
`#toolbar` (search + value-filter + selection-bar) · `#facet-bar` · `#gc-cat-tabs` ·
`#items-wrap` (the table) · `#orders-wrap` · `#empty-state` · `#inv-loading`.

Control visibility is recomputed per view in `renderView` (`:1669-1690`) and
`refreshToolbar` (`:1832-1838`): e.g. game toggle & Buy & category tabs only on `account`;
`#btn-load` hidden on masters/orders; history only on env/global-master; value-filter on
account/folder-/selection-master.

### 3.4 Top-nav / view-switching mechanics
- **Environments → view**: clicking an env-tile (`data-env`) sets `S.env` and opens its
  first account in `account` view (`:1969`). "Global Master" header button → `global-master`.
- **Sidebar → view**: account rows (`data-acct`) → `account`; "Master (environment)"
  (`#btn-env-master`) → `env-master`; "All environments" (`#btn-back-dashboard`) →
  `environments`.
- **Breadcrumb** — `Environments › <env> › <view>` with clickable ancestors (`data-goenv`).
- **Category tabs** (`#gc-cat-tabs`, account only): All / Owned / Trade-Locked / Listed +
  a separator + "Active Orders" jump (`data-goorders` → `orders` view). `renderCatTabs()`.
- **Deep-linking (prototype only)**: URL hash `#s=<screen>&m=<modal>&b=<balance>&l=1&e=1`
  drives the harness (`:1942-1950`). **DROP** — production navigation is user-driven.

### 3.5 Portals as gate states (pre-app)
Three full-screen portals gate the app before the shell is usable (mirrors backordering
`splash → unlock → license`; legacy `splash.html/unlock.html/license.html`):
- **Splash** (`#portal-splash`, `:790-802`) — boot/updater; states start/update/done.
- **Unlock vault** (`#portal-unlock`, `:805-825`) — master-password; states returning/
  firstrun (adds confirm + no-recovery warning)/wrong/busy.
- **License** (`#portal-license`, `:828-842`) — license key + HWID; states idle/checking/
  activated/seat/hwid/invalid.
`openPortal(id)` / `closePortals()` (`:1854-1855`); state setters `setSplashState` /
`setUnlockState` / `setLicenseState` (`:1862-1886`).

---

## 4. OVERLAYS / MODALS (every `[id$="-overlay"]` and what it represents)

All share the frozen contract: `<div id="X-overlay" class="hidden fixed inset-0 … z-40 …">
<div>…modal card…</div></div>`, opened by `openModal('X')` / closed by `closeModal()` +
`data-close` + backdrop click + Esc (`:1846-1851`, `:1927-1928`). The glass adapter (§2.5)
skins them. Opened via `data-modal="X"` anywhere in the DOM.

| Overlay id | Feature (FEATURES.md domain) | Key markup / notes | Line |
|---|---|---|---|
| `modal-overlay` | **Add account** (single, into an env/folder) | env select, username, password, maFile path, proxy override | `:846` |
| `login-overlay` | **Account Login** (QR / credentials → token-only "Limited") | `.seg` QR/Credentials tabs; QR pane w/ expiry overlay (`login-qr-overlay`), cred form w/ Guard code; "imports as Limited" info | `:869` |
| `attach-overlay` | **Attach maFile** (Limited → Full upgrade) | filename input, `.btn-sell` "Upgrade to Full" | `:906` |
| `csfloat-overlay` | **CSFloat workspace** (per-account) | tabbed (`.chip`) Dashboard/Listings/Market/Buy Orders/Trades/Settings + stat cards + activity | `:924` |
| `sda-overlay` | **SDA** — Steam Guard code + pending confirmations | live OTP + progress bar, approve-selected/all list | `:951` |
| `env-overlay` | **New/Edit environment** | name + rotating-proxy (any format) | `:984` |
| `folder-overlay` | **New/Rename folder** | folder name | `:1004` |
| `move-overlay` | **Move account** (to env/folder) | env + target-folder selects | `:1021` |
| `edit-overlay` | **Edit account** (name/proxy/creds + delete) | env-proxy toggle, credentials `<details>`, delete-account danger zone | `:1040` |
| `trade-overlay` | **Send items** (internal/external trade) | internal-vs-external radio, env→folder→recipient picker, 2FA note | `:1069` |
| `sell-overlay` | **Mass Sell on market** | strategy radios (lowest/undercut/custom) + gross/fee/net calc table | `:1099` |
| `buy-overlay` | **Market Buy** (single, buy order) | bot/wallet, game, qty+Max, item search, price+Market-price | `:1129` |
| `fbuy-overlay` | **Mass Buy** (folder/selection) | game, price/item, item search, live-balance note | `:1151` |
| `bulk-overlay` | **Import bots** (SSIM Vault / CSV / maFiles) | `.import-method` grid, file picker, source master-pw | `:1171` |
| `logs-overlay` | **Account activity** (per-account log) | timestamped color-coded log lines | `:1200` |
| `livelogs-overlay` | **Live Logs** — global backend stream | All/Warn/Error filters, pause, `[account]`-tagged lines, buffer footer; opened by the launcher | `:1218` |
| `offers-overlay` | **Trade Offers** (sent / received) | two-column Sent/Received, per-side select-all + batch accept/decline/cancel | `:1252` |
| `ban-overlay` | **Ban Checker** (z-30) | summary pills + collapsible `<details>` per category, "Move this category" | `:1288` |
| `confirm-overlay` | **Styled confirm** (z-[55]) | danger icon + type-to-confirm ("DELETE") + `.btn-danger` | `:1309` |
| `storage-overlay` | **Storage / caskets** | per-casket fill bars + Open | `:1323` |
| `tradeups-overlay` | **Trade-Up contract** | 10-input grid, avg-float → outcome pool, Run | `:1337` |
| `browser-overlay` | **Clean browser** (ephemeral proxied session) | domain select, proxy note, Open | `:1357` |

Plus the inner `login-qr-overlay` (`:882`) — a nested "code expired" overlay inside the
login modal (not a top-level modal).

**Overlay count: 22 top-level modals + 3 portals = 25 overlay surfaces.**
The `MODAL_LIST` registry (`:1847`) enumerates 21 openable modals (livelogs opens via its
launcher; confirm/login-qr are contextual). The `[id$="-overlay"]` glass adapter (`:287`)
means any future modal following the id-suffix convention auto-skins.

---

## 5. DATA-DRIVEN RENDER FUNCTIONS & MOCK DATA SHAPES

These tell you **what real backend data must feed each render function** when porting.
The prototype's mock generators (`:1395-1483`) define the exact shapes.

### 5.1 Mock data shapes (the contract real data must satisfy)
- **`ENV`** (`:1396-1401`, enriched `:1437-1442`): `{ id, name, proxy|null, country, n,
  accounts, worth, wallet, locked }`. `proxy=null` ⇒ "Local IP". Money fields are **cents**.
- **`FOLDERS`** (`:1402-1407`): map `envId → [{ id, name, n }]`.
- **`ACCOUNT`** (`genAccounts` `:1410-1435`): `{ id, env, folder|null, username,
  display|null, tier:'full'|'limited', session:'online'|'offline'|'error',
  network:'proxy'|'local', wallet:cents|0|null, items:int, hidden:bool }`.
  **3-state wallet is load-bearing** (matches INVARIANT / memory `balance-zero-vs-unrefreshed`):
  `null` = never refreshed (`—`), `0` = refreshed-empty (`0,00`), `>0` = value.
  `balCell(a)` (`:1506-1512`) encodes the three states + tooltips.
- **`ITEM`** (`genItems(n, master)` `:1460-1475`): `{ id, name, rar (consumer…gold), ext,
  float, stat:bool (StatTrak™), qty, unit:cents, locked:bool, listed:bool, unlockH:int
  (hours to unlock), accounts:int (master rollup) }`. Rarity taxonomy + label/color maps
  `RN/RB/RLABEL` (`:1456-1458`).
- **View → dataset** (`itemsFor(v)` `:1477-1483`): account 184 · env-master 1400 ·
  folder-master 640 · selection-master 280 · global-master 10000 (lazy). Real backend
  feeds the corresponding aggregation.

### 5.2 Central UI state `S` (`:1486-1489`)
`{ screen, view, env, acct, game:'cs2'|'tf2', src:'steam'|'csfloat', cur:'EUR'|'USD',
bal, cat, facet:{status:Set, rar:Set}, sel:Set (selected accounts), sel2:Set (selected
items), items, filtered, globalEnvs:Set, showHidden }`. Port target: back this with real
selection/filter state; drop `bal` (a proto override).

### 5.3 Formatters (reusable — keep) (`:1491-1512`)
`FX()` (EUR/USD rate — prototype-hardcoded 1.08; real app has a live FX source),
`fmtMoney(cents)` (locale de-DE `€` / en-US `$`), `fmtCompact(cents)` (k/M),
`fmtCount(n)`, `balCell(a)` (3-state balance cell).

### 5.4 Render pipeline (the functions to re-wire to backend)
| Function | Consumes | Produces | Line |
|---|---|---|---|
| `renderEnvTiles()` | `ENVS` | `#env-tiles` grid + "New env" tile | `:1515` |
| `updateSidebar(mode)` | `S.env`, mode home/env | shows/hides sidebar blocks, sets env name/proxy | `:1549` |
| `renderAccountList()` | `ACCOUNTS` + search/filter/sort + `FOLDERS` | folder-grouped account tree | `:1580` |
| `acctRow(a)` | one account | sidebar row (avatar+dot, name, LTD pill, 3-state balance, row-actions) | `:1557` |
| `renderView(v)` | view id | orchestrates the whole inventory screen | `:1663` |
| `breadcrumb(v)` | view + `S.env/acct/sel` | `#breadcrumb` trail | `:1615` |
| `headerCluster(v)` | view + account | `#main-header` (title, pills, per-view action buttons + account tool row) | `:1628` |
| `setStatLabels(v)` | view + game | relabels the 4 KPI cards | `:1608` |
| `paintStats(items,v)` | items + wallet source | the 4 `#stat-*` KPI values | `:1692` |
| `renderCatTabs()` | `S.items` | Owned/Locked/Listed count chips (account only) | `:1709` |
| `renderFacetBar(v)` | rarities + `S.facet` | status + rarity filter chips + clear | `:1717` |
| `applyFilters(v)` | items + cat + search + facets | `S.filtered` | `:1727` |
| `applyAndRenderTable(v)` | filtered items | `.items-table` header + windowed body + footer totals | `:1749` |
| `itemRowHtml(i, master)` | one item | a `<tr>` (rarity bar, icon, lock badge, StatTrak, value, status pill; master swaps Exterior/Status for Accounts) | `:1737` |
| `mountWindowed(scroller,body,items,rowFn,52)` | items | **virtualized 52px-row rendering** (pad-top/visible/pad-bot); the perf backbone for 10k rows | `:1762` |
| `renderHistory()` | env worth/wallet series | SVG value-history (item+wallet polylines) | `:1784` |
| `renderGlobalFilter()` | `ENVS` + `S.globalEnvs` | env-aggregate toggle chips | `:1802` |
| `renderOrders()` | generated buy/sell orders | `#orders-wrap` two-column active orders | `:1807` |
| `paintStats` wallet rule | account=own wallet, global=Σ selected envs, else env.wallet | | `:1701-1705` |

Screen/visibility helpers: `showScreen(name)`, `showLoading()`, `refreshToolbar(v)`,
`updateSelectionBar()`, `setGame(g)`. Modal/portal: `openModal/closeModal`, `openPortal/
closePortals`. Event delegation: one `onClick(e)` (`:1957-1987`) dispatches every
`data-*` handler; keep this delegation pattern (it's how the frozen DOM stays wired).

> **Porting note:** `renderView` → `paintStats/renderFacetBar/applyAndRenderTable` is the
> spine. Replace `itemsFor(v)`, `genAccounts`, `ENVS/FOLDERS`, and `FX()` with real backend
> reads; keep `mountWindowed`, `itemRowHtml`, the formatters, and the state machine.

---

## 6. PROTOTYPE-ONLY CHROME TO DROP

Not part of the product — strip on port:
- **`.proto-bar`** (`:416-425`, markup `:444-475`) — the top harness toolbar (screen picker,
  modal picker, balance-state, loading/error/reduce-motion toggles). z-90. Also drop the
  `.app-shell{ inset:44px … }` offset (`:426`) — production shell fills the window.
- **`.portal-proto-states` / `.pstate`** (`:404-409`, `:801/824/841`) — the "Preview state:"
  switcher row at the bottom of each portal; `buildPortalStates()` (`:1856`) and the
  `data-ps` handler (`:1966`). Real portals derive state from backend, not buttons.
- **`data-screen="designsys"`** section (`:648-785`) + `renderPalette()` (`:1900`) — the
  living style guide. Keep only as a dev reference, not a user route.
- **All mock data + generators** (`:1395-1483`): `ENVS, FOLDERS, genAccounts, ACCOUNTS,
  SKINS, genItems, itemsFor, GLOBAL_ITEMS`. Replace with backend data of the same shape.
- **Proto state overrides in `S`**: `S.bal` (balance override), `protoLoading()/protoError()`
  (`:1821-1822`) and their branches, `simulateRefresh()`/`fillFailed()` fakery,
  hash deep-linking (`:1942-1950`). Wire real loading/error/refresh from backend events.
- **CDN dependencies** (`:23,64-66`) — Tailwind Play + Font Awesome + Google Fonts are
  loaded from CDNs in the prototype; production must self-host / bundle these (the app is a
  self-contained single-file Tailwind build; icons/fonts vendored).
- `FX()` hardcoded 1.08 (`:1491`) — replace with the app's live/fallback FX source
  (surfacing provenance per INV-E5).

Everything else — tokens, the `<style>` DS layer, component markup, the render pipeline,
the frozen `[id$="-overlay"]` contract, the event delegation — is the product and ports.

---

JSON summary appended below (for the caller).
