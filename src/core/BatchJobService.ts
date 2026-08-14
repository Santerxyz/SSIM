// ════════════════════════════════════════════════════════════════════════════
//  W3_32 — BatchJobService: the canonical fan-out. Pick a scope (→ usernames[]),
//  pick a job, run it, watch one progress surface, keep a history.
//
//  The engine is a ROUTER, not a worker. Each JobDef's adapter is a CLOSURE (built in
//  server.ts over the real services) that either (a) kicks an EXISTING fan-out service
//  and returns a `delegating` source carrying that service's own status/cancel readers,
//  or (b) asks the engine to run a serial `internal` per-account loop. Either way caps
//  (login 25 / trade 1 / offer 2), the sacred buy re-POST and MoneyOpJournal stay owned
//  upstream — inherited by construction. The engine adds NO money path of its own.
//
//  `experimental` jobs surface a TEST warning in the UI (wired but not yet live-verified).
// ════════════════════════════════════════════════════════════════════════════
import fs from 'fs';
import { writeJsonAtomic } from '../utils/atomicJson';
import { dataDir } from '../utils/paths';
import { logger } from '../utils/logger';

export interface JobParamField {
  key: string; label: string;
  /** 'multiline' renders as a real textarea (paste one-per-line lists without guessing). */
  type: 'text' | 'multiline' | 'number' | 'money' | 'select' | 'checkbox';
  required?: boolean; min?: number; max?: number;
  options?: { value: string; label: string }[]; help?: string;
}
export type BatchSource =
  | { kind: 'delegating'; readStatus: () => unknown; cancel?: () => void }
  | { kind: 'internal' };
export interface BatchAdapterCtx {
  usernames: string[]; params: Record<string, unknown>; game: 'cs2' | 'tf2';
  /** Run a serial (concurrency 1) per-account loop the engine tracks; call this for jobs whose service
   *  exposes a per-account method but no fleet job. `perAccount` throwing is recorded in failed[], loop continues.
   *
   *  A value RETURNED by `perAccount` is appended to `status().result.rows` as it happens (W4_41). done/failed
   *  counts cannot express a money job's real outcomes — "already owned", "wallet too low" and "bought" are all
   *  non-failures that mean very different things — so a job that has more to say says it here. Returning
   *  `undefined` (every pre-existing job) leaves `result` unset, so nothing changes for them. */
  runInternal(perAccount: (username: string, index: number) => Promise<unknown>): void;
}
export interface JobDef {
  jobType: string; label: string;
  group: 'read' | 'money' | 'manage';
  moneySafe: boolean;
  enabled: boolean;
  experimental: boolean;      // wired but not yet live-verified → TEST warning in the UI
  paramSchema: JobParamField[];
  adapter(ctx: BatchAdapterCtx): Promise<{ source: BatchSource }>;
}

export interface BatchStatus {
  running: boolean; cancelling: boolean;
  jobType: string | null; label: string | null;
  total: number; done: number;
  failed: { username: string; error: string }[];
  startedAt: number | null; finishedAt: number | null;
  result?: unknown;
}
export interface BatchHistoryEntry {
  id: string; jobType: string; label: string;
  scopeCount: number; params: Record<string, unknown>;
  startedAt: number; finishedAt: number | null;
  total: number; done: number; failedCount: number;
  outcome: 'ok' | 'partial' | 'error' | 'cancelled';
}
export interface BatchScope { environmentIds?: unknown; folderIds?: unknown; usernames?: unknown }
export interface BatchRunReq { jobType: string; scope?: BatchScope; params?: Record<string, unknown>; game?: 'cs2' | 'tf2' }
export interface BatchAccounts { get(u: string): { username: string; enabled: boolean } | undefined; getByEnvironment(id: string): Array<{ username: string; enabled: boolean }> }

function httpErr(status: number, message: string): Error & { status: number } { return Object.assign(new Error(message), { status }); }
const HISTORY_FILE = dataDir('batch-jobs.json');
const HISTORY_CAP = 200;
const SECRET_KEYS = new Set(['code', 'codes', 'password', 'secret', 'pin']);

