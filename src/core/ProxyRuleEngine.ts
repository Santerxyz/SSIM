// ─── ProxyRuleEngine ──────────────────────────────────────────────────────────
//
// The pure, deterministic core of the Proxy-Rules module. Given an account, the rule set, and the
// folder tree, it resolves the account's effective network by MOST-SPECIFIC-WINS precedence:
//
//   account (tier 3)  ▸  folder (tier 2, deeper folder wins)  ▸  environment (tier 1)  ▸  global (tier 0)
//
// then, within the winning rule, picks a proxy from the pool — either STABLE per account
// (rendezvous/HRW, when pinPerAccount) or a NEW proxy each login (round-robin cursor).
//
// Everything here is a PURE function of its inputs (rules, folders, and an injected cursor Map) —
// no Date.now / Math.random / vault / disk — so it is unit-testable with tsx and safe to re-run.
// AccountManager.resolveOutcome/networkForLogin delegate here once proxyRulesAuthoritative is set
// (the public AccountManager.legacyResolveNetwork is ONLY the pre-cutover legacy chain).

import type { AccountConfig, Folder, NetworkConfig, ProxyRule, ProxyScope } from '../types/account';
import { parseProxy, normalizeProxy } from '../network/AgentFactory';

const LOCAL_IP: NetworkConfig = { type: 'localip', value: '0.0.0.0' };

/** FNV-1a 32-bit, unsigned. Deterministic (no Date.now/Math.random) → reproducible in tests. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // 32-bit FNV prime, overflow-safe multiply
  }
  return h >>> 0;
}

/** Minimal folder lookup the engine needs (AccountManager passes `{ get: id => this.getFolder(id) }`). */
export interface FolderLookup {
  get(id: string): Folder | undefined;
}

export interface ResolveCtx {
  rules:   ProxyRule[];
  folders: FolderLookup;
  /** When true, a rotation (non-pinned) pick ADVANCES the account's cursor — call exactly once per
   *  login. Reads/display pass false (a pure PEEK that returns the CURRENT/last-used exit and never
   *  writes the cursor). */
  atLogin: boolean;
  /** usernameLower → rotation counter (the LAST-USED pool index). Seeded lazily to fnv1a(username)
   *  so first logins spread across the pool instead of stampeding proxy #0. Written only when atLogin. */
  cursor:  Map<string, number>;
  /** Optional precomputed per-rule valid pool (T3) — built once per resolution sweep to avoid
   *  re-running validPool for every account. Falls back to validPool(rule.proxies) when absent. */
  validPools?: Map<string, string[]>;
  /** Optional precomputed per-rule target Set (T3) — built once per sweep to avoid targets.includes
   *  per account. Falls back to rule.targets when absent. */
  targetSets?: Map<string, Set<string>>;
}

export type ResolveOutcome =
  | { kind: 'network'; network: NetworkConfig }
  /** The most-specific matched pool rule has an EMPTY valid pool — a hydration/vault failure (F2/F7
   *  make an empty pool unrepresentable via the API). The caller MUST refuse the login rather than
   *  fall through to a broader rule or the host IP. */
  | { kind: 'pool-lost'; ruleId: string };

/**
 * Ordered ancestor folder chain for an account: [own folder, parent, …, rootmost], each with its
 * depth (rootmost = 1, own folder = chain length; deeper = more specific). Empty when the account
 * sits at the environment root (folderId null), or when its folderId dangles / points at a folder
 * in ANOTHER environment (coerced to root — byte-for-byte AccountManager.accountsInFolder). Every
 * hop stays inside the account's own environment; a cycle is bounded by a seen-set.
 */
export function ancestorChain(account: AccountConfig, folders: FolderLookup): Array<{ id: string; depth: number }> {
  const startId = account.folderId ?? null;
  if (startId == null) return [];
  const start = folders.get(startId);
  if (!start || start.environmentId !== account.environmentId) return []; // dangling / foreign env → root
  const ids: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = startId;
  while (cur != null) {
    if (seen.has(cur)) break;                 // pre-existing cycle → bounded, deterministic stop
    seen.add(cur);
    const f = folders.get(cur);
    if (!f || f.environmentId !== account.environmentId) break; // never cross an environment boundary
    ids.push(cur);
    cur = f.parentId ?? null;
  }
  // ids: own → root. depth(ids[i]) = ids.length - i  →  own folder deepest, rootmost = 1.
  return ids.map((id, i) => ({ id, depth: ids.length - i }));
}

/** parseProxy-valid, normalized, deduped pool. Drops garbage (a typo would otherwise become a dead
 *  `http://<garbage>` agent that pins the account to a non-connecting proxy with no fall-through). */
