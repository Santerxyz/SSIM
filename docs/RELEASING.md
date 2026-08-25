# Releasing SSIM

For maintainers. Contributors do not need this. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## How updates work

SSIM's updater ([`src/update/Updater.ts`](../src/update/Updater.ts)) fetches a small
static JSON manifest, verifies it, and only then replaces the running executable:

```
GET  UPDATE_MANIFEST_URL          → { latest, url, sha256, sig, sigKind }
     ↓  version newer than mine?
     ↓  download url (resumable)
     ↓  sha256 matches?
     ↓  Ed25519 sigKind valid under UPDATE_PUBLIC_KEY?
     ↓  new exe passes SSIM_SELFTEST?
     swap + relaunch
```

Every one of those gates must pass. There is no server involved, the manifest is a file.

> ### ⚠ The signing key is the single point of no return
>
> One Ed25519 keypair signs every update. The public half ships inside every exe
> ([`src/update/config.ts`](../src/update/config.ts)); the private half must never
> leave your control and must never be committed.
>
> **If you regenerate it, every installed copy of SSIM stops accepting updates forever.**
> They verify against the key baked into the binary they are already running, and there
> is no channel left to push a replacement through. Losing the private key has the same
> effect. Back it up somewhere you will still have in five years.

## Cutting a release

**1. Bump the version.** `package.json` is canonical, the Tauri shell and the dashboard
footer both derive from it. Use a plain 3-part semver: the updater compares numerically and
silently treats `1.5.0-rc1` as "not newer".

**2. Write the release notes** in `RELEASE_NOTES.md`.

**3. Tag it, CI builds and publishes the release.**

```bash
git tag v1.4.10 && git push origin v1.4.10
```

The `Release` workflow typechecks, runs the full suite, builds `SSIM.exe`, writes
`SHA256SUMS`, records a build-provenance attestation, and creates the GitHub release with
both files attached. A failing test stops the release, a build that fails its own tests
must never reach a user, because the updater installs it automatically.

The attestation lets anyone confirm the binary came from this commit of this repository:

```bash
gh attestation verify SSIM.exe -R Santerxyz/SSIM
```

That matters more here than in most projects: an unsigned executable that asks for Steam
credentials is exactly what a counterfeit build looks like, and this is how a user tells
the two apart until code signing is in place.

**Building locally instead** (for testing, or if CI is unavailable):

```bash
npm run build          # typecheck + compile (also produces dist/, which step 4 needs)
npm test
npm run build:tauri    # → release-tauri/SSIM/SSIM.exe
```

**4. Sign the manifest and generate the checksum.**

```bash
node build/sign-update.js \
  --exe release-tauri/SSIM/SSIM.exe \
  --version 1.4.10 \
  --url https://github.com/Santerxyz/SSIM/releases/download/v1.4.10/SSIM.exe \
  --key /path/to/update_private.pem \
  --out version.json
```

Download the released `SSIM.exe` from the tag CI just published and sign **that exact
file**. Signing a locally rebuilt one risks a hash that does not match what users
download.

This writes `version.json` (and a `SHA256SUMS`, which CI has already attached, the release
asset is the authoritative one). `--url` is the release asset URL for the tag.

The script **self-verifies before writing anything**: it resolves the public key from
`dist/update/config.js` (the key actually baked into clients) and refuses to emit a
manifest whose signature doesn't check out. That guard is the difference between catching a
wrong key now and bricking the fleet's update path permanently. If it ever fails, stop.
Do not publish.

**5. Publish the manifest.** Commit `version.json` to `main`. That is the file
`UPDATE_MANIFEST_URL` points at, so **the release goes live to every client the moment this
lands**, do it last, after the exe is uploaded and reachable. A manifest whose `url` 404s
means every client downloads nothing and logs a failure.

**6. Prove the fleet will actually take it.**

```bash
npm run verify-release
```

Fetches the live manifest and runs the client's own `parseManifest` and `isNewer` against it,
checks the asset URL resolves, streams it to confirm the sha256 matches, verifies `sigKind`
under the public key baked into this build, and prints, per prior version, whether a customer
on it would update. Non-zero exit means they would not.

Do not skip this. v1.5.2 was published as a GitHub release while `version.json` on `main` still
advertised `1.5.1` and pointed at a `v1.5.1` tag that never existed. Clients on 1.5.1 were told
they were up to date; clients on 1.5.0 downloaded a 404 on every boot. It went unnoticed for four
days: nothing looks broken on a stranded client, the version is just old.

`sign-update.js` now also refuses, at signing time, a `--version` that disagrees with
`package.json` or a `--url` that does not contain the version (override with
`--allow-version-mismatch` / `--allow-url-mismatch`). Either guard alone would have caught this.

**7. Verify like a user.** From a clean machine, download the exe from the release page,
check the hash against `SHA256SUMS`, and run it.

## Rolling back

Revert `version.json` on `main` to the previous release's contents. Clients only update
*forward* (`isNewer`), so anyone who already took the bad version will not roll back
automatically. You have to ship a higher version with the fix. Leave the bad release's
assets up; deleting them breaks the in-flight downloads of anyone mid-update.

## The manifest must be publicly reachable

`UPDATE_MANIFEST_URL` and the release asset URL are fetched by clients with **no
credentials**. While the repository is private, `raw.githubusercontent.com` and release
assets both return 404 to everyone. Until the repo is public, the update channel does not
work, that is expected, not a bug.

## Retiring the old licence server (one time)

Deployed clients from before the Apache-2.0 pivot still point their updater at
`license.ssim.dev` and hold a 72-hour offline grace with a revocation heartbeat.

**Killing that server before those clients have migrated hard-locks every one of them
within 72 hours, with no update channel left to rescue them.** The order is forced:

1. Publish the delicensed build **through the old server**. It is the rescue vehicle,
   and the only thing that repoints clients at GitHub.
2. Watch which versions still call home; wait for the tail to shrink.
3. **Freeze, don't kill.** Leave `/version` serving a static signed manifest that points at
   the GitHub asset, and `/validate` returning valid-with-no-expiry, for as long as you can
   afford. A stale client that boots after the shutdown must find a working answer, not a
   connection refused.

The Discord bot now reads releases from the GitHub API, so it is unaffected by the
licence server going away. The full procedure is in [MIGRATION.md](MIGRATION.md).
