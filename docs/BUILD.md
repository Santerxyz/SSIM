# Building SSIM

For contributors and maintainers. If you just want to *use* SSIM, download
`SSIM.exe` from the releases page. You do not need any of this.

For how the code is organised, see [ARCHITECTURE.md](../ARCHITECTURE.md).
For cutting a release, see [RELEASING.md](RELEASING.md).

## Requirements

- **Node ≥ 24** (see `.nvmrc`)
- **Rust toolchain**, only for the desktop shell. `rustup default stable` if
  `rustup` reports no toolchains.

**No secrets, keys, or config files are required.** If a build ever asks you for
one, that is a bug worth reporting, it locks contributors out.

## Commands

```bash
npm install
npm run build          # tsc → dist/
npm test               # the full suite
npm run dev            # run the backend from source (ts-node)
```

Artifacts:

```bash
npm run build:protected   # backend only → ssim.exe (bytecode-packed via @yao-pkg/pkg)
npm run build:tauri       # the shippable single file → release-tauri/SSIM/SSIM.exe
```

`build:tauri` runs `build:protected` internally, embeds the resulting backend in
the Rust shell, and self-tests the finished exe (extract → boot → load every
dependency) before declaring success.

The first Tauri build after a clean `src-tauri/target/` compiles the whole Rust
dependency tree and takes several minutes. Later builds are fast.

**Build alone.** `@yao-pkg/pkg` has been observed hanging when several heavy Node
processes run concurrently. If packaging stalls for minutes at "packaging
single-file exe", kill it, let the machine settle, and retry.

## Repository layout

| Path | What it is |
|---|---|
| `src/` | Node backend (TypeScript), the actual application |
| `src-tauri/` | Tauri desktop shell (Rust); native window + backend supervision |
| `public/` | Dashboard frontend (HTML/CSS/JS), bundled *inside* the backend exe at build time |
| `build/` | Build scripts, `pack.js` (backend→exe), `make-tauri.js` (single-file app), `make-ico.js` (icons), `sign-update.js` (release manifest), `preview-static.js` (serve `public/` without a backend) |
| `test/` | The test suite |
| `stress/` | Load harnesses with the Steam libraries mocked |
| `docs/` | Build, release and architecture documentation |
| `dist/` | Compiled backend JS, generated, gitignored |

**Never commit:** `Vault/` (encrypted credentials), `data/`, `logs/`, `mafiles/`,
`*.exe`, `release*/`, `src-tauri/target/`. All are gitignored. Check your diffs
anyway.

## Running from source

`npm run dev` runs the backend directly. `start.bat` does the same from compiled
`dist/` with a memory ceiling set, which is closer to how the shipped build
behaves.

Either way the app creates `data/`, `Vault/`, `logs/` and `mafiles/` in the
working directory and asks for a vault master password on first run. Use a
throwaway directory and throwaway accounts. See the Steam-testing notes in
[CONTRIBUTING.md](../CONTRIBUTING.md).

To work on the frontend without a backend, `node build/preview-static.js 8123`
serves `public/` as static files. The dashboard renders but stays empty, since
every API call fails.

## Crash diagnostics

Written to `logs/`, next to the exe:

| File | What it tells you |
|---|---|
| `shell.log` | Backend exit code/signal plus dying stderr, recorded by the shell, catches external kills |
| `exit-trace.log` | Present after a death ⇒ the backend exited *itself*, and the code names which path. **Absent ⇒ an external `TerminateProcess`.** This is the discriminator for silent deaths. |
| `stderr-trace.log` | Raw backend stderr last-words that the logger could not flush |
| `mem-heartbeat.log` | RSS / heap / handle counts / live-session trajectory over time |
| `crash-log.txt` | JS-level uncaught throws and signals |
