import type { InventoryService } from '../core/InventoryService';
import type { PricingService } from '../pricing/PricingService';
import type { GcActionLayer } from './GcActionLayer';
import { GcBusyError } from './GcActionLayer';
import { Cs2SchemaService, cs2Schema, parseSkinName, type SkinDef } from '../core/Cs2SchemaService';
import { cs2Items } from '../core/Cs2ItemResolver';
import { computeContract, wearMidpoint, achievableWears, type TuContract, type TuInput, type PriceFn } from './tradeupMath';
import { isSellable } from '../core/MarketModel';
import { MoneyOps, assetKey } from './MoneyOps';
import { logger } from '../utils/logger';

const CS2_APPID = 730;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Live status of the (one-at-a-time) trade-up execution job, polled by the UI. */
export interface TradeUpExecJob {
  running:      boolean;
  cancelling?:  boolean;
  cancelled?:   boolean;
  /** False when GC execution is gated off — NOTHING was crafted (safe no-op). */
  enabled:      boolean;
  statusReason: string;
  total:        number;
  done:         number;
  crafted:      number;
  failed:       number;
  current?:     number;
  results:      Array<{ index: number; submitted: boolean; confirmed?: boolean; error?: string }>;
  startedAt?:   string;
  finishedAt?:  string;

  // ── AUTO mode ("trade up everything") — absent on a plain selected-contracts run ──
  /** True while the multi-round planner is driving (plan → craft → re-read → repeat). */
  auto?:           boolean;
  /** 1-based round. Each round re-reads the inventory, because a craft's OUTPUT is itself a
   *  valid input one tier up — that is what makes a single click settle the whole account. */
  round?:          number;
  /** What the job is doing right now; `total`/`done` describe the CURRENT round only. */
  phase?:          'planning' | 'crafting' | 'settling' | 'done';
  /** Cumulative across every round (the per-round counters reset each time we re-plan). */
  totalCrafted?:   number;
  totalFailed?:    number;
  totalPlanned?:   number;
  /** Why the auto loop ended — shown verbatim; never dressed up as success. */
  autoStopReason?: string;
  /**
   * Every distinct failure reason this run hit, with how many contracts hit it, worst first.
   *
   * `results` is RESET at the start of each auto round, so by the time a run finishes the reasons the
   * stop line points at ("see the failures") are gone — which is exactly how a 63-contract run could
   * report "63 failed" and name no cause at all (owner report 2026-08-12). This survives the reset and
   * is what the UI renders.
   */
  failureReasons?: Array<{ error: string; count: number }>;
  /** Contracts that were SENT but whose result never arrived in the confirm window. Neither crafted
   *  nor failed — they need verifying in-game, and they are never retried (that would destroy 10 more
   *  items). Cumulative across rounds, for the same reason `failureReasons` is. */
  totalUnconfirmed?: number;

  // ── RUN SUMMARY (what the run actually cost and produced) ──────────────────────
  /** Market value of every input CONSUMED by a confirmed craft. Cumulative across rounds. */
  inputCents?:  number;
  /** Market value of what those crafts actually PRODUCED — resolved from the real output items the
   *  GC reported, not the pre-craft expected value. Null until the outputs are read (or if that read
   *  failed), so the UI can say "unknown" instead of showing 0. */
  outputCents?: number | null;
  /** True once the outputs were read back and priced, so a 0 means "worth nothing", not "not read". */
  outputResolved?: boolean;
  /** The crafted items, newest last — the "what was made" list in the summary. */
  outputs?: Array<{ name: string; wear?: string | null; float?: number | null; priceCents: number | null }>;
  /** Inputs whose market price was unknown, so `inputCents` understates the true cost by this many. */
  unpricedInputs?: number;
}

/** One selected contract for execution: the 10 input asset ids + the input rarity (→ craft recipe). */
export interface TuExecContract {
  inputAssetIds: string[];
  rarityId:      string;
  stattrak:      boolean;
  /** Market value of the 10 inputs, for the run summary. Optional — a caller that omits it just
   *  gets a summary that counts these inputs as unpriced rather than a wrong total. */
  costCents?:    number;
  /** How many of the 10 inputs had NO known price, so the caller's costCents is a floor. */
  unpricedInputs?: number;
}
/**
 * How many individual assets to expand out of ONE inventory stack.
 *
 * This was 10 ("a contract uses at most 10 of any single skin"), which is true of a SINGLE
 * contract but wrong for the account: 60 copies of one skin are 6 separate contracts, and the
 * old cap made 50 of them invisible. That cap is the main reason a scan reported the same
 * handful of contracts no matter how many were executed (owner report 2026-08-11). A CS2
 * inventory holds ~1000 items total, so lifting this to a full stack keeps the work bounded.
 */
const MAX_PER_STACK = 1000;
/**
 * How many contracts may fail with the SAME error, back to back and with nothing crafted, before the
 * run gives up. A repeat like that is a property of the account or the GC, never of the individual
 * contract, so the rest of the plan can only reproduce it — at up to ~35s of GC connect apiece.
 * Three keeps a genuine one-off (a stale asset, a momentarily busy slot) from ending a working run.
 */
const SYSTEMATIC_FAILURE_STREAK = 3;
/** UI safety cap on surfaced candidates (sorted by profit, best first). */
const MAX_CANDIDATES = 300;
/** Same cap for the "All trade-ups" tab, which additionally carries every unprofitable contract. */
const MAX_CANDIDATES_ALL = 600;
/** Auto mode: hard ceiling on planning→craft rounds, so a mis-planning loop can never run forever. */
const MAX_AUTO_ROUNDS = 12;
/** Auto mode: let Steam's web inventory catch up with the GC before re-planning the next round.
 *  A craft consumes its inputs GC-side immediately, but the web inventory (which getCandidates
 *  re-reads) lags; planning against a stale snapshot just books contracts the GC will reject. */
