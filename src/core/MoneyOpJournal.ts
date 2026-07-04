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
//   • TTL-bounded: an entry older than the TTL is swept (a stale crash long since
//     verified by the operator can't block forever).
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
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // ~1h

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

  private read(): Record<string, MoneyOpEntry> {
    try {
      if (!fs.existsSync(this.filePath)) return {};
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, MoneyOpEntry> | null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {}; // a corrupt journal is a lost dedup memory, not a hazard — degrade to today's behaviour
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
    } catch { /* best-effort — a failed journal write must never break the money op */ }
  }

  /** Record that `opHash` is being INITIATED (before the commit). */
  begin(opHash: string, op: string): void {
    if (!this.enabled) return;
    try {
      const map = this.sweep(this.read());
      map[opHash] = { op, phase: 'initiated', at: this.now() };
      this.write(map);
    } catch { /* never throw */ }
  }

  /** Advance the phase after the commit (so a post-commit crash records it was actually placed/sent). */
  record(opHash: string, phase: MoneyOpPhase, detail?: string): void {
    if (!this.enabled) return;
    try {
      const map = this.read();
      if (map[opHash]) { map[opHash] = { ...map[opHash], phase, at: this.now(), detail }; this.write(map); }
    } catch { /* never throw */ }
  }

  /** Remove the entry — call in the finally on ANY clean resolution (success OR caught failure). */
  resolve(opHash: string): void {
    if (!this.enabled) return;
    try {
      const map = this.read();
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
      const map = this.sweep(this.read());
      this.write(map); // persist the sweep
      return map[opHash];
    } catch {
      return undefined;
    }
  }
}
