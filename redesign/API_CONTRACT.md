# SSIM Frontend ↔ Backend API Contract

**Binding contract.** Every backend interaction the *legacy functional* frontend makes.
The redesign MUST bind to these endpoints **identically** — same paths, methods, body
shapes, header, timeout/error semantics, polling cadences, and the exact response
fields the UI consumes. Backend (`src/`) is FROZEN, so this surface cannot move.

Sources (all `redesign/legacy_public/`): `app.js` (7007 lines), `index.html` (1552),
`logs.html`, `unlock.html`, `license.html`. Citations are `app.js:NNNN` unless the file
is named. All paths verified against every `fetch(...)`, the central `api()` wrapper, and
every `EventSource`.

---

## 0. TL;DR mechanics (read first)

- **Base URL**: `const API = '' ` (`app.js:5`). **Every** call is **same-origin, relative**
  (`fetch(API + path)`, `app.js:456`). The UI never learns or constructs a port/host — it
  simply uses whatever origin (`http://127.0.0.1:<port>`) the page was served from. Port
  discovery is the Tauri shell's job (it serves the page); the frontend inherits it. **Do
  not** hardcode a port or reintroduce an absolute base.
- **Central wrapper**: All dashboard calls go through `async function api(path, opts)`
  (`app.js:440`). It sets `Content-Type: application/json`, attaches the cap token header,
  bounds the call with a client timeout, parses JSON, and throws a rich `Error` on `!res.ok`.
  The redesign should reuse this wrapper verbatim.
- **Cap token header**: `X-SSIM-Cap: <token>` on **every** call when a token is available
  (`app.js:447`). Harmless on reads; **required** for mutating calls.
- **Auth model**: reads are open; **mutating** methods (`POST/PUT/PATCH/DELETE`,
  `MUTATING_METHODS`, `app.js:430`) require the cap token. A 401 with
  `{capabilityRequired:true}` triggers a persistent "session lost authorization — restart"
  banner (`app.js:471`, `renderCapabilityBanner` `app.js:1077`).
- **Default timeout**: 120000 ms per call (`app.js:452`), overridable via `opts.timeoutMs`
  (`0`/`null` → no timeout). Abort → a friendly "request timed out — backend may be busy"
  error with `status:0, timedOut:true` (`app.js:458-461`).
- **Error shape thrown by `api()`**: `Error` with `.message` (= `data.error` or `HTTP <n>`),
  `.status` (HTTP code or `0` on timeout), `.data` (full JSON body, exposing flags like
  `verifyBeforeRetry`, `orphaned`, `quarantined`, `capabilityRequired`) (`app.js:465-472`).

---

## 1. Endpoint table (dashboard — through `api()`)

Method · path — **body/query** — **response fields the UI reads** — cite. Unless noted,
timeout = 120 s default and errors surface via `toast(err.message,'error')`.

### Bootstrap / system

| Method | Path | Body / Query | Response fields UI uses | Cite |
|---|---|---|---|---|
| GET | `/api/system/status` | — | `licensed` (`=== false` → redirect to `/`), `version` (footer), `vaultLocked` (portal discriminator), `update{available,latest,blocked,installing,currentOutcome}`, breaker fields, `priorCrash{at,code}`, token-store & csfloat-key-store warning flags | 1091-1116, 6510-6539, 6558-6561 |
| GET | `/api/environments` | — | array of environments (id/name/proxy…) → `state.environments` | 568 |
| GET | `/api/accounts` | — | array of accounts; per item `.username,.enabled,.environmentId` (+ more) → `state.allAccounts` | 568, 617, 1169 |
| GET | `/api/inventory` | — | map `username → inv{username,items[],wallet,fetchedAt,totalItems,…}` (CS2) | 568, 626, 3610 |
| GET | `/api/inventory-tf2` | — | same map shape for TF2 | 544, 620, 3604 |
| GET | `/api/exchange-rate` | — | `usdToEur` (number), `fallback` (bool), `ageMs` (number) | 569, 573-577 |
| GET | `/api/pricing/source` | — | `effective` (active price source) | 6989 |
| PUT | `/api/pricing/source` | `{source}` | `effective`/echo (UI re-reads source) | 797 |
| GET | `/api/pricing/status` | — | `fetched`, `processed`, `running`, `queued` (drives price-fill watch) | 898, 911 |
| POST | `/api/app/check-update` | `{install?:true}` | `installing`, `error`, `available`, `latest`, `blocked` | 957 |
| POST | `/api/app/client-error` | `{message,source,stack}` | (fire-and-forget; response ignored) — **capability-exempt**, raw `fetch`, no header needed | 493 |

