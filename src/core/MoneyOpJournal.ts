import fs from 'fs';
import { logger } from '../utils/logger';
import { writeJsonAtomic } from '../utils/atomicJson';
import { dataDir } from '../utils/paths';

// ════════════════════════════════════════════════════════════════════════════
//  MoneyOpJournal (B4) — a small, bounded, cross-restart guard against firing the
//  SAME money op twice after a crash.
//
//  The in-flight Sets in TradeService/BuyService stop CONCURRENT duplicates, but
//  they are in-memory: a crash+restart wipes them, and a user who re-clicks a
//  buy/send that was mid-flight when we died has NO server-side dedup — the
//  Steam-side order/offer may already exist (BACKEND_RELIABILITY.md F5, residual 1).
//
//  This journal closes that gap WITHOUT changing any success-path behaviour:
//   • begin(op)   is written BEFORE the commit; resolve(op) removes it after the op
//     RESOLVES (success OR caught failure — both run the finally). So a CLEANLY
//     completed op leaves NO trace → legitimate sequential repeats are unaffected.
//   • Only a HARD crash between begin() and resolve() leaves a LINGERING entry —
//     an op whose Steam-side outcome is unknown. On the next run, a retry whose
//     op-hash matches that lingering entry is refused ONCE (and the entry consumed,
//     so a deliberate second attempt proceeds) with a "verify on Steam" message.
//   • TTL-bounded (24h): an entry older than the TTL is swept. The window must
//     outlive a crash-overnight → retry-next-morning cycle; post-S15 a lingering
//     entry costs only one refused click + an 8s pause, so the sweep exists to
//     bound growth/staleness, not UX — a stale crash long since verified by the
//     operator can't block forever.
//
//  Every method is best-effort and NEVER throws — it must not perturb the money
//  path (esp. the "never throw after placement" contract). Injectable path/ttl/now
//  for tests; the DO-NOT-TOUCH createBuyOrder finalize re-POST is never involved.
// ════════════════════════════════════════════════════════════════════════════

export type MoneyOpPhase = 'initiated' | 'placed' | 'sent';

export interface MoneyOpEntry {
  op: string;        // 'buy' | 'send' — for the surfaced message
  phase: MoneyOpPhase;
  at: number;        // epoch ms of begin()/record()
  detail?: string;
  /** S15: epoch ms this lingering entry was FIRST refused this run. Set on the first refusal so a rapid
   *  re-fire (double-click after a crash-restart) is refused AGAIN until a deliberate-pause min-age
   *  elapses — a synchronous consume-on-refuse could not enforce that pause. */
  refusedAt?: number;
}

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h — must outlive a crash-overnight→retry-next-morning cycle; post-S15 a lingering entry costs only one refused click + an 8s pause, so the sweep exists to bound growth/staleness, not UX
const DEFAULT_MIN_REFUSE_MS = 8_000;   // S15: a lingering op is refused for ≥8s before a deliberate retry is allowed

export class MoneyOpJournal {
  constructor(
    private readonly filePath: string = dataDir('money-op-journal.json'),
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = () => Date.now(),
    /** When false, every method is a no-op (no disk). This is the DEFAULT the services fall back to when
     *  no journal is injected (i.e. direct construction in unit tests) — so tests never contend on a
     *  shared on-disk journal. Production wires an ENABLED, stable-path journal via createDeps. */
    private readonly enabled: boolean = true,
  ) {}

  /** A no-op journal (no persistence) — the safe default for direct construction / tests. */
  static disabled(): MoneyOpJournal {
    return new MoneyOpJournal(dataDir('money-op-journal.json'), DEFAULT_TTL_MS, () => 0, false);
  }

  /** S54/S58: epoch ms (real clock) of the last surfaced fs-failure warn — rate-limits the warn to ≤1/min. */
  private lastWarnAt = 0;

  /**
   * Surface a persistent read/write fs failure ONCE per minute — a persistently unwritable/unreadable data/
   * (EPERM/EACCES after an AV or permissions change, disk full, read-only volume) silently drops the money
   * path back to pre-B4 behaviour with no cross-restart dedup. A rate-limited warn turns that invisible loss
   * of the S3/S15 guarantee into a diagnosable one-liner. Uses the REAL clock (not this.now) so injected test
   * clocks neither suppress nor spam it; self-catching so it never breaks the never-throw contract.
   */
  private warn(kind: 'read' | 'write', err: unknown): void {
    try {
      const now = Date.now();
      if (now - this.lastWarnAt < 60_000) return;
      this.lastWarnAt = now;
      logger.warn(`[money-journal] ${kind} failed (${(err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message ?? 'unknown'}): cross-restart money-op dedup degraded – ${this.filePath}`);
    } catch { /* logging must never break the never-throw contract */ }
  }

