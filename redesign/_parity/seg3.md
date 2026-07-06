# SSIM Legacy Frontend — Parity Fragment · Segment 3 (app.js lines 4500–6788 + index.html)

Scope: `redesign/legacy_public/app.js` L4500–6788 read in full, plus the whole `redesign/legacy_public/index.html` (static modal/overlay markup) and the money-formatting helpers this range depends on (`fmtCents`/`fmtEurCents`/`fmtWallet`/`fmtMoneyMinor`/`parseMajorToMinor`/`curInfo`, defined earlier at L640–770). CSFloat/SDA/QR-login renderers whose *write actions* live inside 4500–6788 are documented in full (their view-context functions sit at L3809–4499 and were read for accuracy). 💰 = money- or real-asset-affecting.

Legend for refs: `app.js:NNNN` = JS source line; `index.html:NNNN` = static markup line.

---

## A. CSFloat Workspace modal (per-account marketplace) — `#csfloat-overlay`

Static shell: `index.html:824` — 4xl × 85vh flex-col card, title `<i fa-water text-cyan-400>CSFloat` + `#csfloat-account` (mono username), tab strip `#csfloat-tabs`, scroll body `#csfloat-body`. Opened via `openCsFloat(username)` (`app.js:4008`); closed via `closeCsFloat` (`app.js:4023`).

| # | Capability / behavior | Detail | Ref |
|---|---|---|---|
| 1 | Open CSFloat workspace | Sets `CSF.username`, resets market state, shows skeleton, parallel-fetches `/api/csfloat/config` (experimental flag) + per-account `/key`; opens on Dashboard if key configured, else Settings | app.js:4008 |
| 2 | Tab bar (core) | Dashboard / My Listings / Market always shown | app.js:4179 |
| 3 | Tab bar (experimental) | Buy Orders / Trades / Inventory shown ONLY when `CSF.experimental` true; Settings always last | app.js:4180-4182 |
| 4 | Active-tab styling | Active tab: `border-brand text-white`; inactive: `border-transparent text-slate-400 hover:text-slate-200` | app.js:4183-4186 |
| 5 | Tab switch gate | Any non-settings tab with no key configured → `csfNeedKey()` empty state ("No CSFloat API key for this account" + "Open Settings" btn) | app.js:4189-4197 |
| 6 | Loading skeleton | `csfSkeleton(rows)` — N pulse rows (`h-14 bg-slate-800/50 animate-pulse`) | app.js:4002 |
| 7 | Error state (per tab) | `csfError(msg)` — warn icon + message + "Retry" button (`data-csf="retry"` → reload current tab) | app.js:4003,4444 |
| 8 | Empty state (per tab) | `csfEmpty(icon,msg)` — icon + message | app.js:4004 |
| 9 | Icon-host allow-list | `csfImg(hash)` builds steamstatic URL or accepts full URL, then passes through `safeIconUrl` allow-list (anti-IP-beacon) | app.js:3997 |
| 10 | **Dashboard view** | 3 stat cards: Balance (`csfUsd`), Active listings (count from `/listings?limit=50`), Account (username/steamid); + "Browse market" / "My listings" quick buttons | app.js:4200-4222 |
| 11 | **My Listings view** | Rows from `/listings?limit=50`; each row: icon, name, float (4dp), editable price input (min 0.03, placeholder current price 2dp), edit-price btn, delist btn, price label (`csfUsd` emerald) | app.js:4225-4243 |
| 12 | 💰 Edit listing price | `csfEditPrice` — reads `.csf-price` input, requires ≥$0.03, `ssimConfirm` "List/Buy…" no—actually PATCH `/listings/:id` price=cents; toast "Price updated"; reload listings | app.js:4496-4502 |
| 13 | 💰 Delist listing | `csfDelist(id)` — `ssimConfirm` danger "Remove this listing from CSFloat?" → DELETE `/listings/:id`; toast "Listing removed"; reload | app.js:4491-4495 |
| 14 | **Market view** | Search form: name, Min $, Max $, Sort select (Best deal/Lowest price/Highest price/Most recent/Lowest float/Highest float), Search btn | app.js:4246-4258 |
| 15 | Market search exec | `csfDoMarketSearch(reset)` — prices ×100 → cents, limit 24, cursor paging; results grid of cards | app.js:4261-4290 |
| 16 | Market result card | icon, name, wear + float (4dp), price (`csfUsd` emerald), Buy button (data-id/price/name) | app.js:4291-4303 |
| 17 | Market "Load more" | Shown when `CSF.market.cursor` present; appends next page (`csfDoMarketSearch(false)`) | app.js:4289,4446 |
| 18 | 💰 Buy from market | `csfBuy(id,priceCents,name)` — `ssimConfirm` tone spend "Buy … for $X from your CSFloat balance?" → POST `/buy`; toast "Purchase sent" | app.js:4503-4508 |
| 19 | **Buy Orders view** (exp) | Create-order form (item search-as-you-type, Max $, Qty default 1, Place order) + list of active orders | app.js:4306-4324 |
| 20 | Buy-order item search | `csfWireBoSearch` — debounced 300ms Steam market search (`/api/market/search?appId=730`), dropdown, click fills exact `market_hash_name`; Steam price deliberately NOT shown | app.js:4326-4357 |
| 21 | Buy-order row | name, qty, max price (`csfUsd` emerald), delete-order btn | app.js:4358-4365 |
| 22 | 💰 Place buy order | `csfCreateBuyOrder(form)` — name+max_price required, price ×100, POST `/buy-orders`; toast "Buy order placed"; reload | app.js:4509-4515 |
| 23 | 💰 Cancel buy order | `csfDeleteBuyOrder(id)` — `ssimConfirm` danger "Cancel this buy order?" → DELETE `/buy-orders/:id`; toast "Buy order cancelled"; reload | app.js:4516-4520 |
| 24 | **Trades view** (exp) | Auto-accept toggle card + trade rows | app.js:4368-4385 |
| 25 | Auto-accept toggle state | Card copy differs when account is Limited (no identity_secret → disabled/greyed); ON=brand ON, OFF=slate; `data-enabled` is source of truth (never button text) | app.js:4378-4381,4484 |
| 26 | Toggle auto-accept | `csfToggleAutoAccept(btn)` — PUT `/auto-accept enabled:!cur`; toast "Auto-accept enabled/disabled"; reload trades | app.js:4484-4490 |
| 27 | Trade row | name, state/status, price (`csfUsd` emerald) | app.js:4386-4393 |
| 28 | **Inventory view** (exp) | Rows from `/inventory`; each: icon, name, float, price input (min 0.03), List btn (disabled if no asset id) | app.js:4396-4414 |
| 29 | 💰 List asset on CSFloat | `csfListAsset(btn)` — needs asset id + price ≥$0.03; `ssimConfirm` brand "Create a CSFloat listing at $X?" → POST `/listings type=buy_now`; toast "Listing created"; reload inventory | app.js:4521-4529 |
| 30 | **Settings view** | API-key form (password field, placeholder shows "configured ending …tail" when set), Save; Clear btn when configured; Experimental toggle card | app.js:4417-4436 |
| 31 | Save API key | `csfSaveKey` — POST/PUT `/key`; msg "Validating…"→"Key saved & validated" (or warning); auto-switch to dashboard after 700ms | app.js:4463-4474 |
| 32 | Clear API key | `csfClearKey` — `ssimConfirm` danger "Remove this account's CSFloat API key?" → DELETE `/key`; toast "CSFloat key cleared" | app.js:4475-4479 |
| 33 | Toggle experimental | `csfToggleExperimental` — PUT `/api/csfloat/config experimental:!`; re-renders tabs+settings | app.js:4480-4483 |
| 34 | CSFloat money format | `csfUsd(cents)` = `'$' + (cents/100).toLocaleString('en-US',{min/max 2 frac})` → e.g. `$1,234.56` | app.js:3992 |
| 35 | Event delegation | Tab clicks (`onCsfTabClick`), body clicks (`onCsfBodyClick` dispatch table), body submits (key/market/bo forms via `onCsfBodySubmit`) | app.js:4439-4460 |

