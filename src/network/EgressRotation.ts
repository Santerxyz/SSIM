import axios from 'axios';
import type { HttpAgent } from './AgentFactory';
import { logger } from '../utils/logger';
import { redactSecrets } from '../utils/logger';

// ════════════════════════════════════════════════════════════════════════════
//  EgressRotation — does this proxy hand out a DIFFERENT exit IP per connection?
//
//  WHY IT MATTERS. The price fill's safety bound is per EXIT IP (see PricingService's
//  pacing note): at most LANES_PER_EXIT lanes may point at one IP. SSIM identifies an
//  exit by the proxy STRING (`proxy:host:port`) because nothing records the observed
//  public IP — so a single ROTATING proxy, whose sessions genuinely land on many
//  different IPs, looks identical to one static proxy and is throttled as if all its
//  lanes shared one address. Correct, but needlessly slow: the whole fleet's fill is
//  capped at one exit's budget.
//
//  Guessing is asymmetric. Assume rotation on a STATIC proxy and every lane piles onto
//  one IP at N× the safe rate — the exact failure behind the July 2026 rolling lockout.
//  So rotation is never assumed: it is MEASURED, and the answer defaults to "static"
//  until a probe proves otherwise.
//
//  THE PROBE. Two GETs to api.ipify.org through the proxy, each on a fresh connection
//  (`Connection: close`, and different session agents when we have them). Two different
//  IPs back ⇒ the provider rotates per connection. Same IP twice ⇒ treated as static.
//  Note the asymmetry in the verdict: "different" is proof of rotation, while "same" is
//  only absence of evidence — which is why the same-IP answer is the SAFE one and a
//  failed/ambiguous probe also lands there.
//
//  HOT-PATH SHAPE. `isRotating` is SYNChronous and reads a cache, so identity selection
//  never awaits the network; `observe` fires the probe in the background and the verdict
//  applies from the NEXT fill. First fill after boot is therefore always the safe pace.
// ════════════════════════════════════════════════════════════════════════════

/** How long a verdict stands before it is re-measured. A provider does not flip between
 *  rotating and static often; this is about eventually noticing if it does. */
const VERDICT_TTL_MS = 30 * 60_000;
/** A failed probe is retried much sooner than a successful verdict is refreshed — but not
 *  immediately, so a dead proxy cannot turn every fill into a probe storm. */
const FAILED_RETRY_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 8_000;
const IPIFY = 'https://api.ipify.org?format=json';

interface Verdict {
  rotating: boolean;
  at: number;
  /** false when the probe could not complete — kept so a failure retries on FAILED_RETRY_MS
   *  rather than sitting for the full TTL, without ever being mistaken for a real "static". */
  measured: boolean;
}

/** Disabled with SSIM_EGRESS_ROTATION_PROBE=0 — the fill then treats every proxy as static
 *  (the safe pace) and no probe traffic is emitted at all. */
function probingEnabled(): boolean {
  return process.env.SSIM_EGRESS_ROTATION_PROBE !== '0';
}

export class EgressRotationRegistry {
  private verdicts = new Map<string, Verdict>();
  private inFlight = new Set<string>();

  /** SYNC, cache-only: may this exit key be treated as one-IP-per-session? Defaults to false
   *  (static / safe) for anything never measured, mid-probe, or whose probe failed. */
  isRotating(egressKey: string): boolean {
    const v = this.verdicts.get(egressKey);
    return !!v && v.measured && v.rotating;
  }

  /** True when this key needs a (re)measurement — absent, failed, or past its TTL. */
  private isStale(egressKey: string): boolean {
    const v = this.verdicts.get(egressKey);
    if (!v) return true;
    return Date.now() - v.at >= (v.measured ? VERDICT_TTL_MS : FAILED_RETRY_MS);
  }

  /**
   * Fire-and-forget: measure `egressKey` if its verdict is stale. `agents` are live session
   * agents on that proxy — two DISTINCT ones are preferred (two sessions ⇒ certainly two
   * connections); with only one we still force fresh sockets via `Connection: close`.
   * Never throws and never awaits the caller.
   */
  observe(egressKey: string, agents: HttpAgent[]): void {
    if (!probingEnabled() || agents.length === 0) return;
    if (this.inFlight.has(egressKey) || !this.isStale(egressKey)) return;
    this.inFlight.add(egressKey);
    void this.probe(egressKey, agents)
      .catch(() => { /* probe() already records the failure verdict */ })
      .finally(() => { this.inFlight.delete(egressKey); });
  }

  private async probe(egressKey: string, agents: HttpAgent[]): Promise<void> {
    const a = agents[0];
    const b = agents[1] ?? agents[0];   // one live session → same agent, fresh socket each time
    try {
      const first = await this.exitIp(a);
      const second = await this.exitIp(b);
      if (!first || !second) {
        this.verdicts.set(egressKey, { rotating: false, at: Date.now(), measured: false });
        logger.info(`[egress-rotation] ${redactSecrets(egressKey)}: probe inconclusive — treating as a single static exit (safe pace)`);
        return;
      }
      const rotating = first !== second;
      this.verdicts.set(egressKey, { rotating, at: Date.now(), measured: true });
      logger.info(`[egress-rotation] ${redactSecrets(egressKey)}: ${rotating
        ? `ROTATING (two connections exited ${first} and ${second}) — its sessions may each be paced as their own exit`
        : `static (both connections exited ${first}) — all its lanes share one exit budget`}`);
    } catch (e) {
      this.verdicts.set(egressKey, { rotating: false, at: Date.now(), measured: false });
      logger.warn(`[egress-rotation] ${redactSecrets(egressKey)}: probe failed (${redactSecrets((e as Error).message)}) — treating as a single static exit`);
    }
  }

  /** One exit-IP read through `agent`, on a FRESH connection. Returns null on any non-answer:
   *  the caller turns that into an inconclusive (safe) verdict rather than a false verdict. */
  private async exitIp(agent: HttpAgent): Promise<string | null> {
    const resp = await axios.get(IPIFY, {
      httpsAgent: agent,
      proxy: false,                       // never let an ambient env proxy re-route the probe
      timeout: PROBE_TIMEOUT_MS,
      validateStatus: () => true,
      // A rotating provider rotates PER CONNECTION, so a keep-alive socket reused between the
      // two probes would report one IP twice and mask the rotation. Force a new connection.
      headers: { Connection: 'close' },
    });
    if (resp.status !== 200) return null;
    const ip = (resp.data as { ip?: unknown } | undefined)?.ip;
    return typeof ip === 'string' && ip ? ip : null;
  }

  /** Test seam: install a verdict without probing. */
  setVerdictForTest(egressKey: string, rotating: boolean): void {
    this.verdicts.set(egressKey, { rotating, at: Date.now(), measured: true });
  }

  /** Test seam: forget everything (also used by shutdown paths that want a clean slate). */
  reset(): void { this.verdicts.clear(); this.inFlight.clear(); }
}

/** Process-wide singleton — verdicts are a property of the proxy, not of any one caller. */
export const egressRotation = new EgressRotationRegistry();
