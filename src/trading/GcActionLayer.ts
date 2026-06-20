import type { SessionManager } from '../core/SessionManager';
import { SessionState } from '../types/session';
import { logger } from '../utils/logger';

// ════════════════════════════════════════════════════════════════════════════
//  GcActionLayer — the ONE shared, low-concurrency, jittered Game-Coordinator
//  action layer for the two GC features (trade-up contracts + storage caskets).
//
//  Per account: connect to the CS2 GC → act → verify → disconnect. A per-account
//  in-flight guard prevents two concurrent GC operations on the same bot, and every
//  connect is jittered so a fleet never storms the GC in lockstep.
//
//  SAFETY GATE (critical — this layer can DESTROY/MOVE real items):
//   • `globaloffensive` is an OPTIONAL dependency, loaded via a LAZY require so the
//     build + every non-GC code path work whether or not it is installed.
//   • Item-MUTATING operations (deposit/withdraw/trade-up) execute ONLY when the
//     mechanism is VERIFIED: the env flag SSIM_GC_VERIFIED=1 AND the library present.
//     Without that they return a clear, non-destructive "not enabled" result and touch
//     nothing. The owner runs the first live execution after installing the dep + the flag.
//   • Trade-up CRAFT is not exposed by the published `globaloffensive` API; this layer
//     probes for a craft method and REFUSES (never guesses a raw GC message) if absent.
//     See FEATURES_REPORT.md for the exact mechanism still required.
//
//  This is SEPARATE from the retired GC *inventory* read path — it is not revived here.
// ════════════════════════════════════════════════════════════════════════════

const CS2_APPID = 730;
const CONNECT_TIMEOUT_MS = 30_000;
const OP_TIMEOUT_MS = 30_000;
const JITTER_MIN_MS = 800;
const JITTER_MAX_MS = 2_200;
/** Storage-unit hard cap (Steam limit). */
export const CASKET_CAPACITY = 1000;

// ── Lazy, absence-tolerant load of the optional `globaloffensive` dependency ──
let GcCtor: unknown;
let gcLoadAttempted = false;
function loadGc(): (new (client: unknown) => GcLike) | undefined {
  if (!gcLoadAttempted) {
    gcLoadAttempted = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      GcCtor = require('globaloffensive');
    } catch {
      GcCtor = undefined;
      logger.info('[gc] globaloffensive not installed — GC features (trade-ups, caskets) are unavailable until it is added');
    }
  }
  return GcCtor as (new (client: unknown) => GcLike) | undefined;
}

/** The subset of the globaloffensive API this layer uses (documented integration surface). */
interface GcLike {
  haveGCSession?: boolean;
  inventory?: GcItem[];
  on(ev: string, cb: (...a: unknown[]) => void): void;
  once(ev: string, cb: (...a: unknown[]) => void): void;
  removeListener(ev: string, cb: (...a: unknown[]) => void): void;
  removeAllListeners?(ev?: string): void;
  getCasketContents?(casketId: string, cb: (err: Error | null, items: GcItem[]) => void): void;
  addToCasket?(casketId: string, itemId: string, cb: (err: Error | null) => void): void;
  removeFromCasket?(casketId: string, itemId: string, cb: (err: Error | null) => void): void;
  /** NOT in the published API — probed for; absent → trade-up execution refused. */
  craft?(items: string[], recipe: number, cb: (err: Error | null) => void): void;
}

export interface GcItem {
  id: string;
  def_index?: number;
  paint_index?: number;
  paint_wear?: number;          // the real float (0..1) — only the GC exposes this
  casket_id?: string;
  casket_contained_item_count?: number;
  custom_name?: string;
  [k: string]: unknown;
}