function normStatus(raw: Record<string, unknown>): { running: boolean; cancelling: boolean; total: number; done: number; failed: { username: string; error: string }[]; result: unknown } {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const fRaw = raw?.failed;
  const failed = Array.isArray(fRaw) ? fRaw.map((f) => {
    if (typeof f === 'string') return { username: f, error: 'failed' };
    const o = (f ?? {}) as Record<string, unknown>;
    return { username: String(o.username ?? o.user ?? o.source ?? ''), error: String(o.error ?? o.message ?? 'failed') };
  }) : [];
  return { running: raw?.running === true, cancelling: raw?.cancelling === true, total: num(raw?.total), done: num(raw?.done), failed, result: raw?.result ?? raw };
}

export function resolveScope(scope: BatchScope | undefined, accounts: BatchAccounts): string[] {
  const set = new Set<string>();
  if (scope) {
    if (Array.isArray(scope.usernames)) for (const u of scope.usernames) if (typeof u === 'string' && accounts.get(u)) set.add(u);
    if (Array.isArray(scope.environmentIds)) for (const id of scope.environmentIds) if (typeof id === 'string') for (const a of accounts.getByEnvironment(id)) if (a.enabled) set.add(a.username);
  }
  return [...set];
}
export function validateParams(schema: JobParamField[], params: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of schema) {
    const v = params?.[f.key];
    if (f.required && (v === undefined || v === null || v === '')) throw httpErr(400, `Missing required param "${f.label ?? f.key}"`);
    if (v !== undefined) out[f.key] = v;
  }
  return out;
}

export class JobRegistry {
  private defs = new Map<string, JobDef>();
  add(def: JobDef): this { this.defs.set(def.jobType, def); return this; }
  get(jobType: string): JobDef | undefined { return this.defs.get(jobType); }
  list(): JobDef[] { return [...this.defs.values()]; }
}

export class BatchJobService {
  private live: BatchStatus = idle();
  private source: BatchSource | null = null;
  private active: BatchHistoryEntry | null = null;
  private hist: BatchHistoryEntry[] = [];
  private seq = 0;

  constructor(private accounts: BatchAccounts, private registry: JobRegistry) { this.load(); }

  registryView() {
    return this.registry.list().map((d) => ({ jobType: d.jobType, label: d.label, group: d.group, moneySafe: d.moneySafe, enabled: d.enabled, experimental: d.experimental, paramSchema: d.paramSchema }));
  }

  async run(req: BatchRunReq): Promise<BatchStatus> {
    const def = this.registry.get(req.jobType);
    if (!def) throw httpErr(400, `Unknown jobType "${req.jobType}"`);
    if (!def.enabled) throw httpErr(400, `"${def.label}" is not available yet`);
    if (this.live.running) throw httpErr(409, 'A batch job is already running');
    const usernames = resolveScope(req.scope, this.accounts);
    if (!usernames.length) throw httpErr(400, 'Scope resolved to zero known accounts');
    const params = validateParams(def.paramSchema, req.params);
    const game: 'cs2' | 'tf2' = req.game === 'tf2' ? 'tf2' : 'cs2';

    this.begin(def, usernames.length, params);
    this.live = { running: true, cancelling: false, jobType: def.jobType, label: def.label, total: usernames.length, done: 0, failed: [], startedAt: this.active!.startedAt, finishedAt: null };
    try {
      const { source } = await def.adapter({ usernames, params, game, runInternal: (fn) => this.startInternal(usernames, fn) });
      this.source = source;
      return this.status();
    } catch (e) {
      // A delegated service refused (e.g. "already running") → finalize error + surface a clean 409.
      this.finalize('error');
      throw (e as { status?: number }).status ? (e as Error) : httpErr(409, (e as Error).message);
    }
  }

