## What and why

<!-- What changes, and the reason. The diff already says what; explain why. -->

## Authority

<!-- Which ratified decision or spec section authorizes this change.
     e.g. Refs: decisions.md #17, docs/00-DESIGN-SPEC.md §3.6 -->

Refs:

## Checklist

- [ ] Commit messages follow `type(scope): subject`, English, imperative, subject <= 72 chars.
- [ ] This PR changes one concern. Spec changes and code changes are not mixed in one commit.
- [ ] The specs and the code still agree. If the code now differs from `docs/`, the doc change is
      in this PR or linked from it.
- [ ] `forge fmt` run on first-party Solidity; `contracts/src/flap/` left untouched.
- [ ] `forge build --sizes` passes and no contract lost meaningful EIP-170 margin.
- [ ] `forge test --no-match-contract ForkSmoke` passes locally.
- [ ] New or changed behavior has tests, including the failure case.

## Public-facing copy

- [ ] No public copy, on-chain string, or documented claim changed by this PR.
- [ ] Or: it did, and it matches the fixed wording in `docs/00-DESIGN-SPEC.md` §4.1 / §8 verbatim.

If copy changed, confirm it makes none of these claims: affiliation with Binance, BNB Chain, CZ,
or Flap; a superlative ("only", "first"); promised returns or yield; that humans cannot enter the
layer or that only programs can transact there; that `marketAddress` is permanently immutable;
that gas costs deter spam; that instant finality improves security.

- [ ] Every number added traces to a chain read or a spec constant.

## Secrets and operations

- [ ] No private key, mnemonic, keystore, `.env`, API token, or node key is added by this PR.
- [ ] No production host detail (username, sudo state, key filename, firewall or disk state,
      co-located services) is added by this PR.
- [ ] No demo or placeholder data that could read as real is added to `web/`.
