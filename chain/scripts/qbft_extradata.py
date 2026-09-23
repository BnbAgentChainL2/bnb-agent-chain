#!/usr/bin/env python3
# chain/scripts/qbft_extradata.py
#
# Encodes a QBFT genesis `extraData` from a validator list, and/or decodes one back into its parts.
#
# READ THIS BEFORE USING THE ENCODER
#   The authority on QBFT extraData is Besu itself:
#       besu rlp encode --from=toEncode.json --to=extraData.txt --type=QBFT_EXTRA_DATA
#   That is what 02-CHAIN-SPEC 3.0/3.0.1 prescribes and what the launch genesis must use.
#   The encoder here exists for two reasons only:
#     1. `chain/build-genesis.sh --rehearsal` runs on a laptop with no Docker and therefore no
#        `besu` binary; it needs *some* syntactically valid extraData to exercise the rest of the
#        pipeline.  Rehearsal output is written to genesis.rehearsal.json and is never a launch file.
#     2. `chain/verify-genesis.sh` cross-checks Besu's own output against this encoder on the
#        server.  If they disagree, the note below gets a measured answer instead of a guess.
#
#   UNVERIFIED DETAIL: the layout is RLP([vanity32, [validators], vote, round, [seals]]).
#   `vote` and `round` in a genesis file are encoded here as the empty string (0x80) and a 4-byte
#   zero (0x8400000000) respectively, following 02-CHAIN-SPEC 3's description.  Besu's own encoder
#   is the tie-breaker and the cross-check in verify-genesis.sh is what settles it.  Do not ship a
#   launch genesis whose extraData came from this file.
#
#   The decoder is always safe to use and is the useful half: it tells you which validators a given
#   extraData actually commits to, which is the thing you want to check before starting a chain.

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from statetrie import rlp  # noqa: E402

VANITY = b"\x00" * 32


def encode(validators):
    addrs = []
    for entry in validators:
        raw = bytes.fromhex(entry[2:] if entry.startswith("0x") else entry)
        if len(raw) != 20:
            raise ValueError("validator address is not 20 bytes: %s" % entry)
        addrs.append(raw)
    if not addrs:
        raise ValueError("a QBFT chain needs at least one validator")
    payload = [VANITY, addrs, b"", b"\x00\x00\x00\x00", []]
    return "0x" + rlp(payload).hex()


def _decode_item(data, pos):
    prefix = data[pos]
    if prefix <= 0x7F:
        return data[pos:pos + 1], pos + 1, False
    if prefix <= 0xB7:
        length = prefix - 0x80
        return data[pos + 1:pos + 1 + length], pos + 1 + length, False
    if prefix <= 0xBF:
        n = prefix - 0xB7
        length = int.from_bytes(data[pos + 1:pos + 1 + n], "big")
        start = pos + 1 + n
        return data[start:start + length], start + length, False
    if prefix <= 0xF7:
        length = prefix - 0xC0
        start = pos + 1
    else:
        n = prefix - 0xF7
        length = int.from_bytes(data[pos + 1:pos + 1 + n], "big")
        start = pos + 1 + n
    end = start + length
    items = []
    cur = start
    while cur < end:
        item, cur, _ = _decode_item(data, cur)
        items.append(item)
    return items, end, True


def decode(extradata):
    raw = bytes.fromhex(extradata[2:] if extradata.startswith("0x") else extradata)
    items, _, is_list = _decode_item(raw, 0)
    if not is_list or len(items) < 2:
        raise ValueError("extraData is not a QBFT RLP list")
    vanity = items[0]
    validators = ["0x" + v.hex() for v in items[1]]
    return {
        "vanity": "0x" + (vanity.hex() if isinstance(vanity, bytes) else ""),
        "vanityIsZero": isinstance(vanity, bytes) and set(vanity) in ({0}, set()),
        "validators": validators,
        "validatorCount": len(validators),
        "fields": len(items),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description="QBFT genesis extraData encoder / decoder")
    ap.add_argument("--encode", nargs="+", metavar="VALIDATOR",
                    help="REHEARSAL ONLY - encode these validator addresses")
    ap.add_argument("--decode", metavar="HEX", help="decode an extraData value")
    args = ap.parse_args(argv)

    if args.decode:
        print(json.dumps(decode(args.decode), indent=2))
        return 0
    if args.encode:
        sys.stderr.write(
            "WARNING: this encoder is UNVERIFIED against Besu. Use "
            "`besu rlp encode --type=QBFT_EXTRA_DATA` for any chain that will carry real value.\n")
        print(encode(args.encode))
        return 0
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
