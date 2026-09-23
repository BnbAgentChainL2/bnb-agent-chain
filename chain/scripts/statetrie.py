#!/usr/bin/env python3
# chain/scripts/statetrie.py
#
# Pure-Python keccak-256 + RLP + Merkle-Patricia state trie.
#
# WHY THIS FILE EXISTS
#   02-CHAIN-SPEC.md 3.3 gets the genesis hash by booting Besu. Besu needs Docker, Docker only
#   exists on the server, and "the genesis is whatever the one machine that can run it says it is"
#   is exactly the kind of un-recomputable claim this project refuses to make.
#   So we compute the genesis *state root* here, from genesis.json alone, with no client at all.
#   Anyone can re-run this and get the same 32 bytes. chain/verify-genesis.sh then asserts that
#   Besu's own eth_getBlockByNumber(0).stateRoot equals this number, on the server.
#
#   The state root depends ONLY on alloc, so it is client-independent and fork-independent.
#   The genesis *block hash* additionally depends on which optional header fields Besu writes for a
#   QBFT cancun chain (withdrawalsRoot / blobGasUsed / excessBlobGas / parentBeaconBlockRoot), which
#   we have NOT measured. We therefore never guess the block hash here - it comes from Besu.
#
# SELF-TEST (python3 statetrie.py --selftest --rpc <anvil rpc>)
#   keccak is checked against `cast keccak`, RLP against `cast to-rlp`, and the whole trie builder
#   against a real client: anvil mines a block, we enumerate every account we touched, rebuild the
#   trie here and require our root to equal anvil's stateRoot. If that passes, the implementation
#   agrees with alloy-trie on branch layout, hex-prefix encoding and account RLP.

import json
import subprocess
import sys

MASK64 = (1 << 64) - 1

_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROT = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
]


def _rol(x, n):
    n %= 64
    return ((x << n) | (x >> (64 - n))) & MASK64


def _keccak_f(A):
    for rnd in range(24):
        C = [A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4] for x in range(5)]
        D = [C[(x - 1) % 5] ^ _rol(C[(x + 1) % 5], 1) for x in range(5)]
        for x in range(5):
            for y in range(5):
                A[x][y] ^= D[x]
        B = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                B[y][(2 * x + 3 * y) % 5] = _rol(A[x][y], _ROT[x][y])
        for x in range(5):
            for y in range(5):
                A[x][y] = B[x][y] ^ ((~B[(x + 1) % 5][y]) & MASK64 & B[(x + 2) % 5][y])
        A[0][0] ^= _RC[rnd]
    return A