export interface GcStatus {
  available: boolean;   // library installed
  verified: boolean;    // SSIM_GC_VERIFIED=1
  live: boolean;        // both → mutating ops permitted
  reason: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class GcActionLayer {
  /** Per-account GC op in-flight guard (keyed lowercase username). */
  private readonly inFlight = new Set<string>();

  constructor(private readonly sessions: SessionManager) {}

  available(): boolean { return !!loadGc(); }
  verified(): boolean { return process.env.SSIM_GC_VERIFIED === '1'; }
  live(): boolean { return this.available() && this.verified(); }

  status(): GcStatus {
    const available = this.available();
    const verified = this.verified();
    const live = available && verified;
    const reason = live ? 'GC execution enabled'
      : !available ? 'globaloffensive is not installed (npm i globaloffensive)'
      : 'GC execution is disabled — set SSIM_GC_VERIFIED=1 to enable (owner-verified)';
    return { available, verified, live, reason };
  }

  /**
   * Connects to the CS2 GC, runs `fn(gc)`, then disconnects — under the per-account in-flight
   * guard with a jittered start. `mutating:true` requires live() (the verified gate) and otherwise
   * throws BEFORE connecting, so a preview/list path can run read-only while item moves stay gated.
   */
  async withSession<T>(username: string, mutating: boolean, fn: (gc: GcLike) => Promise<T>): Promise<T> {
    const Ctor = loadGc();
    if (!Ctor) throw new Error('globaloffensive is not installed — GC features unavailable (see FEATURES_REPORT.md)');
    if (mutating && !this.verified()) {
      throw new Error('GC execution is disabled (set SSIM_GC_VERIFIED=1 after verifying the mechanism on a test account)');
    }
    const key = username.toLowerCase();
    if (this.inFlight.has(key)) throw new Error(`a GC operation is already running for ${username}`);
    this.inFlight.add(key);
    try {
      const session = this.sessions.getSession(username);
      if (!session || session.state !== SessionState.LOGGED_IN) {
        throw new Error(`${username} is not logged in — refresh/login the account first`);
      }
      await sleep(JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS))); // anti-lockstep
      const gc = await this.connect(session.client as unknown, Ctor);
      try {
        return await withTimeout(fn(gc), OP_TIMEOUT_MS, `GC operation for ${username}`);
      } finally {
        this.disconnect(session.client as unknown, gc);
      }
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Establishes a GC session (gamesPlayed([730]) → wait for connectedToGC). */
  private connect(client: unknown, Ctor: new (c: unknown) => GcLike): Promise<GcLike> {
    return new Promise<GcLike>((resolve, reject) => {
      let settled = false;
      const gc = new Ctor(client);
      const done = (err: Error | null, val?: GcLike): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { gc.removeListener('connectedToGC', onConn); } catch { /* noop */ }
        err ? reject(err) : resolve(val!);
      };
      const timer = setTimeout(() => done(new Error('GC connect timeout (account may not own CS2 / GC busy)')), CONNECT_TIMEOUT_MS);
      const onConn = (): void => done(null, gc);
      if (gc.haveGCSession) { done(null, gc); return; }
      gc.once('connectedToGC', onConn);
      try { (client as { gamesPlayed(apps: number[]): void }).gamesPlayed([CS2_APPID]); }
      catch (e) { done(e as Error); }
    });
  }

  /** Leaves the GC cleanly (gamesPlayed([])) and drops listeners. Best-effort, never throws. */
  private disconnect(client: unknown, gc: GcLike): void {
    try { gc.removeAllListeners?.(); } catch { /* noop */ }
    try { (client as { gamesPlayed(apps: number[]): void }).gamesPlayed([]); } catch { /* noop */ }
  }

  // ── Storage units (caskets) ─────────────────────────────────────────────────

  /** Lists the account's storage units (read-only — connects but moves nothing). */
  async listCaskets(username: string): Promise<Array<{ id: string; name: string; count: number }>> {
    return this.withSession(username, false, async (gc) => {
      const inv = Array.isArray(gc.inventory) ? gc.inventory : [];
      return inv
        .filter((i) => typeof i.casket_contained_item_count === 'number')
        .map((i) => ({
          id: String(i.id),
          name: typeof i.custom_name === 'string' && i.custom_name ? i.custom_name : `Storage Unit ${i.id}`,
          count: Number(i.casket_contained_item_count) || 0,
        }));
    });
  }

  /** Reads the contents of one storage unit (read-only). */
  async getCasketContents(username: string, casketId: string): Promise<GcItem[]> {
    return this.withSession(username, false, (gc) => new Promise<GcItem[]>((resolve, reject) => {
      if (typeof gc.getCasketContents !== 'function') return reject(new Error('getCasketContents not available in this globaloffensive build'));
      gc.getCasketContents(casketId, (err, items) => err ? reject(err) : resolve(Array.isArray(items) ? items : []));
    }));
  }

