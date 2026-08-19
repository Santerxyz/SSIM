# Architecture

Read this before changing anything. It explains how the pieces fit and, more
usefully, *why* several of them look the way they do. Most of the odd-looking
decisions in this codebase exist because Steam behaved unexpectedly at scale.

Companion documents: [FEATURES.md](FEATURES.md) maps every feature to a
`file:line`; [INVARIANTS.md](INVARIANTS.md) lists the rules that must not break.

## The shape of the thing

SSIM ships as **one file**, `SSIM.exe` (~145 MB):

```
SSIM.exe
├── Tauri shell (Rust, src-tauri/)        native window, owns the process tree
└── Node backend (embedded)               the actual application
```

On launch the shell extracts the backend to `runtime\`, spawns it as a hidden
child, and passes its own path as `SSIM_SHELL_EXE` (the updater needs to know
which file to replace). The backend binds an HTTP server on `127.0.0.1` and the
shell displays it in a WebView.

So the "web app" and the "desktop app" are the same program. There is no server
of ours anywhere in the picture. The dashboard is served from localhost, and the
only outbound traffic is to Steam, to CSFloat if enabled, and to GitHub for
update checks.

**Data lives next to the exe**, not in `%APPDATA%`: `data/`, `Vault/`, `logs/`,
`mafiles/`. The install is portable: copy the folder, keep the fleet.

## Boot sequence

`src/index.ts` is the entry point and the order matters:

```
single-instance lock   data/ssim.lock, atomic O_EXCL create
      ↓
vault dir migration    move legacy files under Vault/ before anything reads them
      ↓
auto-update check      packaged builds only; may swap the exe and relaunch
      ↓
vault unlock           master password → scrypt → AES-256-GCM key
      ↓
startFullApp()         build services, bind the port, open the window
      ↓
update scheduler       6-hourly check; only swaps when no money op is in flight
```

Two rules that are load-bearing:

- **Nothing that touches credentials is constructed before the vault is
  unlocked.** The unlock portal serves a single page and 403/423s every `/api/*`
  route until it succeeds.
- **A failed port bind returns `false` rather than throwing**, so the caller stops
  before arming background services against a server that never listened.

There is no licence check, no activation, no machine fingerprint, and no
heartbeat. Those existed until the Apache-2.0 relicensing and were removed
wholesale.

## Subsystems

`src/` is ~31,000 lines of TypeScript across 99 files:

| Directory | Responsibility |
|---|---|
| `api/` | The Express app (`server.ts`, ~3.6k lines): every HTTP route, capability tokens, the money-op breaker middleware |
| `core/` | Accounts, sessions, the encrypted vault, inventory stores, process health, single-instance lock |
| `trading/` | Trades, market buy/sell, trade-up contracts, storage units (caskets), the CS2 game-coordinator layer |
| `pricing/` | Price sources (Steam, CSFloat), the price cache, FX rates, per-wallet-currency pricing |
| `csfloat/` | CSFloat client, listing sync, the auto-accept worker |
| `network/` | Per-account HTTP agents, proxy handling, the proxy circuit breaker |
| `store/` | Persistence primitives (atomic JSON writes) |
| `update/` | The signed auto-updater and its scheduler |
| `utils/` | Logging, crash diagnostics, paths, port selection, quiescence |

The frontend is a single page: `public/index.html` + `public/app.js` (~11k
lines), plain JS, no build step. It is bundled *inside* the backend exe at build
time rather than shipped loose.

## Updates and trust

The updater ([`src/update/Updater.ts`](src/update/Updater.ts), ~1k lines) is the
one place SSIM will replace its own executable, so it is deliberately paranoid:

1. Fetch a small signed JSON manifest
2. Compare versions numerically (a pre-release tag reads as "not newer")
3. Download resumably. A dropped connection resumes with a Range request rather
   than restarting a 145 MB transfer
4. Verify SHA-256 **and** an Ed25519 signature against the public key compiled
   into the binary
5. Run the new exe in an isolated temp home with `SSIM_SELFTEST=1` and require it
   to report success
6. Only then swap and relaunch

Being open source is not a reason to weaken any of that. The threat is a
substituted binary, and the source being readable does not help there.

## Testing

293 test files under `test/`. They are the best documentation of intended
behaviour in the repo. When a comment and a test disagree, trust the test.

Several are *source scans* rather than behavioural tests: they read `src/` as
text and assert structural properties (for example, that timer owners route
through `armInterval` instead of raw `setInterval`). If one fails after a
refactor, it is usually telling you a real invariant moved, not that the test is
stale. Check before editing it.

`stress/` holds load harnesses with the Steam libraries mocked, for exercising
throughput paths without touching a live account.

## Where to start reading

`src/index.ts` for the boot sequence, then `src/api/server.ts` for the routes,
then whichever subsystem your change touches. `INVARIANTS.md` before touching
anything under `trading/`.
