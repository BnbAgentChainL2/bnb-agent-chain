#!/usr/bin/env python3
# chain/scripts/fill_genesis.py
#
# Replaces every <PLACEHOLDER> in chain/genesis.template.json and then refuses to hand back a file
# that is wrong in any way we know how to check.  Driven by chain/build-genesis.sh; not meant to be
# run by hand, but it is a plain CLI so that a reviewer can re-run it on the same inputs.
#
# Checks, in order (each one is a hard failure):
#   1. every placeholder was given a value, and no '<' survives anywhere in the output;
#   2. the result is valid JSON and keeps the exact config block the spec fixes (chainId, qbft,
#      zeroBaseFee, mixHash magic, gasLimit, difficulty, contractSizeLimit);
#   3. every `code` is 0x-prefixed even-length hex, non-empty, and <= 24576 bytes (EIP-170, the same
#      number the chain enforces via config.contractSizeLimit);
#   4. every `balance` is a hex string (02-CHAIN-SPEC 3.2 alloc rule 7 - never decimal);
#   5. the arithmetic: L2Bridge holds TOTAL_SUPPLY - OPERATOR_FLOAT, the relayer holds
#      OPERATOR_FLOAT, everything else holds 0, and the alloc sums to exactly TOTAL_SUPPLY;
#   6. the alloc address set is exactly the eight addresses of 02-CHAIN-SPEC 2, and the relayer is
#      not one of the system addresses;
#   7. the genesis timestamp is a UTC midnight (layer epochs must line up with the BSC side, which
#      defines epoch = floor(ts / 86400));
#   8. no storage slots anywhere in the alloc (rule 1: genesis carries state, never storage).
#
# It writes a manifest next to the genesis listing where each placeholder's value came from, so the
# question "why is this byte here" has a written answer for all nine of them.

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from statetrie import state_root_from_genesis  # noqa: E402

TOTAL_SUPPLY = 10 ** 27          # 1,000,000,000 BAC - equals the fixed BAC supply on BSC
OPERATOR_FLOAT = 10 ** 21        # 1,000 BAC - the relayer's gas float, publicly disclosed
EIP170_LIMIT = 24576

L2BRIDGE = "0x0000000000000000000000000000000000000101"
L2GATE = "0x0000000000000000000000000000000000000102"
AGENTBOOK = "0x0000000000000000000000000000000000000103"
FEESPLITTER = "0x0000000000000000000000000000000000000104"
MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C"
FEE_SINK = "0x000000000000000000000000000000000000dEaD"

QBFT_MIXHASH = "0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365"


class Fail(Exception):
    pass


def _hexbytes(value, label):
    if not isinstance(value, str) or not value.startswith("0x"):
        raise Fail("%s is not a 0x-prefixed hex string: %r" % (label, value))
    body = value[2:]
    if len(body) % 2:
        raise Fail("%s has an odd number of hex digits (%d)" % (label, len(body)))
    try:
        return bytes.fromhex(body)
    except ValueError:
        raise Fail("%s is not hex: %r" % (label, value[:40]))


def _addr_key(value):
    raw = _hexbytes(value, "address %s" % value)
    if len(raw) != 20:
        raise Fail("address is not 20 bytes: %s" % value)
    return raw.hex()


