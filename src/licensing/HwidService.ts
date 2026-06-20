import os from 'os';
import crypto from 'crypto';
import { machineIdSync } from 'node-machine-id';
import { HWID_PEPPER } from './config';
import { logger } from '../utils/logger';

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
  const f = getRawFactors();
  const material = [f.machineId, f.hostname, f.mac, f.cpu, f.platform, f.arch].join('|');
  cached = crypto.createHmac('sha256', HWID_PEPPER).update(material).digest('hex');
  return cached;
}

export const HwidService = { getHwid, getRawFactors };
