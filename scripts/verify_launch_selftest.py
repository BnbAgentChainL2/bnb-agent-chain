#!/usr/bin/env python3
"""verify_launch_selftest.py — prove scripts/verify_launch.py's check logic without a chain.

It builds an in-memory mock of every read verify_launch.py makes (a healthy launch), runs the
verifier against it, then breaks one thing at a time and asserts that the matching hard stop —
and only that hard stop — fires. No network, no keys, no broadcast; it never touches BSC.

    python scripts/verify_launch_selftest.py [-v]

Exit code 0 = every scenario behaved as expected.
"""
from __future__ import annotations

import io
import json
import os
import contextlib
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import verify_launch as V  # noqa: E402

# ── fake addresses (never real; 0x…dead endings make that obvious in output) ────────────────
TOKEN = "0x1111111111111111111111111111111111117777"
VAULT = "0x2222222222222222222222222222222222222222"
FACTORY = "0x3333333333333333333333333333333333333333"
BEACON = "0x4444444444444444444444444444444444444444"
IMPL = "0x4545454545454545454545454545454545454545"
BRIDGE = "0x5555555555555555555555555555555555555555"
NODEFUND = "0x6666666666666666666666666666666666666666"
ANCHOR = "0x7777777777777777777777777777777777777777"
STAKING = "0x8888888888888888888888888888888888888888"
REGISTRY = "0x9999999999999999999999999999999999999999"
TAXPROC = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
DIVIDEND = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
NF_OWNER = "0xcccccccccccccccccccccccccccccccccccccccc"
VAULT_OWNER = "0xdddddddddddddddddddddddddddddddddddddddd"
LAUNCHER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
RELAYER = "0x000000000000000000000000000000000000e1a4"
GENESIS_HASH = "0x" + "ab" * 32

FLOAT = V.OPERATOR_FLOAT


# ── tiny ABI encoder ────────────────────────────────────────────────────────────────────────
def w(v):
    if isinstance(v, str) and v.startswith("0x"):
        v = int(v, 16)
    return format(int(v) & (2**256 - 1), "064x")


def words(*vals):
    return "0x" + "".join(w(v) for v in vals)


def enc_str(s):
    b = s.encode()
    pad = (-len(b)) % 32
    return "0x" + w(0x20) + w(len(b)) + b.hex() + "00" * pad


def enc_vault_info(vault, factory, desc, official, risk):
    """abi.encode(VaultInfo{address,address,string,bool,uint8}) as a single return value."""
    body = w(vault) + w(factory) + w(0xA0) + w(1 if official else 0) + w(risk)
    b = desc.encode()
    pad = (-len(b)) % 32
    body += w(len(b)) + b.hex() + "00" * pad
    return "0x" + w(0x20) + body


def sel(sig):
    return "0x" + V.SEL[sig]


def call_key(addr, sig):
    return f"{addr.lower()}|{sel(sig)}"


def call_key_arg(addr, sig, arg):
    return f"{addr.lower()}|{sel(sig)}{V.enc_addr(arg)}"


def description(bridge=BRIDGE, nodefund=NODEFUND, nf_owner=NF_OWNER, vault_owner=VAULT_OWNER):
    """Same shape as BacVaultUI._rules(), with both anchors verify_launch.py looks for."""
    return (
        "BNB Agent Chain treasury vault for BAC: balance 0.0000 BNB. | "
        "Income split after Flap's 10% protocol fee: 50.00% bridge pool (BacBridge `"
        + bridge.lower()
        + "`, agent exits only) / 50.00% official node fund (BacNodeFund `"
        + nodefund.lower()
        + "`, "
        + V.NODEFUND_OWNER_ANCHOR.format(addr=nf_owner.lower())
        + " — a separate, transferable address, not this vault's owner `"
        + vault_owner.lower()
        + "`, which has no power over any funds). No promised return. / "
        "扣除 Flap 10% 协议费后的分账：50.00% 桥池（BacBridge `"
        + bridge.lower()
        + "`，只用于 agent 退出）/ 50.00% 官方节点基金（BacNodeFund `"
        + nodefund.lower()
        + "`，"
        + V.NODEFUND_OWNER_ANCHOR_CN.format(addr=nf_owner.lower())
        + " —— 这是一个独立的、可转让的地址，不是本金库的 owner `"
        + vault_owner.lower()
        + "`）。不承诺任何收益。"
    )