---

## B. SDA Overview modal (Steam Guard OTP + confirmations) — `#sda-overlay`

Static shell: `index.html:839` — 3xl × 85vh, title `SDA` + mono `#sda-account`. Opened `openSda(username)` (`app.js:4034`); closed `closeSda` (`app.js:4043`, clears both timers).

| # | Capability / behavior | Detail | Ref |
|---|---|---|---|
| 36 | OTP display | Large 5-char code `#sda-otp` (`text-4xl mono tracking-[0.3em] emerald-300 select-all`), placeholder `·····` | index.html:853 |
| 37 | OTP auto-roll | `startSdaOtp` fetches `/api/accounts/:u/otp` {code,msRemaining}; re-fetches ~300ms past expiry so displayed value never stale | app.js:4052-4071 |
| 38 | OTP countdown bar | 30 000ms cycle; `#sda-otp-bar` width animated every 200ms via `barTimer` | app.js:4061-4069, index.html:856 |
| 39 | OTP error handling | On fetch fail: shows `—`, bar 0%, toasts once per error streak, bounded 5s retry that self-recovers; guarded to modal-open+same-account | app.js:4072-4082 |
| 40 | Copy OTP button | `copySdaOtp` — copies the LIVE DOM value (not stale), skips placeholder/`—`; label flips to "Copied" for 1200ms | app.js:4085-4096, index.html:854 |
| 41 | Pending confirmations header | Title + count `#sda-conf-count`; buttons: Approve selected (disabled until ≥1), Approve all, Refresh | index.html:862-867 |
| 42 | Load confirmations | `refreshSdaConfirmations` — GET `/confirmations`; loading spinner state; error state with inline Refresh button | app.js:4098-4113 |
| 43 | Confirmations list render | `renderSdaConfirmations` — per-row checkbox, type icon (trade=right-left, market=tag, else shield), title, subline `typeName · gives X · gets Y`, per-row Approve btn | app.js:4115-4135 |
| 44 | Empty confirmations | "No pending confirmations." | app.js:4118 |
| 45 | Multi-select count | `selectedSdaIds`/`updateSdaSelCount` — updates `#sda-conf-sel-count`, enables/disables Approve-selected | app.js:4137-4147 |
| 46 | Approve single | Per-row btn → `respondSda([id], true)` | app.js:4133 |
| 47 | Approve selected | `respondSda(selectedIds, true)` | app.js:6401 |
| 48 | Approve all | `respondSda([], true, true)` | app.js:6400 |
| 49 | Respond result | `respondSda` — POST `/confirmations/respond {ids,accept,all}`; toast "Approved/Denied N confirmation(s)[, M failed]"; ALWAYS re-fetch from canonical source | app.js:4149-4159 |

---

## C. QR / Credentials Account-Login modal — `#login-overlay`

Static shell: `index.html:738` — md card, title "Account Login". Environment select (shared, sets proxy). Method tabs QR / Credentials. Opened `openLogin` (`app.js:3809`), closed `closeLogin` (`app.js:3817`, cancels both sessions + stops poll).

