# SSIM — License-Server Contract & Deploy (what v1.3.0 depends on)

The license server is a **separate project**: `C:\Users\admin\Desktop\ssim-license-server` (NOT part of
this repo, NOT under this repo's git). The SSIM client (`src/licensing/`) talks to it over HTTPS at
`LICENSE_API_URL` (canonical: **`https://license.ssim.dev`**). This documents the exact contract 1.3.0
relies on, and the server changes made for 1.3.0 that **must be deployed** before the migration cut.

---

## Public client endpoints (`server.js`)

| Endpoint | Client sends | Server returns | Client verifies |
|---|---|---|---|
| `POST /activate` | `{key, hwid}` | 200 `{token, tier}` / 404 / 403 / 409 | Ed25519 token sig + `token.hwid===hwid`; caches token `0o600` |
| `POST /validate` | `{hwid, token}` | 200 `{status:'ok'\|'revoked'}` | on `revoked` → re-activation flow |
| `POST /heartbeat` | `{hwid, token}` | 200 `{token}` (rolled) / 403 `{status:'revoked'}` | re-verifies + re-stores fresh token (every 45 min) |
| `GET /version` | — | the update manifest (below) | `isNewer` + sha256 + Ed25519 over `${latest}:${sha256}`, then boot self-test |
| `GET /download/:file` | Range-resumable | 200/206 exe bytes (`res.download` → honors Range) | sha256 + sig |

Token payload `{hwid, exp, iat, tier, key}`; wire format `base64url(json).base64url(ed25519sig)`. The
signing **private key lives only on the server** (`keys/private.pem`); the client has only the baked
`LICENSE_PUBLIC_KEY`, which verifies **both** license tokens **and** update signatures.

## The `/version` update manifest

Served verbatim from `data/version.json`:
```json
{
  "latest":  "1.3.0",
  "url":     "https://license.ssim.dev/download/SSIM-1.3.0.exe",
  "sha256":  "<hex of the served exe>",
  "sig":     "<ed25519(`${latest}:${sha256}`) base64url>",
  "kind":    "single-exe",          // OPTIONAL — present only on a --migrate cut
  "files":   [ { "name": "SSIM.exe", "url": "…", "sha256": "…" } ],
  "filesSig":"<ed25519(manifestSigPayload) base64url>"   // for the OLD Gen-B two-file client only
}
```
- The **single-exe client** (1.3.0) reads only the **top-level** `{latest,url,sha256,sig,kind}`.
- `files[]/filesSig` is consumed only by the **old Gen-B two-file client** (`runManifestUpdate`).
- `kind` is **unsigned** (a forged `kind` can only misplace an already-signed exe → a broken install, never
  unsigned-code execution). The two-file→single-exe migration in the dual updater fires **only** when
  `/version` carries `kind:"single-exe"`.

## Admin release endpoints (`admin.js`, behind the login cookie) — used by `build/publish.js`

| Endpoint | Purpose |
|---|---|
| `POST /admin/login` | `{password}` → session cookie (needs `ADMIN_PASSWORD`) |
| `POST /admin/api/release/stage?version&name` | upload raw exe bytes → `{storedAs, sha256}` |
| `POST /admin/api/release/finalize` | `{version, backend, files[], kind?, allowDowngrade?}` → build + **server-sign** the manifest, write `version.json` |
| `POST /admin/api/release/rollback` | `{to?, manifest?}` → restore `/version` to a prior signed manifest |
| `GET /admin/api/version` · `/version-history` | inspect current + full publish log |

---

## Server changes made for 1.3.0 (in the sibling repo — **DEPLOY before the migrate cut**)

`ssim-license-server/src/admin.js`:
1. **`finalize` now echoes `kind`** into `version.json` (`kind:"single-exe"` when sent). *This is the
   migration blocker fix* — without it, a `--migrate` cut silently degrades to an in-place backend swap and
   the two-file fleet never collapses to single-exe.
2. **Enforced downgrade guard** — `finalize` returns **409** for a version not strictly newer than the last
   publish, unless `allowDowngrade:true`. (Was advisory: it warned but published anyway.)
3. **`PUBLIC_BASE_URL` unset → warns** (so a localhost/dev URL can't silently ship in the manifest).
4. **Full signed manifest stored in history** + new **`POST /release/rollback`** route (restores a prior
   manifest from history or a caller-supplied one; bypasses the downgrade guard by design).

Verified locally end-to-end (15/15: kind echo, public url, downgrade 409 + override, both rollback paths).
The license guard (`activate`/`validate`/`heartbeat`/`token`/`licenses`) was **not touched**.

### Deploy checklist (operator)
- [ ] Deploy the updated `admin.js` to the VPS and restart the server.
- [ ] Ensure `.env` sets **`PUBLIC_BASE_URL=https://license.ssim.dev`** (or the download host), `ADMIN_PASSWORD`,
      and the signing key (`PRIVATE_KEY` env or `keys/private.pem`). The baked client `LICENSE_PUBLIC_KEY` must
      match this private key, or clients log **"verification failed"**.
- [ ] `/download` host must honor **HTTP Range/206** (it does via `res.download`) so the resumable downloader
      can resume a ~185 MB artifact. Keep `license.ssim.dev` grey-clouded for the 164 MB publish upload
      (Cloudflare free caps request bodies at 100 MB); serve downloads from a Range-friendly host.
- [ ] The local `data/version.json` is **stale dev state** (`1.2.0`, `127.0.0.1` URLs). The live `/version`
      is republished to **1.3.0** by `npm run publish-update` at release time; confirm the live `latest` is
      lower than 1.3.0 first (the enforced guard will 409 otherwise).

> Rollout order (see `docs/UPDATER_RUNBOOK.md`): `--legacy-backend` to get the fleet on the dual updater →
> **then** `--migrate` (requires the deployed `kind` echo) → canary one client → broad.