### Environments / folders / tree

| Method | Path | Body / Query | Response fields UI uses | Cite |
|---|---|---|---|---|
| GET | `/api/environments/{envId}/tree` | — | tree (folders + accounts) → `state.tree` | 1163, 1168, 4683, 4983, 5532 |
| GET | `/api/environments/{id}/check-proxy` | — | proxy-health result | 1295 |
| GET | `/api/environments/{id}/proxy` | — | proxy info | 4556 |
| POST | `/api/environments` | `{name,proxy}` | created env | 4586 |
| PATCH | `/api/environments/{id}` | `{name?,proxy?}` (`body`) | updated env | 4583 |
| DELETE | `/api/environments/{id}` | — | ok | 4601 |
| POST | `/api/folders` | `{name,environmentId,parentId|null}` | created folder | 4629 |
| PATCH | `/api/folders/{id}` | `{name}` | updated folder | 4633 |
| DELETE | `/api/folders/{id}` | — | ok | 4646 |
| POST | `/api/folders/{id}/reorder` | `{...}` (reorder payload) | ok | 4656 |

### Accounts

| Method | Path | Body / Query | Response fields UI uses | Cite |
|---|---|---|---|---|
| GET | `/api/accounts/{u}/logs` | — | account log lines | 1323 |
| GET | `/api/accounts/{u}/trade-url` | — | `tradeUrl`, `manual` | 2885 |
| GET | `/api/accounts/{u}/proxy` | — | proxy info | 3678 |
| GET | `/api/accounts/{u}/wallet` | — | `wallet{currency,balance}` (nullable) — **tri-state balance transport, see §6** | 5696, 5711 |
| GET | `/api/accounts/{u}/otp` | — | `code`, `msRemaining` (SDA live OTP; self-reschedules) | 4056 |
| GET | `/api/accounts/{u}/confirmations` | — | `confirmations[]` | 4103 |
| POST | `/api/accounts/{u}/confirmations/respond` | `{ids,accept,all}` | result | 4152 |
| POST | `/api/accounts/{u}/open-browser` | `'{}'` | ok | 4167 |
| POST | `/api/accounts/{u}/{route}` | — (enable/disable etc.) | ok | 3648 |
| POST | `/api/accounts/{u}/attach-mafile` | `{maFilePath}` | `username` (upgraded acct) | 3976 |
| GET | `/api/inventory/{u}` | — | single inv (post-patch reflect) | 3759 |
| GET | `/api/inventory/{u}?refresh=1` | — | single **live** inv `{items[],totalItems,category,quantity,wallet,…}`; UI sums `category==='tradelocked'/'listed'` | 3512, 3506 |
| GET | `/api/inventory-tf2/{u}?refresh=1` | — | same, TF2 | 3506 |
| POST | `/api/accounts` | `{...}` (create/import) | created account (`.username`) | 3796 |
| PATCH | `/api/accounts/{u}` | `{...}` | updated account | 3754 |
| DELETE | `/api/accounts/{u}` | — | ok | 3717, 4722 |
| POST | `/api/accounts/{u}/move` | `{folderId,environmentId}` | ok | 4699 |

### Login / import (session-based, polled — see §3)

| Method | Path | Body / Query | Response fields UI uses | Cite |
|---|---|---|---|---|
| POST | `/api/accounts/login/qr/start` | `{environmentId}` | session start (has `sessionId`) | 3854 |
| POST | `/api/accounts/login/credentials` | `{...creds}` | session start | 3905 |
| POST | `/api/accounts/login/{sessionId}/guard` | `{code}` | guard-step status | 3900 |
| GET | `/api/accounts/login/{sessionId}/status` | — | `state` (`imported`/`expired`/`error`/waiting), `username`, `isUpdate` | 3948 |
| POST | `/api/accounts/login/{id}/cancel` | — | ok (best-effort) | 3825 |

### Market — buy / sell / search (see §3 for job pollers)

