import type { SessionManager } from '../core/SessionManager';
import { SessionState } from '../types/session';
import { IS_PACKAGED } from '../utils/paths';
import { logger } from '../utils/logger';

// ════════════════════════════════════════════════════════════════════════════
//  GcActionLayer — the ONE shared, surgical Game-Coordinator action layer for the
//  two opt-in GC features (storage units + trade-up contracts).
//
//  WHY GC WAS REMOVED (and why this is safe): the old `GcInventoryManager` ran GC on
//  the HOT BACKGROUND inventory path with a cached handle, an uncancelable linger
//  timer, a permanent 'debug' listener, no re-entrancy guard, and races where a
//  linger-stop could `gamesPlayed([])` out from under a live fetch (audit #9/#10/#31).
//  This layer is the opposite: GC is touched ONLY on explicit user action (trade-up /
//  storage), one operation per account at a time (concurrency 1), with a hard connect
//  timeout, guaranteed `gamesPlayed([])` teardown in `finally` (no persistent GC
//  session), and explicit teardown of the GC handle when the session is destroyed.
//
//  LISTENER SAFETY: `new GlobalOffensive(client)` attaches FIVE permanent listeners to
//  the steam-user client and never removes them, so creating a fresh instance per op
//  would leak listeners on the long-lived client (the #31 failure). We therefore keep
//  EXACTLY ONE GlobalOffensive per session client, reuse it, and drop our reference when
//  the session is destroyed (SessionManager then removeAllListeners + discards the client).
//
//  GATING: storage (deposit/withdraw) is REVERSIBLE → enabled whenever the library is
//  present (a real GC connection is the operative gate). Trade-up CRAFT is IRREVERSIBLE
//  (destroys 10 items) → stays behind the explicit SSIM_GC_VERIFIED flag.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Thrown by `withSession` when the per-account single-op slot is already held (concurrency 1).
 * Distinguished from a real failure because it can ONLY fire BEFORE the craft is sent (the
 * inFlight guard rejects pre-connect) — so a busy rejection ⇔ nothing was sent, always safe to wait out.
 */
export class GcBusyError extends Error {
  constructor(username: string) {
    super(`a GC operation is already running for ${username}`);
    this.name = 'GcBusyError';
  }
}

const CS2_APPID = 730;
const CONNECT_TIMEOUT_MS = 35_000; // GC hello has exponential backoff; allow a couple of rounds
const MOVE_VERIFY_TIMEOUT_MS = 15_000;
const CRAFT_CONFIRM_TIMEOUT_MS = 20_000;
const JITTER_MIN_MS = 600;
const JITTER_MAX_MS = 2_000;
/** Storage-unit hard cap (Steam). */
export const CASKET_CAPACITY = 1000;
/** CS2 storage-unit def_index. */
const CASKET_DEF_INDEX = 1201;

// ── Trade-up recipe table (from globaloffensive README → items_game.txt) ───────
//   0 Consumer→Industrial · 1 Industrial→Mil-Spec · 2 Mil-Spec→Restricted ·
//   3 Restricted→Classified · 4 Classified→Covert · +10 for the StatTrak variants.
const RECIPE_BY_RARITY: Record<string, number> = {
  rarity_common_weapon: 0, rarity_uncommon_weapon: 1, rarity_rare_weapon: 2,
  rarity_mythical_weapon: 3, rarity_legendary_weapon: 4,
};
/** The CS2 trade-up craft recipe id for an input rarity tier + StatTrak status, or undefined. */
export function tradeUpRecipe(inputRarityId: string, stattrak: boolean): number | undefined {
  const base = RECIPE_BY_RARITY[inputRarityId];
  if (base === undefined) return undefined;
  return stattrak ? base + 10 : base;
}

// ── Lazy require (still absence-tolerant, though now installed) ────────────────
let GcCtor: (new (client: unknown) => GcLike) | undefined;
let gcLoadAttempted = false;
function loadGc(): (new (client: unknown) => GcLike) | undefined {
  if (!gcLoadAttempted) {
    gcLoadAttempted = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      GcCtor = require('globaloffensive');
    } catch {
      GcCtor = undefined;
      logger.info('[gc] globaloffensive not installed — GC features unavailable');
    }
  }
  return GcCtor;
}

