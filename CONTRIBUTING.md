# Contributing to SSIM

SSIM is 32,000 lines of TypeScript across 103 files. That sounds like a lot to walk
into, and most projects that size are genuinely hard to contribute to. This one
isn't, and the reason is that the map already exists — you don't have to reverse
engineer the architecture from scratch.

Everything here is genuinely welcome: bug reports, docs fixes, typo corrections,
tests, and code. You don't need permission to start.

## Start here

Read these three, in this order. It's about forty minutes and it will save you days:

| Read | What it gives you |
|---|---|
| **[PROJECT_MAP.md](PROJECT_MAP.md)** | The architecture: boot sequence, subsystems, trust/signing, `file:line` references to the code that matters, and the ranked risk list. |
| **[INVARIANTS.md](INVARIANTS.md)** | **The things that must never break.** This is money-handling code operating on live accounts. Read this before changing anything in trading, market, or vault paths. |
| **[FEATURES.md](FEATURES.md)** | The complete feature inventory, each entry citing where it lives. |

Then: **308 test files** in [`test/`](test/). They are your safety net and the best
documentation of intended behaviour in the repo. If you're not sure what something
is supposed to do, there is very likely a test that says.

## Build it

You need **Node ≥24** and the **Rust toolchain** (for the Tauri desktop shell).

```bash
npm install
npm run build          # typecheck + compile backend to dist/
npm test               # run the full test suite
npm run dev            # run the backend from source
```

For the full desktop executable:

```bash
npm run build:tauri    # -> release-tauri/SSIM/SSIM.exe
```

**No secrets, keys, or config files are required to build.** If you hit a build
error asking for a licence key, pepper, or `secrets.local.bat`, that's a bug in
our build — please open an issue, because it means we broke the contributor path.

If `rustup` reports "no toolchains", point `RUSTUP_HOME` / `CARGO_HOME` at your
rustup install. The first Tauri build after a clean `src-tauri/target/` is a
one-time full compile and takes a while.

More detail in [docs/BUILD.md](docs/BUILD.md).

## Good first issues

Issues labelled [`good first issue`](../../issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
are small, scoped, and described well enough to act on without asking. If one is
unclaimed, it's yours — comment on it so nobody duplicates your work.

If something there is underspecified, say so. That's a docs bug and worth fixing.

## Working on it

**Before you start something large, open an issue.** Not for permission — so you
don't spend a weekend on something that conflicts with work already in flight.

A few things specific to this codebase:

- **Tests are not optional for behaviour changes.** Look at how neighbouring tests
  are written and match them.
- **Match the surrounding style.** The codebase has consistent conventions for
  comments, naming, and error handling. Fit in rather than importing your own.
- **Comment the *why*, not the *what*.** Much of this code looks strange because
  Steam is strange. When you work out why something has to be done a particular
  way, write it down — that comment is worth more than the code.
- **Be careful in money paths.** Buy, sell, trade, craft, and casket-move code
  operates on real inventories and real balances. `INVARIANTS.md` exists because
  each of those rules was learned expensively.
- **No band-aids.** Fix causes, not symptoms. A retry wrapper or an auto-restart
  that hides a failure will be sent back — if something fails, we want to know why.

## Pull requests

1. Branch from `main`.
2. Keep it focused. One logical change per PR — a 40-line PR gets reviewed today,
   a 2,000-line PR gets reviewed eventually.
3. `npm test` passes.
4. Explain **why** in the description, not just what. Link the issue if there is one.
5. Note anything you couldn't test — especially live-Steam behaviour. Nobody can
   test everything here, and saying so honestly is expected, not a weakness.

Review is best-effort and may be slow. That's a bandwidth problem, not a judgement
on your work — see [Project status](README.md#project-status). Ping the PR if it's
gone quiet for a couple of weeks.

## Testing against Steam

Much of SSIM can only be truly exercised against live Steam accounts, which
creates a real risk of losing items or getting rate-limited.

- **Use throwaway accounts** with nothing valuable on them.
- **Never commit credentials, `maFile`s, cookies, or tokens.** `Vault/`, `data/`,
  `mafiles/`, and `logs/` are gitignored — keep it that way, and check your
  diffs before pushing.
- **Scrub logs before attaching them** to an issue. They can contain account names,
  Steam IDs, and session identifiers.
- The [`stress/`](stress/) harnesses mock the Steam libraries and let you exercise
  load paths without touching a real account.

## Reporting bugs

Open an issue with: what you did, what you expected, what happened, your SSIM
version, and the relevant bit of `logs/` — **scrubbed**. The crash-diagnostics
table in [docs/BUILD.md](docs/BUILD.md) explains what each log file tells you.

For **security** issues, don't use the public tracker — see [SECURITY.md](SECURITY.md).

## Becoming a maintainer

This is a real, open offer, not boilerplate.

SSIM is maintained best-effort by one person, and the project's long-term survival
depends on that changing. If you've contributed a few times and want to help carry
it, say so — commit rights and a path into the release-signing process are on the
table. What matters is showing up consistently, not being the strongest programmer
in the room.

## Licence

Contributions are licensed under the [Apache License 2.0](LICENSE), same as the
project. By opening a pull request you agree your contribution ships under it.
There is no CLA.

Note that the Apache licence covers the **code**, not the SSIM name and logo — see
[TRADEMARK.md](TRADEMARK.md). Forking is welcome; forks just need their own name.
