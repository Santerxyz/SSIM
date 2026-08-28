import { createHash, randomBytes } from 'crypto';

// ════════════════════════════════════════════════════════════════════════════
//  accountIdentity — the synthetic "who is this machine" facts SSIM reports to
//  Steam, derived PER ACCOUNT instead of per installation.
//
//  ROOT CAUSE (2026-08-27 audit): every account in the fleet logged in claiming to
//  be the SAME PC. Neither login path passed a device name, so both fell through to
//  steam-session's `getSpoofedHostname()` — a sha1 of the OPERATOR's `os.hostname()`,
//  which is one value per installation, not per account. 500+ accounts, each on its
//  own residential exit, all reported `DESKTOP-<7 letters from the operator's PC>`
//  as `device_friendly_name`, and Steam records that string in each account's
//  authorized-device list permanently. A high-entropy string shared across a fleet is
//  precisely the cross-account link the per-account proxies were bought to prevent.
//  (Low-entropy shared values — Chrome's UA, `client_os_type`, `en-US` — are the
//  opposite: they are camouflage, shared with millions of real users. This module
//  deliberately only fixes the high-entropy ones.)
//
//  Two facts are derived here, both fed to the login:
//    • machineName  → steam-user's `machine_name` on the CM logon, which it also
//      forwards to steam-session as `machineFriendlyName` (03-messages.js
//      `_getLoginSession`) → `device_details.device_friendly_name`.
//    • logonID      → steam-user's `obfuscated_private_ip`. Left unset it is 0, and a
//      real Steam client always sends its obfuscated LAN address — so 0 is not a
//      correlation tell but a "not a real client" tell, on every account at once.
//
//  STABLE, NOT RANDOM. Everything here is a pure function of the username: the same
//  account reports the same PC on every login, forever, the way a real install does.
//  Re-randomizing per login would be worse than the bug — an account whose PC changes
//  identity every session is anomalous on its own, without needing a fleet to compare
//  it against. The hash is one-way and carries no secret: the username is already the
//  public login identifier, and the digest never leaves this process except as the
//  derived values below.
// ════════════════════════════════════════════════════════════════════════════

/** Domain-separated, deterministic byte stream for one account. Re-hashes to extend, so a
 *  caller may draw as many bytes as it likes without the derivations colliding. */
export function seededBytes(seed: string, domain: string): () => number {
  let block = createHash('sha256').update(`SSIM/${domain}/v1|${seed.trim().toLowerCase()}`, 'utf8').digest();
  let i = 0;
  return (): number => {
    if (i >= block.length) { block = createHash('sha256').update(block).digest(); i = 0; }
    return block[i++];
  };
}

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** `DESKTOP-XXXXXXX` from a byte source — the exact shape Windows generates for an
 *  unnamed PC (and the shape steam-session's own spoof produces), so the value is
 *  indistinguishable in form from what a real install would report. */
function desktopName(next: () => number): string {
  let out = 'DESKTOP-';
  for (let i = 0; i < 7; i++) out += UPPER[next() % UPPER.length];
  return out;
}

/**
 * The stable device name for an account. Case-insensitive in the username so a
 * differently-cased record cannot mint a second device for the same bot.
 */
export function deviceNameFor(username: string): string {
  return desktopName(seededBytes(username, 'device-name'));
}

/**
 * A one-off device name for a login that does not yet know which account it is —
 * i.e. the QR import, where Steam only reveals the account name after the phone
 * approves, but `device_friendly_name` has to be in the FIRST request. Random is
 * correct here: the goal is that no two accounts share a name, and a fresh random
 * name per QR import achieves exactly that. The account's later credential/token
 * logins use {@link deviceNameFor}, so a QR-imported bot ends up with two entries in
 * its authorized-device list — which is what a real user with two PCs looks like, and
 * strictly better than 500 accounts sharing one.
 */
export function randomDeviceName(): string {
  const buf = randomBytes(7);
  let i = 0;
  return desktopName(() => buf[i++]);
}

/**
 * The private LAN address this account claims, as the dotted string steam-user expects
 * (it converts and XORs it with Valve's obfuscation mask itself — passing the string is
 * what mimics a real client, passing a raw int would not).
 *
 * Drawn from the /24s that actually dominate home networks rather than uniformly over
 * 192.168.0.0/16: a realistic value is the point, and `192.168.203.x` is not a subnet
 * consumer routers hand out. Host octet is 2–250, avoiding the gateway (.1), the network
 * and broadcast addresses, and the top of the usual DHCP pool.
 */
const HOME_SUBNETS = ['192.168.0', '192.168.1', '192.168.2', '192.168.8', '192.168.178', '10.0.0', '10.0.1'];

export function logonIdFor(username: string): string {
  const next = seededBytes(username, 'logon-id');
  const subnet = HOME_SUBNETS[next() % HOME_SUBNETS.length];
  return `${subnet}.${2 + (next() % 249)}`;
}

/**
 * The device fields every `client.logOn()` call must carry — BOTH paths. The token path
 * needs them as much as the credential path: steam-user keeps `machine_name` for a
 * refreshToken logon (it is not in the disallowed-property list), and `webLogOn()` builds
 * its LoginSession from the same `_logOnDetails`, so omitting them there would put the
 * shared hostname back on the everyday login of every account in the fleet.
 */
export function deviceLogOnFields(username: string): { machineName: string; logonID: string } {
  return { machineName: deviceNameFor(username), logonID: logonIdFor(username) };
}