| Method | Path | Body / Query | Response fields UI uses | Cite |
|---|---|---|---|---|
| GET | `/api/market/search?q=&appId=` | q, appId | `results[]{name,marketHashName,iconUrl,priceText}` | 4338, 5807, 5912 |
| GET | `/api/market/buy-price?...` | `username,marketHashName,appId` | `lowestMinor`, `decimals`, `currency` | 5774, 5929 |
| POST | `/api/market/buy` | `{username,marketHashName,appId,pricePerItemMinor,quantity}` | `filled`, `message`, `buyOrderId`, `confirmed`, `priceTotalMinor`, `currency` | 5850 |
| POST | `/api/market/preview` | `{names[],strategy,username,customCents?}` | map `name → {netCents,buyerCents}` | 5296, 5313 |
| POST | `/api/market/sell` | `{...}` | job `{total,…}` → starts `pollSell` | 5394 |
| GET | `/api/market/sell-status` | — | `done,total,listed,confirmed,recovered,retried,gone[],deferred[],failed[],phase,currentBot,running,cancelling` | 5418 |
| POST | `/api/market/folder-buy` | `{...}` | starts `pollFolderBuy` | 5954 |
| GET | `/api/market/folder-buy-status` | — | `phase,refreshed,processed,total,running,cancelling,placed,filled,skipped,failed,cancelled` | 5970 |
| GET | `/api/market/orders/{u}?appId=` | appId | live sell+buy orders | 2217 |

### Trades

| Method | Path | Body / Query | Response fields UI uses | Cite |
|---|---|---|---|---|
| POST | `/api/trade/send` | `{from,assetIds,appId,contextId:'2',toUsername|tradeUrl}` | `status`(`confirmed`/`unconfirmed`/…), `offerId`, `to`; error `.data.verifyBeforeRetry` | 5060 |
| POST | `/api/trade/mass-send` | `{items,appId,contextId:'2',toUsername|tradeUrl}` | `bots`, `totalItems` → starts `pollMass` | 5100 |
| GET | `/api/trade/mass-status` | — | `done,total,confirmed,failed[],running,cancelling` | 5170 |
| POST | `/api/trade/offers` | `{usernames}` | aggregated sent+received offers | 2447 |
| POST | `/api/trade/offer-action` | `{username,offerId,action}` | result | 2618 |
| POST | `/api/trade/offers-batch` | `{items}` | batch result | 2644 |

### History (chart)

| Method | Path | Body / Query | Response fields UI uses | Cite |
|---|---|---|---|---|
| GET | `/api/history/{seriesId}?game=` | game | points[] (worth/wallet curve) | 1798 |
| POST | `/api/history/aggregate` | `{seriesIds,game}` | points[] (aggregated) | 1794 |

### Bans

| Method | Path | Body / Query | Response fields UI uses | Cite |
|---|---|---|---|---|
| POST | `/api/bans/check` | `{usernames}` | starts `pollBanCheck`; 409 = already running | 4767 |
| GET | `/api/bans/status` | — | `result`, `running`, `error`, `progress{resolved,keysAcquired,checked,total}` | 4784 |

### Trade-ups

| Method | Path | Body / Query | Response fields UI uses | Cite |
|---|---|---|---|---|
| POST | `/api/tradeup/candidates` | `{username}` | candidate contracts | 6636 |
| POST | `/api/tradeup/execute` | `{username,contracts}` | starts `tuPollExec` | 6708 |
| GET | `/api/tradeup/execute-status` | — | `enabled,done,total,crafted,failed,running,cancelling,statusReason,results[]{confirmed,error}` | 6720 |
| POST | `/api/tradeup/execute-cancel` | — | ok (best-effort) | 6728 |

### Storage units (caskets)

| Method | Path | Body / Query | Response fields UI uses | Cite |
|---|---|---|---|---|
| GET | `/api/casket/{u}/list` | — | casket list | 6764 |
| GET | `/api/casket/{u}/contents?casketId=` | casketId | contents | 6787 |
| POST | `/api/casket/move` | `{username,casketId,itemIds,direction}` | starts `casketPollMove` | 6891 |
| GET | `/api/casket/move-status` | — | `direction,done,total,moved,unconfirmed,failed,running,cancelling,error,stoppedReason` | 6903 |
| POST | `/api/casket/move-cancel` | — | ok (best-effort) | 6914 |

### Import / mafiles

| Method | Path | Body / Query | Response fields UI uses | Cite |
|---|---|---|---|---|
| POST | `/api/import/vault` | `{vault,accountsJson,password,environmentId,folderId}` | import result | 5517 |
| POST | `/api/import/csv` | `{csv,environmentId,folderId}` | import result | 5606 |
| GET | `/api/mafiles/unlinked` | — | list of unlinked maFiles | 5540 |
| POST | `/api/mafiles/import` | `{files,environmentId,folderId}` | import result | 5577 |