| # | Capability / behavior | Detail | Ref |
|---|---|---|---|
| 50 | Env select | `#login-env` populated from environments; preselects active env | app.js:3810-3811 |
| 51 | Method tabs | QR / Credentials; switching cancels the other method's session | app.js:3834-3845, index.html:753 |
| 52 | QR flow start | `startQr` — POST `/api/accounts/login/qr/start {environmentId}`, sets QR data-URL image, polls status if not terminal | app.js:3848-3862 |
| 53 | QR status stepper | 4 pills Waiting→Scanned→Approved→Done; current = brand+spinner, done = emerald | app.js:3871-3881, index.html:763 |
| 54 | QR overlay states | error → red msg + "Try again"; expired → amber "QR code expired" + "New code" | app.js:3864-3869 |
| 55 | Credentials submit | `submitLoginCredentials` — POST `/credentials {username,password,environmentId}`; polls | app.js:3895-3913 |
| 56 | Guard-code phase | `applyCredStatus` state='guard' → shows guard input; label differs Email vs mobile (`sent to …@detail`); "Verify code"; hint about mobile-app approval | app.js:3915-3935, index.html:778 |
| 57 | Cred status messages | `showCredMsg` — error rose / info slate / ok emerald | app.js:3937-3941 |
| 58 | Login poll | `startLoginPoll` — every 1500ms poll `/status`; tolerant of transient/404 | app.js:3945-3952 |
| 59 | On imported | `onLoginImported` — toast `Account "X" imported/updated as Limited`; reload, select account | app.js:3954-3960 |
| 60 | Limited-tier note | Static: imports as Limited (buy orders/market buys/cancels work; sells/trades queued pending; attach maFile → Full) | index.html:788 |

---

## D. Attach-maFile modal (Limited → Full) — `#attach-overlay`

Static shell: `index.html:799` — title "Attach maFile" (emerald shield). Opened `openAttachMaFile(username)` (`app.js:3963`).

| # | Capability / behavior | Detail | Ref |
|---|---|---|---|
| 61 | Attach maFile / upgrade | `submitAttach` — POST `/api/accounts/:u/attach-mafile {maFilePath}`; toast `"X" upgraded to Full`; reload sidebar | app.js:3970-3983 |
| 62 | maFile path field | placeholder `username.maFile  or  C:\…\file.maFile` | index.html:810 |

---

## E. Clean-Browser action (Phase 6)

| # | Capability / behavior | Detail | Ref |
|---|---|---|---|
| 63 | Open account in clean browser | `openCleanBrowser(btn,username)` — btn spinner "Opening…"; POST `/api/accounts/:u/open-browser`; surfaces warnings as info toasts; success toast shows proxy or "(LOCAL IP)" | app.js:4162-4177 |

---

## F. Environment create / edit / delete modals — `#env-overlay`

Static shell: `index.html:874` — title toggles New/Edit environment. Name + "Global (rotating) proxy" (empty = local IP), any proxy format accepted.

| # | Capability / behavior | Detail | Ref |
|---|---|---|---|
| 64 | Open env modal (create/edit) | `openEnvModal(mode,id)` — edit reveals REAL saved proxy via GET `/environments/:id/proxy` (guards against a different modal opening meanwhile) | app.js:4532-4567 |
| 65 | Proxy load-error | toast `Could not load the saved proxy: …` | app.js:4564 |
| 66 | Submit env | `submitEnv` — create POST `/api/environments {name,proxy}`; edit PATCH sends proxy ONLY when changed (cleared/changed/omitted logic); toast created/updated; reloads + re-renders | app.js:4569-4593 |
| 67 | 🔸 Delete environment | `deleteEnvironment` — `ssimConfirm` danger "Delete environment X?" (only when empty of accounts) → DELETE; toast deleted; removes from globalEnvs | app.js:4595-4607 |

---

## G. Folder create / rename / delete / reorder

Static shell (name modal): `index.html:905` — title toggles New folder / Rename folder.

| # | Capability / behavior | Detail | Ref |
|---|---|---|---|
| 68 | Open folder modal | `openFolderModal(action)` — create vs rename title/icon; prefill name on rename | app.js:4610-4619 |
| 69 | Submit folder | `submitFolder` — create POST `/api/folders {name,environmentId,parentId}` (un-collapses parent) / rename PATCH `/folders/:id`; toast; refresh env | app.js:4621-4639 |
| 70 | Delete folder | `deleteFolder` — `ssimConfirm` danger "Delete folder X? Subfolders and accounts move to the parent folder." → DELETE; toast | app.js:4640-4651 |
| 71 | Reorder folder up/down | `reorderFolder(id,direction)` — POST `/folders/:id/reorder {direction}`; refresh env | app.js:4653-4661 |

---

## H. Move account modal (single or batch) — `#move-overlay`

Static shell: `index.html:928` — env select + target-folder select.

| # | Capability / behavior | Detail | Ref |
|---|---|---|---|
| 72 | Open move modal | `openMoveModal(usernameOrList)` — single vs batch; label `Move "X":` or `Move N selected account(s):`; env dropdown; folder tree flattened & indented | app.js:4664-4678 |
| 73 | Populate move folders | `populateMoveFolders` — GET `/environments/:id/tree`; "— Root —" + indented options | app.js:4680-4689 |
| 74 | Submit move (batch-safe) | `submitMove` — `Promise.allSettled` per-account POST `/accounts/:u/move {folderId,environmentId}`; toast `N moved, M failed` / `Account moved` / `N accounts moved`; reload + refresh env | app.js:4690-4709 |
| 75 | Batch delete accounts | `batchDeleteAccounts` — `ssimConfirm` danger "Remove N selected account(s)? …maFiles kept" → allSettled DELETE `/accounts/:u`; clears selection; falls back to env master if active account removed; toast `N removed, M failed` | app.js:4713-4733 |

