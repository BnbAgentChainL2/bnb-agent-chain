#!/usr/bin/env python3
"""verify_launch.py — read-only post-launch verification of BNB Agent Chain (BAC).

Adapted from rat/scripts/verify_launch.py to our eleven contracts. It implements the
hard-stop list of docs/00-DESIGN-SPEC.md §7.3 (14 items) plus the layer-side genesis
checks, and it writes a JSON snapshot of everything the website must show from chain
values rather than from a plan.

Usage
  python scripts/verify_launch.py --token 0x...7777 --factory 0x... --bridge 0x... --nodefund 0x...
         [--rpc URL]... [--registry 0x...] [--anchor 0x...] [--staking 0x...]
         [--phase launch|genesis] [--layer-rpc URL]... [--genesis-hash 0x...]
         [--genesis-manifest chain/build/genesis-manifest.json] [--no-layer]
         [--out PATH] [--dry-run] [--strict] [--mock FIXTURE.json]
         [planned: --name "BNB Agent Chain" --symbol BAC --buy 200 --sell 200 --mkt 10000
          --defl 0 --lp 0 --div 0 --commission 0 --antifarmer 86400 --launcher 0x... --owner 0x...]

Two phases, because the real order is: deploy BSC → launch on flap.sh → verify → build
genesis with the real addresses → boot Besu → relayer → indexer → site.
  --phase launch  (default)  items 1–13 are hard stops; item 14 (the operator float and
                             ChainAnchor.lastFinalCirculating) is reported as PENDING,
                             because the float can only be locked once BAC exists; the
                             layer does not exist yet, so the layer block is skipped.
  --phase genesis            items 1–14 are hard stops AND the layer block is enforced:
                             layer chain id, the published genesis hash, and the layer
                             L2Bridge bound to this exact BacBridge.

Hard stops (exit code 2, nothing is written) — docs/00-DESIGN-SPEC.md §7.3:
   1 VaultPortal.getVault(token).vaultFactory == --factory
   2 TaxProcessor(token.taxProcessor()).marketAddress() == the vault   (unfixable; relaunch only)
   3 vault.taxToken() == token
   4 storage[vault][0xa3f0ad74…33d50] == factory.beacon(), and the beacon is not 0x0
   5 beacon.owner() == factory                                          (unless upgrades are locked)
   6 feeConfigV2: dividendBps == 0, marketBps == 10000, commissionBps == 0 (feeRate recorded)
   7 vault.vaultQuoteToken() == 0x0, vault.vaultSpecVersion() == "v3", factory.factorySpecVersion() == "v2.3"
   8 vault.bridge() == --bridge and vault.nodeFund() == --nodefund
   9 BacBridge.bacToken() == BacNodeFund.bacToken() == ValidatorStaking.bacToken() == token
  10 vault.solvency(): balance >= accounted and accounted == unsplit + stuckBridge + stuckNodeFund
  11 token.state() is never TaxFree, and taxRate/buyTaxRate/sellTaxRate are all 200
  12 antiFarmerDuration() equals the planned constant   (DIFF row; a stop only under --strict)
  13 BacNodeFund.owner() reads, and vault.description() names THAT address as the node-fund
     withdrawer, verbatim (not the vault's own owner)
  14 ChainAnchor.lastFinalCirculating() == 1000e18 and BacBridge.totalCreditsIssued() >= 1000e18
     (PENDING under --phase launch, hard stop under --phase genesis)
  L1 layer chain id == 56777
  L2 layer block 0 hash == the published genesis hash
  L3 layer L2Bridge(0x…0101).BSC_BRIDGE() == --bridge
  L4 the genesis system contracts have code at 0x…0101/0102/0103/0104 and 0x…0105 has none

Recorded, never enforced (the website must render these from chain, not from the plan):
  name/symbol exact case, buy/sell tax, the five bps, feeRate, antiFarmerDuration, riskLevel,
  vault owner, BacNodeFund.owner(), the VaultPortal description, pool state, progress.
  taxDuration is NOT readable on chain anywhere (IFlapTaxTokenV3 has no view for it and
  TokenStateV8Safe does not carry it). The only evidence it was typed correctly is that
  state() never becomes TaxFree — so this script must keep being run, forever.

Only eth_chainId, eth_blockNumber, eth_getCode, eth_getStorageAt, eth_getBlockByNumber and
eth_call are used. Nothing is signed or sent, no private key or .env file is read. Standard
library only (Python 3.8+).
Exit codes: 0 ok, 1 planned-value differences with --strict, 2 hard stop / bad input / RPC failure.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

# ── BSC mainnet protocol constants (measured 2026-09-22, docs/research/09-chain-truth.md) ──
VAULT_PORTAL = "0x90497450f2a706f1951b5bdda52B4E5d16f34C06"  # Flap VaultPortal 1.15.0
PORTAL = "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0"  # Flap Portal v5.24.0
GUARDIAN = "0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b"
BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50"
ZERO = "0x" + "0" * 40
BSC_CHAIN_ID = 56

# ── our chain (docs/02-CHAIN-SPEC.md §1–§2) ──
LAYER_CHAIN_ID = 56777
L2_BRIDGE = "0x0000000000000000000000000000000000000101"
L2_GATE = "0x0000000000000000000000000000000000000102"
AGENT_BOOK = "0x0000000000000000000000000000000000000103"
FEE_SPLITTER = "0x0000000000000000000000000000000000000104"  # decision #17
RESERVED_0105 = "0x0000000000000000000000000000000000000105"  # must stay empty at genesis
OPERATOR_FLOAT = 1000 * 10**18
LAYER_TOTAL_SUPPLY = 10**27

DEFAULT_RPCS = ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org"]
DEFAULT_LAYER_RPCS = ["https://bnbagentchain-rpc.xyz/rpc", "https://95-179-183-132.sslip.io/rpc"]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, "artifacts", "verify", "launch-snapshot.json")
DEFAULT_MANIFEST = os.path.join(ROOT, "chain", "build", "genesis-manifest.json")

# planned launch form — keep in sync with scripts/sim_launch.sh and
# contracts/test/BacForkLaunch.t.sol. These are NOT chain truth; they only produce DIFF rows.
PLANNED = {
    "name": "BNB Agent Chain",
    "symbol": "BAC",
    "buyTaxBps": 200,
    "sellTaxBps": 200,
    "marketBps": 10000,
    "deflationBps": 0,
    "lpBps": 0,
    "dividendBps": 0,
    "commissionBps": 0,
    "antiFarmerDuration": 86400,  # 1 day
    "launcher": None,  # factory.LAUNCHER(), compared only when given
    "owner": None,  # vault owner; 0x0 in the form means "the launching wallet"
}

# function selectors (keccak256 of the signature, first 4 bytes; produced with `cast sig`)
SEL = {
    # ERC20 / Flap Tax Token V3
    "name()": "06fdde03",
    "symbol()": "95d89b41",
    "decimals()": "313ce567",
    "totalSupply()": "18160ddd",
    "balanceOf(address)": "70a08231",
    "taxRate()": "771a3a1d",
    "buyTaxRate()": "691f224f",
    "sellTaxRate()": "24024efd",
    "taxProcessor()": "f3635019",
    "dividendContract()": "6124e4e7",
    "antiFarmerDuration()": "7f3e1969",
    "state()": "c19d93fb",
    "metaURI()": "67605787",
    # TaxProcessor
    "marketAddress()": "95623641",
    "feeConfigV2()": "8856bc58",
    "commissionReceiver()": "f92aa57f",
    "dividendAddress()": "546d08fe",
    # Flap portals
    "getVault(address)": "0eb9af38",
    "getTokenV8Safe(address)": "62fafcca",
    # BacTreasuryVault
    "taxToken()": "1fc928ae",
    "bridge()": "e78cea92",
    "nodeFund()": "e93e1556",
    "owner()": "8da5cb5b",
    "accountedQuote()": "1bb3bff3",
    "unsplitRevenue()": "a80db54a",
    "stuckAmounts()": "0ab5a134",
    "lifetimeToBridge()": "f73a8bf8",
    "lifetimeToNodeFund()": "e7621a1b",
    "totalRecognized()": "5cdbbb5f",
    "solvency()": "773c5049",
    "vaultQuoteToken()": "23417f58",
    "vaultSpecVersion()": "87b690a7",
    "description()": "7284e416",
    # BacVaultFactory
    "beacon()": "59659e90",
    "beaconImplementation()": "28609983",
    "factorySpecVersion()": "a7b32ef0",
    "isVaultUpgradesLocked()": "d37d438b",
    "LAUNCHER()": "7b7159bf",
    "REQUIRED_MKT_BPS()": "a1a773ce",
    "REQUIRED_BUY_TAX_BPS()": "29ea9db6",
    "REQUIRED_SELL_TAX_BPS()": "404cc464",
    "isQuoteTokenSupported(address)": "b62a4f9a",
    # BacBridge / BacNodeFund / ValidatorStaking / ChainAnchor / AgentRegistry
    "bacToken()": "c586f517",
    "registry()": "7b103999",
    "anchor()": "d3fb73b4",
    "watchdog()": "5ebad250",
    "totalCreditsIssued()": "2008d7a0",
    "totalLocked()": "56891412",
    "poolBalance()": "96365d44",
    "isPaused()": "b187bd26",
    "balance()": "b69ef8a8",
    "totalStaked()": "817b1cd2",
    "relayer()": "8406c079",
    "validatorStaking()": "06424db5",
    "lastFinalCirculating()": "12019fcb",
    "initialCirculating()": "70f5f07e",
    "lastFinalEpoch()": "0c2b67b0",
    "lastPostedEpoch()": "ff1109cd",
    "vaultSink()": "b3dc0c93",
    "admin()": "f851a440",
    "vetoKey()": "7208d5ac",
    # layer
    "BSC_BRIDGE()": "ca7b9a51",
    "LAYER_CHAIN_ID()": "d79dfbf7",
    "GENESIS_RELAYER()": "0b83e1af",
    "ROTATION_SIGNER()": "55770c10",
    "reserve()": "cd3293de",
}

TOKEN_STATE = {0: "BondingCurve", 1: "Migrating", 2: "TaxEnforcedAntiFarmer", 3: "TaxEnforced", 4: "TaxFree"}
PORTAL_STATUS = {0: "Invalid", 1: "Tradable", 2: "InDuel", 3: "Killed", 4: "DEX", 5: "Staged"}
RISK = {0: "UNVERIFIED", 1: "LOW_RISK", 2: "LOW_MEDIUM_RISK", 3: "MEDIUM_RISK", 4: "HIGH_RISK"}

# The exact English anchor rendered by BacVaultUI._rules() around the node-fund withdrawer.
# Item 13 of the hard-stop list is "the address in the banner IS BacNodeFund.owner()".
NODEFUND_OWNER_ANCHOR = "withdrawable by that contract's owner `{addr}`"
NODEFUND_OWNER_ANCHOR_CN = "由该合约的 owner `{addr}` 提取"


class RpcError(Exception):
    pass


class Stop(Exception):
    """Hard stop or bad input: printed as STOP / ERROR, exit code 2."""


class Reverted(Exception):
    pass


# ── RPC ─────────────────────────────────────────────────────────────────────────────────────────
class Rpc:
    """Minimal JSON-RPC client with retries (Cloudflare pages, 403/429, 5xx, timeouts) and URL rotation."""

    def __init__(self, urls, retries=4, timeout=30, label="bsc"):
        self.urls = list(urls)
        self.retries = retries
        self.timeout = timeout
        self.label = label
        self.used = self.urls[0] if self.urls else ""
        self._id = 0

    def request(self, method, params):
        last = None
        for attempt in range(self.retries * max(1, len(self.urls))):
            url = self.urls[attempt % len(self.urls)]
            self._id += 1
            body = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params}).encode()
            req = urllib.request.Request(
                url,
                data=body,
                headers={"Content-Type": "application/json", "User-Agent": "bac-verify-launch/1.0"},
            )
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    raw = r.read().decode("utf-8", "replace")
            except urllib.error.HTTPError as e:
                last = f"HTTP {e.code} from {url}"
                if e.code in (403, 408, 425, 429) or e.code >= 500:
                    time.sleep(min(2 * (attempt + 1), 10))
                    continue
                raise RpcError(last)
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
                last = f"{type(e).__name__}: {e} ({url})"
                time.sleep(min(2 * (attempt + 1), 10))
                continue
            head = raw.lstrip()
            if head.startswith("<") or (not head.startswith("{") and "cloudflare" in raw.lower()[:2000]):
                last = f"non-JSON answer (Cloudflare?) from {url}"
                time.sleep(min(2 * (attempt + 1), 10))
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                last = f"bad JSON from {url}: {raw[:120]!r}"
                time.sleep(1)
                continue
            if "error" in msg and msg["error"]:
                err = msg["error"]
                text = str(err.get("message", err))
                if "revert" in text.lower() or "execution reverted" in text.lower():
                    raise Reverted(f"{text} {err.get('data', '')}".strip())
                if any(k in text.lower() for k in ("rate", "limit", "too many", "timeout", "busy", "capacity")):
                    last = f"{text} ({url})"
                    time.sleep(min(2 * (attempt + 1), 10))
                    continue
                raise RpcError(f"{method}: {text}")
            self.used = url
            return msg.get("result")
        raise RpcError(f"{method} failed after retries: {last}")

    def call(self, to, data, block="latest"):
        res = self.request("eth_call", [{"to": to, "data": data}, block])
        if not isinstance(res, str) or not res.startswith("0x"):
            raise RpcError(f"eth_call {to}: unexpected result {res!r}")
        return bytes.fromhex(res[2:])


class MockRpc:
    """Offline replacement for Rpc, reading every answer from a JSON fixture.

    Fixture shape (all keys lower-case hex):
      {"chainId": "0x38", "blockNumber": "0x1",
       "code":    {"<addr>": "0x60..."},
       "storage": {"<addr>|<slot>": "0x..."},
       "calls":   {"<addr>|<full calldata>": "0x<abi>" | {"revert": "..."} },
       "blocks":  {"0x0": {"hash": "0x..."}}}
    A call is looked up by full calldata first, then by the 4-byte selector alone.
    Used by scripts/verify_launch_selftest.py to prove the check logic without a chain.
    """

    def __init__(self, fixture, label="mock"):
        self.f = fixture
        self.label = label
        self.used = f"mock:{label}"

    def request(self, method, params):
        if method == "eth_chainId":
            return self.f.get("chainId", "0x0")
        if method == "eth_blockNumber":
            return self.f.get("blockNumber", "0x0")
        if method == "eth_getCode":
            return self.f.get("code", {}).get(params[0].lower(), "0x")
        if method == "eth_getStorageAt":
            return self.f.get("storage", {}).get(f"{params[0].lower()}|{params[1].lower()}", "0x" + "0" * 64)
        if method == "eth_getBlockByNumber":
            b = self.f.get("blocks", {}).get(params[0].lower())
            if b is None:
                raise RpcError(f"mock: no block {params[0]}")
            return b
        if method == "eth_call":
            to = params[0]["to"].lower()
            data = params[0]["data"].lower()
            calls = self.f.get("calls", {})
            hit = calls.get(f"{to}|{data}")
            if hit is None:
                hit = calls.get(f"{to}|{data[:10]}")
            if hit is None:
                raise Reverted(f"mock: no answer for {to} {data[:10]}")
            if isinstance(hit, dict):
                raise Reverted(hit.get("revert", "mock revert"))
            return hit
        raise RpcError(f"mock: unsupported method {method}")

    def call(self, to, data, block="latest"):
        res = self.request("eth_call", [{"to": to, "data": data}, block])
        return bytes.fromhex(res[2:])


# ── ABI helpers ─────────────────────────────────────────────────────────────────────────────────
def is_addr(a):
    return isinstance(a, str) and re.fullmatch(r"0x[0-9a-fA-F]{40}", a) is not None


def is_hash(h):
    return isinstance(h, str) and re.fullmatch(r"0x[0-9a-fA-F]{64}", h) is not None


def enc_addr(a):
    return a.lower()[2:].rjust(64, "0")


def word(data, i):
    b = data[32 * i : 32 * (i + 1)]
    if len(b) != 32:
        raise RpcError(f"short return data ({len(data)} bytes, wanted word {i})")
    return int.from_bytes(b, "big")


def as_addr(v):
    return "0x" + format(v & ((1 << 160) - 1), "040x")


def _tuple_string(t, index):
    """The string whose offset (relative to the start of `t`) is in head word `index`."""
    off = word(t, index)
    n = int.from_bytes(t[off : off + 32], "big")
    return t[off + 32 : off + 32 + n].decode("utf-8", "replace")


def dec_string(data):
    return _tuple_string(data, 0)


def same(a, b):
    return isinstance(a, str) and isinstance(b, str) and a.lower() == b.lower()


def bnb(wei):
    """Exact decimal string of a wei amount in BNB, trailing zeros trimmed."""
    q, r = divmod(int(wei), 10**18)
    if r == 0:
        return str(q)
    return f"{q}.{str(r).rjust(18, '0').rstrip('0')}"


class Chain:
    def __init__(self, rpc):
        self.rpc = rpc

    def raw(self, to, sig, *args):
        return self.rpc.call(to, "0x" + SEL[sig] + "".join(args))

    def uint(self, to, sig, *args):
        return word(self.raw(to, sig, *args), 0)

    def addr(self, to, sig, *args):
        return as_addr(self.uint(to, sig, *args))

    def boolean(self, to, sig, *args):
        return self.uint(to, sig, *args) != 0

    def string(self, to, sig, *args):
        return dec_string(self.raw(to, sig, *args))

    def code_size(self, a):
        code = self.rpc.request("eth_getCode", [a, "latest"])
        return (len(code) - 2) // 2 if isinstance(code, str) and code.startswith("0x") else 0

    def storage(self, a, slot):
        v = self.rpc.request("eth_getStorageAt", [a, slot, "latest"])
        return int(v, 16)


# ── BSC-side verification ───────────────────────────────────────────────────────────────────────
def verify_bsc(chain, token, pinned, plan, phase):
    """Items 1–14. Returns (snapshot, stops, pending). `pinned` holds the addresses we deployed."""
    stops = []
    pending = []
    snap = {}
    checks = {}

    def check(key, ok, detail=""):
        checks[key] = bool(ok)
        if not ok:
            stops.append(f"[{key}] {detail}")
        return ok

    chain_id = int(chain.rpc.request("eth_chainId", []), 16)
    block = int(chain.rpc.request("eth_blockNumber", []), 16)
    check("00_chainIsBsc", chain_id == BSC_CHAIN_ID, f"RPC chain id is {chain_id}, not {BSC_CHAIN_ID} (BSC mainnet)")
    if chain.code_size(token) == 0:
        raise Stop(f"STOP: no contract at token {token}")

    factory = pinned["factory"]
    exp_bridge = pinned["bridge"]
    exp_nodefund = pinned["nodeFund"]

    # ── 1. VaultPortal record ────────────────────────────────────────────────────────────────
    try:
        info = chain.raw(VAULT_PORTAL, "getVault(address)", enc_addr(token))
    except Reverted as e:
        raise Stop(f"STOP: VaultPortal.getVault reverted (not launched through the VaultPortal?): {e}")
    t = info[word(info, 0) :]
    vault = as_addr(word(t, 0))
    vfactory = as_addr(word(t, 1))
    portal_desc = _tuple_string(t, 2)
    official = word(t, 3) != 0
    risk = word(t, 4)
    check("01_factoryMatches", same(vfactory, factory), f"VaultPortal says the factory is {vfactory}, expected {factory}")
    if chain.code_size(vault) == 0:
        raise Stop(f"STOP: no contract at the vault {vault} the VaultPortal registered")

    # ── 2. tax routing (unfixable by us; a relaunch is the only repair) ──────────────────────
    tp = chain.addr(token, "taxProcessor()")
    market = chain.addr(tp, "marketAddress()")
    check(
        "02_marketAddressIsVault",
        same(market, vault),
        f"TaxProcessor.marketAddress() is {market}, not the vault {vault} — tax does not reach us; RELAUNCH ONLY",
    )

    # ── 3. vault ↔ token ─────────────────────────────────────────────────────────────────────
    vtoken = chain.addr(vault, "taxToken()")
    check("03_vaultTaxTokenMatches", same(vtoken, token), f"vault.taxToken() is {vtoken}, not {token}")

    # ── 4./5. beacon ─────────────────────────────────────────────────────────────────────────
    beacon_slot = as_addr(chain.storage(vault, BEACON_SLOT))
    fcode = chain.code_size(factory)
    if fcode == 0:
        stops.append(f"[04_beaconSlotMatches] no contract at the expected factory {factory}")
        checks["04_beaconSlotMatches"] = False
        checks["05_beaconOwnedByFactory"] = False
        fbeacon = ZERO
        upgrades_locked = False
    else:
        fbeacon = chain.addr(factory, "beacon()")
        check(
            "04_beaconSlotMatches",
            same(beacon_slot, fbeacon) and not same(fbeacon, ZERO),
            f"vault beacon slot is {beacon_slot}, factory.beacon() is {fbeacon}",
        )
        upgrades_locked = chain.boolean(factory, "isVaultUpgradesLocked()")
        beacon_owner = chain.addr(fbeacon, "owner()") if not same(fbeacon, ZERO) else ZERO
        check(
            "05_beaconOwnedByFactory",
            same(beacon_owner, factory) or upgrades_locked,
            f"beacon owner is {beacon_owner}, not the factory {factory} (and upgrades are not locked)",
        )

    # ── 6. the five bps ──────────────────────────────────────────────────────────────────────
    fee_raw = chain.raw(tp, "feeConfigV2()")
    fee = {
        "marketBps": word(fee_raw, 0),
        "deflationBps": word(fee_raw, 1),
        "lpBps": word(fee_raw, 2),
        "dividendBps": word(fee_raw, 3),
        "feeRate": word(fee_raw, 4),
        "isWeth": word(fee_raw, 5) != 0,
        "commissionBps": word(fee_raw, 6),
        "dividendToken": as_addr(word(fee_raw, 7)),
    }
    bad = []
    if fee["dividendBps"] != 0:
        bad.append(f"dividendBps={fee['dividendBps']} (holder dividends arrive as WBNB the vault never books)")
    if fee["marketBps"] != 10000:
        bad.append(f"marketBps={fee['marketBps']}, expected 10000")
    if fee["commissionBps"] != 0:
        bad.append(f"commissionBps={fee['commissionBps']}, expected 0")
    check("06_taxSplit", not bad, "; ".join(bad))

    # ── 7. spec versions and quote token ─────────────────────────────────────────────────────
    v_quote = chain.addr(vault, "vaultQuoteToken()")
    v_spec = chain.string(vault, "vaultSpecVersion()")
    f_spec = chain.string(factory, "factorySpecVersion()") if fcode else "?"
    bad = []
    if not same(v_quote, ZERO):
        bad.append(f"vault.vaultQuoteToken() is {v_quote}, expected 0x0 (native BNB)")
    if v_spec != "v3":
        bad.append(f'vault.vaultSpecVersion() is {v_spec!r}, expected "v3"')
    if f_spec != "v2.3":
        bad.append(f'factory.factorySpecVersion() is {f_spec!r}, expected "v2.3"')
    check("07_specVersions", not bad, "; ".join(bad))

    # ── 8. the vault points at OUR bridge and OUR node fund ──────────────────────────────────
    v_bridge = chain.addr(vault, "bridge()")
    v_nodefund = chain.addr(vault, "nodeFund()")
    bad = []
    if not same(v_bridge, exp_bridge):
        bad.append(f"vault.bridge() is {v_bridge}, expected {exp_bridge}")
    if not same(v_nodefund, exp_nodefund):
        bad.append(f"vault.nodeFund() is {v_nodefund}, expected {exp_nodefund}")
    check("08_vaultWiring", not bad, "; ".join(bad))

    # ── 9. the three token immutables ────────────────────────────────────────────────────────
    bad = []
    imm = {}
    for label, addr in (("BacBridge", exp_bridge), ("BacNodeFund", exp_nodefund)):
        try:
            got = chain.addr(addr, "bacToken()")
        except (Reverted, RpcError) as e:
            got = None
            bad.append(f"{label} {addr}.bacToken() did not answer ({e})")
        imm[label] = got
        if got is not None and not same(got, token):
            bad.append(f"{label}.bacToken() is {got}, not {token}")
    # ValidatorStaking is reachable from the pinned bridge's anchor, so it needs no extra trust
    staking = pinned.get("staking")
    anchor = pinned.get("anchor")
    registry = pinned.get("registry")
    try:
        bridge_anchor = chain.addr(exp_bridge, "anchor()")
        bridge_registry = chain.addr(exp_bridge, "registry()")
    except (Reverted, RpcError) as e:
        bridge_anchor = bridge_registry = None
        bad.append(f"BacBridge.anchor()/registry() did not answer ({e})")
    if anchor and bridge_anchor and not same(anchor, bridge_anchor):
        bad.append(f"--anchor {anchor} != BacBridge.anchor() {bridge_anchor}")
    if registry and bridge_registry and not same(registry, bridge_registry):
        bad.append(f"--registry {registry} != BacBridge.registry() {bridge_registry}")
    anchor = anchor or bridge_anchor
    registry = registry or bridge_registry
    if not staking and anchor:
        try:
            staking = chain.addr(anchor, "validatorStaking()")
        except (Reverted, RpcError):
            staking = None
    if staking and not same(staking, ZERO):
        try:
            got = chain.addr(staking, "bacToken()")
            imm["ValidatorStaking"] = got
            if not same(got, token):
                bad.append(f"ValidatorStaking.bacToken() is {got}, not {token}")
        except (Reverted, RpcError) as e:
            bad.append(f"ValidatorStaking {staking}.bacToken() did not answer ({e})")
    else:
        bad.append("ValidatorStaking is not bound yet (ChainAnchor.setValidatorStaking was never called)")
    check("09_tokenImmutables", not bad, "; ".join(bad))

    # ── 10. solvency ─────────────────────────────────────────────────────────────────────────
    sol = chain.raw(vault, "solvency()")
    balance, accounted, buckets = word(sol, 0), word(sol, 1), word(sol, 2)
    check(
        "10_solvency",
        balance >= accounted and accounted == buckets,
        f"balance={balance} accounted={accounted} buckets={buckets} "
        f"(need balance >= accounted and accounted == unsplit + stuckBridge + stuckNodeFund)",
    )

    # ── 11. the tax is on, and it is 2% ──────────────────────────────────────────────────────
    token_state = chain.uint(token, "state()")
    tax_rate = chain.uint(token, "taxRate()")
    buy = chain.uint(token, "buyTaxRate()")
    sell = chain.uint(token, "sellTaxRate()")
    bad = []
    if token_state == 4:
        bad.append("state() is TaxFree — taxDuration has expired, the vault will NEVER be paid again; RELAUNCH ONLY")
    if token_state not in (0, 2, 3):
        bad.append(f"state() is {token_state} ({TOKEN_STATE.get(token_state, '?')}), expected BondingCurve/TaxEnforced*")
    for label, got in (("taxRate", tax_rate), ("buyTaxRate", buy), ("sellTaxRate", sell)):
        if got != 200:
            bad.append(f"{label}() is {got} bps, expected 200")
    check("11_taxLive", not bad, "; ".join(bad))

    # ── 12. antiFarmerDuration (DIFF row; a stop only under --strict, handled by the caller) ─
    anti = chain.uint(token, "antiFarmerDuration()")
    checks["12_antiFarmerAsPlanned"] = anti == plan["antiFarmerDuration"]

    # ── 13. the node-fund withdrawer named in the banner IS BacNodeFund.owner() ─────────────
    try:
        nf_owner = chain.addr(exp_nodefund, "owner()")
    except (Reverted, RpcError) as e:
        nf_owner = None
        stops.append(f"[13_descriptionNamesNodeFundOwner] BacNodeFund.owner() did not answer ({e})")
        checks["13_descriptionNamesNodeFundOwner"] = False
    v_owner = chain.addr(vault, "owner()")
    desc = None
    if nf_owner is not None:
        try:
            desc = chain.string(vault, "description()")
        except (Reverted, RpcError) as e:
            stops.append(f"[13_descriptionNamesNodeFundOwner] vault.description() reverted ({e}) — Flap rule 001")
            checks["13_descriptionNamesNodeFundOwner"] = False
    if desc is not None:
        want_en = NODEFUND_OWNER_ANCHOR.format(addr=nf_owner.lower())
        want_cn = NODEFUND_OWNER_ANCHOR_CN.format(addr=nf_owner.lower())
        bad = []
        if want_en not in desc:
            bad.append(f"the English banner does not say {want_en!r}")
        if want_cn not in desc:
            bad.append(f"the Chinese banner does not say {want_cn!r}")
        if exp_bridge.lower() not in desc.lower():
            bad.append("the banner does not name the bridge address")
        if exp_nodefund.lower() not in desc.lower():
            bad.append("the banner does not name the node fund address")
        check("13_descriptionNamesNodeFundOwner", not bad, "; ".join(bad))

    # ── 14. the 1:1 backing of the genesis operator float ───────────────────────────────────
    lfc = None
    issued = None
    bad = []
    if anchor and not same(anchor, ZERO):
        try:
            lfc = chain.uint(anchor, "lastFinalCirculating()")
            if lfc != OPERATOR_FLOAT:
                bad.append(f"ChainAnchor.lastFinalCirculating() is {lfc}, expected {OPERATOR_FLOAT} (OPERATOR_FLOAT)")
        except (Reverted, RpcError) as e:
            bad.append(f"ChainAnchor.lastFinalCirculating() did not answer ({e})")
    else:
        bad.append("no ChainAnchor address (pass --anchor, or fix BacBridge.anchor())")
    try:
        issued = chain.uint(exp_bridge, "totalCreditsIssued()")
        if issued < OPERATOR_FLOAT:
            bad.append(
                f"BacBridge.totalCreditsIssued() is {issued} ({bnb(issued)} BAC), below OPERATOR_FLOAT "
                f"{bnb(OPERATOR_FLOAT)} BAC — the relayer's genesis balance is not backed 1:1 yet"
            )
    except (Reverted, RpcError) as e:
        bad.append(f"BacBridge.totalCreditsIssued() did not answer ({e})")
    if phase == "genesis":
        check("14_operatorFloatBacked", not bad, "; ".join(bad))
    else:
        checks["14_operatorFloatBacked"] = not bad
        if bad:
            pending.append(
                "[14_operatorFloatBacked] PENDING under --phase launch (lock the operator float BEFORE "
                "generating genesis, then re-run with --phase genesis): " + "; ".join(bad)
            )

    # ── everything we only record ────────────────────────────────────────────────────────────
    try:
        portal_state = chain.raw(PORTAL, "getTokenV8Safe(address)", enc_addr(token))
        status = word(portal_state, 0)
        progress = str(word(portal_state, 15))
    except (Reverted, RpcError):
        status, progress = 0, "0"
    stuck = chain.raw(vault, "stuckAmounts()")

    snap["token"] = {
        "address": token.lower(),
        "name": chain.string(token, "name()"),
        "symbol": chain.string(token, "symbol()"),
        "decimals": chain.uint(token, "decimals()"),
        "totalSupply": str(chain.uint(token, "totalSupply()")),
        "taxRateBps": tax_rate,
        "buyTaxBps": buy,
        "sellTaxBps": sell,
        "antiFarmerDuration": anti,
        "taxDuration": None,  # NOT readable on chain — see the module docstring
        "poolState": token_state,
        "poolStateName": TOKEN_STATE.get(token_state, "?"),
        "portalStatus": status,
        "portalStatusName": PORTAL_STATUS.get(status, "?"),
        "progress": progress,
        "vanity7777": token.lower().endswith("7777"),
        "taxProcessor": tp,
        "dividendContract": chain.addr(token, "dividendContract()"),
    }
    snap["feeConfigV2"] = fee
    snap["commissionReceiver"] = chain.addr(tp, "commissionReceiver()")
    snap["vault"] = {
        "address": vault,
        "taxToken": vtoken,
        "owner": v_owner,
        "bridge": v_bridge,
        "nodeFund": v_nodefund,
        "vaultQuoteToken": v_quote,
        "vaultSpecVersion": v_spec,
        "balance": str(balance),
        "balanceBnb": bnb(balance),
        "accountedQuote": str(accounted),
        "unsplitRevenue": str(chain.uint(vault, "unsplitRevenue()")),
        "buckets": str(buckets),
        "stuckBridge": str(word(stuck, 0)),
        "stuckNodeFund": str(word(stuck, 1)),
        "lifetimeToBridge": str(chain.uint(vault, "lifetimeToBridge()")),
        "lifetimeToNodeFund": str(chain.uint(vault, "lifetimeToNodeFund()")),
        "totalRecognized": str(chain.uint(vault, "totalRecognized()")),
        "tokenBalance": str(chain.uint(token, "balanceOf(address)", enc_addr(vault))),
        "beacon": beacon_slot,
        "guardian": GUARDIAN.lower(),
        "description": desc,
    }
    snap["factory"] = {
        "address": factory.lower(),
        "beacon": fbeacon,
        "upgradesLocked": upgrades_locked if fcode else None,
        "factorySpecVersion": f_spec,
    }
    if fcode:
        try:
            snap["factory"].update(
                {
                    "beaconImplementation": chain.addr(factory, "beaconImplementation()"),
                    "launcher": chain.addr(factory, "LAUNCHER()"),
                    "requiredMktBps": chain.uint(factory, "REQUIRED_MKT_BPS()"),
                    "requiredBuyTaxBps": chain.uint(factory, "REQUIRED_BUY_TAX_BPS()"),
                    "requiredSellTaxBps": chain.uint(factory, "REQUIRED_SELL_TAX_BPS()"),
                    "bnbQuoteSupported": chain.boolean(factory, "isQuoteTokenSupported(address)", enc_addr(ZERO)),
                }
            )
        except (Reverted, RpcError) as e:
            snap["factory"]["error"] = str(e)
    bridge_block = {"address": exp_bridge.lower(), "bacToken": imm.get("BacBridge")}
    for key, sig in (
        ("totalLocked", "totalLocked()"),
        ("totalCreditsIssued", "totalCreditsIssued()"),
        ("poolBalance", "poolBalance()"),
    ):
        try:
            bridge_block[key] = str(chain.uint(exp_bridge, sig))
        except (Reverted, RpcError):
            bridge_block[key] = None
    bridge_block["anchor"] = anchor
    bridge_block["registry"] = registry
    try:
        p = chain.raw(exp_bridge, "isPaused()")
        bridge_block["paused"] = word(p, 0) != 0
        bridge_block["pausedUntil"] = word(p, 1)
        bridge_block["pausedCumulative"] = word(p, 2)
    except (Reverted, RpcError):
        pass
    snap["bridge"] = bridge_block
    snap["nodeFund"] = {
        "address": exp_nodefund.lower(),
        "bacToken": imm.get("BacNodeFund"),
        "owner": nf_owner,
        "balance": str(chain.uint(exp_nodefund, "balance()")) if nf_owner else None,
    }
    snap["anchor"] = {"address": anchor, "lastFinalCirculating": str(lfc) if lfc is not None else None}
    if anchor and not same(anchor, ZERO):
        for key, sig in (
            ("relayer", "relayer()"),
            ("validatorStaking", "validatorStaking()"),
            ("admin", "admin()"),
            ("vetoKey", "vetoKey()"),
        ):
            try:
                snap["anchor"][key] = chain.addr(anchor, sig)
            except (Reverted, RpcError):
                snap["anchor"][key] = None
        for key, sig in (("lastPostedEpoch", "lastPostedEpoch()"), ("lastFinalEpoch", "lastFinalEpoch()")):
            try:
                snap["anchor"][key] = chain.uint(anchor, sig)
            except (Reverted, RpcError):
                snap["anchor"][key] = None
    snap["staking"] = {"address": staking, "bacToken": imm.get("ValidatorStaking")}
    snap["registry"] = {"address": registry}
    if registry and not same(registry, ZERO):
        try:
            sink = chain.addr(registry, "vaultSink()")
            snap["registry"]["vaultSink"] = sink
            # not one of the 14, but a launch-day mistake that silently loses forfeited deposits
            if same(sink, ZERO):
                pending.append(
                    "[registry] AgentRegistry.vaultSink() is still 0x0 — run setVaultSink(vault) "
                    "(deploy step 12) or forfeited deposits have nowhere to go"
                )
            elif not same(sink, vault):
                stops.append(f"[registry] AgentRegistry.vaultSink() is {sink}, not the vault {vault}")
                checks["registry_vaultSink"] = False
            else:
                checks["registry_vaultSink"] = True
        except (Reverted, RpcError):
            snap["registry"]["vaultSink"] = None
    snap["vaultPortal"] = {
        "address": VAULT_PORTAL.lower(),
        "vault": vault,
        "vaultFactory": vfactory,
        "isOfficial": official,
        "riskLevel": risk,
        "riskLevelName": RISK.get(risk, "?"),
        "description": portal_desc,
    }
    snap["checks"] = checks
    snap["meta"] = {"chainId": chain_id, "blockNumber": block, "rpc": chain.rpc.used}
    return snap, stops, pending


# ── layer-side verification ─────────────────────────────────────────────────────────────────────
def verify_layer(chain, expected_genesis_hash, expected_bsc_bridge):
    """L1–L4. Only run once the layer exists (--phase genesis)."""
    stops = []
    snap = {}
    checks = {}

    def check(key, ok, detail=""):
        checks[key] = bool(ok)
        if not ok:
            stops.append(f"[{key}] {detail}")

    chain_id = int(chain.rpc.request("eth_chainId", []), 16)
    check("L1_layerChainId", chain_id == LAYER_CHAIN_ID, f"layer chain id is {chain_id}, expected {LAYER_CHAIN_ID}")

    b0 = chain.rpc.request("eth_getBlockByNumber", ["0x0", False]) or {}
    genesis_hash = b0.get("hash")
    if not expected_genesis_hash:
        check("L2_genesisHash", False, "no expected genesis hash given (--genesis-hash / --genesis-manifest)")
    else:
        check(
            "L2_genesisHash",
            is_hash(genesis_hash) and genesis_hash.lower() == expected_genesis_hash.lower(),
            f"layer block 0 hash is {genesis_hash}, the published genesis hash is {expected_genesis_hash} — "
            "this node is NOT running the chain we published",
        )

    try:
        bsc_bridge = chain.addr(L2_BRIDGE, "BSC_BRIDGE()")
    except (Reverted, RpcError) as e:
        bsc_bridge = None
        check("L3_bridgeBinding", False, f"L2Bridge({L2_BRIDGE}).BSC_BRIDGE() did not answer ({e})")
    if bsc_bridge is not None:
        check(
            "L3_bridgeBinding",
            same(bsc_bridge, expected_bsc_bridge),
            f"layer L2Bridge.BSC_BRIDGE() is {bsc_bridge}, expected the deployed BacBridge {expected_bsc_bridge} — "
            "exits on this layer would credit a different bridge",
        )

    sizes = {}
    bad = []
    for label, addr in (
        ("L2Bridge", L2_BRIDGE),
        ("L2Gate", L2_GATE),
        ("AgentBook", AGENT_BOOK),
        ("FeeSplitter", FEE_SPLITTER),
    ):
        n = chain.code_size(addr)
        sizes[label] = n
        if n == 0:
            bad.append(f"{label} at {addr} has no code at genesis (code can never be added later)")
    n105 = chain.code_size(RESERVED_0105)
    sizes["reserved0105"] = n105
    if n105 != 0:
        bad.append(f"{RESERVED_0105} must be empty at genesis but holds {n105} bytes")
    check("L4_systemContracts", not bad, "; ".join(bad))

    snap["layer"] = {
        "chainId": chain_id,
        "rpc": chain.rpc.used,
        "genesisHash": genesis_hash,
        "expectedGenesisHash": expected_genesis_hash,
        "head": int(chain.rpc.request("eth_blockNumber", []), 16),
        "l2BridgeBscBridge": bsc_bridge,
        "codeSizes": sizes,
    }
    for key, sig in (("relayer", "relayer()"), ("genesisRelayer", "GENESIS_RELAYER()"), ("reserve", "reserve()")):
        try:
            snap["layer"][key] = (
                str(chain.uint(L2_BRIDGE, sig)) if sig == "reserve()" else chain.addr(L2_BRIDGE, sig)
            )
        except (Reverted, RpcError):
            snap["layer"][key] = None
    snap["checks"] = checks
    return snap, stops


# ── planned-value diffing ───────────────────────────────────────────────────────────────────────
def planned_from_args(a):
    p = dict(PLANNED)
    for key, attr in [
        ("name", "name"),
        ("symbol", "symbol"),
        ("buyTaxBps", "buy"),
        ("sellTaxBps", "sell"),
        ("marketBps", "mkt"),
        ("deflationBps", "defl"),
        ("lpBps", "lp"),
        ("dividendBps", "div"),
        ("commissionBps", "commission"),
        ("antiFarmerDuration", "antifarmer"),
        ("launcher", "launcher"),
        ("owner", "owner"),
    ]:
        v = getattr(a, attr, None)
        if v is not None:
            p[key] = v
    return p


def diff(snap, plan):
    rows = []

    def add(field, want, got):
        if want is None:
            return
        ok = same(want, got) if isinstance(want, str) and is_addr(want) else str(want) == str(got)
        rows.append({"field": field, "planned": want, "onChain": got, "ok": ok})

    t, f, v = snap["token"], snap["feeConfigV2"], snap["vault"]
    add("name (exact case)", plan["name"], t["name"])
    add("symbol (exact case)", plan["symbol"], t["symbol"])
    add("buyTaxBps", plan["buyTaxBps"], t["buyTaxBps"])
    add("sellTaxBps", plan["sellTaxBps"], t["sellTaxBps"])
    for k in ("marketBps", "deflationBps", "lpBps", "dividendBps", "commissionBps"):
        add(f"feeConfigV2.{k}", plan[k], f[k])
    add("antiFarmerDuration", plan["antiFarmerDuration"], t["antiFarmerDuration"])
    add("factory.LAUNCHER", plan["launcher"], snap["factory"].get("launcher"))
    add("vault.owner", plan["owner"], v.get("owner"))
    return rows


def load_genesis_hash(a):
    if a.genesis_hash:
        return a.genesis_hash
    path = a.genesis_manifest or DEFAULT_MANIFEST
    if os.path.isfile(path):
        try:
            with open(path, encoding="utf-8") as fh:
                m = json.load(fh)
            for key in ("genesisHash", "genesis_hash", "hash"):
                if isinstance(m.get(key), str):
                    return m[key]
        except (OSError, ValueError):
            return None
    return None


# ── main ────────────────────────────────────────────────────────────────────────────────────────
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--token", required=True, help="the launched BAC token address (…7777)")
    ap.add_argument("--factory", help="BacVaultFactory we deployed (env FACTORY)")
    ap.add_argument("--bridge", help="BacBridge we deployed (env BRIDGE)")
    ap.add_argument("--nodefund", help="BacNodeFund we deployed (env NODEFUND)")
    ap.add_argument("--registry", help="AgentRegistry (optional; cross-checked against BacBridge.registry())")
    ap.add_argument("--anchor", help="ChainAnchor (optional; cross-checked against BacBridge.anchor())")
    ap.add_argument("--staking", help="ValidatorStaking (optional; read from ChainAnchor when omitted)")
    ap.add_argument("--rpc", action="append", help="BSC RPC URL (repeatable)")
    ap.add_argument("--phase", choices=["launch", "genesis"], default="launch", help="see the module docstring")
    ap.add_argument("--layer-rpc", action="append", help="layer RPC URL (repeatable)")
    ap.add_argument("--genesis-hash", help="the published layer genesis hash")
    ap.add_argument("--genesis-manifest", help=f"JSON holding genesisHash (default {DEFAULT_MANIFEST})")
    ap.add_argument("--no-layer", action="store_true", help="skip the layer block even under --phase genesis")
    ap.add_argument("--out", default=DEFAULT_OUT, help=f"snapshot path (default {DEFAULT_OUT})")
    ap.add_argument("--dry-run", action="store_true", help="verify and print, write nothing")
    ap.add_argument("--strict", action="store_true", help="exit 1 when a planned value differs")
    ap.add_argument("--mock", help="offline fixture (see MockRpc); proves the logic without touching a chain")
    g = ap.add_argument_group("planned values (defaults = the planned flap.sh form)")
    g.add_argument("--name")
    g.add_argument("--symbol")
    g.add_argument("--buy", type=int)
    g.add_argument("--sell", type=int)
    g.add_argument("--mkt", type=int)
    g.add_argument("--defl", type=int)
    g.add_argument("--lp", type=int)
    g.add_argument("--div", type=int)
    g.add_argument("--commission", type=int)
    g.add_argument("--antifarmer", type=int, help="seconds")
    g.add_argument("--launcher", help="expected factory.LAUNCHER()")
    g.add_argument("--owner", help="expected vault owner")
    a = ap.parse_args(argv)

    token = a.token.strip()
    if not is_addr(token):
        raise Stop("ERROR: --token must be a 0x address")
    pinned = {}
    for key, flag, env in (
        ("factory", a.factory, "FACTORY"),
        ("bridge", a.bridge, "BRIDGE"),
        ("nodeFund", a.nodefund, "NODEFUND"),
    ):
        v = (flag or os.environ.get(env) or "").strip()
        if not is_addr(v):
            raise Stop(
                f"ERROR: --{key.lower()} (or ${env}) must be the 0x address we deployed. "
                "These are the addresses the launch is checked AGAINST; reading them back off the "
                "chain would make every check tautological."
            )
        pinned[key] = v
    for key, flag in (("registry", a.registry), ("anchor", a.anchor), ("staking", a.staking)):
        v = (flag or "").strip()
        if v and not is_addr(v):
            raise Stop(f"ERROR: --{key} must be a 0x address")
        pinned[key] = v or None
    if len({pinned["factory"].lower(), pinned["bridge"].lower(), pinned["nodeFund"].lower()}) != 3:
        raise Stop("ERROR: --factory, --bridge and --nodefund must be three different contracts")
    for flag in (a.launcher, a.owner):
        if flag is not None and not is_addr(flag):
            raise Stop("ERROR: --launcher / --owner must be 0x addresses")

    mock = None
    if a.mock:
        with open(a.mock, encoding="utf-8") as fh:
            mock = json.load(fh)

    bsc_rpc = MockRpc(mock.get("bsc", {}), "bsc") if mock else Rpc(a.rpc or DEFAULT_RPCS, label="bsc")
    plan = planned_from_args(a)
    try:
        snap, stops, pending = verify_bsc(Chain(bsc_rpc), token, pinned, plan, a.phase)
    except (RpcError, Reverted) as e:
        print(f"STOP: BSC chain read failed: {e}")
        return 2

    layer_snap = None
    layer_stops = []
    layer_skipped = None
    expected_gh = load_genesis_hash(a)
    if a.no_layer:
        layer_skipped = "--no-layer was passed"
    elif a.phase == "launch":
        layer_skipped = "--phase launch (the layer does not exist until genesis is built from these addresses)"
    else:
        layer_rpc = (
            MockRpc(mock.get("layer", {}), "layer") if mock else Rpc(a.layer_rpc or DEFAULT_LAYER_RPCS, label="layer")
        )
        try:
            layer_snap, layer_stops = verify_layer(Chain(layer_rpc), expected_gh, pinned["bridge"])
        except (RpcError, Reverted) as e:
            layer_stops = [f"[layer] chain read failed: {e}"]
            layer_snap = {"layer": {"error": str(e)}, "checks": {"L0_layerReachable": False}}
        snap["checks"].update(layer_snap.get("checks", {}))

    rows = diff(snap, plan)
    now = _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()
    out = {
        "schema": "bac-chain-snapshot/1",
        "generatedAt": now,
        "phase": a.phase,
        **snap["meta"],
        "token": snap["token"],
        "feeConfigV2": snap["feeConfigV2"],
        "commissionReceiver": snap["commissionReceiver"],
        "vault": snap["vault"],
        "factory": snap["factory"],
        "bridge": snap["bridge"],
        "nodeFund": snap["nodeFund"],
        "anchor": snap["anchor"],
        "staking": snap["staking"],
        "registry": snap["registry"],
        "vaultPortal": snap["vaultPortal"],
        "checks": snap["checks"],
        "planned": plan,
        "diff": rows,
    }
    if layer_snap:
        out["layer"] = layer_snap["layer"]
    elif layer_skipped:
        out["layer"] = {"skipped": layer_skipped}

    t, f, v = snap["token"], snap["feeConfigV2"], snap["vault"]
    print("== verify_launch (read-only; nothing is signed or sent) ==")
    print(f"phase      {a.phase}")
    print(f"rpc        {snap['meta']['rpc']}  chain {snap['meta']['chainId']}  block {snap['meta']['blockNumber']}")
    print(f"token      {t['address']}  name={t['name']!r} symbol={t['symbol']!r}  state={t['poolStateName']}")
    print(f"vault      {v['address']}  owner={v['owner']}  balance={v['balanceBnb']} BNB")
    print(f"           bridge={v['bridge']}  nodeFund={v['nodeFund']}  spec={v['vaultSpecVersion']}")
    print(f"factory    {snap['factory']['address']}  beacon={snap['factory']['beacon']}  spec={snap['factory']['factorySpecVersion']}")
    print(f"nodeFund   owner={snap['nodeFund']['owner']}  (this is the withdrawer, NOT the vault owner)")
    print(f"bridge     totalCreditsIssued={snap['bridge'].get('totalCreditsIssued')}  pool={snap['bridge'].get('poolBalance')}")
    print(f"anchor     {snap['anchor']['address']}  lastFinalCirculating={snap['anchor']['lastFinalCirculating']}")
    print(
        "feeConfigV2 marketBps={marketBps} deflationBps={deflationBps} lpBps={lpBps} dividendBps={dividendBps} "
        "feeRate={feeRate} isWeth={isWeth} commissionBps={commissionBps} dividendToken={dividendToken}".format(**f)
    )
    print(f"taxes      taxRate={t['taxRateBps']} buy={t['buyTaxBps']} sell={t['sellTaxBps']} bps  antiFarmer={t['antiFarmerDuration']} s")
    print(f"riskLevel  {snap['vaultPortal']['riskLevel']} ({snap['vaultPortal']['riskLevelName']}) — decision #10 accepts UNVERIFIED")
    if layer_snap and "error" not in layer_snap["layer"]:
        L = layer_snap["layer"]
        print(f"layer      chain {L['chainId']}  head {L['head']}  genesis {L['genesisHash']}")
    elif layer_skipped:
        print(f"layer      not checked: {layer_skipped}")
    print("hard checks")
    for k in sorted(snap["checks"]):
        print(f"  {'OK  ' if snap['checks'][k] else 'FAIL'} {k}")
    print("planned vs on-chain (recorded, not enforced — the site must render the chain value)")
    for r in rows:
        print(f"  {'OK  ' if r['ok'] else 'DIFF'} {r['field']:<26} planned={r['planned']!s:<28} chain={r['onChain']}")
    print("  note taxDuration cannot be read on chain; the only evidence is state() never becoming TaxFree")

    for p in pending:
        print(f"\nPENDING: {p}")

    all_stops = stops + layer_stops
    if all_stops:
        print("\n" + "=" * 78)
        print("STOP — 暂停一切宣传 / PAUSE ALL PROMOTION")
        for s in all_stops:
            print("  " + s)
        print(
            "Nothing was written. Do not post, do not tweet, do not point the website at this token.\n"
            "The token↔vault binding cannot be changed by us or by Flap: the only repair is a relaunch."
        )
        print("=" * 78)
        return 2

    text = json.dumps(out, indent=2, ensure_ascii=False) + "\n"
    if a.dry_run:
        print("\n-- dry run: snapshot not written --")
        print(text)
    else:
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        with open(a.out, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        print(f"\nsnapshot written: {os.path.abspath(a.out)}")
    diffs = [r for r in rows if not r["ok"]]
    if diffs:
        print(
            f"{len(diffs)} planned value(s) differ. These are permanent: adapt the site and the copy to the "
            "chain values (or relaunch). rat had 6 such rows."
        )
        return 1 if a.strict else 0
    print("all hard checks passed; every planned value matches the chain")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Stop as e:
        print(e)
        sys.exit(2)