const AUTO_SETTLE_MS = 8_000;

export interface TradeUpCandidate extends TuContract {
  /** Stable id (rarity|stattrak|collection|sorted-asset-ids) for selection + execution mapping. */
  id:                string;
  collectionLabel:   string;
  rarityLabel:       string;
  outputRarityLabel: string;
  /** True when every input + every outcome had a known price (EV fully trustworthy). */
  fullyPriced:       boolean;
}

export interface TradeUpResult {
  username:   string;
  candidates: TradeUpCandidate[];
  warnings:   string[];
  /** True when EV used the REAL per-item GC floats (vs. wear-based estimates). */
  realFloats: boolean;
  /** Diagnostics for the UI footer. */
  eligibleInputs: number;
  schemaSkins:    number;
}

/**
 * Computes positive-profit CS2 trade-up contracts from ONE account's inventory.
 *
 * SEARCH STRATEGY (documented, bounded — NOT a brute force over all C(n,10), which is billions):
 * inputs are grouped by (rarity tier, StatTrak); within each group we evaluate the realistic
 * profitable contracts — the cheapest-10 MIXED contract, plus per single collection the cheapest-10
 * and the lowest-float-10. Each candidate is then scored with the EXACT contract math (computeContract).
 * This finds the trade-ups a human would actually run; the EV/probability/float math is exact.
 *
 * MONEY/ITEM SAFETY: this class only CALCULATES. It never touches the Game Coordinator or destroys
 * items — execution lives behind the gated GC action layer (see GcActionLayer / FEATURES_REPORT).
 */
export class TradeUpService {
  /** Single live execution job (the trade-up money/item path is deliberately serialized). */
  private execJob: TradeUpExecJob = { running: false, enabled: false, statusReason: '', total: 0, done: 0, crafted: 0, failed: 0, results: [] };
  private execCancel = false;
  /** Asset ids the GC reported for this run's confirmed crafts — priced by resolveOutputs at the end. */
  private craftedOutputIds: string[] = [];
  /** Set by craftContracts when it gives up on a repeating, account-wide failure (see
   *  SYSTEMATIC_FAILURE_STREAK). Carries the verbatim cause out to the run's stop line. */
  private systematicFailure = '';
  // H-TRD-069: a GcBusyError can ONLY fire before the craft is sent (the per-account slot rejects
  // pre-connect), so a busy rejection ⇔ nothing sent → we WAIT the slot out (a storage move / float
  // read holding it) rather than burning the contract as a real failure. Bounded, cancel-aware; a
  // maximal 1000-item casket batch can legitimately exhaust the window and lands in the honest message.
  private readonly busyRetryWaitMs = 5_000;
  private readonly busyRetryMaxAttempts = 24; // ~2min: covers the float read (≤~37s) + small/medium storage batches

  constructor(
    private readonly inventory: InventoryService,
    private readonly pricing:   PricingService,
    private readonly schema:    Cs2SchemaService,
    private readonly gc:        GcActionLayer,
  ) {}

  private priceFn(): PriceFn {
    return (mhn: string) => this.pricing.priceCents(mhn, CS2_APPID) ?? null;
  }

  // ── Execution (HIGH RISK, GATED — see GcActionLayer) ────────────────────────

  gcStatus(): ReturnType<GcActionLayer['status']> { return this.gc.status(); }

  executeStatus(): TradeUpExecJob {
    return {
      ...this.execJob,
      results: this.execJob.results.map((r) => ({ ...r })),
      failureReasons: (this.execJob.failureReasons ?? []).map((r) => ({ ...r })), // deep-copied: the live tally keeps mutating
    };
  }

  /** True while a trade-up craft job is running — gates a mid-session update swap (S14): a swap
   *  hard-exit mid-craft leaves an irreversible 10-item craft's outcome unknown. */
  busy(): boolean { return this.execJob.running; }