---

## I. Ban Checker modal — `#ban-overlay` (z-30, below Move z-40)

Static shell: `index.html:1428`. Category set `BAN_CATS`: Clean(emerald), VAC(rose), Game(orange), Community(amber), Economy/Trade(fuchsia), Lookup Failed(slate). `movable` true for the 4 ban types.

| # | Capability / behavior | Detail | Ref |
|---|---|---|---|
| 76 | Open ban checker (job + poll) | `openBanChecker(usernames,scopeLabel)` — dedups; scope label `· X` or `· N account(s)`; POST `/api/bans/check {usernames}` (202 detached); 409 "already running" toast; then poll | app.js:4757-4776 |
| 77 | Ban-check poll (1.5s) | `pollBanCheck` — GET `/api/bans/status` every 1500ms; bounded error-retry (S17); stall guard; live phase label: "Resolving SteamIDs…"/"Acquiring keys…"/"Checked X of N…" | app.js:4778-4817 |
| 78 | Stuck detection | pollerStalled → amber "The ban check appears stuck (no progress)…" | app.js:4803-4806 |
| 79 | Result summary chips | `renderBanResult` — "N checked" + one chip per category w/ count (errors chip only when >0) | app.js:4845-4858 |
| 80 | Category accordions | `banAccordion` — collapsible per non-empty category; caret rotates; count badge; movable categories get "Move this Category" btn | app.js:4868-4885 |
| 81 | Ban tags per account | `banTags` — VAC (×count), Game (×count), Community, Trade:reason, "No bans"; "Nd since last ban" | app.js:4888-4899 |
| 82 | Account row | user icon, display/username, mono steamId, tags | app.js:4901-4914 |
| 83 | Accordion toggle + Move-category | `onBanBodyClick` — header toggles body/caret; "Move this Category" collects category usernames → `openMoveModal` (layers z-40 above; ban modal stays open) | app.js:4916-4936 |
| 84 | Account-level trigger | `checkAccountBans(username)` | app.js:4821-4825 |
| 85 | Folder-level trigger | `checkFolderBans(folderId)` — every account in subtree | app.js:4827-4833 |

---

## J. Send-Trade modal (single + folder mass-send) — `#trade-overlay`

Static shell: `index.html:1012`. Internal-account vs External-link radio; env→folder→recipient picker; 2FA auto-confirm note.

| # | Capability / behavior | Detail | Ref |
|---|---|---|---|
| 86 | Open trade modal | `openTradeModal` — folder vs single; summary "N Item(s)"; from = bots list or active user; default env; reset target; internal radio checked | app.js:4939-4968 |
| 87 | Target-mode toggle | `updateTradeTargetVisibility` — shows internal-block or external-URL block | app.js:4971-4975 |
| 88 | Populate trade folders | `populateTradeFolders` — GET tree; "All folders" + "— no folder —" + indented; rebuild recipients | app.js:4979-4992 |
| 89 | Build recipient list | `buildRecipientList` — filter by env+folder+search; excludes self (single mode); drops stale selection; count line "Selected: X" / "N account(s) · click to select" | app.js:4995-5020 |
| 90 | Recipient row | `recipientRow` — selected highlight (brand ring), folder name subline, check icon | app.js:5022-5034 |
| 91 | Read target | `readTradeTarget` — internal {toUsername} (warn if none) / external {tradeUrl} (warn if empty) | app.js:5037-5046 |
| 92 | 💰 Submit trade (single) | `submitTrade` — POST `/api/trade/send {from,assetIds,appId,contextId:'2',target}`; clears selection; status handling: **unconfirmed** → warn "SENT but NOT 2FA-confirmed — confirm manually, do NOT resend"; confirmed/sent → success toast; **9s deferred re-refresh** of affected accounts (INV-E1) | app.js:5048-5089 |
| 93 | 💰 Send-fail money-safety | On error w/ `verifyBeforeRetry` → error "Send may have placed an offer — verify outgoing offers before retrying" + refresh sender | app.js:5079-5086 |
| 94 | 💰 Submit mass-trade (folder) | `submitMassTrade` — POST `/api/trade/mass-send {items,appId,contextId:'2',target}`; shows progress; polls; toast `Mass trade started: N bot(s), M items` | app.js:5092-5111 |
| 95 | Mass progress panel | `showMassProgress` — bottom-center `#mass-progress`; bar, count `0/bots`, "Processing queue (max. 2 at a time)…" | app.js:5112-5118, index.html:1471 |
| 96 | Mass-trade poll (1s) | `pollMass` — GET `/api/trade/mass-status`; bar %, `done/total`, detail `X confirmed · Y failed` (or cancelling); stall guard; on done re-pull cache + surface failures + toast `Mass trade done/ended/stopped: X confirmed[, Y failed]`; hides after 3500ms | app.js:5166-5205 |
| 97 | Surface trade failures | `surfaceTradeFailures` — groups by reason; up to 4 error toasts `reason — who (+N more)`; overflow warn | app.js:5148-5164 |

---

## K. End-Task (cooperative cancel) — shared across mass jobs

| # | Capability / behavior | Detail | Ref |
|---|---|---|---|
| 98 | End task (confirmed cancel) | `endTask({label,endpoint,button})` — MANDATORY `ssimConfirm` danger "End task? …account in progress finishes; remaining skipped" → POST endpoint; btn→"Stopping…"; warn toast | app.js:5129-5146 |
| 99 | Reset end button | `resetEndBtn` re-enables + restores "End task" label on fresh run | app.js:5124-5128 |
| 100 | Wired end-task buttons | Refresh (`/api/inventory/refresh-cancel`), Mass trade (`/api/trade/mass-cancel`), Market sale (`/api/market/sell-cancel`), Mass buy (`/api/market/folder-buy-cancel`) | app.js:6357-6360 |

