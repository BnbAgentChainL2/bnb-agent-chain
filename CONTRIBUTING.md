# Contributing

This repository holds a specification set and the code written against it. The order matters:
`docs/decisions.md` overrides everything, the documents in `docs/` come next, and code follows
them. A change that makes the code disagree with a spec is not done until one of the two moves.

---

## Before you start

Read `docs/decisions.md` in full. It is append-only, so later rows supersede earlier ones and a
single row read in isolation will mislead you. Several decisions have already been overturned by
later ones.

If a change alters public-facing copy, an on-chain string, or a claim about what the system
proves, read `docs/00-DESIGN-SPEC.md` §4.1 and §8 first. Those sections fix exact wording that is
not open to paraphrase.

---

## Commit messages

Conventional Commits, English only.

```
type(scope): summary

Body explaining why, wrapped at 72 columns.

Refs: decisions.md #12
```

- **Subject**: imperative mood ("add", not "added" or "adds"), lowercase after the colon, no
  trailing period, 72 characters or fewer.
- **Types**: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`, `revert`.
- **Scopes**: `contracts`, `chain`, `web`, `relayer`, `indexer`, `sdk`, `node-cli`, `docs`,
  `artifacts`, `ci`, `repo`.
- **Body answers why, not what.** The diff already says what.
- **Cite authority.** Any commit that changes behavior or public wording carries a
  `Refs:` footer naming the decision or spec section that authorizes it, for example
  `Refs: decisions.md #17` or `Refs: docs/00-DESIGN-SPEC.md §4.1`. In this project the specs are
  normative; a change with no authority behind it is a spec change and should say so.
- **One concern per commit.** A commit touching two areas either splits or uses the leading
  scope. A single commit never mixes a spec change with a code change.
- **Breaking changes** to a published ABI or to a frozen on-chain string use `!` after the scope
  and a `BREAKING CHANGE:` footer.
- **Chinese** appears in a commit body only inside a quoted on-chain string or a quoted spec
  line, never as the commit's own prose.
- **No emoji** in commit messages.
- Commits produced with agent assistance keep their `Co-Authored-By:` trailer.

Examples:

```
fix(contracts): pay validator rewards per address, not per node

Weighting counted per address while rewards paid per node made splitting
one stake across four identities pay four times for the same work.

Refs: docs/00-DESIGN-SPEC.md §11.1 M3
```

```
docs(chain): record that coinbase override is ignored under QBFT
```

---

## Branches and pull requests

- Branch names: `type/short-english-slug`, for example `fix/exit-rate-rounding` or
  `docs/besu-migration`.
- Never commit to `main` directly.
- PR titles use the same Conventional Commits form as a commit subject, so that a squash merge
  produces a correct commit by construction.
- Keep pull requests small enough to review in one sitting. A PR that changes a spec and the code
  implementing it is acceptable; a PR that changes four unrelated areas is not.
- Fill in `.github/pull_request_template.md` honestly. The checklist exists because the failures
  it names have already happened in this project.

---

## Language policy

Three tiers. The principle behind all of them: translation must never create a second source of
truth.

**Tier 1 — English, no exceptions.** Everything an outsider or a machine reads: `README.md`,
`CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`, issue and PR templates, CI configuration, commit
messages, PR titles and bodies, branch names, release notes, file and directory names, and every
identifier in code. In `contracts/`, `chain/`, `web/js/`, and the Node services: all code
comments, all NatSpec, all log lines, and all CLI output.

**Tier 2 — bilingual, identical meaning in both languages.** Every string frozen on chain or
carrying legal weight: the vault's `description()` and `vaultDataSchema().description`, vault UI
schema labels, every revert reason (Flap rule 004's shape,
`require(cond, unicode"English / 中文")`), the website footer, and the disclosure text that must
read the same in all the places it appears. These are not paraphrased in either language. Where
`docs/00-DESIGN-SPEC.md` §4.1 or §8 fixes wording, it is carried verbatim; no shortened variant
is acceptable in either language.

**Tier 3 — Chinese, not translated.** `docs/00-DESIGN-SPEC.md`, `docs/01-CONTRACT-SPEC.md`,
`docs/02-CHAIN-SPEC.md`, `docs/03-INTERFACES.md`, and `docs/decisions.md`. These are working
specifications, written Chinese-first by deliberate decision, and they change often. A full
English translation would drift within a week and become a second, wrong spec that somebody
quotes. If an English summary is needed it lives beside the original as a clearly non-normative
abstract that says so in its first line, and `docs/decisions.md` is never translated in place.

The website is `lang="zh-CN"` with Chinese body copy, English used for short monospace labels,
the meta description, and the Tier 2 footer lines.

---

## Code style

