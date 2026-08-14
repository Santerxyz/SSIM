# SSIM Trademark Policy

**Short version:** the code is free. The name is not.

You may do anything the [Apache License 2.0](LICENSE) permits with the SSIM source
code — use it, modify it, redistribute it, sell services around it, fork it
permanently. That freedom is real and irrevocable, and nothing here takes it back.

What the Apache License explicitly does **not** grant (see §6, "Trademarks") is
permission to use the project's name and branding. This document sets out what we
do and don't allow, so you don't have to guess.

## Why this exists

SSIM handles Steam passwords, `maFile` 2FA secrets, and live wallet balances. That
makes a build wearing the SSIM name an unusually attractive vehicle for a
credential stealer: users who trust the name will hand it everything.

This policy exists so that **"is this really SSIM?" has a checkable answer**. It is
not here to restrict forks, discourage derivatives, or protect commercial interest.
It is here so a malicious build can be identified as *not us* and taken down.

## The marks

- The name **"SSIM"** and **"Santer Steam Inventory Manager"**
- The SSIM logo and icon
- The visual identity of the dashboard as shipped by the project

## You may, without asking

- **State what your work is based on**, accurately and in plain text:
  "based on SSIM", "a fork of SSIM", "compatible with SSIM", "SSIM plugin".
- **Use the name to refer to this project** — in articles, reviews, tutorials,
  videos, comparisons, academic work, or conversation. Nominative use is fine and
  always will be.
- **Redistribute official, unmodified builds** under the SSIM name, provided you
  do not alter the binary and you link to the canonical source.
- **Use the name in your repository description or documentation** to explain the
  relationship.

## You may not, without written permission

- **Name your modified build "SSIM"**, or any name likely to be confused with it
  ("SSIM Pro", "SSIM+", "SSIM Unlocked", "SSIM Reloaded", "SS1M").
- **Use the SSIM logo or icon** as the identity of a derivative work.
- **Imply endorsement, affiliation, or official status** — "official SSIM build",
  "SSIM certified", "recommended by SSIM".
- **Register** the name, logo, confusingly similar marks, or matching domains and
  social handles.
- **Distribute a modified binary under the SSIM name.** This is the one that
  matters most, and the one we will always act on.

## Forking is welcome — just rename

If you fork SSIM and change it, give it your own name. You keep every right the
Apache License grants; you simply don't inherit the reputation attached to ours,
because that reputation is the only thing protecting users from a poisoned build.

A good fork announcement looks like:

> **FleetTool** — a Steam multi-account manager, based on SSIM.
> Not affiliated with or endorsed by the SSIM project.

That is explicitly allowed and needs no permission.

## Verifying an official build

Official SSIM releases come from **exactly one place**: the project's GitHub
Releases page linked from the [README](README.md). Every release is published with
a `SHA256SUMS` file and is signed. Anything distributed anywhere else — a forum
attachment, a Discord DM, a mirror site, a "cracked" or "unlocked" build — is not
an official release, regardless of what it calls itself.

**If you did not get it from the canonical source, do not give it your Steam
credentials.**

## Enforcement

We would rather send an email than a takedown. If you're using the marks in a way
this policy doesn't allow, we'll normally just ask you to rename, and that will be
the end of it.

The exception is a **modified binary distributed under the SSIM name**. That
endangers users directly, and we will pursue takedowns without a warning step.

## Questions and permission requests

Open an issue, or ask on the project Discord. Requests to use the marks in ways
not covered here are welcome and generally granted when the use is honest and not
confusing.

---

*This policy covers trademarks only. It does not restrict any right granted by the
[Apache License 2.0](LICENSE), and in any conflict, the Apache License governs the
code.*
