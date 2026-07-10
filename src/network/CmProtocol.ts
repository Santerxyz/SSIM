/**
 * Per-proxy Steam CM protocol selection with automatic TCP → WebSocket demotion.
 *
 * WHY THIS EXISTS (owner report 2026-07-09: "3 proxy providers used to work, now only one"):
 * the proxy tank (b58002a) forces steam-user `protocol: TCP` to remove the wss-TLS-over-proxy
 * teardown primitive behind the 0xC0000409 native fast-fail. Under an HTTP proxy, TCP CM
 * connections are tunneled via HTTP CONNECT to the CM's raw TCP ports (27017-27050) — but many
 * commercial proxy providers whitelist CONNECT to :443 ONLY (standard anti-abuse policy). On
 * those providers the CONNECT is rejected or silently blackholed, the CM never comes up, and
 * every login dies in the 15s login timeout. The old default (Auto → WebSocket, wss on :443)
 * worked everywhere — which is why the breakage is provider-dependent.
 *
 * POLICY: TCP-first (keeps the tank's anti-crash win wherever the provider allows it); after
 * TCP_FAILURES_TO_DEMOTE consecutive connection-class TCP failures on the SAME proxy
 * (host:port — shared across all accounts on it, so a fleet converges after the first two
 * failures, not two per account), that proxy is demoted to WebSocket for the process lifetime.
 * WebSocket re-accepts the wss-TLS primitive for that one proxy — a working-but-riskier
 * connection beats no connection, and the rest of the tank (breaker, jitter, session ceiling,
 * fail-fast timeouts) still guards the teardown path. A restart re-probes TCP (two failures,
 * then demotes again); fleets on known 443-only providers can skip the probe entirely with
 * SSIM_CM_PROTOCOL=ws.
 *
 * MONEY-SAFE / CRASH-SAFE: the choice is made once per login attempt at client construction —
 * a live session's transport is never touched.
 *
 * Env override (SSIM_CM_PROTOCOL): 'tcp' | 'ws'/'websocket' | 'auto' — forces the protocol for
 * every HTTP-proxied/direct login and disables learning. SOCKS proxies always use WebSocket
 * (steam-user hard-forces that combination anyway; choosing it explicitly skips its per-login warn).
 */

import fs from 'fs';
import { logger } from '../utils/logger';
import { writeJsonAtomic } from '../utils/atomicJson';
import { dataDir } from '../utils/paths';

export type CmProtocolLabel = 'tcp' | 'ws' | 'auto';

/** Consecutive connection-class TCP failures on one provider before it is demoted to WebSocket. */
export const TCP_FAILURES_TO_DEMOTE = 2;

/** A persisted demotion older than this is RE-PROBED (TCP tried again) instead of trusted blindly —
 *  so a demotion caused by a transient 2-failure blip, or a provider that later opened the CM ports,
 *  self-corrects within a day, while a genuinely CONNECT-blocked provider costs at most one re-probe
 *  (2 failed logins) per day rather than re-learning on every single run. (owner 2026-07-10.) */
const REPROBE_AFTER_MS = 24 * 60 * 60 * 1000;

// Keyed by provider HOST (not host:port) — the "provider blocks CONNECT to the CM ports" policy is a
// host-wide firewall rule, so all ports of one provider share the verdict (a fleet on a rotating pool
// converges after the first two failures on ANY of its ports, not two per port). Value = demotedAt (ms).
const demoted = new Map<string, number>();
const tcpFailStreak = new Map<string, number>();

/** data/cm-protocol.json — set by loadPersisted(); null disables persistence (unit tests never load). */
let persistPath: string | null = null;

/** Provider host for a proxyKey ("host:port" → "host"). Strips a trailing :port; leaves bare hosts. */
function hostOf(pkey: string): string { return pkey.replace(/:\d+$/, ''); }

/** Parses SSIM_CM_PROTOCOL. Unset/unknown → null (learning mode). */
export function envCmProtocolOverride(raw: string | undefined = process.env.SSIM_CM_PROTOCOL): CmProtocolLabel | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'tcp') return 'tcp';
  if (v === 'ws' || v === 'websocket') return 'ws';
  if (v === 'auto') return 'auto';
  return null;
}

/**
 * Load persisted demotions at boot so a known-CONNECT-blocked provider is NOT re-learned (two failed
 * logins) on every run. Only demotions FRESHER than REPROBE_AFTER_MS are trusted; older ones are left
 * out of the live set so the next login re-probes TCP (and re-persists fresh if it still fails, or
 * promotes if it now works). Best-effort — a missing/corrupt file just means an empty learning slate.
 */
