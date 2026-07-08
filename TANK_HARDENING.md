# Proxy "tank" hardening — make SSIM absorb any proxy's reset storm (v1.4.0)

**Goal (owner):** the *software*, not the proxy provider, must be the tank. A flaky proxy
(veritasproxy et al.) that RST-storms must degrade *its* accounts gracefully — never drive the
process into the `0xC0000409` native fast-fail. Customers must not be forced onto specific "good"
providers.

## Root cause (multi-agent investigation, 16 agents)

The crash is a Node-core native abort (`STATUS_STACK_BUFFER_OVERRUN` / `__fastfail`) in the
TLSWrap-over-a-proxied-socket **teardown** path, tripped when hundreds of concurrent half-open TLS
handshakes are torn down at once during a full-fleet refresh through a storming proxy. It is below
the JS layer, so every JS/WER recorder is silent. **SSIM had no storm-awareness anywhere — it
*amplified* a bad proxy instead of absorbing it:**

- No per-proxy failure state: a storming proxy kept receiving 5×N lockstep fresh TLS handshakes.
- No timeout on the proxy CONNECT/TLS phase: a half-open connect hangs forever, pinning a worker
  slot and leaving the raw socket to pile up toward the ~115-resident danger point.
- Un-jittered synchronized retries → thundering-herd socket create/destroy churn on the bad proxy.
- `MAX_LIVE_SESSIONS=150` sat *above* the ~115 crash point, so the ceiling never engaged.
- The `AgentFactory` teardown-quiescence invariant is **inert for proxy agents** (agent-base@6 never
  populates `sockets`/`requests`; its `destroy()` is a no-op).

## Shipped this pass (money-safe core tank)

| # | Fix | File(s) | Effect |
|---|-----|---------|--------|
| 1 | **Per-proxy circuit breaker** (`ProxyHealth`) | `src/network/ProxyHealth.ts` (new, 10 unit tests) | A proxy that reset-storms trips OPEN; **bulk refresh defers** its accounts (surfaced, retryable) instead of hammering it. Half-open probe recovers it. |
| 2 | **Breaker wired into bulk refresh + login** | `SessionManager.ts`, `InventoryService.ts` | Login handshakes feed the breaker; the fleet-refresh worker consults it and **defers** storming-proxy accounts. **Money-safe: a deferred account is never dialed, so its cached inventory/balance is untouched (never coerced to empty/0) — it shows in the failed panel as retryable.** Only BULK paths consult; single-account/money ops never defer. |
| 3 | **Fail-fast proxy CONNECT/TLS timeout** | `AgentFactory.ts` | Agent-level (arms during CONNECT), ~13–17 s jittered. A stalled half-open CONNECT fails fast instead of hanging → slot frees, socket doesn't accumulate. |
| 4 | **Full-jitter backoff** | `SessionManager.ts`, `InventoryService.ts` | Login + transient-retry backoff jittered to [50%,100%] so a fleet doesn't retry in lockstep. (429 branch untouched — never drops below Steam's per-IP window.) |
| 5 | **Force `protocol: TCP`** | `SessionManager.ts` | Removes the wss-TLS-over-proxy CM path (`tls.connect({socket})`), a native-teardown primitive; raw-TCP CM uses Valve crypto (no TLSWrap over the proxy socket). |
| 6 | **Lower `MAX_LIVE_SESSIONS` 150→90** | `SessionManager.ts` | Caps the resident pile-up *under* the ~115 empirical crash point (was above it). |
| 7 | **stderr tee: held fd** | `bootflags.ts` | Keeps the synchronous death-capture (dying last-words) but replaces the per-line `open+write+close` with a persistent `O_APPEND` fd — removes the event-loop-stall amplifier under a spew storm. |

Tests: `test/proxyHealth.test.ts` (10). Full suite **1052 pass / 0 fail**; tsc clean.

## Deferred to Phase 2 (owner review — higher risk / bigger effort)

Verifiers said to pair these AFTER the core, and some need care:
- **AIMD adaptive concurrency** — reactive login/refresh concurrency driven by the breaker's
  `openCount()`. (The static lower ceiling + breaker already cut the peak; AIMD is the refinement.)
- **Poller pause during a fleet refresh + abort-aware `shutdown()`** — the ~107 TradeOfferManager
  pollers add parallel socket churn; pausing needs care not to miss offers.
- **`https-proxy-agent` 5→7 / `socks-proxy-agent` 6→8** (agent-base 7) — churn-reduction *hygiene*
  only; verified it does NOT close the Node-core teardown window (still `tls.connect` over a
  `net.Socket`), and it touches every construction site. Do after the churn work.
- **Process isolation** (child-process shard pool) — the only thing that truly *contains* a native
  abort, but a real re-architecture; legitimate only in surfaced form.
- **Node 22 vs 24 A/B** under a synthetic reset storm — tells an inherent Node-24 TLSWrap regression
  from our own churn.

## Confirmation still required

The exact faulting native frame is unproven. **Run `ARM_CRASH_DUMP.ps1` (as admin) and reproduce** —
the WER full-dump is the only instrument that names it and tells whether the class-level fixes above
brought the crash rate to zero. The tank reduces the churn that feeds the crash; the dump confirms.