def build(args):
    # Load and re-serialise first, so the template's own `_comment` (which talks *about*
    # placeholders) can never be mistaken for one.
    with open(args.template, "r", encoding="utf-8") as fh:
        template = json.load(fh)
    template.pop("_comment", None)
    text = json.dumps(template, indent=2)

    codes = {}
    for line in open(args.codes, "r", encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, _, value = line.partition("=")
        codes[name.strip()] = value.strip()

    timestamp = int(args.timestamp)
    if timestamp % 86400 != 0:
        raise Fail(
            "genesis timestamp %d is not a UTC midnight; layer epochs would not line up with the "
            "BSC side (epoch = floor(ts/86400))" % timestamp)

    substitutions = {
        "<GENESIS_TIMESTAMP_HEX>": hex(timestamp),
        "<QBFT_EXTRADATA_RLP>": args.extradata,
        "<RELAYER_LAYER_ADDR>": args.relayer,
        "<L2BRIDGE_RUNTIME_BYTECODE>": codes.get("L2BRIDGE", ""),
        "<L2GATE_RUNTIME_BYTECODE>": codes.get("L2GATE", ""),
        "<AGENTBOOK_RUNTIME_BYTECODE>": codes.get("AGENTBOOK", ""),
        "<FEESPLITTER_RUNTIME_BYTECODE>": codes.get("FEESPLITTER", ""),
        "<MULTICALL3_RUNTIME_BYTECODE>": codes.get("MULTICALL3", ""),
        "<CREATE2_DEPLOYER_RUNTIME_BYTECODE>": codes.get("CREATE2_DEPLOYER", ""),
    }

    present = set(re.findall(r"<[A-Z0-9_]+>", text))
    missing_in_map = present - set(substitutions)
    if missing_in_map:
        raise Fail("template has placeholders nobody fills: %s" % ", ".join(sorted(missing_in_map)))
    unused = set(substitutions) - present
    if unused:
        raise Fail("we were given values for placeholders the template does not have: %s"
                   % ", ".join(sorted(unused)))
    for key, value in substitutions.items():
        if not value:
            raise Fail("no value for placeholder %s" % key)
        text = text.replace(key, value)

    if "<" in text:
        raise Fail("a '<' survived substitution - placeholder left in the output")

    genesis = json.loads(text)
    genesis.pop("_comment", None)
    return genesis, substitutions


def check(genesis, allow_stub_code):
    cfg = genesis["config"]
    fixed = {
        "chainId": 56777,
        "shanghaiTime": 0,
        "cancunTime": 0,
        "contractSizeLimit": EIP170_LIMIT,
        "zeroBaseFee": True,
    }
    for key, want in fixed.items():
        if cfg.get(key) != want:
            raise Fail("config.%s is %r, expected %r" % (key, cfg.get(key), want))
    qbft = cfg.get("qbft") or {}
    for key, want in (("blockperiodseconds", 3), ("epochlength", 30000),
                      ("requesttimeoutseconds", 6)):
        if qbft.get(key) != want:
            raise Fail("config.qbft.%s is %r, expected %r" % (key, qbft.get(key), want))
    if genesis.get("mixHash") != QBFT_MIXHASH:
        raise Fail("mixHash is not the QBFT magic constant; Besu would not recognise this chain")
    if genesis.get("difficulty") != "0x1":
        raise Fail("difficulty must be 0x1 on a BFT chain")
    if genesis.get("gasLimit") != "0x1312d00":
        raise Fail("gasLimit must be 0x1312d00 (20,000,000)")
    if genesis.get("baseFeePerGas") != "0x0":
        raise Fail("baseFeePerGas must be 0x0 under zeroBaseFee (decision #16)")
    _hexbytes(genesis["extraData"], "extraData")

    alloc = genesis["alloc"]
    expected = {L2BRIDGE, L2GATE, AGENTBOOK, FEESPLITTER, MULTICALL3, CREATE2_DEPLOYER, FEE_SINK}
    keys = {_addr_key(a) for a in alloc}
    if len(keys) != len(alloc):
        raise Fail("duplicate address in alloc (differing only by case)")
    expected_keys = {_addr_key(a) for a in expected}
    extra = keys - expected_keys
    if len(extra) != 1:
        raise Fail("alloc must hold exactly the 7 fixed addresses plus the relayer; "
                   "unexpected set: %s" % sorted("0x" + k for k in extra))
    missing = expected_keys - keys
    if missing:
        raise Fail("alloc is missing fixed addresses: %s" % sorted("0x" + k for k in missing))
    relayer_key = list(extra)[0]

    total = 0
    with_code = 0
    for addr, entry in alloc.items():
        label = "alloc[%s]" % addr
        if "storage" in entry and entry["storage"]:
            raise Fail("%s carries storage slots; genesis must contain none at all" % label)
        bal = entry.get("balance", "0x0")
        if not isinstance(bal, str) or not bal.startswith("0x"):
            raise Fail("%s.balance must be a hex string, got %r (alloc rule 7)" % (label, bal))
        value = int(bal, 16)
        total += value
        key = _addr_key(addr)
        if key == _addr_key(L2BRIDGE):
            if value != TOTAL_SUPPLY - OPERATOR_FLOAT:
                raise Fail("L2Bridge balance is %d, expected TOTAL_SUPPLY - OPERATOR_FLOAT = %d"
                           % (value, TOTAL_SUPPLY - OPERATOR_FLOAT))
        elif key == relayer_key:
            if value != OPERATOR_FLOAT:
                raise Fail("relayer balance is %d, expected OPERATOR_FLOAT = %d"
                           % (value, OPERATOR_FLOAT))
        elif value != 0:
            raise Fail("%s has a non-zero balance (%d); only L2Bridge and the relayer may"
                       % (label, value))

        if "code" in entry:
            code = _hexbytes(entry["code"], label + ".code")
            if len(code) == 0:
                raise Fail("%s.code is empty" % label)
            if len(code) > EIP170_LIMIT:
                raise Fail("%s.code is %d bytes, over the EIP-170 limit of %d"
                           % (label, len(code), EIP170_LIMIT))
            if len(code) < 32 and not allow_stub_code:
                raise Fail("%s.code is only %d bytes - that is a stub, not a contract"
                           % (label, len(code)))
            with_code += 1

    if total != TOTAL_SUPPLY:
        raise Fail("alloc balances sum to %d, expected TOTAL_SUPPLY = %d" % (total, TOTAL_SUPPLY))
    if with_code != 6:
        raise Fail("expected 6 accounts with code, found %d" % with_code)
    return relayer_key


def main(argv=None):
    ap = argparse.ArgumentParser(description="fill and validate the layer genesis")
    ap.add_argument("--template", required=True)
    ap.add_argument("--codes", required=True, help="file of NAME=0x<runtime bytecode> lines")
    ap.add_argument("--extradata", required=True, help="QBFT RLP extraData")
    ap.add_argument("--timestamp", required=True, help="genesis timestamp, unix seconds (decimal)")
    ap.add_argument("--relayer", required=True, help="relayer layer EOA")
    ap.add_argument("--out", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--sources", default="", help="path to a JSON map placeholder -> provenance")
    ap.add_argument("--allow-stub-code", action="store_true",
                    help="rehearsal only: permit a placeholder stub for a contract not written yet")
    args = ap.parse_args(argv)

    try:
        genesis, substitutions = build(args)
        relayer_key = check(genesis, args.allow_stub_code)
    except Fail as exc:
        print("FILL GENESIS FAILED: %s" % exc, file=sys.stderr)
        return 1

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(genesis, fh, indent=2, sort_keys=False)
        fh.write("\n")

    root = "0x" + state_root_from_genesis(genesis).hex()

    provenance = {}
    if args.sources and os.path.exists(args.sources):
        with open(args.sources, "r", encoding="utf-8") as fh:
            provenance = json.load(fh)

    manifest = {
        "genesisFile": os.path.basename(args.out),
        "chainId": genesis["config"]["chainId"],
        "timestamp": genesis["timestamp"],
        "timestampDecimal": int(genesis["timestamp"], 16),
        "stateRoot": root,
        "stateRootComputedBy": "chain/scripts/statetrie.py (no client involved)",
        "totalSupplyWei": str(TOTAL_SUPPLY),
        "operatorFloatWei": str(OPERATOR_FLOAT),
        "relayer": "0x" + relayer_key,
        "placeholders": {
            key.strip("<>"): {
                "value": (value if len(value) <= 80 else value[:66] + "...(%d bytes)"
                          % ((len(value) - 2) // 2)),
                "source": provenance.get(key.strip("<>"), "UNRECORDED"),
            }
            for key, value in sorted(substitutions.items())
        },
    }
    with open(args.manifest, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")

    print("STATE_ROOT=%s" % root)
    return 0


if __name__ == "__main__":
    sys.exit(main())