  /**
   * Starts executing the SELECTED contracts (each its 10 input asset ids) on `username`, one at a
   * time. When GC execution is gated off, the job completes immediately as a SAFE NO-OP (enabled:false,
   * nothing crafted). Cancel stops AFTER the current contract — a submitted craft is never interrupted.
   */
  startExecute(username: string, contracts: TuExecContract[]): TradeUpExecJob {
    if (this.execJob.running) throw new Error('a trade-up execution is already running');
    if (!Array.isArray(contracts) || contracts.length === 0) throw new Error('no contracts selected');
    // H-TRD-067: contracts CONSUME their inputs — an asset id may appear at most once across the whole
    // selection (and not twice within one contract). Overlapping candidates (the top-N by profit are
    // near-duplicates by construction) otherwise craft contract 1 then fail every later sharer at the GC
    // presence re-check; a non-unique intra-contract set passes that per-id membership check and pushes a
    // malformed craft the GC refuses — reported today as a false confirmed success (H-TRD-052).
    const used = new Set<string>();
    for (const c of contracts) {
      if (!c || !Array.isArray(c.inputAssetIds) || c.inputAssetIds.length !== 10 || !c.inputAssetIds.every((id) => typeof id === 'string' && id)) {
        throw new Error('each contract must carry exactly 10 input asset ids');
      }
      if (typeof c.rarityId !== 'string' || !c.rarityId) throw new Error('each contract must carry its input rarityId (for the craft recipe)');
      for (const id of c.inputAssetIds) {
        if (used.has(id)) throw new Error(`asset ${id} is used by more than one selected contract (or twice in one) — contracts consume their inputs; deselect overlapping candidates`);
        used.add(id);
      }
    }
    // H-TRD-069: refuse upfront if this account's single GC-op slot is already held (a storage move /
    // float read is running) — otherwise every contract would enter the loop only to wait the slot out.
    if (this.gc.opInFlight(username)) {
      throw new Error(`a GC operation (storage/float read) is running for ${username} — wait for it to finish`);
    }
    const st = this.gc.status();
    this.execCancel = false;
    // Gated off (SSIM_GC_VERIFIED=0 / dev): completes IMMEDIATELY as a SAFE NO-OP. Running the loop
    // would only iterate every contract to a guaranteed craftTradeUp throw (~1.5s each) with busy()===true
    // the whole time (defers a mid-session update install, S14), and report failed:N for an execution
    // that never could run. Short-circuit to a no-op terminal state — nothing is ever crafted.
    if (!st.craftEnabled) {
      const now = new Date().toISOString();
      this.execJob = {
        running: false, cancelling: false, cancelled: false, enabled: false, statusReason: st.reason,
        total: contracts.length, done: 0, crafted: 0, failed: 0, results: [], startedAt: now, finishedAt: now,
      };
      return this.executeStatus();
    }
    this.craftedOutputIds = [];   // fresh run summary (never carry the previous run's outputs)
    this.systematicFailure = '';  // …nor a previous run's give-up reason
    this.execJob = {
      running: true, cancelling: false, cancelled: false, enabled: st.craftEnabled, statusReason: st.reason,
      total: contracts.length, done: 0, crafted: 0, failed: 0, results: [], startedAt: new Date().toISOString(),
      inputCents: 0, outputCents: null, outputResolved: false, outputs: [], unpricedInputs: 0,
      failureReasons: [], totalUnconfirmed: 0,
    };
    // S33: a fire-and-forget orchestrator that ever REJECTS would (a) escape `void` as an
    // unhandledRejection → a money-breaker tick, and (b) never reach its trailing running=false → the
    // job stays latched running until restart (409s every future start; S14 update busy-gate defers
    // installs forever). Finalize on rejection: release the job + log (never rethrow).
    void this.runExecute(username, contracts).catch((err) => {
      this.execJob.running = false;
      this.execJob.cancelling = false;
      this.execJob.current = undefined;
      this.execJob.finishedAt = new Date().toISOString();
      this.execCancel = false;
      logger.error(`[tradeup] execution orchestrator crashed — job released: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.executeStatus();
  }

  cancelExecute(): TradeUpExecJob {
    if (this.execJob.running) { this.execCancel = true; this.execJob.cancelling = true; logger.info('[tradeup] execution cancel requested'); }
    return this.executeStatus();
  }

  private async runExecute(username: string, contracts: TuExecContract[]): Promise<void> {
    await this.craftContracts(username, contracts);
    await this.resolveOutputs(username);
    this.execJob.running = false;
    this.execJob.cancelling = false;
    this.execJob.cancelled = this.execCancel;
    this.execJob.current = undefined;
    this.execJob.finishedAt = new Date().toISOString();
    this.execCancel = false;
  }

  /**
   * Crafts `contracts` one at a time into the CURRENT job counters. Shared by the plain
   * selected-contracts run and by the auto planner (which calls it once per round), so both
   * paths get identical claim/busy-retry/rejection semantics. Does NOT finalize the job —
   * the caller owns that, because auto keeps it running across rounds.
   */
  private async craftContracts(username: string, contracts: TuExecContract[]): Promise<void> {
    let lastError = '';
    let repeats = 0;
    /**
     * Records ONE contract failure: counters, the per-round result row, the run-level reason tally the
     * UI reads, and a server log line. Every failure path goes through here — before this, a failed
     * contract wrote a `results` row that the auto planner then wiped on the next round's reset and
     * that nothing ever logged, so a whole run could fail 63 times and leave no trace anywhere.
     */
    const fail = (index: number, error: string, submitted: boolean): void => {
      this.execJob.failed++;
      this.execJob.results.push({ index, submitted, error });
      const reasons = (this.execJob.failureReasons ??= []);
      const hit = reasons.find((r) => r.error === error);
      if (hit) hit.count++; else reasons.push({ error, count: 1 });
      reasons.sort((a, b) => b.count - a.count);
      logger.warn(`[tradeup] ${username}: contract ${index + 1}/${contracts.length} FAILED (${submitted ? 'submitted' : 'nothing sent'}) — ${error}`);
      repeats = error === lastError ? repeats + 1 : 1;
      lastError = error;
    };

    for (let i = 0; i < contracts.length; i++) {
      if (this.execCancel) break;
      // SYSTEMATIC FAILURE — stop instead of grinding through the whole plan (owner report 2026-08-12:
      // a 63-contract run that failed 63 times, one identical failure at a time, after a long wait).
      // The same error on the first few contracts with NOTHING crafted is a property of the account or
      // the GC, not of a contract: the remaining ones can only reproduce it, and each costs a full GC
      // connect (up to 35s on a connect timeout). Requires a repeat streak AND zero crafts, so a run
      // that is genuinely working never trips it, and the reason is carried out as the stop line.
      if (repeats >= SYSTEMATIC_FAILURE_STREAK && this.execJob.crafted === 0) {
        this.systematicFailure = lastError;
        logger.error(`[tradeup] ${username}: aborting after ${repeats} identical failures with nothing crafted — ${lastError}`);
        break;
      }
      this.execJob.current = i;
      // Cross-service asset guard (D2 / INV-D2): a craft IRREVERSIBLY consumes its 10 inputs, so
      // claim them all-or-nothing before submitting — refuse (never craft) if any input is mid-flight
      // in another money op (being sold/sent). Release in the finally once this contract settles.
      const keys = contracts[i].inputAssetIds.map((id) => assetKey(username, id));
      let claimed = false;
      try {
        if (!MoneyOps.claimAll(keys)) {
          fail(i, 'input asset busy in another money operation (sell/send) — not submitted', false);
          continue;
        }
        claimed = true;
        // H-TRD-069: a GcBusyError ⇔ the craft was NEVER sent (the per-account slot rejects pre-connect),
        // so it is 100% safe to wait the holder (storage move / float read) out and re-attempt the SAME
        // contract — never a masking retry of a submitted craft. Bounded + cancel-aware; done++ fires ONCE.
        for (let attempt = 1; ; attempt++) {
          try {
            const r = await this.gc.craftTradeUp(username, {
              inputAssetIds: contracts[i].inputAssetIds,
              inputRarityId: contracts[i].rarityId,
              stattrak: !!contracts[i].stattrak,
            });
            if (r.rejected) {
              // The GC answered and REFUSED the craft — no items were consumed, nothing produced. Name
              // the recipe and rarity: a refusal is about THIS contract's inputs, and without them the
              // message says nothing the operator can act on.
              fail(i, `CS2 refused the contract (${this.rarityLabelSafe(contracts[i].rarityId)}${contracts[i].stattrak ? ' StatTrak™' : ''} → one tier up) — no items were consumed. `
                + 'The game rejects inputs it will not consume: trade-protected or trade-held skins, items sitting in a storage unit, or a mix of rarities/StatTrak.', true);
            } else {
              if (r.confirmed) {
                this.execJob.crafted++; // count only a GC-confirmed craft
                // Summary: bank the cost of the inputs this craft actually consumed, and remember the
                // produced item's id so the outputs can be priced for real once the run settles.
                this.execJob.inputCents = (this.execJob.inputCents ?? 0) + (contracts[i].costCents ?? 0);
                this.execJob.unpricedInputs = (this.execJob.unpricedInputs ?? 0) + (contracts[i].unpricedInputs ?? 0);
                if (r.outputItemId) this.craftedOutputIds.push(String(r.outputItemId));
                repeats = 0; lastError = ''; // progress — a later failure starts a fresh streak
              } else {
                // Sent, no answer in the window. NOT a failure (the craft may well have landed) and
                // never retried — but it is not a success either, so it needs its own visible counter.
                // Counted nowhere, a run of these reported "0 crafted, 0 failed" and named no cause.
                this.execJob.totalUnconfirmed = (this.execJob.totalUnconfirmed ?? 0) + 1;
                logger.warn(`[tradeup] ${username}: contract ${i + 1}/${contracts.length} submitted but NOT confirmed in-window — verify in-game (not retried)`);
              }
              this.execJob.results.push({ index: i, submitted: r.submitted, confirmed: r.confirmed, error: r.confirmed ? undefined : 'submitted — not confirmed in-window (verify in-game; NOT retried)' });
            }
            break;
          } catch (e) {
            if (e instanceof GcBusyError && attempt < this.busyRetryMaxAttempts) {
              if (this.execCancel) {
                fail(i, `${e.message} — cancelled while waiting`, false);
                break;
              }
              await sleep(this.busyRetryWaitMs);
              continue; // slot may have freed — re-attempt the same contract
            }
            const msg = e instanceof GcBusyError
              ? 'GC busy for the whole wait window (storage/float op running) — nothing was sent; re-run when it finishes'
              : (e instanceof Error ? e.message : String(e));
            fail(i, msg, false);
            break;
          }
        }
      } finally {
        if (claimed) MoneyOps.releaseAll(keys);
        this.execJob.done++;
      }
      if (i < contracts.length - 1 && !this.execCancel) await sleep(1_500);
    }
  }

  // ── AUTO: "trade up everything" (one click, many rounds) ────────────────────

  /**
   * Starts the multi-round auto planner: plan a maximal set of NON-OVERLAPPING contracts,
   * craft them all, let the inventory settle, re-plan, repeat — until nothing is left.
   *
   * Re-planning each round is the point, not a retry: a contract's OUTPUT is a valid input one
   * rarity up, so settling an account genuinely takes several passes. The loop only ever
   * continues while it is making progress (a round that crafts nothing stops it), and is capped
   * at MAX_AUTO_ROUNDS regardless.
   *
   * `profitableOnly` (default TRUE) restricts every round to positive-EV contracts. With it off
   * the planner crafts every computable contract, including value-destroying ones — that is the
   * literal "do every possible trade-up", so it is opt-in and named plainly at the call site.
   */
  startAuto(username: string, opts: { profitableOnly?: boolean } = {}): TradeUpExecJob {
    if (this.execJob.running) throw new Error('a trade-up execution is already running');
    if (this.gc.opInFlight(username)) {
      throw new Error(`a GC operation (storage/float read) is running for ${username} — wait for it to finish`);
    }
    const st = this.gc.status();
    this.execCancel = false;
    const now = new Date().toISOString();
    // Gated off → terminal SAFE NO-OP, exactly like startExecute. Never enter the loop: every
    // round would plan, refresh a live inventory, and craft nothing.
    if (!st.craftEnabled) {
      this.execJob = {
        running: false, cancelling: false, cancelled: false, enabled: false, statusReason: st.reason,
        total: 0, done: 0, crafted: 0, failed: 0, results: [], startedAt: now, finishedAt: now,
        auto: true, round: 0, phase: 'done', totalCrafted: 0, totalFailed: 0, totalPlanned: 0,
        autoStopReason: st.reason,
      };
      return this.executeStatus();
    }
    this.craftedOutputIds = [];   // fresh run summary (never carry the previous run's outputs)
    this.systematicFailure = '';  // …nor a previous run's give-up reason
    this.execJob = {
      running: true, cancelling: false, cancelled: false, enabled: true, statusReason: st.reason,
      total: 0, done: 0, crafted: 0, failed: 0, results: [], startedAt: now,
      auto: true, round: 0, phase: 'planning', totalCrafted: 0, totalFailed: 0, totalPlanned: 0,
      inputCents: 0, outputCents: null, outputResolved: false, outputs: [], unpricedInputs: 0,
      failureReasons: [], totalUnconfirmed: 0,
    };
    // S33: same rejection-safety contract as startExecute — a fire-and-forget orchestrator that
    // rejects must never leave the job latched `running` (that 409s every later start forever).
    void this.runAuto(username, opts.profitableOnly !== false).catch((err) => {
      this.execJob.autoStopReason = `auto planner crashed: ${err instanceof Error ? err.message : String(err)}`;
      this.execJob.phase = 'done';
      this.execJob.running = false;
      this.execJob.cancelling = false;
      this.execJob.current = undefined;
      this.execJob.finishedAt = new Date().toISOString();
      this.execCancel = false;
      logger.error(`[tradeup] auto planner crashed — job released: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.executeStatus();
  }

  private async runAuto(username: string, profitableOnly: boolean): Promise<void> {
    const job = this.execJob;
    let stop = `settled after ${MAX_AUTO_ROUNDS} rounds (cap reached)`;
    try {
      for (let round = 1; round <= MAX_AUTO_ROUNDS; round++) {
        if (this.execCancel) { stop = 'cancelled'; break; }
        job.round = round;
        job.phase = 'planning';

        // includeUnprofitable mirrors the mode: profitable-only planning must not even see
        // negative-EV contracts, or the disjoint picker would spend inputs on them.
        const res = await this.getCandidates(username, { includeUnprofitable: !profitableOnly });
        if (this.execCancel) { stop = 'cancelled'; break; }
        const usable = res.candidates.filter((c) =>
          c.inputs.length === 10 && c.inputs.every((i) => i.assetId) && (!profitableOnly || c.profitCents > 0));
        const contracts = pickDisjoint(usable);
        if (!contracts.length) {
          stop = round === 1
            ? (profitableOnly ? 'no profitable trade-up is possible on this account' : 'no trade-up is possible on this account')
            : `nothing left to trade up after ${round - 1} round(s)`;
          break;
        }

        job.phase = 'crafting';
        job.total = contracts.length;
        job.done = 0; job.crafted = 0; job.failed = 0; job.results = [];
        job.totalPlanned = (job.totalPlanned ?? 0) + contracts.length;
        logger.info(`[tradeup] ${username}: auto round ${round} — crafting ${contracts.length} disjoint contract(s)`);

        await this.craftContracts(username, contracts.map((c) => ({
          inputAssetIds: c.inputs.map((i) => i.assetId as string),
          rarityId: c.rarityId,
          stattrak: !!c.stattrak,
          costCents: c.costCents,
          unpricedInputs: c.inputs.filter((i) => i.priceCents == null).length,
        })));

        job.totalCrafted = (job.totalCrafted ?? 0) + job.crafted;
        job.totalFailed = (job.totalFailed ?? 0) + job.failed;
        if (this.execCancel) { stop = 'cancelled'; break; }
        // A round that crafted NOTHING means every contract was rejected/failed — re-planning
        // would produce the same set against the same inventory. Stop, and say WHY: the reason
        // has to travel with the stop line, because pointing at a failure list the UI never
        // rendered is what left a 63-contract run looking like it failed for nothing.
        if (job.crafted === 0) {
          stop = this.systematicFailure
            ? `stopped in round ${round} — every contract failed the same way: ${this.systematicFailure}`
            : `stopped after round ${round} — no contract could be crafted: ${this.summarizeFailures()}`;
          break;
        }

        job.phase = 'settling';
        await sleep(AUTO_SETTLE_MS);
      }
    } finally {
      // One read-back for the WHOLE run (not per round) — the summary is about the run as a whole,
      // and this keeps the cost at a single extra GC op however many rounds it took.
      await this.resolveOutputs(username).catch(() => { /* resolveOutputs already fails soft */ });
      job.autoStopReason = stop;
      job.phase = 'done';
      job.running = false;
      job.cancelling = false;
      job.cancelled = this.execCancel;
      job.current = undefined;
      job.finishedAt = new Date().toISOString();
      this.execCancel = false;
      logger.info(`[tradeup] ${username}: auto finished — ${job.totalCrafted ?? 0} crafted, ${job.totalFailed ?? 0} failed (${stop})`);
    }
  }

  /** A human rarity name for a failure message. Never throws: a diagnostic that can fail while
   *  describing a failure would replace the real cause with its own stack. */
  private rarityLabelSafe(rarityId: string): string {
    try { return this.schema.rarityLabel(rarityId) || rarityId; } catch { return rarityId; }
  }

  /** The run's failure reasons as one line, commonest first — what the stop line quotes. */
  private summarizeFailures(): string {
    const reasons = this.execJob.failureReasons ?? [];
    if (!reasons.length) return 'no contract failed and none was crafted (nothing was submitted)';
    return reasons.slice(0, 3).map((r) => `${r.count}× ${r.error}`).join(' · ');
  }

  /**
   * Reads back what the run actually PRODUCED and prices it, closing the run summary.
   *
   * craftTradeUp reports only the new item's id and the GC never sends a name, so the outcomes are
   * looked up in one inventory read and named via Cs2ItemResolver (the same path the storage-unit
   * panel uses). This is the REAL result — not the pre-craft expected value — which is the whole
   * point of showing it: EV says what the contracts were worth on paper, this says what you got.
   *
   * Never throws and never fails the job: the crafts already happened. If the read is unavailable the
   * summary reports `outputResolved:false` so the UI says "unknown" rather than implying zero.
   */
  private async resolveOutputs(username: string): Promise<void> {
    const ids = this.craftedOutputIds;
    if (!ids.length) { this.execJob.outputCents = 0; this.execJob.outputResolved = true; this.execJob.outputs = []; return; }
    try {
      await Promise.all([
        cs2Schema.ensureLoaded().catch(() => { /* resolver degrades to a def-index label */ }),
        cs2Items.ensureLoaded(),
      ]);
      const inv = await this.gc.readInventoryItems(username);
      const outputs: NonNullable<TradeUpExecJob['outputs']> = [];
      let total = 0;
      let priced = 0;
      for (const id of ids) {
        const item = inv.get(id);
        // An output already moved/sold between the craft and this read is simply unknown to us —
        // count it as unpriced rather than as zero value.
        if (!item) { outputs.push({ name: `Crafted item ${id}`, priceCents: null }); continue; }
        const r = cs2Items.resolve(item as Parameters<typeof cs2Items.resolve>[0]);
        const p = this.pricing.priceCents(r.marketHashName, CS2_APPID);
        if (typeof p === 'number') { total += p; priced++; }
        outputs.push({ name: r.marketHashName, wear: r.wear, float: r.float, priceCents: typeof p === 'number' ? p : null });
      }
      this.execJob.outputs = outputs;
      this.execJob.outputCents = total;
      // Only claim the total is complete when EVERY output priced; otherwise it is a floor and the
      // UI says so, rather than quietly reporting a low number as the run's result.
      this.execJob.outputResolved = priced === ids.length;
      logger.info(`[tradeup] ${username}: run produced ${ids.length} item(s), ${priced} priced, total ${total}c`);
    } catch (e) {
      this.execJob.outputCents = null;
      this.execJob.outputResolved = false;
      logger.warn(`[tradeup] ${username}: could not read back the crafted outputs (${(e as Error).message}) — summary shows inputs only`);
    }
  }

  /** Live-refresh the account, then compute trade-ups from its skins. By default only positive-profit
   *  contracts; with `includeUnprofitable` it returns EVERY computable contract (the frontend's "All
   *  trade-ups" tab), each carrying its own `profitCents` so the UI can split profitable vs all. */
  async getCandidates(username: string, opts?: { minProfitCents?: number; includeUnprofitable?: boolean }): Promise<TradeUpResult> {
    await this.schema.ensureLoaded();
    const minProfit = Number.isFinite(opts?.minProfitCents) ? Number(opts?.minProfitCents) : 0;
    const includeUnprofitable = !!opts?.includeUnprofitable;
    const warnings: string[] = [];

    const inv = await this.inventory.forceRefresh(username, 'cs2'); // fresh snapshot, like the buy path
    const inputs = this.buildEligibleInputs(inv.items);
    if (inputs.length < 10) {
      warnings.push('Not enough trade-up-eligible skins (need at least 10 of one rarity + StatTrak status).');
      return { username, candidates: [], warnings, realFloats: false, eligibleInputs: inputs.length, schemaSkins: this.schema.skinCount() };
    }

    // ACCURACY: replace the wear-midpoint float ESTIMATE with the REAL per-item GC float when the
    // library is present. This is a user-initiated trade-up action, so a one-shot GC connect here is
    // in-scope (never the background path); it disconnects immediately. Falls back to the estimate
    // (clearly labelled) if the GC is unavailable / the read fails.
    let realFloats = false;
    if (this.gc.available()) {
      try {
        const floats = await this.gc.readInventoryFloats(username);
        let applied = 0;
        for (const inp of inputs) {
          if (inp.assetId && floats.has(inp.assetId)) { inp.float = floats.get(inp.assetId)!; applied++; }
        }
        realFloats = applied > 0 && applied === inputs.filter((i) => i.assetId).length;
        logger.info(`[tradeup] ${username}: applied ${applied}/${inputs.length} real GC float(s)`);
        if (applied > 0 && !realFloats) warnings.push('Some items had no GC float — those use a wear-based estimate.');
      } catch (e) {
        warnings.push(`Could not read real floats from the GC (${(e as Error).message}) — using wear-based estimates.`);
      }
    }

    // Warm the price cache for every eligible collection's OUTPUT skins (all wears) + the inputs,
    // so a follow-up call has accurate EV. Outputs are NOT in the account inventory, so they would
    // otherwise never be queued.
    this.warmOutputPrices(inputs);

    const price = this.priceFn();
    const candidates: TradeUpCandidate[] = [];
    const seen = new Set<string>();
    // H-TRD-071: a computeContract throw means a schema/grouping regression (grouping guarantees
    // same rarity+StatTrak, so this is only reachable via a schema mismatch). Count the skips so a
    // regression that breaks EVERY set surfaces as a distinct warning instead of the ordinary
    // "no profitable trade-ups" empty state (failed ≠ empty).
    let skippedSets = 0;
    let firstSkipError = '';

    // Group by (rarity tier, StatTrak).
    const groups = new Map<string, TuInput[]>();
    for (const inp of inputs) {
      const k = `${inp.rarityId}|${inp.stattrak ? 1 : 0}`;
      const arr = groups.get(k) ?? [];
      arr.push(inp);
      groups.set(k, arr);
    }

    for (const group of groups.values()) {
      if (group.length < 10) continue;
      const outputRarity = this.schema.nextRarity(group[0].rarityId);
      if (!outputRarity) continue;

      // Candidate input-sets, in two flavours:
      //
      //  (a) HEURISTIC picks — the single best-looking contract of each shape (cheapest-10 mixed,
      //      per-collection cheapest-10 and lowest-float-10). These are what a human would pick
      //      first, but they all draw from the SAME cheap/low-float items, so they overlap heavily.
      //      On their own they are also all this scan ever produced: a fixed handful of contracts
      //      (~12) regardless of inventory size, and selecting more than one of them tripped the
      //      "asset is used by more than one selected contract" refusal. That is the owner's report.
      //
      //  (b) A DISJOINT PARTITION — the group carved into as many non-overlapping 10-item contracts
      //      as it can actually support. This is what makes "how many trade-ups can this account
      //      really do" a truthful number, and it is what the auto planner executes.
      const sets: TuInput[][] = [];
      sets.push(cheapest(group, 10));
      const byCol = new Map<string, TuInput[]>();
      for (const i of group) { const a = byCol.get(i.collection) ?? []; a.push(i); byCol.set(i.collection, a); }
      for (const colItems of byCol.values()) {
        if (colItems.length < 10) continue;
        sets.push(cheapest(colItems, 10));
        sets.push(lowestFloat(colItems, 10));
      }
      sets.push(...partitionSets(byCol));

      for (const set of sets) {
        if (set.length !== 10) continue;
        const key = set.map((i) => i.assetId ?? i.marketHashName).sort().join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        let contract: TuContract;
        try { contract = computeContract(set, this.schema, price); }
        catch (e) {
          skippedSets++;
          if (!firstSkipError) firstSkipError = (e as Error).message;
          logger.debug(`[tradeup] skipped a set: ${(e as Error).message}`);
          continue;
        }
        if (!includeUnprofitable && contract.profitCents <= minProfit) continue;
        candidates.push(this.decorate(contract, key));
      }
    }

    // H-TRD-071: if any set failed the exact math, say so — a full-blown regression would otherwise
    // read as "nothing profitable". One warn carries the first captured cause for the operator.
    if (skippedSets > 0) {
      warnings.push(`${skippedSets} candidate set(s) could not be evaluated (schema mismatch) — results may be incomplete.`);
      logger.warn(`[tradeup] ${username}: ${skippedSets} candidate set(s) failed computeContract (schema mismatch); first error: ${firstSkipError}`);
    }

    // H-TRD-072: rank fully-priced first, profit second, so the MAX_CANDIDATES slice
    // keeps honest fully-priced contracts over estimate ones with fabricated near-zero cost.
    candidates.sort((a, b) => (Number(b.fullyPriced) - Number(a.fullyPriced)) || (b.profitCents - a.profitCents));
    // Caps are deliberately generous now that the partition makes the count MEANINGFUL: an account
    // that can genuinely run 60 disjoint contracts must be able to show and execute all 60. The old
    // 80 was set when the generator only ever emitted a dozen overlapping picks, so it never bound;
    // with the partition it would silently truncate the answer to "how many can I do?".
    const top = candidates.slice(0, includeUnprofitable ? MAX_CANDIDATES_ALL : MAX_CANDIDATES);

    // H-TRD-073: the price cache is tri-state (PricingService.priceCents: undefined = not fetched yet
    // → a re-click can fill it; null = FRESH authoritative "no market price", cached 24h per S2 → a
    // re-click never changes it; number = priced). The old single warning told the user to "click again
    // in a moment" for BOTH gap kinds, so a candidate whose only gap is an authoritative no-price
    // outcome looked perpetually loading. Partition the not-fully-priced candidates' involved names and
    // warn per real cause. (computeContract's null-in = unpriced math contract stays untouched.)
    let anyLoading = false;
    let anyNoPrice = false;
    for (const c of top) {
      if (c.fullyPriced) continue;
      for (const mhn of [...c.inputs.map((i) => i.marketHashName), ...c.outcomes.map((o) => o.marketHashName)]) {
        const p = this.pricing.priceCents(mhn, CS2_APPID);
        if (p === undefined) anyLoading = true;
        else if (p === null) anyNoPrice = true;
      }
    }
    if (anyLoading) {
      warnings.push('Some prices are still loading — EV/profit shown are estimates; click again in a moment for accurate figures.');
    }
    if (anyNoPrice) {
      warnings.push('Some items have no current market price — their EV contribution is 0 (not loading; re-clicking will not change this).');
    }
    warnings.push(realFloats
      ? 'Input floats are the REAL per-item GC floats — output wears + EV are accurate (subject to live market prices).'
      : 'Input floats are ESTIMATED from each item’s wear (GC float read unavailable) — EV is an approximation.');

    const profitableCount = top.filter((c) => c.profitCents > 0).length;
    logger.info(`[tradeup] ${username}: ${top.length} candidate(s) (${profitableCount} profitable) from ${inputs.length} eligible input(s)${realFloats ? ' (real floats)' : ' (estimated floats)'}`);
    return { username, candidates: top, warnings, eligibleInputs: inputs.length, schemaSkins: this.schema.skinCount(), realFloats };
  }

  /** Expands inventory stacks into individual trade-up-eligible input items (≤10 per stack). */
  private buildEligibleInputs(items: Array<{ marketHashName: string; quantity?: number; assetIds: string[]; price?: number | null; category?: string; tradeLockExpiry?: Date | string | null; tradable?: boolean }>): TuInput[] {
    const out: TuInput[] = [];
    for (const it of items) {
      if (it.category === 'listed') continue;                       // on the market, not in inventory
      // Never feed a trade-locked / non-tradable skin into a craft (INV-D6 / C10). The
      // forceRefresh path doesn't set `category`, so check the lock state directly.
      if (!isSellable(it)) continue;
      const parsed = parseSkinName(it.marketHashName);
      if (!parsed || parsed.souvenir || !parsed.wear) continue;     // souvenirs/no-wear → ineligible
      const def: SkinDef | undefined = this.schema.lookup(parsed.baseName);
      if (!def || !this.schema.isEligibleInput(def)) continue;
      const float = wearMidpoint(parsed.wear, def.minFloat, def.maxFloat); // estimate (exact float unknown on web)
      const priceCents = this.pricing.priceCents(it.marketHashName, CS2_APPID);
      const n = Math.min(it.assetIds.length, it.quantity ?? it.assetIds.length, MAX_PER_STACK);
      for (let i = 0; i < n; i++) {
        out.push({
          marketHashName: it.marketHashName,
          baseName: def.name,
          collection: def.collection,
          rarityId: def.rarityId,
          stattrak: parsed.stattrak,
          float,
          priceCents: priceCents ?? null,
          assetId: it.assetIds[i],
        });
      }
    }
    return out;
  }

  /** Queues background price fills for every eligible collection's output skins (only the wears each
   *  skin's float range can roll) + the inputs, so the NEXT calculation has accurate EV (outputs are
   *  never in the account inventory). */
  private warmOutputPrices(inputs: TuInput[]): void {
    const missing: Array<{ name: string; appid: number }> = [];
    const seen = new Set<string>();
    const add = (mhn: string): void => {
      if (seen.has(mhn)) return;
      seen.add(mhn);
      if (this.pricing.priceCents(mhn, CS2_APPID) === undefined) missing.push({ name: mhn, appid: CS2_APPID });
    };
    const collections = new Set<string>();
    for (const i of inputs) { add(i.marketHashName); collections.add(`${i.collection}|${i.rarityId}|${i.stattrak ? 1 : 0}`); }
    for (const key of collections) {
      const [collection, rarityId, st] = key.split('|');
      for (const o of this.schema.outputsFor(collection, rarityId)) {
        for (const wear of achievableWears(o.minFloat, o.maxFloat)) {
          add(this.schema.marketHashName(o.name, wear, st === '1'));
        }
      }
    }
    if (missing.length) this.pricing.ensureFilled(missing);
  }

  private decorate(c: TuContract, key: string): TradeUpCandidate {
    const collection = c.inputs.every((i) => i.collection === c.inputs[0].collection) ? c.inputs[0].collection : 'Mixed';
    return {
      ...c,
      id: `${c.rarityId}|${c.stattrak ? 1 : 0}|${collection}|${key}`,
      collectionLabel: collection,
      rarityLabel: this.schema.rarityLabel(c.rarityId),
      outputRarityLabel: this.schema.rarityLabel(c.outputRarityId),
      fullyPriced: c.pricedInputs === 10 && c.pricedOutcomeProb > 0.999,
    };
  }
}

/** The `count` cheapest inputs (unpriced sorted last — we never want to bank on an unknown cost). */
function cheapest(items: TuInput[], count: number): TuInput[] {
  return [...items].sort((a, b) => (a.priceCents ?? Infinity) - (b.priceCents ?? Infinity)).slice(0, count);
}
/** The `count` lowest-float inputs (better output wear → usually higher output value). */
function lowestFloat(items: TuInput[], count: number): TuInput[] {
  return [...items].sort((a, b) => a.float - b.float).slice(0, count);
}

/**
 * Carves one (rarity × StatTrak) group into a MAXIMAL set of non-overlapping 10-item contracts.
 *
 * Single-collection contracts are cut first: their output pool is one collection, so the outcome
 * is predictable and usually worth more than a mixed roll. Whatever is left over (each collection's
 * remainder of <10) is then combined ACROSS collections — a mixed contract is perfectly legal in
 * CS2, its output pools every input collection — so leftovers still get used instead of stranded.
 *
 * Within a collection items are cut lowest-float first, so the good floats land together in one
 * contract rather than being smeared across all of them (that materially changes output wear).
 * The returned sets share no asset, so the whole list can be selected and executed in one go.
 * Pure + exported for unit tests.
 */
export function partitionSets(byCollection: Map<string, TuInput[]>): TuInput[][] {
  const sets: TuInput[][] = [];
  const leftovers: TuInput[] = [];
  for (const items of byCollection.values()) {
    const pool = [...items].sort((a, b) => a.float - b.float);
    while (pool.length >= 10) sets.push(pool.splice(0, 10));
    leftovers.push(...pool);
  }
  const mixed = leftovers.sort((a, b) => (a.priceCents ?? Infinity) - (b.priceCents ?? Infinity));
  while (mixed.length >= 10) sets.push(mixed.splice(0, 10));
  return sets;
}

/**
 * Greedily selects the largest run of candidates that share no input asset, best first.
 *
 * Contracts CONSUME their inputs, so an overlapping selection is not executable — startExecute
 * refuses it outright ("asset is used by more than one selected contract"). Candidates arrive
 * ranked (fully-priced first, then profit), so taking greedily in order keeps the best contract
 * of each overlapping cluster and drops only its near-duplicates. Pure + exported for unit tests
 * (the frontend's Select-all mirrors this exactly — see tuPickDisjoint in public/app.js).
 */
export function pickDisjoint(candidates: TradeUpCandidate[]): TradeUpCandidate[] {
  const used = new Set<string>();
  const out: TradeUpCandidate[] = [];
  for (const c of candidates) {
    const ids = c.inputs.map((i) => i.assetId).filter((id): id is string => !!id);
    if (ids.length !== 10 || ids.some((id) => used.has(id))) continue;
    for (const id of ids) used.add(id);
    out.push(c);
  }
  return out;
}