/** The real globaloffensive surface this layer uses (verified against v3.3.0). The stale-`_helloTimer`
 *  heal in `connect` reaches private v3.x fields (`_helloTimer`/`_isInCSGO`) — re-verify on any 4.x upgrade. */
interface GcLike {
  haveGCSession: boolean;
  inventory?: GcItem[];
  on(ev: string, cb: (...a: unknown[]) => void): void;
  once(ev: string, cb: (...a: unknown[]) => void): void;
  removeListener(ev: string, cb: (...a: unknown[]) => void): void;
  removeAllListeners(ev: string): void;                        // present on EventEmitter
  getCasketContents(casketId: string, cb: (err: Error | null, items?: GcItem[]) => void): void;
  addToCasket(casketId: string, itemId: string): void;       // fire-and-forget (no callback)
  removeFromCasket(casketId: string, itemId: string): void;  // fire-and-forget (no callback)
  craft(items: string[], recipe: number): void;              // → 'craftingComplete' event
}

export interface GcItem {
  id: string;
  def_index?: number;
  paint_index?: number;
  paint_wear?: number;          // the real float (0..1) — GC-only
  paint_seed?: number;
  casket_id?: string;
  casket_contained_item_count?: number;
  custom_name?: string;
  [k: string]: unknown;
}