---

## L. Market-Sell modal (mass-sell) — `#sell-overlay`

Static shell: `index.html:1080`. Strategy radios: Lowest listing price / 1 cent below / Custom price (net). Gross/Net/fee note; 2FA-irreversible warning.

| # | Capability / behavior | Detail | Ref |
|---|---|---|---|
| 101 | Flatten selection → sell items | `selectedSellItems` — {username,assetId,marketHashName} across agg (folder) or single account | app.js:5211-5237 |
| 102 | Sell strategy read | `sellStrategy` — lowest / undercut / custom | app.js:5239-5242 |
| 103 | Custom price parse | `customSellCents` — EUR field → integer cents (comma/dot tolerant, >0) | app.js:5244-5249 |
| 104 | Toggle custom-price row | `toggleSellCustomRow` — shows `#sell-custom-row` when custom, focuses field | app.js:5258-5262 |
| 105 | Open sell modal | `openSellModal` — summary "N Item(s)"; from bots/user; resets preview; lowest checked | app.js:5264-5280 |
| 106 | 💰 Preview sell prices | `previewSell` — POST `/api/market/preview {names,strategy,username[,customCents]}`; btn "Calculating…"→"Calculate prices & proceeds"; renders table | app.js:5283-5304 |
| 107 | Retry one price | `retryOnePrice(name,btn)` — re-query single item; spinner; warn if still no price | app.js:5306-5322 |
| 108 | Sell-preview table | `renderSellPreview` — per item: name ×count, Gross (`fmtEurCents`), Steam fee (−, amber), Net (emerald); "no price" rows w/ re-query btn; totals footer `Total (N item(s))`; missing-price note | app.js:5324-5379 |
| 109 | 💰 Submit sell | `submitSell` — POST `/api/market/sell {items,strategy[,customCents]}`; toast `Market sale started: N item(s) on M bot(s)`; progress + poll | app.js:5381-5406 |
| 110 | Sell progress panel | `showSellProgress` — bottom `#sell-progress`; "Creating listings & confirming via 2FA…" | app.js:5407-5413, index.html:1487 |
| 111 | Sell poll (1s) | `pollSell` — GET `/api/market/sell-status`; bar %, `done/total`; parts `X listed · Y confirmed [· recovered/retries/gone/deferred] · Z failed`; phase label {preflight→Connecting,pricing,listing,confirming 2FA,done}; current bot; stall guard; on done toast + refresh sellers; hides after 4500ms | app.js:5414-5468 |

---

## M. Bulk-Import modal (maFiles / CSV / Vault) — `#bulk-overlay`

Static shell: `index.html:1267`. 3-method chooser (Vault/CSV/maFiles) + env/folder destination.

| # | Capability / behavior | Detail | Ref |
|---|---|---|---|
| 112 | Open bulk import | `openBulkImport` — env dropdown (preselect active), populate folders, load maFile list, default to maFiles method | app.js:5471-5482 |
| 113 | Method selector | `selectImportMethod` — shows chosen panel, highlights btn (border-brand/bg-brand/10) | app.js:5486-5496 |
| 114 | Import SSIM Vault | `onBulkVaultImport` — sorts selected files into vault.enc(req)+accounts.json(opt); requires password; POST `/api/import/vault {vault,accountsJson,password,environmentId,folderId}`; status `Imported X new, Y skipped [· folders recreated]`; toast; clears pw | app.js:5498-5528 |
| 115 | Populate bulk folders | `populateBulkFolders` — tree → "— Root —" + indented | app.js:5529-5537 |
| 116 | Load maFile list | `loadBulkList` — GET `/api/mafiles/unlinked`; per file: checkbox (disabled if no password), name, path, Password/no-password badge; empty → "No new maFiles in mafiles/" | app.js:5538-5558 |
| 117 | Select-all maFiles | `onBulkSelectAll` — checks only password-bearing files | app.js:5565-5569 |
| 118 | Bulk submit button state | `updateBulkSubmit` — label `Import (N)`, disabled when 0 | app.js:5560-5564 |
| 119 | Submit maFile import | `submitBulk` — POST `/api/mafiles/import {files,environmentId,folderId}`; vault vs legacy response; toast counts; surfaces skip reasons (first 5) H-ACC-078 | app.js:5570-5593 |
| 120 | CSV import | `onBulkCsv` — reads file, POST `/api/import/csv {csv,…}`; status `Imported X new, Y skipped`; surfaces rejected rows (first 5, `line N: reason`); resets file input | app.js:5595-5621 |

---

## N. Toolbar utilities + Market-Buy modal — `#buy-overlay`

Static shell: `index.html:1144`. Bot datalist, Game select, Qty+Max, live item search, Price+Market-price fetch, ×qty total.