### CSFloat workspace (per account; all via `csfApi`)

`csfApi(path,opts) = api('/api/csfloat/' + encodeURIComponent(CSF.username) + path, opts)`
(`app.js:3993`). Renderers extract fields **defensively** (undocumented shapes).

| Method | Path | Body / Query | UI use | Cite |
|---|---|---|---|---|
| GET | `/api/csfloat/config` | — | `{experimental}` | 4015 |
| PUT | `/api/csfloat/config` | `{experimental}` | toggle | 4481 |
| GET | `/api/csfloat/{u}/key` | — | `{configured}` | 4016 |
| PUT | `/api/csfloat/{u}/key` | `{apiKey}` | set key | 4469 |
| DELETE | `/api/csfloat/{u}/key` | — | clear key | 4477 |
| GET | `/api/csfloat/{u}/me` | — | account summary | 4203 |
| GET | `/api/csfloat/{u}/listings?limit=50` | limit | listings[] | 4207, 4228 |
| GET | `/api/csfloat/{u}/listings/search?...` | search params | results | 4278 |
| POST | `/api/csfloat/{u}/listings` | `{asset_id,price,type:'buy_now'}` | create listing | 4527 |
| PATCH | `/api/csfloat/{u}/listings/{id}` | `{price}` (cents) | reprice | 4500 |
| DELETE | `/api/csfloat/{u}/listings/{id}` | — | remove listing | 4493 |
| GET | `/api/csfloat/{u}/buy-orders?limit=50` | limit | orders[] | 4309 |
| POST | `/api/csfloat/{u}/buy-orders` | `{...}` | place order | 4513 |
| DELETE | `/api/csfloat/{u}/buy-orders/{id}` | — | cancel order | 4518 |
| POST | `/api/csfloat/{u}/buy` | `{listingId,totalPrice}` | buy listing | 4506 |
| GET | `/api/csfloat/{u}/trades?limit=50` | limit | trades[] | 4374 |
| GET | `/api/csfloat/{u}/auto-accept` | — | `{enabled}` | 4374 |
| PUT | `/api/csfloat/{u}/auto-accept` | `{enabled}` | `{enabled}` | 4488 |
| GET | `/api/csfloat/{u}/inventory` | — | items[] | 4399 |

---

## 2. Endpoints OUTSIDE `api()` — raw `fetch` / portals / streams

These bypass the wrapper: they are on **portal pages** (unlock/license) that render
*before* the dashboard and its cap token exist, or are heartbeats/telemetry, or the SSE
stream. **No `X-SSIM-Cap` header** is sent on any of these; the backend treats them as
capability-exempt.

| Method | Path | Where | Body | UI use | Cite |
|---|---|---|---|---|---|
| GET | `/api/vault/state` | unlock.html | — | `exists` → firstRun = `!exists` (create vs unlock) | unlock.html:134 |
| POST | `/api/vault/unlock` | unlock.html | `{password,confirm,createEmptyAnyway?}` | `ok`, `created`; 409 `{orphaned:true,error}` → orphan mode | unlock.html:187 |
| GET | `/api/system/status` | unlock.html | — (`cache:'no-store'`) | readiness gate: `vaultLocked !== true` ⇔ dashboard live → `location.replace('/')` | unlock.html:204 |
| GET | `/api/license/state` | license.html | — | `hwid` (shown), (also gates state) | license.html:74 |
| POST | `/api/license/activate` | license.html | `{key}` | `ok`, `tier`, `error` | license.html:88 |
| GET | `/api/system/status` | license.html | — (`cache:'no-store'`) | readiness gate: `licensed === true` → `location.replace('/')` | license.html:105 |
| GET | `/api/system/status` | app.js `ensureLicensed` | — (`cache:'no-store'`, 8 s abort) | boot license gate: `res.ok && licensed===true`; 403 or `licensed===false` → `/`; else "backend unreachable" retry screen | 6515 |
| GET | `/api/system/status` | app.js unreachable re-probe | — (`cache:'no-store'`, 6 s abort, every 3 s) | `licensed===true` → `location.reload()` | 6559 |
| GET | `/api/app/ping` | index.html + unlock.html | — | keep-alive heartbeat every **4000 ms** (legacy Edge; Tauri now owns shutdown) | index.html:1511, unlock.html:117 |
| POST | `/api/app/open-logs` | index.html Live Logs launcher | — | signals Tauri shell to open native logs window | index.html:1545 |
| GET (SSE) | `/api/logs/stream` | logs.html | — | live log stream — see §4 | logs.html:136 |