  /**
   * Read the journal, distinguishing a genuinely-absent/corrupt file (empty is AUTHORITATIVE — the
   * dedup memory really is nothing) from a TRANSIENT fs error on an existing file (empty is a FABRICATION
   * we must not persist — an EBUSY/EPERM sharing violation from AV/indexer/backup, the Windows S54/S58
   * failure mode). `unreliable` gates the destructive persists (begin's wholesale write, the sweep-persist,
   * the no-entry rm) so a blip can never erase other accounts' lingering double-spend entries.
   */
  private read(): { map: Record<string, MoneyOpEntry>; unreliable: boolean } {
    if (!fs.existsSync(this.filePath)) return { map: {}, unreliable: false };
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      // ENOENT (raced deletion) is authoritative-empty; any other fs error (EBUSY/EPERM/EACCES/EIO…) is a
      // transient failure on an existing file — degrade to empty for THIS call but never persist it.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { map: {}, unreliable: false };
      this.warn('read', err);
      return { map: {}, unreliable: true };
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, MoneyOpEntry> | null;
      return { map: parsed && typeof parsed === 'object' ? parsed : {}, unreliable: false };
    } catch {
      return { map: {}, unreliable: false }; // a corrupt journal is a lost dedup memory, not a hazard — degrade to today's behaviour
    }
  }

  /** Drop entries older than the TTL. Returns the swept map. */
  private sweep(map: Record<string, MoneyOpEntry>): Record<string, MoneyOpEntry> {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, v] of Object.entries(map)) {
      if (!v || typeof v.at !== 'number' || v.at < cutoff) delete map[k];
    }
    return map;
  }

  private write(map: Record<string, MoneyOpEntry>): void {
    try {
      if (Object.keys(map).length === 0) { if (fs.existsSync(this.filePath)) fs.rmSync(this.filePath, { force: true }); return; }
      writeJsonAtomic(this.filePath, map, { spaces: 0 });
    } catch (err) { this.warn('write', err); /* best-effort — a failed journal write must never break the money op */ }
  }

  /** Record that `opHash` is being INITIATED (before the commit). */
  begin(opHash: string, op: string): void {
    if (!this.enabled) return;
    try {
      const { map, unreliable } = this.read();
      if (unreliable) return; // a transient read blip — do NOT clobber the whole file to this one entry (the op proceeds unjournaled, as it does today on a failed write)
      const swept = this.sweep(map);
      swept[opHash] = { op, phase: 'initiated', at: this.now() };
      this.write(swept);
    } catch { /* never throw */ }
  }

  /** Advance the phase after the commit (so a post-commit crash records it was actually placed/sent).
   *  UPSERT: if a transient begin() write failed (blip) or the entry was clobbered, record() is the one
   *  call made with CERTAIN knowledge the op landed on Steam — so it CREATES the entry when absent rather
   *  than silently no-op'ing away the highest-value crash-protection window (H-TRD-110). */
  record(opHash: string, op: string, phase: MoneyOpPhase, detail?: string): void {
    if (!this.enabled) return;
    try {
      const { map, unreliable } = this.read();
      if (unreliable) return; // a transient read blip — do not write over an unread file
      const existing = map[opHash];
      map[opHash] = { op: existing?.op ?? op, phase, at: this.now(), detail };
      this.write(map);
    } catch { /* never throw */ }
  }

  /** Remove the entry — call in the finally on ANY clean resolution (success OR caught failure). */
  resolve(opHash: string): void {
    if (!this.enabled) return;
    try {
      const { map, unreliable } = this.read();
      if (unreliable) return; // a transient read blip — do not write over an unread file
      if (map[opHash]) { delete map[opHash]; this.write(map); }
    } catch { /* never throw */ }
  }

  /**
   * Return a LINGERING (crash-interrupted) entry for `opHash` within the TTL, or undefined. A non-empty
   * result means a prior identical op died mid-flight and its Steam-side outcome is unknown → the caller
   * should refuse the auto-refire and surface it. (Persists the sweep so expired entries are cleaned.)
   */
  findUnresolved(opHash: string): MoneyOpEntry | undefined {
    if (!this.enabled) return undefined;
    try {
      const { map, unreliable } = this.read();
      if (unreliable) return undefined; // a transient read blip — allow (today's degrade), and do NOT persist the fabricated-empty sweep
      const swept = this.sweep(map);
      this.write(swept); // persist the sweep
      return swept[opHash];
    } catch {
      return undefined;
    }
  }

  /**
   * S15: decide REFUSE vs ALLOW for a lingering entry, enforcing a "check on Steam, then retry" PAUSE
   * that a synchronous consume-on-refuse could not. Returns the entry to REFUSE (and KEEPS it on disk),
   * or undefined to ALLOW (consuming the entry). The FIRST encounter is refused and stamped `refusedAt`;
   * a re-attempt within `minRefuseMs` (a double-click / rapid re-fire) is refused AGAIN and the entry is
   * NOT consumed; a DELIBERATE re-attempt after `minRefuseMs` — or `force` — is allowed and consumes the
   * entry so the caller proceeds. Best-effort; a journal error degrades to ALLOW (today's no-dedup).
   */
  consultRefusal(opHash: string, opts?: { force?: boolean; minRefuseMs?: number }): MoneyOpEntry | undefined {
    if (!this.enabled) return undefined;
    try {
      const { map, unreliable } = this.read();
      if (unreliable) return undefined; // a transient read blip — allow (today's degrade), and do NOT write/delete over an unread file (would erase other accounts' lingering entries)
      this.sweep(map);
      const entry = map[opHash];
      if (!entry) { this.write(map); return undefined; } // no lingering op → allow (persist the sweep)
      const minAge = opts?.minRefuseMs ?? DEFAULT_MIN_REFUSE_MS;
      const paused = typeof entry.refusedAt === 'number' && this.now() - entry.refusedAt >= minAge;
      if (opts?.force === true || paused) {
        delete map[opHash]; // deliberate retry (paused long enough) or force → consume + allow
        this.write(map);
        return undefined;
      }
      if (typeof entry.refusedAt !== 'number') entry.refusedAt = this.now(); // stamp the FIRST refusal
      this.write(map); // keep the entry so a rapid re-fire is refused too
      return entry;
    } catch {
      return undefined; // never throw — degrade to allow
    }
  }
}
