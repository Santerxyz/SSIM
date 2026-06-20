// ════════════════════════════════════════════════════════════════════════════
//  Licensing configuration – BUILD-TIME constants
//
//  These values are the security anchor of the whole protection scheme. They are
//  meant to be INJECTED AT BUILD TIME (see build/pack.js) and baked into the
//  V8 bytecode (.jsc) so they are not trivially readable in a shipped binary.
//
//  The defaults below are DEV placeholders. The build replaces them via
//  `LICENSE_*` env vars. NEVER commit the production pepper / private material.
//  Only the PUBLIC key lives here – the matching private key stays on the
//  license backend and signs tokens. A cracker holding this file still cannot
//  forge a valid license token.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Secret pepper mixed into the HWID HMAC. Build-injected; never in data/.
 *
 * THREAT MODEL / KNOWN LIMIT (#22): this is a SINGLE shared symmetric secret baked
 * into every client binary. Bytecode + obfuscation only RAISE the cost of recovering
 * it (e.g. base64-decoding the obfuscator string array) — they do not make it secret.
 * Consequences and the explicit limit of this protection:
 *   • Token forgery is still impossible (only the Ed25519 PUBLIC key ships; the
 *     signing private key stays on the backend).
 *   • But once one binary is cracked, an attacker can compute valid HWIDs for
 *     arbitrary machines, easing seat-spoofing/bulk activation, and the pepper
 *     cannot be rotated per-seat without a client rebuild.
 * The REAL fix is server-side and out of scope for the client: bind the HWID with a
 * per-seat salt issued by the backend (or HMAC the HWID server-side), so no shared
 * client secret governs anti-sharing. Do NOT claim this client value is unleakable.
 */
export const HWID_PEPPER: string =
  process.env.LICENSE_PEPPER ?? 'DEV_PEPPER_replace_at_build_time';

/** License backend base URL (REST). Build-injected.
 *  NOTE: the line below MUST stay a bare env-fallback statement (no wrapping
 *  parens, no chained method on the same line) so build/pack.js can string-
 *  replace its literal. The greedy bake regex would otherwise swallow a trailing
 *  call and emit invalid JS into the .jsc. Trailing-slash stripping happens on
 *  the NEXT line, off the bake target. */
const RAW_API_URL: string = process.env.LICENSE_API_URL ?? 'https://license.example.com';
export const LICENSE_API_URL: string = RAW_API_URL.replace(/\/+$/, '');

/**
 * Ed25519 PUBLIC key (PEM, SPKI) used to verify signed license + update
 * artifacts locally. The private counterpart never leaves the backend.
 */
const RAW_PUBLIC_KEY: string =
  process.env.LICENSE_PUBLIC_KEY ??
  `-----BEGIN PUBLIC KEY-----\nDEV_PLACEHOLDER_PUBLIC_KEY\n-----END PUBLIC KEY-----`;
// Accept the key as a one-liner with literal "\n" (how genkeys / build-bake
// supply it) OR with real newlines – normalise to a valid PEM either way.
export const LICENSE_PUBLIC_KEY: string =
  RAW_PUBLIC_KEY.includes('\\n') ? RAW_PUBLIC_KEY.replace(/\\n/g, '\n') : RAW_PUBLIC_KEY;

/** How long a signed token is trusted offline before an online re-check is forced. */
export const OFFLINE_GRACE_MS: number =
  Number(process.env.LICENSE_OFFLINE_GRACE_MS ?? 72 * 60 * 60 * 1000); // 72h

/** Heartbeat interval – server can revoke a seat between beats. */
export const HEARTBEAT_INTERVAL_MS: number =
  Number(process.env.LICENSE_HEARTBEAT_MS ?? 45 * 60 * 1000); // 45 min

/** Network timeout for every license/update HTTP call. */
export const LICENSE_HTTP_TIMEOUT_MS = 15_000;

/** Local paths (kept out of git via .gitignore). */
export const LICENSE_KEY_FILE = 'license.key';     // raw key the operator pastes in
export const LICENSE_TOKEN_FILE = 'license.token'; // signed token from /activate