---

## 3. Polling loops (job-status pollers + watchers)

Two idioms:
1. **`api()`-driven self-rescheduling pollers** — recursive `setTimeout`; each poll re-reads
   a `*-status` endpoint until `!job.running`.
2. **Watchers** — a `while(true)` loop with `await sleep(ms)`.

Shared guards: `POLL_STALL_MS = 180000` (3 min zero-progress → give up, `app.js:6098`);
`pollerStalled(key,done)` / `resetPoller(key)` (`app.js:6099-6106`) drive both a
**no-progress** guard (job counter frozen while `running`) and a **consecutive-error** guard
(transient status errors retry until 3 min of *continuous* failure, then a terminal
give-up line — never a fabricated "done"). A good poll `resetPoller`s the error window.

| Loop | Endpoint | Interval | Stop condition | Error/retry UX | Cite |
|---|---|---|---|---|---|
| `watchSystemStatus` | `/api/system/status` | **30000 ms** | never (life of process) | `st=null` on error, skip a tick | 1091-1117 |
| `watchPriceFill` | `/api/pricing/status` | **2500 ms** | `!busy` or 15-min no-progress (`REPRICE_NO_PROGRESS_MS`) | stop after **24** consecutive errors (`MAX_CONSEC_ERRORS`); re-pull coalesced ≥ `REPRICE_MIN_REPULL_MS=10000` | 894-943 |
| `pollRefresh` | `/api/inventory/refresh-status` | **immediate re-arm** (recursive, no fixed delay) | `!job.running` | bounded error retry via `pollerStalled('refreshErr')`; stall guard on `job.done` | 3584-3641 |
| `pollBanCheck` | `/api/bans/status` | **1500 ms** | `job.result` / (`!running && error`) | `banErr` bounded retry; `ban` stall guard | 4780-4808 |
| `pollMass` | `/api/trade/mass-status` | immediate re-arm | `!job.running` | `massErr` bounded retry; stall on `job.done` | 5166-5200 |
| `pollSell` | `/api/market/sell-status` | immediate re-arm | `!job.running` | `sellErr` bounded retry; stall on `job.done` | 5414-5463 |
| `pollFolderBuy` | `/api/market/folder-buy-status` | **1200 ms** | `!job.running` | `fbuyErr` bounded retry; stall on `processed+refreshed` | 5966-6004 |
| `tuPollExec` | `/api/tradeup/execute-status` | **1200 ms** | `!j.running` | `tuExecErr` bounded retry → terminal "status LOST, verify in-game" | 6713-6747 |
| `casketPollMove` | `/api/casket/move-status` | **1000 ms** (running), **2000 ms** (error retry) | `!j.running` | `casketErr` bounded retry → "status unavailable, reopen Storage" | 6896-6949 |
| `startLoginPoll` | `/api/accounts/login/{sid}/status` | **1500 ms** (`setInterval`) | terminal state (`imported`/`expired`/`error`) or modal close | swallow transient/404, keep polling | 3945-3952 |
| Live OTP (SDA) | `/api/accounts/{u}/otp` | self-reschedules at `msRemaining+300` | modal close / account change | re-fetch on expiry | 4056, 4071 |

Also polled by portals (§2): unlock.html readiness (**500 ms**), license.html readiness
(**700 ms**), unreachable re-probe (**3000 ms**), ping heartbeat (**4000 ms**).

**Redesign note:** these cadences and the stall/error semantics are load-bearing against a
busy 500-account backend. Preserve the intervals, the `POLL_STALL_MS` giveup, and the rule
that a lost status poll for a money/irreversible job (trade-up, mass-send, casket) must
render a *terminal "status lost — verify"* line, **never** a fabricated success.

---

## 4. SSE / live-log stream

`logs.html` is a standalone window (opened via the index.html launcher). It consumes exactly
one stream:

- `new EventSource('/api/logs/stream')` (`logs.html:136`).
- **Events**: default `message` events; `ev.data` is a JSON line
  `{t:<iso>, level:'error'|'warn'|'info'|'debug', msg:<string>}` — parsed in `addLine`
  (`logs.html:92-108`). Unknown levels coerce to `info` (`logs.html:95`).