def healthy():
    """A launch where all 14 items pass (and the operator float is already locked)."""
    token_v8 = words(1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 200, 200, 0, 5 * 10**17, 0, 0)
    calls = {
        # VaultPortal / Portal
        call_key_arg(V.VAULT_PORTAL, "getVault(address)", TOKEN): enc_vault_info(
            VAULT, FACTORY, "BNB Agent Chain treasury vault", False, 0
        ),
        call_key_arg(V.PORTAL, "getTokenV8Safe(address)", TOKEN): token_v8,
        # token
        call_key(TOKEN, "name()"): enc_str("BNB Agent Chain"),
        call_key(TOKEN, "symbol()"): enc_str("BAC"),
        call_key(TOKEN, "decimals()"): words(18),
        call_key(TOKEN, "totalSupply()"): words(10**27),
        call_key(TOKEN, "taxRate()"): words(200),
        call_key(TOKEN, "buyTaxRate()"): words(200),
        call_key(TOKEN, "sellTaxRate()"): words(200),
        call_key(TOKEN, "taxProcessor()"): words(TAXPROC),
        call_key(TOKEN, "dividendContract()"): words(DIVIDEND),
        call_key(TOKEN, "antiFarmerDuration()"): words(86400),
        call_key(TOKEN, "state()"): words(0),
        call_key_arg(TOKEN, "balanceOf(address)", VAULT): words(0),
        # TaxProcessor
        call_key(TAXPROC, "marketAddress()"): words(VAULT),
        call_key(TAXPROC, "feeConfigV2()"): words(10000, 0, 0, 0, 1000, 1, 0, 0),
        call_key(TAXPROC, "commissionReceiver()"): words(0),
        # vault
        call_key(VAULT, "taxToken()"): words(TOKEN),
        call_key(VAULT, "bridge()"): words(BRIDGE),
        call_key(VAULT, "nodeFund()"): words(NODEFUND),
        call_key(VAULT, "owner()"): words(VAULT_OWNER),
        call_key(VAULT, "vaultQuoteToken()"): words(0),
        call_key(VAULT, "vaultSpecVersion()"): enc_str("v3"),
        call_key(VAULT, "solvency()"): words(0, 0, 0),
        call_key(VAULT, "stuckAmounts()"): words(0, 0),
        call_key(VAULT, "unsplitRevenue()"): words(0),
        call_key(VAULT, "lifetimeToBridge()"): words(0),
        call_key(VAULT, "lifetimeToNodeFund()"): words(0),
        call_key(VAULT, "totalRecognized()"): words(0),
        call_key(VAULT, "description()"): enc_str(description()),
        # factory + beacon
        call_key(FACTORY, "beacon()"): words(BEACON),
        call_key(FACTORY, "isVaultUpgradesLocked()"): words(0),
        call_key(FACTORY, "factorySpecVersion()"): enc_str("v2.3"),
        call_key(FACTORY, "beaconImplementation()"): words(IMPL),
        call_key(FACTORY, "LAUNCHER()"): words(LAUNCHER),
        call_key(FACTORY, "REQUIRED_MKT_BPS()"): words(10000),
        call_key(FACTORY, "REQUIRED_BUY_TAX_BPS()"): words(200),
        call_key(FACTORY, "REQUIRED_SELL_TAX_BPS()"): words(200),
        call_key_arg(FACTORY, "isQuoteTokenSupported(address)", V.ZERO): words(1),
        call_key(BEACON, "owner()"): words(FACTORY),
        # bridge / node fund / staking / anchor / registry
        call_key(BRIDGE, "bacToken()"): words(TOKEN),
        call_key(BRIDGE, "anchor()"): words(ANCHOR),
        call_key(BRIDGE, "registry()"): words(REGISTRY),
        call_key(BRIDGE, "totalLocked()"): words(FLOAT),
        call_key(BRIDGE, "totalCreditsIssued()"): words(FLOAT),
        call_key(BRIDGE, "poolBalance()"): words(0),
        call_key(BRIDGE, "isPaused()"): words(0, 0, 0),
        call_key(NODEFUND, "bacToken()"): words(TOKEN),
        call_key(NODEFUND, "owner()"): words(NF_OWNER),
        call_key(NODEFUND, "balance()"): words(0),
        call_key(STAKING, "bacToken()"): words(TOKEN),
        call_key(ANCHOR, "lastFinalCirculating()"): words(FLOAT),
        call_key(ANCHOR, "validatorStaking()"): words(STAKING),
        call_key(ANCHOR, "relayer()"): words(RELAYER),
        call_key(ANCHOR, "admin()"): words(0),
        call_key(ANCHOR, "vetoKey()"): words(0),
        call_key(ANCHOR, "lastPostedEpoch()"): words(0),
        call_key(ANCHOR, "lastFinalEpoch()"): words(0),
        call_key(REGISTRY, "vaultSink()"): words(VAULT),
    }
    code = {a.lower(): "0x60006000" for a in (TOKEN, VAULT, FACTORY, BEACON, BRIDGE, NODEFUND, ANCHOR, STAKING, REGISTRY, TAXPROC)}
    bsc = {
        "chainId": hex(56),
        "blockNumber": hex(12345678),
        "code": code,
        "storage": {f"{VAULT.lower()}|{V.BEACON_SLOT}": w(BEACON)},
        "calls": calls,
    }
    layer = {
        "chainId": hex(V.LAYER_CHAIN_ID),
        "blockNumber": hex(605),
        "blocks": {"0x0": {"hash": GENESIS_HASH}},
        "code": {
            V.L2_BRIDGE: "0x" + "60" * 4825,
            V.L2_GATE: "0x" + "60" * 1695,
            V.AGENT_BOOK: "0x" + "60" * 2972,
            V.FEE_SPLITTER: "0x" + "60" * 900,
        },
        "calls": {
            call_key(V.L2_BRIDGE, "BSC_BRIDGE()"): words(BRIDGE),
            call_key(V.L2_BRIDGE, "relayer()"): words(RELAYER),
            call_key(V.L2_BRIDGE, "GENESIS_RELAYER()"): words(RELAYER),
            call_key(V.L2_BRIDGE, "reserve()"): words(10**27 - FLOAT),
        },
    }
    return {"bsc": bsc, "layer": layer}