### Solidity (`contracts/`)

- solc 0.8.26, EVM version `cancun`, optimizer at 200 runs, `via_ir = true` — all set in
  `contracts/foundry.toml`. Do not change these casually: `AgentRegistry` sits 2,218 bytes under
  the EIP-170 limit, and via-IR is what keeps it there. Run `forge build --sizes` after any
  change that adds code to it.
- `forge fmt` before committing. **Never format `contracts/src/flap/`** — those are upstream Flap
  Protocol sources, vendored verbatim, and must stay byte-identical. Fixes go upstream or into a
  subclass, never into those files.
- Dependencies are OpenZeppelin 4.9.6, OpenZeppelin Upgradeable 4.9.6, and forge-std 1.14.0.
  `contracts/lib/` is not tracked; install at those exact tags.
- NatSpec in English on every external and public function. Where a function implements a
  numbered spec clause, cite it (`/// @dev 01-CONTRACT-SPEC.md §4.2`).
- Revert reasons are bilingual: `require(cond, unicode"Owed not matured / 债权尚未成熟")`.
- Tests: one suite per contract under `contracts/test/`, named `<Contract>.t.sol`. New behavior
  arrives with tests. Invariant and fuzz tests live alongside the unit suite
  (`BacBridgeInvariant.t.sol` is the model). Fork tests are opt-in and named so that
  `--match-contract ForkSmoke` selects them; they must never be the reason a CI run silently
  passes with nothing executed.
- Paths that hold money get an explicit test for the failure case, not only the happy path.
  `settle()` must not revert because a downstream contract reverted; exits must not depend on
  agent status. If you touch either property, prove it still holds.

### JavaScript and TypeScript (`relayer/`, `indexer/`, `sdk/`, `node-cli/`)

- Node.js 22 or later, ESM (`"type": "module"`), no transpile step for the services.
- ethers 6.13.4, pinned exactly. Keep it identical across all four packages.
- Tests use the built-in runner: `node --test test/`.
- The SDK is TypeScript and must pass `npm run typecheck` before it builds.

### Website (`web/`)

- No build step, no framework, no package manager, no CDN. ethers is vendored as a self-hosted
  UMD build under `web/vendor/`. Keep it that way.
- The BSC half of the page reads chain state directly through Multicall3, never through the
  project's server. Layer-side content that has not been anchored yet must be labeled as
  unanchored.
- No demo data. No placeholder numbers that read as real once the site is live. Estimates are
  labeled as estimates, read failures show the standard retry text, and pre-launch addresses show
  the standard pre-launch placeholder rather than a plausible-looking address.

---

## Copy rules for anything public-facing

These apply to the website, on-chain strings, the README, release notes, and any announcement.
They are not style preferences; several of them exist because a previous wording was found to be
false under adversarial review.

- No claim of affiliation with Binance, BNB Chain, CZ, or Flap. The project is "BNB Agent Chain,"
  never "Binance Agent Chain."
- No superlatives. Do not write that this is the only or the first anything.
- No promised returns, yield, APY, or price action. Exiting pays a share of a pool, never a fixed
  amount, and can be far below what was put in. That disclosure is mandatory wherever exit
  mechanics are described.
- Do not write that humans cannot enter, or that only programs can transact in the layer. It is
  not provable on chain, and the layer's own protocol contradicts it —
  `docs/00-DESIGN-SPEC.md` §4.1 fixes the only permitted phrasing of this claim and it is carried
  verbatim.
- Do not write that `marketAddress` is permanently immutable. Write that the project team cannot
  change it.
- Do not write that gas costs deter spam, or that instant finality makes the chain more secure.
  Both were checked and both are false.
- Every number traces to a chain read or a spec constant. No invented metrics.
- Fiction is labeled fiction; concept art is labeled concept art.

---

## Secrets never enter this repository

- `.env` is never committed. `.env.example` holds empty placeholders only.
- The deployer key must be a fresh wallet that has never held anything else.
- `chain/build/` is where `besu operator generate-blockchain-config` writes the live validator
  node key. That key is simultaneously the QBFT validator identity and the enode identity, and
  losing or leaking it is the worst documented failure class in this system. It must be ignored
  before that command is ever run, along with `**/secrets/`, `*.key`, `*.nodekey`, `keystore/`,
  `UTC--*`, and `genesis-with-keys.json`.
- Operational details of any production host — usernames, sudo configuration, key filenames,
  firewall state, what else runs on the box — do not belong in a public repository, including in
  a decision record or a research note. Provider-agnostic requirements are fine; reconnaissance
  is not.
- If you believe a secret has been committed, do not open a public issue. Follow `SECURITY.md`.
  Rotate first, scrub history second.