- **Reconnect**: relies on native `EventSource` auto-reconnect; the server sends
  `retry: 3000` (comment `logs.html:140`). `onopen` → status "live" + green dot;
  `onerror` → status "reconnecting…" + red dot (`logs.html:137-139`). No manual backoff.
- **Client-side only** (no backend calls): level filter chips, text search, follow/auto-scroll,
  a 3000-row DOM cap (`MAX_ROWS`, `logs.html:76,105`).
- **No cap token** is used or needed on the stream.

The dashboard itself does **not** open the stream — it only (a) opens the window via
`window.open('/logs.html', …)` and (b) POSTs `/api/app/open-logs` so the Tauri shell can open
a native logs window instead (`index.html:1539-1546`).

---

## 5. Capability-token lifecycle (the P0/S1 reload fix)

This is the single most important mechanic to reproduce exactly.

**Delivery.** The Tauri shell injects a per-run secret out-of-band by `eval`-ing
`window.__SSIM_CAP__ = '<token>'` into the dashboard document (dev/Edge build injects it into
`index.html`). It is **not** a literal in the shipped `index.html`. (`app.js:409-423`.)

**The bug it fixes (S1).** `window.__SSIM_CAP__` is an in-memory value that **does not survive
a reload** — F5, WebView2 renderer recovery, or the `location.replace('/')` used by the
license/vault-locked redirects. Before the fix, any reload dropped the token and every
money/config/refresh op 401'd until a full app restart, while reads kept working (so the app
*looked* alive).

**The fix — `capToken()` (`app.js:415-429`):**
1. Read `window.__SSIM_CAP__`.
2. If present, **persist it to `sessionStorage['ssim_cap']`** the first time it's seen.
3. If absent (post-reload), **fall back to the `sessionStorage` copy**.
4. `sessionStorage` is per-origin (`http://127.0.0.1:<port>`), so a **fresh process on a new
   port never inherits a stale token** — correctness preserved.
5. Wrapped in `try/catch` so private-mode / non-browser (no `sessionStorage`) degrades to the
   window value only.

**Send path (`api()`):**
- `MUTATING_METHODS = {POST,PUT,PATCH,DELETE}` (`app.js:430`).
- For a mutating call, `await awaitCap()` first — polls `capToken()` every 25 ms up to 3000 ms
  for the shell's injection to land, so the initial load isn't blocked but an early write
  waits briefly (`app.js:431-438,444`).
- The header `X-SSIM-Cap: <cap>` is attached whenever a token exists — **reads included**
  (harmless, `app.js:445-447`). Reads never wait.