# ── the scenarios ───────────────────────────────────────────────────────────────────────────
def run(fixture, extra_args, verbose=False):
    """Run verify_launch.main() against a fixture; return (exit code, stdout)."""
    fd, path = tempfile.mkstemp(suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(fixture, fh)
        argv = [
            "--token", TOKEN,
            "--factory", FACTORY,
            "--bridge", BRIDGE,
            "--nodefund", NODEFUND,
            "--launcher", LAUNCHER,
            "--owner", VAULT_OWNER,
            "--mock", path,
            "--dry-run",
        ] + extra_args
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            try:
                rc = V.main(argv)
            except V.Stop as e:
                print(e)
                rc = 2
        out = buf.getvalue()
        if verbose:
            print(out)
        return rc, out
    finally:
        os.unlink(path)


def scenarios():
    """(name, mutate(fixture), expected exit code, substring that must appear in the output)."""

    def mut(fn):
        def inner(f):
            fn(f)
            return f

        return inner

    def c(f, key, value):
        f["bsc"]["calls"][key] = value

    return [
        ("healthy launch phase", lambda f: f, 0, "all hard checks passed"),
        (
            "01 factory not the one we deployed",
            mut(lambda f: c(f, call_key_arg(V.VAULT_PORTAL, "getVault(address)", TOKEN),
                            enc_vault_info(VAULT, "0x" + "12" * 20, "x", False, 0))),
            2, "01_factoryMatches",
        ),
        (
            "02 tax routed away from the vault",
            mut(lambda f: c(f, call_key(TAXPROC, "marketAddress()"), words("0x" + "12" * 20))),
            2, "02_marketAddressIsVault",
        ),
        (
            "03 vault serves a different token",
            mut(lambda f: c(f, call_key(VAULT, "taxToken()"), words("0x" + "12" * 20))),
            2, "03_vaultTaxTokenMatches",
        ),
        (
            "04 beacon slot does not match factory.beacon()",
            mut(lambda f: f["bsc"]["storage"].update({f"{VAULT.lower()}|{V.BEACON_SLOT}": w("0x" + "12" * 20)})),
            2, "04_beaconSlotMatches",
        ),
        (
            "05 beacon owned by someone other than the factory",
            mut(lambda f: c(f, call_key(BEACON, "owner()"), words("0x" + "12" * 20))),
            2, "05_beaconOwnedByFactory",
        ),
        (
            "06 holder dividends are on",
            mut(lambda f: c(f, call_key(TAXPROC, "feeConfigV2()"), words(8000, 0, 0, 2000, 1000, 1, 0, 0))),
            2, "06_taxSplit",
        ),
        (
            "06 commission receiver takes a cut",
            mut(lambda f: c(f, call_key(TAXPROC, "feeConfigV2()"), words(10000, 0, 0, 0, 1000, 1, 300, 0))),
            2, "06_taxSplit",
        ),
        (
            "07 factory reports the wrong spec version",
            mut(lambda f: c(f, call_key(FACTORY, "factorySpecVersion()"), enc_str("v2.2"))),
            2, "07_specVersions",
        ),
        (
            "07 vault quotes WBNB instead of native BNB",
            mut(lambda f: c(f, call_key(VAULT, "vaultQuoteToken()"),
                            words("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"))),
            2, "07_specVersions",
        ),
        (
            "08 vault points at a stranger's bridge",
            mut(lambda f: c(f, call_key(VAULT, "bridge()"), words("0x" + "12" * 20))),
            2, "08_vaultWiring",
        ),
        (
            "09 BacNodeFund bound to another token",
            mut(lambda f: c(f, call_key(NODEFUND, "bacToken()"), words("0x" + "12" * 20))),
            2, "09_tokenImmutables",
        ),
        (
            "09 ValidatorStaking never bound to the anchor",
            mut(lambda f: c(f, call_key(ANCHOR, "validatorStaking()"), words(0))),
            2, "09_tokenImmutables",
        ),
        (
            "10 solvency broken (buckets exceed accounted)",
            mut(lambda f: c(f, call_key(VAULT, "solvency()"), words(10**18, 10**18, 2 * 10**18))),
            2, "10_solvency",
        ),
        (
            "11 taxDuration expired — token is TaxFree",
            mut(lambda f: c(f, call_key(TOKEN, "state()"), words(4))),
            2, "11_taxLive",
        ),
        (
            "11 buy tax is not 2%",
            mut(lambda f: c(f, call_key(TOKEN, "buyTaxRate()"), words(300))),
            2, "11_taxLive",
        ),
        (
            "13 banner names the vault owner as the node-fund withdrawer",
            mut(lambda f: c(f, call_key(VAULT, "description()"),
                            enc_str(description(nf_owner=VAULT_OWNER)))),
            2, "13_descriptionNamesNodeFundOwner",
        ),
        (
            "13 description() reverts (Flap rule 001)",
            mut(lambda f: c(f, call_key(VAULT, "description()"), {"revert": "execution reverted"})),
            2, "13_descriptionNamesNodeFundOwner",
        ),
        (
            "registry vaultSink points somewhere else",
            mut(lambda f: c(f, call_key(REGISTRY, "vaultSink()"), words("0x" + "12" * 20))),
            2, "AgentRegistry.vaultSink()",
        ),
        (
            "12 antiFarmerDuration drifted (rat's real failure) — DIFF, not a stop",
            mut(lambda f: c(f, call_key(TOKEN, "antiFarmerDuration()"), words(2592000))),
            0, "DIFF antiFarmerDuration",
        ),
        (
            "14 operator float not locked yet — PENDING under --phase launch",
            mut(lambda f: c(f, call_key(BRIDGE, "totalCreditsIssued()"), words(0))),
            0, "PENDING:",
        ),
    ]


def genesis_scenarios():
    def mut(fn):
        def inner(f):
            fn(f)
            return f

        return inner

    args = ["--phase", "genesis", "--genesis-hash", GENESIS_HASH]
    return [
        ("genesis phase, healthy", lambda f: f, args, 0, "all hard checks passed"),
        (
            "L2 the node is running a different genesis",
            mut(lambda f: f["layer"]["blocks"].__setitem__("0x0", {"hash": "0x" + "cd" * 32})),
            args, 2, "L2_genesisHash",
        ),
        (
            "L2 no published genesis hash to compare against",
            lambda f: f,
            ["--phase", "genesis", "--genesis-manifest", os.path.join(HERE, "__no_such_manifest__.json")],
            2, "L2_genesisHash",
        ),
        (
            "L1 wrong layer chain id",
            mut(lambda f: f["layer"].__setitem__("chainId", hex(56778))),
            args, 2, "L1_layerChainId",
        ),
        (
            "L3 layer L2Bridge bound to a different BacBridge",
            mut(lambda f: f["layer"]["calls"].__setitem__(call_key(V.L2_BRIDGE, "BSC_BRIDGE()"), words("0x" + "12" * 20))),
            args, 2, "L3_bridgeBinding",
        ),
        (
            "L4 FeeSplitter missing from genesis (decision #17)",
            mut(lambda f: f["layer"]["code"].pop(V.FEE_SPLITTER)),
            args, 2, "L4_systemContracts",
        ),
        (
            "L4 something squatted the reserved 0x…0105",
            mut(lambda f: f["layer"]["code"].__setitem__(V.RESERVED_0105, "0x6001")),
            args, 2, "L4_systemContracts",
        ),
        (
            "14 operator float not locked — a hard stop at genesis time",
            mut(lambda f: f["bsc"]["calls"].__setitem__(call_key(BRIDGE, "totalCreditsIssued()"), words(0))),
            args, 2, "14_operatorFloatBacked",
        ),
    ]


def main(argv=None):
    verbose = "-v" in (argv or sys.argv[1:])
    failures = []
    total = 0

    print("== verify_launch selftest (offline; no RPC, no keys, nothing sent) ==\n")
    for name, mutate, want_rc, want_text in scenarios():
        total += 1
        rc, out = run(mutate(healthy()), [], verbose)
        ok = rc == want_rc and want_text in out
        print(f"  {'PASS' if ok else 'FAIL'}  [launch] {name}  (exit {rc}, wanted {want_rc})")
        if not ok:
            failures.append((name, rc, want_rc, want_text, out))

    for name, mutate, extra, want_rc, want_text in genesis_scenarios():
        total += 1
        rc, out = run(mutate(healthy()), extra, verbose)
        ok = rc == want_rc and want_text in out
        print(f"  {'PASS' if ok else 'FAIL'}  [genesis] {name}  (exit {rc}, wanted {want_rc})")
        if not ok:
            failures.append((name, rc, want_rc, want_text, out))

    # --strict must turn a planned-value DIFF into exit 1
    total += 1
    f = healthy()
    f["bsc"]["calls"][call_key(TOKEN, "antiFarmerDuration()")] = words(2592000)
    rc, out = run(f, ["--strict"], verbose)
    ok = rc == 1
    print(f"  {'PASS' if ok else 'FAIL'}  [launch] --strict turns a planned-value DIFF into exit 1  (exit {rc}, wanted 1)")
    if not ok:
        failures.append(("--strict", rc, 1, "", out))

    # a missing pinned address must be refused, never silently read off the chain
    total += 1
    fd, path = tempfile.mkstemp(suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(healthy(), fh)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        try:
            rc = V.main(["--token", TOKEN, "--factory", FACTORY, "--mock", path, "--dry-run"])
        except V.Stop as e:
            print(e)
            rc = 2
    os.unlink(path)
    ok = rc == 2 and "must be the 0x address we deployed" in buf.getvalue()
    print(f"  {'PASS' if ok else 'FAIL'}  [input] refuses to run without --bridge / --nodefund  (exit {rc}, wanted 2)")
    if not ok:
        failures.append(("missing pinned address", rc, 2, "", buf.getvalue()))

    print(f"\n{total - len(failures)}/{total} scenarios behaved as expected")
    for name, rc, want_rc, want_text, out in failures:
        print(f"\n--- FAILED: {name} (exit {rc}, wanted {want_rc}, wanted text {want_text!r}) ---")
        print(out)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