export function loadPersisted(path: string = dataDir('cm-protocol.json')): void {
  persistPath = path;
  try {
    if (!fs.existsSync(path)) return;
    const data = JSON.parse(fs.readFileSync(path, 'utf8')) as { demoted?: Record<string, { demotedAt?: string }> };
    const now = Date.now();
    let loaded = 0, stale = 0;
    // Seed EVERY persisted demotion (fresh AND stale) with its timestamp. The age check lives in
    // chooseCmProtocol: a fresh (<24h) demotion is trusted (WebSocket, no re-learning across restarts);
    // a stale one is re-probed on TCP and then either promoted (removed) or re-demoted (clock refreshed) —
    // so a genuinely-blocked provider re-probes at most once per 24h, not every run.
    for (const [host, rec] of Object.entries(data.demoted ?? {})) {
      const at = new Date(rec?.demotedAt ?? '').getTime();
      if (!Number.isFinite(at)) continue;
      demoted.set(host, at); loaded++;
      if (now - at >= REPROBE_AFTER_MS) stale++;
    }
    logger.info(`[cm-protocol] loaded ${loaded} demotion(s) from ${path}${stale ? ` (${stale} due for a TCP re-probe)` : ''}`);
  } catch (e) {
    logger.warn(`[cm-protocol] could not load ${path} (${(e as Error).message}) — starting with an empty learning slate`);
  }
}

function persist(): void {
  if (!persistPath) return;   // persistence disabled (never loaded) → no-op (unit tests)
  try {
    const out = { version: 1, demoted: {} as Record<string, { demotedAt: string }> };
    for (const [host, at] of demoted) out.demoted[host] = { demotedAt: new Date(at).toISOString() };
    writeJsonAtomic(persistPath, out, { spaces: 2 });
  } catch (e) {
    logger.warn(`[cm-protocol] could not persist demotions (${(e as Error).message})`);
  }
}

/**
 * Protocol for the NEXT login attempt through `pkey` (null = no proxy / local IP — no CONNECT in the
 * path, TCP is always safe there). A demotion within REPROBE_AFTER_MS → WebSocket; a STALE demotion →
 * TCP (re-probe, so a provider that opened the CM ports, or a false 2-failure demotion, recovers).
 * `envRaw` is injectable for tests.
 */
export function chooseCmProtocol(pkey: string | null, isSocks: boolean, envRaw?: string): CmProtocolLabel {
  if (isSocks) return 'ws';
  const forced = envCmProtocolOverride(envRaw ?? process.env.SSIM_CM_PROTOCOL);
  if (forced) return forced;
  if (!pkey) return 'tcp';
  const at = demoted.get(hostOf(pkey));
  if (at !== undefined && Date.now() - at < REPROBE_AFTER_MS) return 'ws';   // fresh demotion → WebSocket
  return 'tcp';                                                              // not demoted, or stale → (re-)probe TCP
}

/**
 * Feed a login attempt's outcome back. Call with ok=false ONLY for connection-class failures
 * (auth/ceiling failures mean the CM connected fine — they must not demote a healthy proxy).
 * Returns 'demoted' when a provider flips to WebSocket, 'promoted' when a successful TCP attempt
 * clears a prior demotion (the provider now allows the CM ports), else null — so the caller can log
 * each transition exactly once. Demotions/promotions persist across runs.
 */
export function noteCmOutcome(pkey: string | null, used: CmProtocolLabel, ok: boolean): 'demoted' | 'promoted' | null {
  if (!pkey || used !== 'tcp') return null;   // a WebSocket outcome tells us nothing about TCP viability
  const host = hostOf(pkey);
  if (ok) {
    tcpFailStreak.delete(host);
    if (demoted.has(host)) { demoted.delete(host); persist(); return 'promoted'; }   // TCP works now → promote
    return null;
  }
  // Connection-class TCP failure.
  if (demoted.has(host)) { demoted.set(host, Date.now()); persist(); return null; }   // a re-probe failed → stay WS, refresh the clock
  const n = (tcpFailStreak.get(host) ?? 0) + 1;
  tcpFailStreak.set(host, n);
  if (n >= TCP_FAILURES_TO_DEMOTE) {
    tcpFailStreak.delete(host);
    demoted.set(host, Date.now());
    persist();
    return 'demoted';
  }
  return null;
}

/** Test hook: forget all demotions/streaks AND disable persistence (so tests never write data/). */
export function resetCmProtocolLearning(): void {
  demoted.clear();
  tcpFailStreak.clear();
  persistPath = null;
}