**Failure surface.** A `401` whose body has `capabilityRequired:true` calls
`renderCapabilityBanner()` (`app.js:471,1077`): a persistent center-top banner stating that
**only a full restart** re-mints the token (a reload can't). The `/api/app/client-error`
reporter is deliberately capability-exempt so error telemetry still ships while capless
(`app.js:492`).

**Redesign requirement:** keep `capToken()` + the `sessionStorage['ssim_cap']` stash + the
`X-SSIM-Cap` header + `awaitCap()` gating + the `capabilityRequired` banner *byte-for-byte in
behaviour*. Do not switch to `localStorage` (cross-process leak) or drop the sessionStorage
fallback (reintroduces S1).

---

## 6. Balance tri-state transport (S4/S13/INV — never let empty masquerade as unknown)

Three strict display states, decided from *transport*, not truthiness:

| State | Meaning | Display |
|---|---|---|
| never refreshed | no cached inv AND no remembered wallet | `—` |
| refreshed, empty | fetched but `hasWallet=false` / no funds | `0,00` |
| funded | wallet with a balance | the value |

**How wallet data arrives:**
- Inventory maps (`/api/inventory`, `/api/inventory-tf2`) attach `inv.wallet` **and
  `inv.fetchedAt`** per account — the wallet rides on the inventory payload, **even when
  `hasWallet=false`** (the value is `0`, not absent). `rememberWallet(inv)` (`app.js:590-596`)
  stores the **most recently fetched** wallet by `fetchedAt` timestamp into
  `state.wallets[username.toLowerCase()] = {wallet, ts}`, so a staler game-cache can never
  clobber a fresher balance. The wallet is **one account property shared across CS2 and TF2**
  (whichever game refreshed last is source of truth for both).
- `wasRefreshed(u)` (`app.js:603-609`) returns true if there is a cached inv **or** a
  remembered wallet — this is what distinguishes "refreshed-empty → 0" from "never-fetched → —".
  A missing `wallet` must **not** gate display off; the code stores the wallet even when empty.
- The exact, live per-account balance for the buy modal comes from
  `GET /api/accounts/{u}/wallet` → `{wallet:{currency,balance}}` (nullable). `updateBuyWallet`
  / `refreshBuyWallet` (`app.js:5690-5716`) show the local value instantly, then overwrite with
  the fresh backend value and also update `state.wallets`. On error they **keep** the local
  value (`catch { }`) — never blank it.
- Stat cards use `setMoneyStats(valueCents, walletUsd)` (`app.js:1125-1128`): `null` → `—`,
  otherwise a compact figure with the exact amount on hover.

**Redesign requirement:** carry `inv.wallet` + `inv.fetchedAt` through unchanged, keep the
`state.wallets` newest-wins store, and keep the three states distinct. Regressing this to
"falsy balance → unknown" is the exact INV-E5 bug that has recurred 3×.

---

## 7. Error → user-visible state mapping

| Backend signal | UI state | Cite |
|---|---|---|
| any `api()` reject `.message` | `toast(msg,'error')` (default) | throughout |
| timeout/abort (`status:0,timedOut`) | toast "request timed out — backend may be busy" | 458-461 |
| `401 {capabilityRequired:true}` | persistent center-top "session lost authorization — restart SSIM" banner | 471, 1077 |
| `409` on `/api/bans/check` | toast "a ban check is already running" | 4770 |
| `409 {orphaned:true}` on `/api/vault/unlock` | switch unlock page to destructive "create NEW empty vault" mode | unlock.html:219 |
| trade/buy reject with `.data.verifyBeforeRetry` (or any failed money POST) | toast "may have placed an order — verify before retrying" + auto-refresh the affected account(s) | 5081, 5867 |
| `system/status.licensed === false` (runtime) | `location.replace('/')` → activation portal | 1100 |
| boot `system/status` 403 / `licensed:false` | `location.replace('/')` | 6533 |
| boot `system/status` unreachable / 5xx / non-JSON | full-screen "Can't reach SSIM's backend" retry screen (auto re-probes every 3 s, manual Retry) | 6521, 6544 |
| uncaught `window.onerror` / `unhandledrejection` | toast "UI error: …" + POST `/api/app/client-error` (coalesced 1 s) | 484-503 |
| price-fill status dead (24 consec errors) | hide "Fetching prices…" badge, stop watch | 916 |
| job status poll lost (money/irreversible job) | terminal "status lost — verify in-game" line, never a success toast | 6743, 6945 |
| load-failure of TF2 cold fetch | distinct "couldn't load TF2 — Retry" panel (not a silent empty inventory) | 542-556 |

---

## 8. Invariants for the redesign (do-not-break checklist)

1. `API=''`; every call same-origin relative. Never hardcode a port. (§0)
2. Route all dashboard calls through the `api()` wrapper; keep the 120 s default timeout and
   the rich thrown-error shape (`.status/.data/.message`). (§0)
3. `X-SSIM-Cap` on every call; `awaitCap()` before mutations; `capToken()` reads
   `window.__SSIM_CAP__` then `sessionStorage['ssim_cap']` (never `localStorage`). (§5)
4. Reproduce the `capabilityRequired` restart banner. (§5, §7)
5. Keep the exact poll cadences and the `POLL_STALL_MS`/consec-error giveup semantics; a lost
   money-job status renders "verify", never "done". (§3)
6. Live logs = `EventSource('/api/logs/stream')`, JSON `{t,level,msg}` lines, native reconnect.
   Dashboard also POSTs `/api/app/open-logs`. (§4)
7. Balance tri-state: carry `inv.wallet` + `inv.fetchedAt`, newest-wins `state.wallets`, three
   distinct states; empty wallet ≠ unknown. (§6)
8. Portals (unlock/license) are separate pages that poll `/api/system/status` for readiness
   before `location.replace('/')`; the vault discriminator is `vaultLocked!==true`, the license
   discriminator is `licensed===true`. (§2)
9. Keep the keep-alive `POST`… actually `GET /api/app/ping` every 4000 ms on index + unlock. (§2)
10. `/api/app/client-error` and `/api/logs/stream` are capability-exempt and must work while
    the session is capless. (§2, §5)
