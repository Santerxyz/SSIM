// ════════════════════════════════════════════════════════════════════════════
//  Update configuration.
//
//  SSIM is free software (Apache-2.0). There is NO licence check, no activation,
//  no HWID, and no telemetry — this file used to hold the anchors for all of
//  that and now holds only what the auto-updater needs.
//
//  Nothing here is secret, and NOTHING here is required to build. A contributor
//  can clone and build with no env vars, no key files, and no secrets.local.bat.
//  If that ever stops being true, it's a bug — see CONTRIBUTING.md.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Where the updater looks for the signed release manifest.
 *
 * The manifest is a small JSON blob — `{ latest, url, sha256, sig }` — hosted as
 * a static file. It is deliberately not the GitHub Releases API: that API has
 * nowhere to carry our Ed25519 signature, and dropping the signature check on a
 * ~185 MB executable that handles Steam passwords and maFile secrets would be a
 * bad trade for a little convenience. So we publish our own signed manifest and
 * point `url` at the GitHub release asset.
 *
 * Overridable so forks can run their own update channel without patching source.
 * A fork SHOULD do this: builds signed by our key are ours, and yours should be
 * yours (see TRADEMARK.md).
 */
export const UPDATE_MANIFEST_URL: string =
  process.env.SSIM_UPDATE_MANIFEST_URL ??
  'https://raw.githubusercontent.com/Santerxyz/SSIM/main/version.json';

/**
 * Ed25519 PUBLIC key (PEM, SPKI) that update manifests are verified against.
 *
 * Public by definition — it verifies signatures, it cannot create them. The
 * private counterpart never leaves the maintainer's release process. Committing
 * it in the clear is correct and is what every signed-update scheme does.
 *
 * ⚠ DO not REGENERATE this KEYPAIR. Every deployed client verifies against this
 * exact key; a new one means no existing install can ever accept another update,
 * stranding the fleet with no recovery channel. Forks running their own channel
 * should override the key and the manifest URL together.
 */
const RAW_PUBLIC_KEY: string =
  process.env.SSIM_UPDATE_PUBLIC_KEY ??
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAlZtkREWxSz4Mt9WZVChTdJU+eonO3eCTGFVz/1akAMk=\n-----END PUBLIC KEY-----';

// Accept the key as a one-liner with literal "\n" (how an env override supplies
// it) OR with real newlines — normalise to a valid PEM either way.
export const UPDATE_PUBLIC_KEY: string =
  RAW_PUBLIC_KEY.includes('\\n') ? RAW_PUBLIC_KEY.replace(/\\n/g, '\n') : RAW_PUBLIC_KEY;

/** Network timeout for every update HTTP call. */
export const UPDATE_HTTP_TIMEOUT_MS = 15_000;