def keccak256(data):
    rate = 136
    A = [[0] * 5 for _ in range(5)]
    padded = bytearray(data)
    padded.append(0x01)
    while len(padded) % rate != 0:
        padded.append(0x00)
    padded[-1] ^= 0x80
    for off in range(0, len(padded), rate):
        block = padded[off:off + rate]
        for i in range(rate // 8):
            lane = int.from_bytes(block[8 * i:8 * i + 8], "little")
            A[i % 5][i // 5] ^= lane
        A = _keccak_f(A)
    out = bytearray()
    for i in range(4):
        out += (A[i % 5][i // 5]).to_bytes(8, "little")
    return bytes(out)


# ----------------------------------------------------------------------------------------- RLP --

class Raw(object):
    """An already-RLP-encoded blob, spliced into a parent list verbatim.

    Used for trie nodes shorter than 32 bytes, which are embedded in their parent instead of being
    referenced by hash. A state trie with 32-byte keys never produces one, but leaving it out
    would make this an implementation that is only correct for our own input."""

    __slots__ = ("enc",)

    def __init__(self, enc):
        self.enc = enc


def _len_prefix(length, offset):
    if length < 56:
        return bytes([offset + length])
    be = length.to_bytes((length.bit_length() + 7) // 8, "big")
    return bytes([offset + 55 + len(be)]) + be


def rlp(item):
    if isinstance(item, Raw):
        return item.enc
    if isinstance(item, bool):
        raise TypeError("bool has no RLP encoding here")
    if isinstance(item, int):
        if item < 0:
            raise ValueError("negative integers have no RLP encoding")
        item = b"" if item == 0 else item.to_bytes((item.bit_length() + 7) // 8, "big")
    if isinstance(item, (bytes, bytearray)):
        b = bytes(item)
        if len(b) == 1 and b[0] < 0x80:
            return b
        return _len_prefix(len(b), 0x80) + b
    if isinstance(item, (list, tuple)):
        body = b"".join(rlp(x) for x in item)
        return _len_prefix(len(body), 0xC0) + body
    raise TypeError("cannot RLP-encode %r" % type(item))


EMPTY_TRIE_ROOT = keccak256(rlp(b""))
EMPTY_CODE_HASH = keccak256(b"")


# ----------------------------------------------------------------- Merkle-Patricia trie (build) --

def _nibbles(key):
    out = []
    for byte in key:
        out.append(byte >> 4)
        out.append(byte & 0x0F)
    return out


def _hex_prefix(nibs, is_leaf):
    flag = 2 if is_leaf else 0
    if len(nibs) % 2:
        head = ((flag + 1) << 4) | nibs[0]
        rest = nibs[1:]
    else:
        head = flag << 4
        rest = nibs
    out = bytearray([head])
    for i in range(0, len(rest), 2):
        out.append((rest[i] << 4) | rest[i + 1])
    return bytes(out)


def _ref(encoded):
    return Raw(encoded) if len(encoded) < 32 else keccak256(encoded)


def _build(items, depth):
    """items: list of (nibbles, value). Returns the RLP encoding of the subtree node."""
    if len(items) == 1:
        nibs, value = items[0]
        return rlp([_hex_prefix(nibs[depth:], True), value])

    first = items[0][0]
    end = depth
    limit = min(len(n) for n, _ in items)
    while end < limit and all(n[end] == first[end] for n, _ in items):
        end += 1
    if end > depth:
        child = _build(items, end)
        return rlp([_hex_prefix(first[depth:end], False), _ref(child)])

    branches = [b""] * 17
    for nib in range(16):
        sub = [it for it in items if len(it[0]) > depth and it[0][depth] == nib]
        if sub:
            branches[nib] = _ref(_build(sub, depth + 1))
    terminal = [v for (n, v) in items if len(n) == depth]
    branches[16] = terminal[0] if terminal else b""
    return rlp(branches)


def trie_root(pairs):
    """pairs: iterable of (key_bytes, value_bytes) - keys are hashed already (secure trie)."""
    items = [(_nibbles(k), v) for k, v in pairs if v != b""]
    if not items:
        return EMPTY_TRIE_ROOT
    items.sort(key=lambda it: it[0])
    return keccak256(_build(items, 0))


# ---------------------------------------------------------------------------------- state trie --

def account_rlp(nonce, balance, storage_root, code_hash):
    return rlp([nonce, balance, storage_root, code_hash])


def state_root(accounts):
    """accounts: iterable of dicts {address, balance, nonce, code}.

    Storage root is always EMPTY_TRIE_ROOT: genesis carries no storage slots at all
    (02-CHAIN-SPEC 3.2 alloc rule 1), and build-genesis.sh asserts that on a live anvil."""
    pairs = []
    for acct in accounts:
        addr = acct["address"]
        if isinstance(addr, str):
            addr = bytes.fromhex(addr[2:] if addr.startswith("0x") else addr)
        if len(addr) != 20:
            raise ValueError("address is not 20 bytes: %r" % acct["address"])
        code = acct.get("code") or b""
        if isinstance(code, str):
            code = bytes.fromhex(code[2:] if code.startswith("0x") else code)
        value = account_rlp(
            int(acct.get("nonce", 0)),
            int(acct["balance"]),
            acct.get("storage_root", EMPTY_TRIE_ROOT),
            keccak256(code) if code else EMPTY_CODE_HASH,
        )
        pairs.append((keccak256(addr), value))
    return trie_root(pairs)


def _as_int(value):
    if isinstance(value, str):
        return int(value, 16) if value.startswith("0x") else int(value)
    return int(value)


def state_root_from_genesis(genesis):
    accounts = []
    for addr, entry in genesis["alloc"].items():
        accounts.append({
            "address": addr,
            "balance": _as_int(entry.get("balance", 0)),
            "nonce": _as_int(entry.get("nonce", 0)),
            "code": entry.get("code", ""),
        })
    return state_root(accounts)


# ------------------------------------------------------------------------------------ self-test --

def _cast(args):
    return subprocess.run(["cast"] + args, capture_output=True, text=True, check=True).stdout.strip()


def _rpc(rpc, method, params):
    out = subprocess.run(
        ["cast", "rpc", "--rpc-url", rpc, method] + params,
        capture_output=True, text=True, check=True).stdout.strip()
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return out.strip('"')


def _selftest_trie_against_anvil(rpc):
    """anvil computes a real stateRoot for mined blocks. We create a block whose complete account
    set we know by construction, then require our root to equal anvil's."""
    probes = [
        "0x000000000000000000000000000000000000bEEF",
        "0x00000000000000000000000000000000000CaFe1",
        "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        "0x4e59b44847b379578588920cA78FbF26c0B4956C",
        "0x0000000000000000000000000000000000000000",
    ]
    _rpc(rpc, "anvil_setBalance", ['"%s"' % probes[0], '"0x1"'])
    _rpc(rpc, "anvil_setBalance", ['"%s"' % probes[1], '"0xde0b6b3a7640000"'])
    _rpc(rpc, "evm_mine", [])
    block = _rpc(rpc, "eth_getBlockByNumber", ['"latest"', "false"])
    height = block["number"]
    accounts = []
    for addr in probes:
        bal = int(_rpc(rpc, "eth_getBalance", ['"%s"' % addr, '"%s"' % height]), 16)
        nonce = int(_rpc(rpc, "eth_getTransactionCount", ['"%s"' % addr, '"%s"' % height]), 16)
        code = _rpc(rpc, "eth_getCode", ['"%s"' % addr, '"%s"' % height])
        code = bytes.fromhex(code[2:]) if code and code != "0x" else b""
        if bal == 0 and nonce == 0 and not code:
            continue
        accounts.append({"address": addr, "balance": bal, "nonce": nonce, "code": code})
    ours = "0x" + state_root(accounts).hex()
    theirs = block["stateRoot"]
    if ours != theirs:
        return ["trie root at block %s: ours %s != anvil %s (accounts: %d)"
                % (height, ours, theirs, len(accounts))]
    return []


def _selftest(rpc):
    failures = []

    for probe in ["0x", "0x00", "0xdeadbeef", "0x" + "ab" * 200]:
        mine = "0x" + keccak256(bytes.fromhex(probe[2:])).hex()
        theirs = _cast(["keccak", probe])
        if mine != theirs:
            failures.append("keccak(%s): ours %s != cast %s" % (probe[:14], mine, theirs))

    vectors = [
        ([b"\x01", b"\x02"], '["0x01","0x02"]'),
        ([], "[]"),
        ([b"", b"\x00"], '["0x","0x00"]'),
        ([bytes(range(60))], '["0x%s"]' % bytes(range(60)).hex()),
        ([[b"\x01"], b"\x02"], '[["0x01"],"0x02"]'),
    ]
    for value, literal in vectors:
        mine = "0x" + rlp(value).hex()
        theirs = _cast(["to-rlp", literal])
        if mine != theirs:
            failures.append("rlp(%s): ours %s != cast %s" % (literal, mine, theirs))

    if EMPTY_TRIE_ROOT.hex() != "56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421":
        failures.append("empty trie root wrong: %s" % EMPTY_TRIE_ROOT.hex())

    if rpc:
        failures += _selftest_trie_against_anvil(rpc)
    else:
        failures.append("no --rpc given: the trie builder was NOT checked against a client")

    for line in failures:
        print("SELFTEST FAIL: " + line)
    if failures:
        return 1
    print("SELFTEST OK: keccak/RLP match cast, trie root matches the client's stateRoot")
    return 0


def main(argv):
    if "--selftest" in argv:
        rpc = ""
        if "--rpc" in argv:
            rpc = argv[argv.index("--rpc") + 1]
        return _selftest(rpc)
    if "--genesis" in argv:
        path = argv[argv.index("--genesis") + 1]
        with open(path, "r", encoding="utf-8") as fh:
            print("0x" + state_root_from_genesis(json.load(fh)).hex())
        return 0
    print("usage: statetrie.py --selftest --rpc URL | --genesis path/to/genesis.json")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