  status(): BatchStatus {
    if (!this.source || !this.live.running) return this.live;
    if (this.source.kind === 'delegating') {
      const s = normStatus(this.source.readStatus() as Record<string, unknown>);
      this.live = { ...this.live, running: s.running, cancelling: s.cancelling || this.live.cancelling, total: s.total || this.live.total, done: s.done, failed: s.failed, result: s.result };
      if (!s.running) { this.live.finishedAt = Date.now(); this.finalize(this.live.cancelling ? 'cancelled' : (s.failed.length ? (s.done > s.failed.length ? 'partial' : 'error') : 'ok')); }
    }
    // internal: startInternal updates this.live directly → just return it.
    return this.live;
  }

  cancel(): BatchStatus {
    if (this.live.running) {
      this.live.cancelling = true;
      if (this.source?.kind === 'delegating') { try { this.source.cancel?.(); } catch { /* best-effort */ } }
    }
    return this.status();
  }

  history(): BatchHistoryEntry[] { return [...this.hist].reverse(); }

  // ── internals ──
  private startInternal(usernames: string[], perAccount: (u: string, i: number) => Promise<unknown>): void {
    this.source = { kind: 'internal' };
    const rows: unknown[] = [];
    void (async () => {
      for (let i = 0; i < usernames.length; i++) {
        if (this.live.cancelling) break;                     // co-operative cancel (in-flight op finishes)
        try {
          const row = await perAccount(usernames[i], i);
          // Published as it happens, not at the end: on a money job the operator must be able to watch
          // the outcomes land, and a run that is cancelled (or crashes) still shows what it already did.
          if (row !== undefined) { rows.push(row); this.live.result = { rows }; }
        }
        catch (e) { this.live.failed.push({ username: usernames[i], error: (e as Error).message }); }   // no-band-aid: record + continue
        this.live.done++;
      }
      this.live.finishedAt = Date.now();
      this.finalize(this.live.cancelling ? 'cancelled' : (this.live.failed.length ? (this.live.done > this.live.failed.length ? 'partial' : 'error') : 'ok'));
    })();
  }
  private begin(def: JobDef, scopeCount: number, params: Record<string, unknown>): void {
    this.active = { id: `b${Date.now()}-${++this.seq}`, jobType: def.jobType, label: def.label, scopeCount, params: redactParams(params), startedAt: Date.now(), finishedAt: null, total: scopeCount, done: 0, failedCount: 0, outcome: 'ok' };
  }
  private finalize(outcome: BatchHistoryEntry['outcome']): void {
    this.live.running = false;
    if (this.active) {
      this.active.finishedAt = this.live.finishedAt ?? Date.now();
      this.active.total = this.live.total; this.active.done = this.live.done; this.active.failedCount = this.live.failed.length; this.active.outcome = outcome;
      this.hist.push(this.active);
      if (this.hist.length > HISTORY_CAP) this.hist = this.hist.slice(-HISTORY_CAP);
      this.save();
      this.active = null;
    }
    this.source = null;
  }
  private load(): void {
    try {
      if (!fs.existsSync(HISTORY_FILE)) return;
      const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) as { entries?: BatchHistoryEntry[] } | null;
      if (parsed && Array.isArray(parsed.entries)) this.hist = parsed.entries.slice(-HISTORY_CAP);
    } catch { /* a corrupt/locked history is a lost log, never a hazard — start empty */ }
  }
  private save(): void {
    try { writeJsonAtomic(HISTORY_FILE, { version: 1, entries: this.hist }, { spaces: 0 }); }
    catch (e) { logger.warn(`[batch] history write failed: ${(e as Error).message}`); }
  }
}

function idle(): BatchStatus { return { running: false, cancelling: false, jobType: null, label: null, total: 0, done: 0, failed: [], startedAt: null, finishedAt: null }; }
function redactParams(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) out[k] = SECRET_KEYS.has(k) ? (Array.isArray(v) ? `«${v.length} redacted»` : '«redacted»') : v;
  return out;
}