export interface GcStatus {
  available:       boolean;   // library installed
  casketsEnabled:  boolean;   // storage works (reversible → only needs the library + a live connect)
  craftEnabled:    boolean;   // trade-up craft permitted (needs SSIM_GC_VERIFIED — irreversible)
  reason:          string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class GcActionLayer {
  /** EXACTLY ONE GlobalOffensive per live session client (reused; dropped on session destroy). */
  private readonly handles = new Map<string, { go: GcLike; client: unknown }>();
  /** Per-account GC-op in-flight guard (concurrency 1 per account). */
  private readonly inFlight = new Set<string>();

  constructor(private readonly sessions: SessionManager) {
    // #31 fix — explicit teardown: when a session dies (logout / re-login), drop its GC handle.
    // SessionManager.destroySession removeAllListeners() the client, so the handle's 5 permanent
    // listeners go with it; we just release our reference.
    this.sessions.on('sessionDestroyed', (username: string) => this.handles.delete(username.toLowerCase()));
  }

  available(): boolean { return !!loadGc(); }

  /** True while this account holds the single per-account GC-op slot (a storage move / float read is running). */
  opInFlight(username: string): boolean { return this.inFlight.has(username.toLowerCase()); }

  /**
   * Trade-up CRAFT gate resolution (irreversible — destroys 10 items). The single source of truth for
   * BOTH `craftVerified()` and `status()`, so the gate decision and the reason string can never diverge:
   *   • SSIM_GC_VERIFIED = 0/false/off  → 'kill-switch' — FORCE OFF. Set this (then relaunch) to
   *     instantly disable trade-up execution in production, no rebuild, if anything looks wrong.
   *   • SSIM_GC_VERIFIED = 1/true/on    → 'explicit-on' — FORCE ON.
   *   • unset → 'default-on' in the shipped (packaged) release, 'default-off' in dev. The shipped default
   *     is ON per the owner's explicit release decision; storage stays unaffected (its own, flagless gate).
   * NOTE: the mechanism has not been live-verified — the first real contract IS the test. The UI
   * warns loudly and the kill switch above is the panic button.
   */
  private craftGateResolution(): 'kill-switch' | 'explicit-on' | 'default-on' | 'default-off' {
    const v = (process.env.SSIM_GC_VERIFIED ?? '').trim().toLowerCase();
    if (v === '0' || v === 'false' || v === 'off') return 'kill-switch'; // works everywhere
    if (v === '1' || v === 'true' || v === 'on') return 'explicit-on';   // explicit enable
    return IS_PACKAGED ? 'default-on' : 'default-off';                   // shipped release ON; dev OFF
  }

  private craftVerified(): boolean {
    const r = this.craftGateResolution();
    return r === 'explicit-on' || r === 'default-on';
  }

  status(): GcStatus {
    const available = this.available();
    const craftEnabled = available && this.craftVerified();
    const resolution = this.craftGateResolution();
    return {
      available,
      casketsEnabled: available,
      craftEnabled,
      reason: !available
        ? 'globaloffensive is not installed (npm i globaloffensive)'
        : craftEnabled
          ? 'GC ready — storage + trade-up craft ENABLED (unverified live — test one cheap contract first; SSIM_GC_VERIFIED=0 disables)'
          : resolution === 'kill-switch'
            ? 'GC ready — storage enabled; trade-up craft disabled (kill switch SSIM_GC_VERIFIED=0)'
            : 'GC ready — storage enabled; trade-up craft disabled (dev default — set SSIM_GC_VERIFIED=1 to enable)',
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** Get-or-create the single GlobalOffensive handle for this account's CURRENT client. */
  private getHandle(username: string): GcLike {
    const Ctor = loadGc();
    if (!Ctor) throw new Error('globaloffensive is not installed — GC features unavailable');
    const key = username.toLowerCase();
    const session = this.sessions.getSession(username);
    if (!session || session.state !== SessionState.LOGGED_IN) {
      throw new Error(`${username} is not logged in — refresh/login the account first`);
    }
    const existing = this.handles.get(key);
    if (existing && existing.client === (session.client as unknown)) return existing.go;
    // New session/client (or first use) → fresh handle. A stale handle (old client) is dropped;
    // its client was/will be removeAllListeners'd by SessionManager.
    const go = new Ctor(session.client as unknown);
    // PERSISTENT safety listeners (one set per handle): an 'error'/'disconnectedFromGC' with NO
    // listener would crash the process from inside the library's timer callbacks.
    go.on('error', (err: unknown) => logger.warn(`[gc] ${username} error: ${(err as Error)?.message ?? err}`));
    go.on('disconnectedFromGC', (s: unknown) => logger.info(`[gc] ${username} disconnected from GC (status ${String(s)})`));
    this.handles.set(key, { go, client: session.client as unknown });
    return go;
  }

  /**
   * Runs `fn(go)` with a live GC session for `username`: per-account guard → jittered start →
   * connect (gamesPlayed[730] + await connectedToGC, hard timeout) → fn → GUARANTEED disconnect
   * (gamesPlayed[]) in finally. No persistent GC session; one op per account at a time.
   */
  private async withSession<T>(username: string, fn: (go: GcLike) => Promise<T>, timeoutMs = 60_000): Promise<T> {
    const key = username.toLowerCase();
    if (this.inFlight.has(key)) throw new GcBusyError(username);
    this.inFlight.add(key);
    // B40: this is a genuine op entry — touch it now and keep it fresh so the idle reaper (30-min TTL)
    // can never log the account out mid-move/mid-craft (a large casket move legitimately runs 10-35+ min).
    this.sessions.markUsed(username);
    const keepAlive = setInterval(() => this.sessions.markUsed(username), 60_000);
    keepAlive.unref?.();
    let client: unknown;
    try {
      const go = this.getHandle(username);
      client = (this.sessions.getSession(username)!.client as unknown);
      await sleep(JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS))); // anti-lockstep
      try {
        // connect() is inside the guard so a connect timeout/error still runs disconnect() (gamesPlayed([]))
        // — otherwise the account stays in-game CS2 with the lib's hello retry loop firing indefinitely.
        await this.connect(go, client);
        // S16: the backstop budget is caller-scaled (a per-item op loop scales it by item count, and gives
        // the loop its OWN shorter deadline so it self-aborts first). withTimeout can't cancel fn(go), so a
        // premature fire would abandon a detached loop — the scaling makes it fire only as a true backstop.
        return await withTimeout(fn(go), timeoutMs, `GC op for ${username}`);
      } finally {
        this.disconnect(client); // drop the GC session (keep the bounded handle for reuse)
      }
    } finally {
      clearInterval(keepAlive);
      this.inFlight.delete(key);
    }
  }

  private connect(go: GcLike, client: unknown): Promise<void> {
    if (go.haveGCSession) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { go.removeListener('connectedToGC', onConn); go.removeListener('error', onErr); } catch { /* noop */ }
        err ? reject(err) : resolve();
      };
      const onConn = (): void => done();
      const onErr = (e: unknown): void => done(e instanceof Error ? e : new Error('GC error during connect'));
      const timer = setTimeout(() => done(new Error('GC connect timeout (account may not own CS2, or the GC is busy)')), CONNECT_TIMEOUT_MS);
      go.once('connectedToGC', onConn);
      go.once('error', onErr);
      // Heal the globaloffensive v3.3.0 bug: a prior ClientLogonFatalError does `clearTimeout(this._helloTimer)`
      // but never nulls it (handlers.js:16), and `handleAppQuit` clears the misnamed `_helloInterval` instead
      // (index.js:70-74), so the stale (cleared, truthy) Timeout permanently makes `_connect()` refuse to send a
      // hello ("has helloTimer", index.js:104-107) → every later op on this reused handle fakes a connect timeout.
      // The guard touches only provably-dead state — a live hello loop (`_isInCSGO` true) is never disturbed.
      const priv = go as unknown as { _helloTimer?: NodeJS.Timeout | null; _isInCSGO?: boolean };
      if (!go.haveGCSession && !priv._isInCSGO && priv._helloTimer) { clearTimeout(priv._helloTimer); priv._helloTimer = null; }
      try { (client as { gamesPlayed(apps: number[]): void }).gamesPlayed([CS2_APPID]); }
      catch (e) { done(e as Error); }
    });
  }

  /** Drops the GC session (gamesPlayed([])) — best-effort, never throws. Keeps the handle. */
  private disconnect(client: unknown): void {
    try { (client as { gamesPlayed(apps: number[]): void }).gamesPlayed([]); } catch { /* noop */ }
  }

  // ── Reads (no item mutation; need only a live connect) ──────────────────────

  /** Maps each owned asset id → its REAL float (paint_wear) from the live GC inventory. */
  async readInventoryFloats(username: string): Promise<Map<string, number>> {
    return this.withSession(username, async (go) => {
      const out = new Map<string, number>();
      for (const it of go.inventory ?? []) {
        const w = it.paint_wear;
        if (typeof w === 'number' && Number.isFinite(w) && it.id != null) out.set(String(it.id), w);
      }
      return out;
    });
  }

  /**
   * The live GC inventory as raw econ items, keyed by asset id. Read-only.
   *
   * Used to look up what a trade-up ACTUALLY produced: craftTradeUp returns only the new item's id,
   * and the GC never sends a name, so the outcome has to be resolved against the inventory and then
   * named via Cs2ItemResolver. One read covers a whole batch of crafts, so a run costs a single
   * extra GC op rather than one per contract.
   */
  async readInventoryItems(username: string): Promise<Map<string, GcItem>> {
    return this.withSession(username, async (go) => {
      const out = new Map<string, GcItem>();
      for (const it of go.inventory ?? []) if (it?.id != null) out.set(String(it.id), it);
      return out;
    });
  }

  /** Lists the account's storage units (def_index 1201). Read-only. */
  async listCaskets(username: string): Promise<Array<{ id: string; name: string; count: number }>> {
    return this.withSession(username, async (go) => (go.inventory ?? [])
      .filter((i) => i.def_index === CASKET_DEF_INDEX)
      .map((i) => ({
        id: String(i.id),
        name: typeof i.custom_name === 'string' && i.custom_name ? i.custom_name : `Storage Unit ${i.id}`,
        count: Number(i.casket_contained_item_count) || 0,
      })));
  }

  /** Reads one storage unit's contents (read-only). */
  async getCasketContents(username: string, casketId: string): Promise<GcItem[]> {
    return this.withSession(username, (go) => new Promise<GcItem[]>((resolve, reject) => {
      go.getCasketContents(casketId, (err, items) => {
        if (err) {
          // globaloffensive v3.x: the 30s timeout path fires the error callback but never sets `timedOut`
          // nor detaches its `itemCustomizationNotification` listener (index.js:399-405), so it orphans one
          // listener + closure on this reused handle (and a late notification would fire callback twice).
          // We are the sole listener for that event and the inFlight guard means ≤1 read is pending per
          // handle, so clearing it on the error settle is safe.
          try { go.removeAllListeners('itemCustomizationNotification'); } catch { /* noop */ }
          reject(err);
        } else {
          resolve(Array.isArray(items) ? items : []);
        }
      });
    }));
  }

  // ── Storage moves (deposit/withdraw) — REAL send + verify ───────────────────

  /**
   * Deposits/withdraws items one at a time with verify-after. addToCasket/removeFromCasket are
   * fire-and-forget; we confirm by observing the SO cache (`gc.inventory`) reflect the new
   * `casket_id`. Money/item-safety: per-account guard (withSession), 1000-cap on deposit, cancel
   * stops between items, and once an item's move is SENT we NEVER throw/retry it (a confirmed move
   * is `moved`; a sent-but-unconfirmed move is `unconfirmed` — reversible, never blind-retried).
   */
  async moveCasketItems(
    username: string,
    casketId: string,
    itemIds: string[],
    direction: 'deposit' | 'withdraw',
    onProgress?: (p: { done: number; total: number; current: string; moved: number; unconfirmed: number; failed: number }) => void,
    shouldCancel?: () => boolean,
  ): Promise<{ moved: string[]; unconfirmed: string[]; failed: Array<{ itemId: string; error: string }>; stopped: 'completed' | 'budget' | 'cancelled' }> {
    // S16: a per-item move costs ~0.9–1.8s (verify + pacing), so the old FIXED 60s backstop falsely
    // "timed out" any move above ~50 items AND — since withTimeout cannot cancel fn(go) — left the loop
    // running DETACHED (a 2nd GC op could then interleave). Scale the backstop by item count, and give the
    // loop its OWN slightly-shorter deadline so it aborts COOPERATIVELY (returning its partial counts)
    // before the backstop can fire — no detached zombie, and no "timed out = nothing moved" mislabel.
    const MOVE_BASE_MS = 20_000;
    const MOVE_PER_ITEM_MS = 3_000; // generous upper bound; a normal item finishes in ~half this
    const loopBudgetMs = MOVE_BASE_MS + MOVE_PER_ITEM_MS * Math.max(1, itemIds.length);
    return this.withSession(username, async (go) => {
      // A stale/wrong casketId (unit deleted in-game since listCaskets) otherwise burns the whole
      // budget crawling misleading "unconfirmed" items against a unit that does not exist: deposits
      // empty-coerce a missing unit to `current = 0` and pass the cap; withdraws never look it up at
      // all. Caskets are always in the SO cache (listCaskets reads it), so a missing unit is a hard,
      // pre-send failure for BOTH directions — fail fast with nothing sent (lands runMove's 'preflight').
      const unit = (go.inventory ?? []).find((i) => String(i.id) === String(casketId));
      if (!unit) throw new Error(`storage unit ${casketId} not found in the live GC inventory — refresh the unit list and retry`);
      if (direction === 'deposit') {
        // The GC omits casket_contained_item_count for an EMPTY unit, so "absent" and "0" are the same
        // on the wire — but they are NOT the same for diagnosis. `|| 0` silently lets a deposit through
        // when the count is unreadable, and a FULL unit then behaves exactly like the trade-lock case
        // (GC accepts the message, discards it, every item times out "unconfirmed"). Say which one we
        // saw, so the next report distinguishes "unit full" from "item trade-held" without guesswork.
        const raw = unit?.casket_contained_item_count;
        const known = Number.isFinite(Number(raw));
        const current = known ? Number(raw) : 0;
        logger.info(`[gc] ${username} deposit pre-flight: unit ${casketId}` +
          `${typeof unit?.custom_name === 'string' && unit.custom_name ? ` ("${unit.custom_name}")` : ''} ` +
          `holds ${known ? current : 'UNKNOWN (attribute absent — treated as empty)'} / ${CASKET_CAPACITY}, ` +
          `depositing ${itemIds.length}`);
        if (current + itemIds.length > CASKET_CAPACITY) {
          throw new Error(`deposit would exceed the ${CASKET_CAPACITY}-item cap (unit holds ${current})`);
        }
      }
      const deadline = Date.now() + loopBudgetMs; // the loop's cooperative deadline (measured post-connect)
      const moved: string[] = [];
      const unconfirmed: string[] = [];
      const failed: Array<{ itemId: string; error: string }> = [];
      let stopped: 'completed' | 'budget' | 'cancelled' = 'completed';
      for (let i = 0; i < itemIds.length; i++) {
        if (shouldCancel?.()) { stopped = 'cancelled'; break; }
        if (Date.now() >= deadline) {
          // S16: abort CLEANLY before the backstop timeout — return the partial result so far (honest
          // counts, no detached loop). The remaining items were not attempted; a re-run continues.
          logger.warn(`[gc] ${username} ${direction}: move budget reached at item ${i}/${itemIds.length} – stopping cleanly (partial); the rest were NOT attempted (re-run to continue)`);
          stopped = 'budget';
          break;
        }
        const itemId = String(itemIds[i]);
        // Pre-send guard for DEPOSIT: verifyMove treats "item gone from the inventory array" as proof the
        // deposit landed (the GC emits itemRemoved). That inference is only sound if the item was a FREE
        // inventory item to begin with — so establish that BEFORE sending. An id that is already absent (or
        // already inside a unit) is a stale selection: fail it pre-send, with nothing submitted.
        if (direction === 'deposit') {
          const free = (go.inventory ?? []).find((x) => String(x.id) === String(itemId) && !x.casket_id);
          if (!free) {
            failed.push({ itemId, error: 'item is not a free inventory item (already stored, or the selection is stale) — refresh and retry' });
            onProgress?.({ done: i + 1, total: itemIds.length, current: itemId, moved: moved.length, unconfirmed: unconfirmed.length, failed: failed.length });
            continue;
          }
        }
        try {
          // SEND (fire-and-forget). After this point we never throw for this item.
          if (direction === 'deposit') go.addToCasket(casketId, itemId);
          else go.removeFromCasket(casketId, itemId);
        } catch (e) {
          failed.push({ itemId, error: (e as Error).message }); // threw BEFORE submit → safe, not moved
          onProgress?.({ done: i + 1, total: itemIds.length, current: itemId, moved: moved.length, unconfirmed: unconfirmed.length, failed: failed.length });
          continue;
        }
        const ok = await this.verifyMove(go, casketId, itemId, direction);
        (ok ? moved : unconfirmed).push(itemId);
        onProgress?.({ done: i + 1, total: itemIds.length, current: itemId, moved: moved.length, unconfirmed: unconfirmed.length, failed: failed.length });
        await sleep(350 + Math.floor(Math.random() * 400)); // gentle pacing between GC writes
      }
      logger.info(`[gc] ${username} ${direction}: ${moved.length} moved, ${unconfirmed.length} unconfirmed, ${failed.length} failed`);
      return { moved, unconfirmed, failed, stopped };
    }, loopBudgetMs + 20_000); // backstop > the loop's own deadline → the loop self-aborts first (no detached zombie)
  }

  /**
   * Polls the SO cache until the item reflects the expected casket state (or times out).
   *
   * DEPOSIT (2026-07-31 root-cause fix — owner: "storage says items unconfirmed, and is insanely slow"):
   * the old predicate required the item to still be IN `go.inventory` carrying `casket_id`. That never
   * happens. The GC emits `itemRemoved` for a deposited item — it LEAVES the inventory array entirely and
   * only reappears (tagged with `casket_id`) if `getCasketContents` is later called to load that unit.
   * So every successful deposit failed the check, burned the full 15s verify window, and was reported
   * "unconfirmed" — which also blew the move budget (20s + 3s/item), leaving most items unattempted.
   * A deposit is confirmed when the item is no longer a FREE inventory item: gone, or tagged into THIS
   * casket. The caller guarantees the item was free before the send, so "gone" cannot be a false positive.
   *
   * WITHDRAW is unchanged and was already correct: the GC emits `itemAcquired`, so the item is present
   * with no `casket_id`.
   */
  private async verifyMove(go: GcLike, casketId: string, itemId: string, direction: 'deposit' | 'withdraw'): Promise<boolean> {
    const want = (it: GcItem | undefined): boolean => direction === 'deposit'
      ? !it || String(it.casket_id) === String(casketId)
      : !!it && !it.casket_id;
    const deadline = nowMs() + MOVE_VERIFY_TIMEOUT_MS;
    while (nowMs() < deadline) {
      if (want((go.inventory ?? []).find((x) => String(x.id) === String(itemId)))) return true;
      await sleep(300);
    }
    return false; // sent but unconfirmed within the window — never retried (reversible)
  }

  // ── Trade-up craft — REAL, gated (irreversible) ─────────────────────────────

  /**
   * Executes ONE trade-up contract via the GC craft message. GATED behind SSIM_GC_VERIFIED.
   * Re-verifies the 10 inputs are present in the live GC inventory immediately before sending,
   * picks the documented recipe for the (rarity, StatTrak), submits exactly once, and confirms
   * via the `craftingComplete` event (which returns the produced item id). NEVER re-sends.
   */
  async craftTradeUp(username: string, p: { inputAssetIds: string[]; inputRarityId: string; stattrak: boolean }):
    Promise<{ submitted: boolean; confirmed: boolean; rejected?: boolean; outputItemId?: string }> {
    if (p.inputAssetIds.length !== 10) throw new Error('a trade-up needs exactly 10 input asset ids');
    if (new Set(p.inputAssetIds.map(String)).size !== 10) throw new Error('a trade-up needs 10 UNIQUE input asset ids');
    if (!this.craftVerified()) {
      throw new Error('trade-up craft is disabled — set SSIM_GC_VERIFIED=1 after verifying on a test account (irreversible: destroys 10 items)');
    }
    const recipe = tradeUpRecipe(p.inputRarityId, p.stattrak);
    if (recipe === undefined) throw new Error(`no trade-up recipe for rarity ${p.inputRarityId} (Covert is terminal; knives/gloves are ineligible)`);

    return this.withSession(username, (go) => new Promise((resolve, reject) => {
      // Re-verify the 10 inputs are present RIGHT NOW (state may have changed since the preview).
      const have = new Set((go.inventory ?? []).map((i) => String(i.id)));
      const missing = p.inputAssetIds.filter((id) => !have.has(String(id)));
      if (missing.length) { reject(new Error(`inputs no longer present: ${missing.join(', ')} — refresh & recompute`)); return; }

      let settled = false;
      const finish = (val: { submitted: boolean; confirmed: boolean; rejected?: boolean; outputItemId?: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { go.removeListener('craftingComplete', onDone); } catch { /* noop */ }
        resolve(val);
      };
      const onDone = (_recipe: unknown, idList: unknown): void => {
        const ids = Array.isArray(idList) ? idList.map(String) : [];
        const rec = Number(_recipe);
        if (rec >= 0 && rec !== recipe) return; // another craft's response — keep waiting
        // The GC answers a REFUSED craft with recipe -1 and an empty id list (lib README: "-1 on
        // failure"); a successful trade-up ALWAYS yields exactly one item, so no id can never be success.
        if (rec === -1 || ids.length === 0) { finish({ submitted: true, confirmed: false, rejected: true }); return; }
        finish({ submitted: true, confirmed: true, outputItemId: ids[0] });
      };
      // After the send we NEVER reject — a thrown post-submit error would invite a duplicate craft
      // (destroying another 10 items). An unconfirmed result means "submitted; verify in-game".
      const timer = setTimeout(() => finish({ submitted: true, confirmed: false }), CRAFT_CONFIRM_TIMEOUT_MS);
      go.on('craftingComplete', onDone);
      try {
        go.craft(p.inputAssetIds.map(String), recipe);
        logger.info(`[gc] ${username} trade-up submitted (recipe ${recipe}, 10 inputs)`);
      } catch (e) {
        // Threw BEFORE the message went out → safe to surface as a real failure (nothing crafted).
        settled = true; clearTimeout(timer);
        try { go.removeListener('craftingComplete', onDone); } catch { /* noop */ }
        reject(e as Error);
      }
    }));
  }
}

function nowMs(): number { return Date.now(); }

/** Rejects if `p` does not settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
