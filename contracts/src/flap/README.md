# Upstream Flap Protocol sources

These files are **not authored by this project**. They are interfaces and base
contracts of the Flap Protocol, copied verbatim from upstream on 2026-09-22 so
that the build does not depend on a network fetch, and so that an upstream
change shows up as a diff rather than as a surprise at launch.

- Author: The Flap Team (see the `@author` tag in each file).
- Licence: MIT, as declared by each file's own SPDX identifier.
- Do not edit anything in this directory. Never run `forge fmt` over it — it
  must stay byte-identical to upstream so the diff stays meaningful. Changes
  belong upstream, or in a subclass under `contracts/src/`.
- The live deployment these are pinned against is asserted by the fork smoke
  test in `contracts/test/`, which fails the build if Flap upgrades underneath
  the project.