  /**
   * Moves items INTO (deposit) or OUT OF (withdraw) a storage unit. GATED: requires live().
   * Money/item-safety: per-account in-flight guard (withSession), each item moved + verified one
   * at a time, never throws AFTER a successful move (records the partial result instead), respects
   * the 1000-item cap on deposit. Returns a per-item outcome list; the caller never blind-retries.
   */
  async moveCasketItems(
    username: string,
    casketId: string,
    itemIds: string[],
    direction: 'deposit' | 'withdraw',
    onProgress?: (p: { done: number; total: number; current: string; moved: number; failed: number }) => void,
    shouldCancel?: () => boolean,
  ): Promise<{ moved: string[]; failed: Array<{ itemId: string; error: string }> }> {
    return this.withSession(username, true, async (gc) => {
      const fn = direction === 'deposit' ? gc.addToCasket : gc.removeFromCasket;
      if (typeof fn !== 'function') throw new Error(`${direction} not available in this globaloffensive build`);
      // Deposit cap: never exceed the storage unit's 1000-item ceiling.
      if (direction === 'deposit') {
        const current = Array.isArray(gc.inventory)
          ? gc.inventory.find((i) => String(i.id) === String(casketId))?.casket_contained_item_count ?? 0
          : 0;
        if (Number(current) + itemIds.length > CASKET_CAPACITY) {
          throw new Error(`deposit would exceed the ${CASKET_CAPACITY}-item storage cap (unit holds ${current})`);
        }
      }
      const moved: string[] = [];
      const failed: Array<{ itemId: string; error: string }> = [];
      for (let i = 0; i < itemIds.length; i++) {
        if (shouldCancel?.()) break; // cancel stops BEFORE the next item — never mid-move
        const itemId = itemIds[i];
        try {
          await withTimeout(new Promise<void>((resolve, reject) =>
            fn.call(gc, casketId, itemId, (err: Error | null) => err ? reject(err) : resolve())),
            OP_TIMEOUT_MS, `${direction} ${itemId}`);
          moved.push(itemId); // success — NEVER throw past here for this item
        } catch (e) {
          failed.push({ itemId, error: (e as Error).message });
          logger.warn(`[gc] ${username} ${direction} ${itemId} failed: ${(e as Error).message}`);
        }
        onProgress?.({ done: i + 1, total: itemIds.length, current: itemId, moved: moved.length, failed: failed.length });
        await sleep(300 + Math.floor(Math.random() * 400)); // gentle pacing between GC writes
      }
      logger.info(`[gc] ${username} ${direction}: ${moved.length}/${itemIds.length} moved`);
      return { moved, failed };
    });
  }

  // ── Trade-up contracts (execution) ──────────────────────────────────────────

  /**
   * Executes ONE trade-up contract (destroys the 10 inputs → 1 output). HIGH RISK + GATED.
   * The published globaloffensive API does NOT expose a craft/trade-up call, so this layer PROBES
   * for `gc.craft` and REFUSES (throws, touches nothing) when it is absent — it never guesses a raw
   * GC message that could destroy items incorrectly. When a craft method IS present and the verified
   * gate is on, it submits exactly once and never re-submits. See FEATURES_REPORT.md for the exact
   * GC message still required to implement this fully.
   */
  async craftTradeUp(username: string, inputAssetIds: string[]): Promise<{ submitted: boolean; outputItemId?: string }> {
    if (inputAssetIds.length !== 10) throw new Error('a trade-up needs exactly 10 input asset ids');
    return this.withSession(username, true, async (gc) => {
      if (typeof gc.craft !== 'function') {
        throw new Error('trade-up execution mechanism is not available in the installed globaloffensive (craft not exposed) — see FEATURES_REPORT.md; calculation + preview are fully available');
      }
      // Re-verify the 10 inputs are present in the live GC inventory IMMEDIATELY before crafting.
      const inv = Array.isArray(gc.inventory) ? gc.inventory : [];
      const have = new Set(inv.map((i) => String(i.id)));
      const missing = inputAssetIds.filter((id) => !have.has(String(id)));
      if (missing.length) throw new Error(`inputs no longer present: ${missing.join(', ')} — refresh and recompute`);
      // Submit exactly once. After this point we NEVER throw (a thrown post-submit error would invite
      // a duplicate craft that destroys another 10 items).
      await new Promise<void>((resolve, reject) =>
        gc.craft!(inputAssetIds, 0, (err: Error | null) => err ? reject(err) : resolve()));
      logger.info(`[gc] ${username} trade-up submitted (10 inputs)`);
      return { submitted: true };
    });
  }
}

/** Rejects if `p` does not settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