export function validPool(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of raw) {
    if (!parseProxy(p)) continue;             // unparseable / IPv6-literal / garbage → drop
    const norm = normalizeProxy(p);           // canonical, idempotent, single-encoded
    const key = norm.toLowerCase();           // fold host-case variants so they don't split the pool
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

/** Stable per-account pick: highest-random-weight (rendezvous) proxy. Adding/removing a pool member
 *  moves only ~1/N accounts, not everyone. Tie-broken by value for determinism. */
function hrwPick(usernameLower: string, pool: string[]): string {
  let best = pool[0];
  let bestH = fnv1a(usernameLower + '@' + pool[0]);
  for (let i = 1; i < pool.length; i++) {
    const h = fnv1a(usernameLower + '@' + pool[i]);
    if (h > bestH || (h === bestH && pool[i] < best)) { bestH = h; best = pool[i]; }
  }
  return best;
}

/** Rotation pick. The cursor stores the LAST-USED pool index. A login ADVANCES-then-picks (stores &
 *  returns the new index); a peek returns the stored index WITHOUT writing — so a peek reports the
 *  SAME exit the last login used (not the next one), and CSFloat/open-browser/preview never split
 *  egress from the live Steam session (F4). Seeded by fnv1a(username). */
function rotatePick(usernameLower: string, pool: string[], ctx: ResolveCtx): string {
  if (ctx.atLogin) {
    const cur = (((ctx.cursor.get(usernameLower) ?? fnv1a(usernameLower)) + 1) >>> 0);
    ctx.cursor.set(usernameLower, cur);
    return pool[cur % pool.length];
  }
  const cur = ctx.cursor.get(usernameLower) ?? fnv1a(usernameLower); // peek: last-used, no write
  return pool[cur % pool.length];
}

interface Candidate { rule: ProxyRule; tier: number; depth: number }

/** Matching enabled rules for an account, most-specific first: tier ▸ folderDepth ▸ priority (lower
 *  rank wins) ▸ id (stable — a same-millisecond createdAt must never decide the exit IP by iteration
 *  order). Shared by resolveViaRules and resolveExplain so they can never diverge. */
function rankedCandidates(account: AccountConfig, ctx: ResolveCtx): Candidate[] {
  const chain = ancestorChain(account, ctx.folders);
  const uname = account.username.toLowerCase();
  const cands: Candidate[] = [];
  for (const rule of ctx.rules) {
    if (!rule.enabled) continue;
    const tset = ctx.targetSets?.get(rule.id);
    const has = (v: string): boolean => tset ? tset.has(v) : rule.targets.includes(v);
    let tier = -1;
    let depth = 0;
    switch (rule.scope) {
      case 'global':
        tier = 0;
        break;
      case 'environment':
        if (has(account.environmentId)) tier = 1;
        break;
      case 'folder': {
        let deepest = 0;
        for (const c of chain) if (has(c.id) && c.depth > deepest) deepest = c.depth; // deepest targeted folder
        if (deepest > 0) { tier = 2; depth = deepest; }
        break;
      }
      case 'account':
        if (has(uname)) tier = 3;
        break;
    }
    if (tier >= 0) cands.push({ rule, tier, depth });
  }
  cands.sort((a, b) =>
    b.tier - a.tier
    || b.depth - a.depth
    || a.rule.priority - b.rule.priority
    || (a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0));
  return cands;
}

/** Pick a proxy from a MATCHED rule's pool, or signal pool-lost. A matched `kind:'pool'` rule whose
 *  valid pool is empty returns 'pool-lost' — F2/F7 make an empty pool unrepresentable via the API, so
 *  at resolve time an empty pool can ONLY be a hydration/vault failure: refuse (never fall open). */
function pickFromRule(rule: ProxyRule, uname: string, ctx: ResolveCtx): NetworkConfig | 'pool-lost' {
  if (rule.kind === 'local') return LOCAL_IP;
  const pool = ctx.validPools?.get(rule.id) ?? validPool(rule.proxies);
  if (pool.length === 0) return 'pool-lost';
  return { type: 'proxy', value: rule.pinPerAccount ? hrwPick(uname, pool) : rotatePick(uname, pool, ctx) };
}

/**
 * Resolve an account's effective network via the rule set. ALWAYS returns an outcome (never throws).
 * The MOST-SPECIFIC matched rule DECIDES — there is NO fall-through: a matched pool rule with a lost
 * pool refuses (`pool-lost`), it does NOT silently drop to a broader rule or the host IP. Only when
 * NO rule matches at all does it fall to LOCAL_IP (today's default for unproxied accounts).
 */
export function resolveViaRules(account: AccountConfig, ctx: ResolveCtx): ResolveOutcome {
  const ranked = rankedCandidates(account, ctx);
  if (ranked.length === 0) return { kind: 'network', network: LOCAL_IP };
  const rule = ranked[0].rule; // most-specific match — no fall-through
  const pick = pickFromRule(rule, account.username.toLowerCase(), ctx);
  return pick === 'pool-lost' ? { kind: 'pool-lost', ruleId: rule.id } : { kind: 'network', network: pick };
}

export interface ResolveExplain {
  network: NetworkConfig | null;   // null only when poolLost
  ruleId: string | null;           // the winning rule (null when no rule matched → default local IP)
  scope: ProxyScope | null;
  poolLost: boolean;
  /** Rules at the SAME (tier, folderDepth) as the winner — an ambiguous overlap resolved only by
   *  priority/id. Surfaced so the operator can spot conflicting rules. */
  overlaps: string[];
}

/** Like resolveViaRules, but reports WHICH rule won + any same-specificity overlaps — for the
 *  "who gets what" resolution preview. Never advances the rotation cursor (peek only). */
export function resolveExplain(account: AccountConfig, ctx: ResolveCtx): ResolveExplain {
  const peekCtx: ResolveCtx = { ...ctx, atLogin: false };
  const ranked = rankedCandidates(account, peekCtx);
  if (ranked.length === 0) return { network: LOCAL_IP, ruleId: null, scope: null, poolLost: false, overlaps: [] };
  const cand = ranked[0]; // most-specific match — no fall-through (mirrors resolveViaRules)
  const overlaps = ranked
    .filter(c => c.rule.id !== cand.rule.id && c.tier === cand.tier && c.depth === cand.depth)
    .map(c => c.rule.id);
  const pick = pickFromRule(cand.rule, account.username.toLowerCase(), peekCtx);
  if (pick === 'pool-lost') return { network: null, ruleId: cand.rule.id, scope: cand.rule.scope, poolLost: true, overlaps };
  return { network: pick, ruleId: cand.rule.id, scope: cand.rule.scope, poolLost: false, overlaps };
}
