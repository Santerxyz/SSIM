import os from 'os';
import fs from 'fs';
import crypto from 'crypto';
import { machineIdSync } from 'node-machine-id';
import { HWID_PEPPER } from './config';
import { dataDir } from '../utils/paths';
import { logger } from '../utils/logger';

// S27: the hwid is PINNED to disk on first computation so it never DRIFTS (a VPN/hotspot/virtual adapter,
// a NIC re-order, or a transient machineId failure used to silently change it → the seat re-bound → a
// seat_limit 409 needing owner intervention). paths.dataDir is a leaf util (no core/trading dep), so it
// keeps HwidService bootable-early.
const HWID_PIN_FILE = 'hwid.pin';
/** Read the pinned hwid (64-hex), or undefined if absent/invalid. */
export function readPinnedHwid(): string | undefined {
  try {
    const s = fs.readFileSync(dataDir(HWID_PIN_FILE), 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(s) ? s : undefined;
  } catch { return undefined; }
}
/** Persist the pinned hwid (best-effort, mode 600). */
export function writePinnedHwid(hwid: string): void {
  try { fs.mkdirSync(dataDir(), { recursive: true }); fs.writeFileSync(dataDir(HWID_PIN_FILE), hwid, { mode: 0o600 }); }
  catch (err) { logger.warn(`could not pin hwid: ${(err as Error).message}`); }
}

// ════════════════════════════════════════════════════════════════════════════
//  HwidService – stable, salted hardware fingerprint
//
//  ISOLATED by design: imports only os/crypto/config/logger. No core/trading
//  dependency so it can run inside the boot gatekeeper before anything else.
//
//  A single factor (e.g. machine-id alone) is easy to spoof, so we blend several
//  weakly-correlated machine signals and HMAC them with a build-baked pepper.
//  The pepper means an attacker cannot reproduce the hash even knowing the raw
//  factors – they would also need the pepper baked into the binary.
// ════════════════════════════════════════════════════════════════════════════

export interface HwidFactors {
  machineId: string;
  hostname:  string;
  mac:       string;
  cpu:       string;
  platform:  string;
  arch:      string;
}

let cached: string | undefined;

/** First non-internal, non-zero MAC address (stable per NIC). */
function firstMac(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] ?? []) {
      if (!net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
        return net.mac;
      }
    }
  }
  return 'no-mac';
}

/** Raw, UN-hashed factors. Support/debug only – never sent to the backend. */
export function getRawFactors(): HwidFactors {
  let machineId = 'no-machine-id';
  try {
    machineId = machineIdSync(true); // original=true → OS GUID, not app-hashed
  } catch (err) {
    logger.warn(`machineId unavailable: ${(err as Error).message}`);
  }
  return {
    machineId,
    hostname: os.hostname(),
    mac:      firstMac(),
    cpu:      os.cpus()[0]?.model ?? 'no-cpu',
    platform: os.platform(),
    arch:     os.arch(),
  };
}

/**
 * Deterministic, salted 64-hex hardware id for this machine.
 * Memoized – the underlying signals do not change while the process runs.
 */
export function getHwid(): string {
  if (cached) return cached;
  // S27: a PINNED hwid wins — this is the whole fix, it keeps the id stable across MAC/machineId churn.
  const pinned = readPinnedHwid();
  if (pinned) { cached = pinned; return pinned; }
  const f = getRawFactors();
  // The first computation is BYTE-IDENTICAL to the legacy one, so a deployed machine keeps its existing
  // seat; the pin then keeps it stable forever after. Only pin a HEALTHY fingerprint (real machineId AND
  // MAC) so a TRANSIENT failure never pins a bad id — a later healthy boot pins the correct one.
  const material = [f.machineId, f.hostname, f.mac, f.cpu, f.platform, f.arch].join('|');
  const hwid = crypto.createHmac('sha256', HWID_PEPPER).update(material).digest('hex');
  if (f.machineId !== 'no-machine-id' && f.mac !== 'no-mac') writePinnedHwid(hwid);
  cached = hwid;
  return cached;
}

/** Test-only: clear the per-process memo so a test can exercise the pin path. */
export function _resetHwidCache(): void { cached = undefined; }

export const HwidService = { getHwid, getRawFactors };
