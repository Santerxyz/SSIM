# One-time migration: licence server to GitHub

This document covers moving the deployed fleet from the licence-gated builds to
v1.5.0, which has no licence and updates from GitHub. It is a one-time procedure.
Delete this file once the migration is finished.

Everything stated here was verified against the deployed client's own source, not
assumed. Where a claim came from running the real code, it says so.

## The one rule that governs everything

**A deployed client only reaches the updater after the licence gate passes.**

From `gateAndRun()` in the v1.4.5 source, with its own comment:

```
validate()  ->  not ok  ->  activation portal  ->  still not ok  ->  process.exit(1)
     |  ok
     v
maybeAutoUpdate()          // "Only licensed clients update."
```

So a client that fails the gate never downloads anything, and can never be
rescued by publishing an update. The licence server must stay up, reachable and
permissive until the fleet has moved.

**Do not, at any point before the migration completes:**

- shut down or firewall the licence server
- revoke any licence
- let any licence expire
- change the Ed25519 keypair

The gate passes on `token-valid`, on `offline-grace` (an expired token within 72
hours of the last server contact), or on a fresh `activated`. It fails, and the
client exits, when the token has expired, grace has elapsed, and re-activation
cannot reach the server or is refused. Re-activation always needs the server.

**Before starting, check every licence's expiry date on the server and extend any
that falls inside the migration window.** A seat that expires mid-migration takes
that machine out of reach permanently.

## What the deployed clients accept

Verified by running the real v1.4.5 `parseManifest` and `verifyUpdateSignature`
against manifests produced by `build/sign-update.js`:

| Manifest | Result |
|---|---|
| Correct, no `kind` field | parse accepted, signature valid |
| `sha256` altered by one character | signature invalid |
| `sigKind` removed | rejected at parse, before verification |
| `kind: "single-exe"` added, signature still for `backend` | signature invalid |

Three things follow:

1. **`sigKind` is mandatory.** A manifest without it is refused before the
   signature is even checked. Any tool that emits only the legacy `sig` will fail
   silently against the whole fleet.
2. **`sigKind` covers the kind tag**, over `latest:sha256:kind`, defaulting to
   `backend` when the manifest omits `kind`. Declaring a `kind` without signing
   that same tag invalidates the manifest.
3. The signature must come from the same Ed25519 key the clients already carry.
   That key is unchanged, and `src/update/config.ts` ships its public half.

Version comparison is numeric, so every deployed build treats 1.5.0 as newer:
1.2.4, 1.3.4, 1.4.5 and 1.4.10 all upgrade.

## Order of operations

The order is forced. Each step depends on the one above it.

### 1. Make the repository public

Until then `raw.githubusercontent.com` and release assets return 404 to
everyone, so a migrated client has no update channel, and GitHub Pages will not
serve the site. This is the gate for everything else.

### 2. Cut the v1.5.0 release

Tag `v1.5.0` and let the Release workflow build it, attach `SSIM.exe` and
`SHA256SUMS`, and record the provenance attestation. See [RELEASING.md](RELEASING.md).

### 3. Publish `version.json` for the GitHub channel

Sign the released exe with the offline key and commit `version.json` to `main`.
After this, a client already on 1.5.0 has a working update channel.

Do this **before** step 4. A freshly migrated client checks GitHub on its next
launch; if the manifest is missing it logs a failure. Nothing breaks, but the
channel should be proven live before the fleet arrives on it.

### 4. Publish the same build through the old licence server

This is the rescue vehicle, and the only thing that repoints existing installs.
Upload the **same** `SSIM.exe` from the GitHub release through the admin panel.
The server signs the manifest with the same keypair, so deployed clients accept
it.

Use the identical binary. A locally rebuilt one has a different hash, and then
the two channels disagree about what 1.5.0 is.

### 5. Watch the tail

Server-side, watch which versions still call `/validate` and `/heartbeat`. Each
client that migrates stops appearing. Wait until the remainder is small enough
to accept losing, remembering that a machine switched off for a month is not
lost, only late.

### 6. Freeze the server, do not kill it

Leave it serving:

- `/version` returning a static signed manifest that points at the GitHub asset
- `/validate` returning valid with no expiry, for anything that asks

Keep the DNS name resolving to that for as long as you can afford. A client that
boots after the shutdown must find a working answer rather than a connection
refused, because a refused connection is what sends it to the activation portal
and then to `exit(1)`.

## After the fleet has moved

- Retire the admin panel and the licence database.
- Keep the private signing key. It still signs every GitHub release, and losing
  it ends the update channel permanently.
- Delete this document.