| # | Capability / behavior | Detail | Ref |
|---|---|---|---|
| 121 | Item search input | `onSearch` — sets `state.search`, re-render | app.js:5627 |
| 122 | Toggle hidden accounts | `onToggleHidden` — flips `state.showHidden`, re-render sidebar | app.js:5628 |
| 123 | Button loading helper | `setButtonLoading(btn,loading,text,icon)` — spinner/icon swap | app.js:5630-5634 |
| 124 | Wallet resolver | `walletOf(u)` — GLOBAL wallet (not per-game), prefers remembered newest, falls back to either game cache | app.js:5642-5652 |
| 125 | Buy currency code | `buyCurrencyCode` — NEVER defaults to EUR (wrong scale would misprice); uses live buyWallet or `walletOf` | app.js:5655-5660 |
| 126 | Open buy modal | `openBuyModal` — datalist of all accounts, preselects active bot, game from `state.game`, qty 1, empty price/name, fetches wallet | app.js:5661-5680 |
| 127 | Render buy wallet | `renderBuyWallet(w)` — currency label `(ISO)`/"(currency unknown)"; `Balance: …` or "Balance unknown – Refresh the account first (buying disabled)" | app.js:5682-5687 |
| 128 | Update buy wallet | `updateBuyWallet` — instant local value, then GET `/api/accounts/:u/wallet` for freshest; caches | app.js:5690-5702 |
| 129 | Refresh buy wallet (exact) | `refreshBuyWallet` — live wallet fetch used by funds check + Max; throws on error | app.js:5710-5716 |
| 130 | Recompute buy total | `recomputeBuyTotal` — `fmtMoneyMinor(minor*qty, code)` or `—` | app.js:5717-5724 |
| 131 | 💰 Max (spend entire balance) | `fillMaxBuyQty` — fetches exact wallet, computes affordable qty at price, caps at per-order max (100); toasts capped/max info | app.js:5730-5762 |
| 132 | 💰 Fetch buy market price | `fetchBuyPrice` — GET `/api/market/buy-price?username&marketHashName&appId`; fills price (comma decimal); toast "Lowest offer: …" | app.js:5764-5781 |
| 133 | Buy item live search | `searchBuyItems` (debounced 350ms) — GET `/api/market/search?q&appId`; dropdown ≤20; `renderBuySearch` icon+name+"from price"; click fills marketHashName | app.js:5782-5811 |
| 134 | 💰 Submit market buy | `submitBuy` — validates account/name/qty(1-100)/currency/price; **pre-buy live funds check** (`refreshBuyWallet`, aborts if insufficient); POST `/api/market/buy {username,marketHashName,appId,pricePerItemMinor,quantity}`; result box ok/info; toast; refreshes buyer for that game | app.js:5812-5872 |
| 135 | 💰 Buy-fail money-safety | On error: "Buy failed: … — verify inventory/orders before retrying" + refresh buyer (a failed POST may still have reached Steam) | app.js:5864-5868 |
| 136 | Buy result box | shows `r.message`, `Order X · confirmed/unconfirmed · Total …` | app.js:5856-5859 |

---

## O. Folder Mass-Buy modal — `#fbuy-overlay`

Static shell: `index.html:1209`. Game, Price/item (own currency), item search, progress bar, results list.

| # | Capability / behavior | Detail | Ref |
|---|---|---|---|
| 137 | Open folder buy | `openFolderBuy(folderName,usernames)` — summary `<folder> · N account(s). Each bot's balance refreshed live, then maxed out` | app.js:5878-5891 |
| 138 | Fbuy item search | `searchFbuyItems`/`renderFbuySearch` (debounced 350ms) — same Steam search dropdown | app.js:5894-5916 |
| 139 | 💰 Fetch fbuy price | `fetchFbuyPrice` — representative account's `/buy-price`; fills price; toast lowest offer | app.js:5919-5935 |
| 140 | 💰 Submit folder buy | `submitFolderBuy` — validates name/price; `ssimConfirm` tone spend "Mass Buy — real money … maxed out at X … Real money. Irreversible." → POST `/api/market/folder-buy {usernames,marketHashName,appId,pricePerItemMajor}`; progress + poll | app.js:5936-5965 |
| 141 | Fbuy poll (1.2s / 0.9s done) | `pollFolderBuy` — GET `/api/market/folder-buy-status`; phase refreshing (`refreshed/total`) vs placing (`processed/total`); bar %; bounded error-retry; stall guard | app.js:5966-6010 |
| 142 | Fbuy results render | `renderFolderBuyResults` — sorted rows; status color/icon {bought,placed,skipped,failed,refresh-failed}; qty `N×`/`0/planned`/`—`; message | app.js:6011-6025 |
| 143 | Fbuy done toast | `Mass buy done/ended: X order(s), Y item(s) filled, Z skipped, W failed`; refresh active view from cache | app.js:6003-6008 |

---

## P. Toasts (FB-02 stacking) — `#toast-stack`

Static container: `index.html:1503` (bottom-right z-[60], aria-live polite).

| # | Capability / behavior | Detail | Ref |
|---|---|---|---|
| 144 | Toast API | `toast(message,type,opts)` — types info/success/warn/error; de-dupes identical (`type|message`); queue cap 50 (drops oldest) | app.js:6037-6050 |
| 145 | Stacking (max 3 visible) | `TOAST_MAX=3`; rest queued; `drainToasts` refills as slots free | app.js:6030,6051-6056 |
| 146 | Toast render | tone bg {success emerald, error rose, warn amber, info slate}; icon {circle-check, circle-exclamation, triangle-exclamation, circle-info}; role alert(error)/status | app.js:6057-6066 |
| 147 | Auto-dismiss / persist | errors 20 000ms TTL, others 4000ms (or `opts.duration`); optional inline "Undo" button | app.js:6064-6076 |
| 148 | Live-Logs floating launcher | Bottom-LEFT pill "◳ Live Logs" (z-index 30, purple gradient); opens `/logs.html` popup + POST `/api/app/open-logs` (Tauri native window) | index.html:1516-1550 |
| 149 | Keep-alive heartbeat | `fetch('/api/app/ping')` every 4000ms | index.html:1509-1515 |

---

## Q. Security / formatting / poller helpers

