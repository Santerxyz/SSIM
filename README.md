<div align="center">

<img src="docs/img/logo.png" alt="SSIM" width="88">

# SSIM

**Run a large Steam trading fleet from one dashboard.**

Inventories, trade locks, trading, and the Steam Market for every account in one
place. Everything runs on your own PC. Your passwords and 2FA secrets never
leave it.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)](#requirements)
[![Tests](https://img.shields.io/badge/tests-293%20files-green.svg)](test/)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2.svg?logo=discord&logoColor=white)](https://discord.gg/rnDWYtkbxN)

[Download](#install) · [How it works](#how-it-works) · [Security](#security) · [Discord](https://discord.gg/rnDWYtkbxN) · [Contributing](CONTRIBUTING.md)

</div>

> [!IMPORTANT]
> **Download SSIM only from the [Releases page](https://github.com/Santerxyz/SSIM/releases/latest).**
> SSIM handles Steam passwords and 2FA secrets, so a copy from a forum, a Discord
> message, or any site advertising an "unlocked" build is not worth the risk.
> Every release includes a `SHA256SUMS` file so you can confirm the file you have
> is the file we published.

## What it is

SSIM is a Windows desktop application for people who run many Steam accounts and
are tired of signing into them one at a time. It brings every account's
inventory, wallet, trade locks, listings, and open orders into a single
dashboard, and lets you act on all of them together.

It runs a production fleet of roughly 544 accounts, and it is built for that
scale rather than adapted to it.

## Features

**Accounts and inventory**

* Every account's CS2 inventory in one view, with trade-lock state per item
* Storage units, folders, and environments for organising a large fleet
* Bulk import, an encrypted credential vault, and per-account proxy support

**Trading**

* Mass trade sending across accounts, with balances and locks checked up front
* One screen for every incoming and outgoing offer, each side priced
* Batch accept, decline, and cancel
* Trade-up contracts

**Market**

* Buy orders placed and confirmed from the dashboard
* Sell at the lowest price, an undercut, or a fixed net payout, with the payout
  shown before anything goes live
* Order tracking and bulk cancellation across the fleet
* Prices in each account's own wallet currency

**Operations**

* Portfolio value and history across the whole fleet
* CSFloat integration for pricing and listings
* Diagnostics that report why something failed, not just that it did

A complete inventory with file references is in [FEATURES.md](FEATURES.md).

## Install

1. Download `SSIM.exe` from the [Releases page](https://github.com/Santerxyz/SSIM/releases/latest).
2. Check the hash against `SHA256SUMS`. See [below](#verify-your-download).
3. Put it in its own folder. It creates `data`, `Vault`, `logs`, and `mafiles`
   beside itself, so avoid running it from your Downloads folder.
4. Open it.

On first launch SSIM asks you to set a master password, which encrypts your
credential vault. There is no recovery for it. Keep it somewhere safe.

### Verify your download

In PowerShell:

```powershell
Get-FileHash .\SSIM.exe -Algorithm SHA256
```

Compare the result with `SHA256SUMS` from the same release. If they differ, do
not run the file, and please let us know.

Releases are built by GitHub Actions and published with a provenance
attestation, so you can also confirm the binary came from this repository:

```bash
gh attestation verify SSIM.exe -R Santerxyz/SSIM
```

### Requirements

* Windows 10 or 11, 64-bit
* Around 500 MB of free disk space
* Steam accounts you control. Adding their 2FA secrets lets SSIM confirm trades
  and listings for you.

## How it works

SSIM is a single self-contained executable: a native window with its backend
built in. On launch it starts that backend and opens a dashboard served from
`localhost`. No server of ours is involved in day to day use.

SSIM talks to Steam through the same public web endpoints your browser uses.

## Security

**Your credentials stay on your machine.** Passwords and 2FA secrets are held in
an encrypted vault on your disk, using scrypt key derivation and AES-256-GCM
keyed from your master password. They are sent nowhere except to Steam itself, at
login, over TLS.

**No telemetry, no accounts, no phone home.** SSIM does not report usage or
require registration, and it contacts no server operated by this project during
normal use. Its only outbound connections are to Steam, to CSFloat if you enable
it, and to GitHub to check for updates.

**Updates are verified before they are applied.** The updater checks a SHA-256
hash and an Ed25519 signature before replacing the running program, and rejects
anything that does not match.

**The vault's security does not depend on the code being secret.** The
encryption is standard and reviewable, and its strength comes from your
password. That is why publishing the source costs you nothing.

**You can read the code.** 31,000 lines of TypeScript across 99 files, with an
[architecture overview](ARCHITECTURE.md), [documented invariants](INVARIANTS.md),
and 293 test files. `src/index.ts` is the place to start.

Found a vulnerability? Please report it privately. See [SECURITY.md](SECURITY.md).

## Before you start

SSIM automates actions on Steam accounts, and Steam's Subscriber Agreement
restricts automated access. Use it on accounts you own and decide for yourself
whether that trade-off suits you.

The software is provided as is, without warranty of any kind, under the
[Apache License 2.0](LICENSE). SSIM is an independent project and is not
affiliated with or endorsed by Valve Corporation.

## Contributing

Contributions are welcome, and the codebase is more approachable than its size
suggests. [CONTRIBUTING.md](CONTRIBUTING.md) points you at the architecture, the
invariants worth knowing before you touch trading code, and issues labelled
`good first issue`.

Building takes two commands and needs no keys or configuration. See
[docs/BUILD.md](docs/BUILD.md).

## Community

Questions, setup help, and release announcements are on
[Discord](https://discord.gg/rnDWYtkbxN). Bug reports are better as
[issues](https://github.com/Santerxyz/SSIM/issues), where they stay findable.

## Project status

SSIM is maintained in spare time. Issues and pull requests are read, though not
always quickly, and there is no support commitment. If you would like to help
carry the project, that offer is genuine and open. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache License 2.0](LICENSE). Free to use, modify, redistribute, and fork.

The name and logo are not covered by that licence. Fork freely, and give your
fork its own name. [TRADEMARK.md](TRADEMARK.md) explains why.
