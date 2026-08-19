# Security Policy

SSIM handles Steam passwords, `maFile` 2FA secrets, and live wallet balances. A
vulnerability here can cost someone their accounts and their money. We take that
seriously and we would much rather hear from you than not.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately, by whichever is easiest:

1. **GitHub Private Vulnerability Reporting**: the *Security* tab → *Report a
   vulnerability*. Preferred, since it keeps everything in one place.
2. **Discord**: DM the maintainer (`Santer.xyz`). Say only that you have a
   security report; don't put details in the first message.

Helpful to include, if you have it: what the issue is, how to reproduce it, what
an attacker gets out of it, and the version or commit you found it on. A rough
report sent today beats a polished one sent next month.

## What to expect

Maintenance here is **best-effort**. See the README's project status. Realistically:

- **Acknowledgement:** within 7 days.
- **Assessment:** within 30 days, with an honest answer about whether and when
  it'll be fixed.
- **Disclosure:** once a fix ships, or 90 days after the report, whichever comes
  first. If we've gone quiet past 90 days, publish. You do not need our
  permission, and we won't hold it against you.

We don't run a bug bounty and can't pay for reports. Credit in the release notes
and the fix commit is offered by default. Tell us if you'd rather stay anonymous.

## Scope

**In scope**

- The vault: key derivation, encryption, at-rest handling of credentials and `maFile` secrets
- The updater: signature and hash verification, the swap-and-relaunch path
- The local HTTP API and dashboard: authentication, capability tokens, CSRF, injection
- Credential or secret leakage into logs, crash dumps, error messages, or telemetry
- Anything letting one account's session act as another's
- Dependency vulnerabilities with a demonstrable path to exploitation here

**Out of scope**

- Steam account bans or trade restrictions from using SSIM. That risk is inherent
  and documented in the README.
- Attacks assuming an attacker already has code execution or admin rights on the
  user's machine. If they are already there, the vault password is the only thing
  left, and it is their keyboard.
- The master password being weak. Entropy is the user's responsibility; we
  document it.
- Social engineering of users or maintainers.
- Missing hardening flags with no demonstrated impact.
- Reports from automated scanners with no working proof of concept.

## Known and documented limitations

These are understood trade-offs, not undiscovered bugs. Reporting them is fine,
but they aren't news:

- **A portable `vault.enc` is only as strong as the master password.** Copy the
  file, and an offline attacker gets unlimited guesses. scrypt (N=2¹⁵) makes that
  expensive, not impossible. Use a strong password.
- **`maFile` secrets must be usable at runtime** to confirm trades and listings.
  They are decrypted in memory while SSIM runs. There is no way around this that
  still confirms trades.
- **SSIM trusts the machine it runs on.** It is not designed to defend against a
  compromised host.

## For users

If you believe you downloaded a **malicious build of SSIM**, that is not a
vulnerability in this project. It is a counterfeit, and it is the threat we worry
about most. Please report it anyway, urgently, so we can pursue a takedown:
say where you got it and include the file hash if you still have it. Then change
your Steam password and revoke active sessions.

Official releases come from the GitHub Releases page linked in the README, and
nowhere else. See [TRADEMARK.md](TRADEMARK.md).