| # | Capability / behavior | Detail | Ref |
|---|---|---|---|
| 150 | HTML/attr escaping | `escapeHtml`/`escapeAttr` — entity-encode `&<>"'` | app.js:6078-6081 |
| 151 | Icon-host allow-list | `safeIconUrl` — only steamstatic/akamaihd/steamcommunity https; else '' (anti IP-beacon #29) | app.js:6083-6093 |
| 152 | Poller stall guard | `pollerStalled(key,done)` / `resetPoller` — 180 000ms (3min) zero-progress → give up (#27) | app.js:6095-6106 |
| 153 | 💰 Money format — USD cents | `fmtCents(cents)` → `fmtUsd(cents/100)`; USD `$1,234.56` (en-US), EUR `€1.234,56` (de-DE), FX-converted for EUR | app.js:640-647 |
| 154 | 💰 Money format — EUR cents | `fmtEurCents(cents)` → `'€' + (cents/100).toLocaleString('de-DE',{2 frac})` e.g. `€1.234,56`; NO FX (sell prices already EUR) | app.js:649-652 |
| 155 | 💰 Money format — native minor | `fmtMoneyMinor(minor,code)` → `Intl.NumberFormat(localeForIso(iso),{style:currency,…})`; per-currency locale (USD→en-US, EUR→de-DE, GBP→en-GB, JPY→ja-JP 0 frac, …) | app.js:718-726 |
| 156 | 💰 Wallet format (strict) | `fmtWallet(w)` — null/undefined/'' balance → `—` (never fetched); real 0 → `0,00`; funded → native currency | app.js:731-738 |
| 157 | Steam currency table | `STEAM_CURRENCIES` (code→ISO+decimals, 46 entries); `curInfo` default EUR/2 | app.js:694-705 |
| 158 | 💰 Major→minor parse | `parseMajorToMinor` / `normalizeMajor` — decimal-vs-grouping disambig; never over-parses; >0 → minor units | app.js:739-759 |
| 159 | Currency toggle | `setCurrency(cur)` — persists `ssim.currency`, FX-provenance tooltip on `#cur-btn` (fallback/stale rate warnings) | app.js:761-779 |

---

## R. Confirm dialog (FB-01) + modal infrastructure (FB-04) + boot

Static confirm shell: `index.html:1446` (z-[55]).

| # | Capability / behavior | Detail | Ref |
|---|---|---|---|
| 160 | Sticky header offset sync | `syncStickyOffsets`/`setupStickyHeader` — `--ssim-stick-top` = live toolbar height (ResizeObserver) so pinned column headers sit flush | app.js:6115-6130 |
| 161 | Overlay closer registry | `OVERLAY_CLOSERS` map — Esc/registry routes each overlay through its REAL close fn (17 overlays incl. confirm=safe-cancel) | app.js:6138-6146 |
| 162 | Modal open lifecycle | `onModalOpen` — records trigger, scroll-lock, autofocus first field | app.js:6165-6179 |
| 163 | Modal close lifecycle | `onModalClose` — runs teardown hook, unlocks scroll, restores focus to trigger if still valid (`isRestorable`) | app.js:6182-6201 |
| 164 | Overlay MutationObserver | `observeOverlay` — wires hidden↔shown class toggles to open/close lifecycle (also for lazily-built overlays) | app.js:6205-6212 |
| 165 | Modal infra setup | `setupModalInfra` — focusin/pointerdown trigger tracking; Esc closes top overlay; Tab focus-trap | app.js:6214-6244 |
| 166 | Per-modal teardown hooks | `MODAL_TEARDOWNS` — stops tradeup/casket status pollers on close (H-FE-010) | app.js:6152,6603,6753 |
| 167 | Confirm dialog | `ssimConfirm(opts)` — async boolean; tones danger/spend/brand (icon+btn color); optional typed-word gate (disables OK until exact match); DEFENSIVE focus on Cancel (never destructive btn); backdrop/Esc = cancel | app.js:6251-6305 |
| 168 | Sidebar resize | `setupSidebarResize` — drag `#sidebar-resizer` (220–560px), persists `ssim.sidebarWidth`, double-click resets | app.js:6307-6346, index.html:483 |
| 169 | Static event wiring | `bindStaticEvents` — binds ALL nav/toolbar/modal/import/source-menu/currency controls | app.js:6348-6490 |
| 170 | Price-source + currency split menus | src-menu (Steam/CSFloat) + cur-menu (USD/EUR); mutually-exclusive open; click-away closes | app.js:6473-6477, index.html:571 |
| 171 | License gate (client-guard) | `ensureLicensed` — bounded 8s probe of `/api/system/status`; licensed→sets footer version; 403/licensed:false→activation screen; unreachable→retry screen (no reload loop) | app.js:6510-6539 |
| 172 | Backend-unreachable screen | `showBackendUnreachableScreen` — "Can't reach SSIM's backend" + Retry; auto re-probes every 3s, reloads once backend confirms licensed | app.js:6544-6566 |
| 173 | Timeout signal helper | `timeoutSignal(ms)` — AbortSignal.timeout fallback (bounds hanging fetches S23/S32) | app.js:6503-6508 |
| 174 | Startup splash | `playStartupSplash` — one-shot brand bloom on unlock→dashboard (sessionStorage-gated, skipped under reduced-motion) | app.js:6951-6966, index.html:338 |

---

## S. Trade-Ups feature modal — `#tradeup-overlay` (lazily built)

Built by `ensureFeatureOverlay` (`app.js:6576`); GC execution gated server-side.

| # | Capability / behavior | Detail | Ref |
|---|---|---|---|
| 175 | Feature overlay shell | `ensureFeatureOverlay(id,title,icon,width)` — generic modal-card w/ scope/toolbar/body/foot; observeOverlay; backdrop-click close | app.js:6576-6597 |
| 176 | Open Trade-Ups | `openTradeUpModal(username)` — empty state "Scan this account for profitable trade-up contracts."; scope `· username` | app.js:6605-6613 |
| 177 | Trade-up toolbar | `renderTuToolbar` — Scan; when candidates: Select all / Clear / Execute (N) | app.js:6615-6629 |
| 178 | Scan trade-ups | `tuScan` — POST `/api/tradeup/candidates {username}`; "Refreshing inventory & computing…"; auto-selects all; foot `N profitable contract(s) · M eligible input(s)` + warnings | app.js:6631-6647 |
| 179 | Trade-up candidate list | `renderTuList` — per contract: checkbox, rarity→outputRarity, collection pill, avg float (3dp), ~est-prices pill, no-asset-ids pill; inputs summary; outcomes (name/wear/prob %1dp/price); profit ±`fmtCents`, cost, EV | app.js:6649-6692 |
| 180 | Empty candidates | "No positive-profit trade-ups from this account's skins." | app.js:6652-6655 |
| 181 | 💰 Execute trade-ups | `tuStart` — only executable (asset ids) chosen; `ssimConfirm` danger "Execute N trade-up(s)? …Each destroys 10 real items. IRREVERSIBLE. ⚠ GC not live-verified… start with 1…" → POST `/api/tradeup/execute`; poll | app.js:6694-6711 |
| 182 | Trade-up exec poll (1.2s) | `tuPollExec` — GET `/api/tradeup/execute-status`; line `Executing X/Y · submitted Z (C confirmed) · failed F [· cancelling]` or "Execution disabled (reason)"; Cancel btn; bounded error-retry → "status LOST, verify in-game" (never fabricates done) | app.js:6713-6747 |

---

## T. Storage Units (Casket) feature modal — `#casket-overlay` (lazily built)

| # | Capability / behavior | Detail | Ref |
|---|---|---|---|
| 183 | Open Storage Units | `openCasketModal(username)` — "Connecting to the game coordinator…"; unit `<select>`; GET `/api/casket/:u/list`; loads first unit's contents | app.js:6755-6772 |
| 184 | Unit select | `renderCasketUnitSelect` — options `name (count/1000)` or "— no storage units —"; onchange reloads contents | app.js:6774-6782 |
| 185 | Load contents | `loadCasketContents` — GET `/api/casket/:u/contents?casketId` | app.js:6784-6790 |
| 186 | Depositable inv rows | `casketInvRows` — filters cache to in-inventory (not listed) w/ asset ids; search-filtered | app.js:6793-6798 |
| 187 | Storable gate | `casketStorable` — greys out Storage Unit / Collectible / Pass / Gift (GC-rejected) | app.js:6807-6813 |
| 188 | Two-panel render | `renderCasketPanels` — Inventory panel (checkboxes, ×count, not-storable rows greyed) ↔ Unit panel (contents, capacity bar `count/1000`, def index); Deposit → / ← Withdraw; per-panel Select-all; filter input | app.js:6815-6872 |
| 189 | Empty states | inv "No depositable items in cache." / unit "Empty storage unit." or error "…need the GC layer (install globaloffensive + SSIM_GC_VERIFIED=1)" | app.js:6833,6840 |
| 190 | 💰 Casket move (deposit/withdraw) | `casketMove(direction)` — collects asset/item ids; `ssimConfirm` brand "Deposit/Withdraw N item(s)?"; POST `/api/casket/move {username,casketId,itemIds,direction}`; poll | app.js:6874-6894 |
| 191 | Casket move poll (1s / 2s err) | `casketPollMove` — GET `/api/casket/move-status`; counters `direction: done/total · moved M [· unconfirmed U] · failed F`; error shown WITH partial counters (never error-only if progress); Cancel btn; budget-stop warn "N not attempted; run again"; cancelled prefix; unconfirmed → "verify in-game"; re-pulls cache + re-renders | app.js:6896-6949 |

---

## U. Cross-cutting patterns observed in this range

| # | Pattern | Detail | Ref |
|---|---|---|---|
| 192 | Poll cadences | login 1500ms · ban 1500ms · mass-trade 1000ms · mass-sell 1000ms · folder-buy 1200ms (900ms on done) · SDA OTP bar 200ms + re-fetch at expiry · tradeup 1200ms · casket 1000ms (2000ms on error) · keep-alive 4000ms | app.js (per fn) |
| 193 | Bounded error-retry (S17) | Every self-rescheduling poller keeps polling through transient status errors until POLL_STALL_MS, then gives up with a visible non-fabricated terminal line | app.js:4779,5171,5199,5462,5970,6717,6741,6900,6943 |
| 194 | Search debounce | Buy/Fbuy/CSFloat-BO item search all debounce ~300–350ms; ignore stale in-flight results | app.js:6458,6469,4336 |
| 195 | 💰 Post-action live refresh | Trade (9s deferred), buy, sell, mass-buy, casket all re-pull affected accounts / active-view-from-cache so sent/sold/moved items stop showing as owned (INV-E1) | app.js:5076,5456,5862,6008,6936 |
| 196 | 💰 Confirm-gate on all money/asset paths | `ssimConfirm` guards: env/folder/account delete, mass-buy, trade-up execute, casket move, CSFloat buy/list/delist/order/clear-key, end-task | app.js (multiple) |
| 197 | No backdrop-close on data modals | Static modals close only via X / Cancel / Esc (prevents accidental loss); confirm + feature overlays DO backdrop-close (safe cancel) | app.js:6378,6595 |
