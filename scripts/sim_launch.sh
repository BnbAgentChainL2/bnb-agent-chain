#!/usr/bin/env bash
# sim_launch.sh — read-only launch simulation of BNB Agent Chain (BAC) through the Flap
# VaultPortal on BSC. Adapted from rat/scripts/sim_launch.sh.
#
# Every chain access is `cast call` (eth_call) or a local computation. Nothing is signed, nothing
# is sent, no private key is read. Safe to run against mainnet, and meant to be run minutes before
# the real launch with the exact values that will go into the flap.sh form.
#
# What it does
#   1. pre-checks the BacVaultFactory (spec version, BNB quote, beacon owned by the factory,
#      upgrades unlocked, LAUNCHER immutable, vaultDataSchema fields, the 8 tokenCreationPolicies)
#   2. pre-checks the three BAC-token immutables (BacBridge / BacNodeFund / ValidatorStaking all
#      bound to the same token T) and that T is still free
#   3. mines (or accepts) the vanity ...7777 CREATE2 salt for the Tax Token V3 clone and predicts T
#   4. eth_calls VaultPortal.newTokenV6WithVault(...) with the planned form values, from the
#      LAUNCHER address -> must return exactly T
#   5. negative rows that must fail: wrong sender, buy tax 3%, sell tax 3%, vault share 80%,
#      holder dividends on, deflation on, LP share on, USDT quote, Tax Token V2,
#      bridge/nodeFund swapped for a stranger contract, vaultData too short
#   Exit code 0 = every row behaved as expected, 1 = at least one row did not, 2 = bad input.
#
# Usage
#   TAXDURATION=3153600000 ANTIFARMER=86400 \
#   scripts/sim_launch.sh --factory 0x... --bridge 0x... --nodefund 0x... --launcher 0x... \
#                         [--rpc URL] [--vault-owner 0x...] [--salt 0x...] [--token 0x...] \
#                         [--name "BNB Agent Chain"] [--symbol BAC] [--buy 200] [--sell 200] \
#                         [--quote-amt 0] [--registry 0x...] [--staking 0x...] [--no-negative]
#   Every flag also works as an environment variable of the same name in capitals
#   (FACTORY BRIDGE NODEFUND LAUNCHER RPC VAULT_OWNER SALT TOKEN NAME SYMBOL BUY SELL ...).
#
#   TAXDURATION and ANTIFARMER have NO DEFAULTS on purpose (docs/01-CONTRACT-SPEC.md §9):
#   the hook cannot see them and the factory cannot police them, and once `taxDuration` expires
#   the token flips to PoolState.TaxFree, the vault's `receive()` is never called again, and the
#   bridge pool stays 0 forever. Only a relaunch fixes that. So you type them every time.
#
# Against a local anvil fork: scripts/sim_launch.sh --rpc http://127.0.0.1:18655 --factory 0x...
set -uo pipefail

usage() { sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'; }

# ── defaults: the planned form (keep in sync with contracts/test/BacForkLaunch.t.sol) ──
RPC="${RPC:-https://bsc-rpc.publicnode.com}"
FACTORY="${FACTORY:-}"
BRIDGE="${BRIDGE:-}"
NODEFUND="${NODEFUND:-}"
LAUNCHER="${LAUNCHER:-}"
REGISTRY="${REGISTRY:-}"
STAKING="${STAKING:-}"
VAULT_OWNER="${VAULT_OWNER:-0x0000000000000000000000000000000000000000}"
NAME="${NAME:-BNB Agent Chain}"
SYMBOL="${SYMBOL:-BAC}"
META="${META:-bnb-agent-chain}"
BUY="${BUY:-200}"
SELL="${SELL:-200}"
MKT="${MKT:-10000}"
DEFL="${DEFL:-0}"
DIV="${DIV:-0}"
LP="${LP:-0}"
MINSHARE="${MINSHARE:-0}"
DIVTOKEN="${DIVTOKEN:-0x0000000000000000000000000000000000000000}"
COMMISSION="${COMMISSION:-0x0000000000000000000000000000000000000000}"
QUOTE_AMT="${QUOTE_AMT:-0}"
SALT="${SALT:-}"
TOKEN="${TOKEN:-}"
NEGATIVE="${NEGATIVE:-1}"
RETRIES="${RETRIES:-6}"

while [ $# -gt 0 ]; do
  case "$1" in
    --rpc) RPC="$2"; shift 2 ;;
    --factory) FACTORY="$2"; shift 2 ;;
    --bridge) BRIDGE="$2"; shift 2 ;;
    --nodefund) NODEFUND="$2"; shift 2 ;;
    --launcher) LAUNCHER="$2"; shift 2 ;;
    --registry) REGISTRY="$2"; shift 2 ;;
    --staking) STAKING="$2"; shift 2 ;;
    --vault-owner) VAULT_OWNER="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --symbol) SYMBOL="$2"; shift 2 ;;
    --meta) META="$2"; shift 2 ;;
    --buy) BUY="$2"; shift 2 ;;
    --sell) SELL="$2"; shift 2 ;;
    --mkt) MKT="$2"; shift 2 ;;
    --defl) DEFL="$2"; shift 2 ;;
    --div) DIV="$2"; shift 2 ;;
    --lp) LP="$2"; shift 2 ;;
    --minshare) MINSHARE="$2"; shift 2 ;;
    --tax-duration) TAXDURATION="$2"; shift 2 ;;
    --antifarmer) ANTIFARMER="$2"; shift 2 ;;
    --quote-amt) QUOTE_AMT="$2"; shift 2 ;;
    --salt) SALT="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --no-negative) NEGATIVE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# The two fields the factory cannot police. No defaults, ever (§9).
: "${TAXDURATION:?must set TAXDURATION explicitly (seconds; the planned value is 3153600000 = 100 years)}"
: "${ANTIFARMER:?must set ANTIFARMER explicitly (seconds; the planned value is 86400 = 1 day)}"

# ── protocol constants (BSC mainnet, measured 2026-09-22, docs/research/09-chain-truth.md) ──
VP=0x90497450f2a706f1951b5bdda52B4E5d16f34C06          # Flap VaultPortal 1.15.0
PORTAL=0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0      # Flap Portal v5.24.0 (CREATE2 deployer of the clone)
IMPL_V3=0x024f18294970B5c76c0691b87f138A0317156422     # Tax Token V3 implementation (EIP-1167 target)
USDT=0x55d398326f99059fF775485246999027B3197955
ZERO=0x0000000000000000000000000000000000000000
Z32=0x0000000000000000000000000000000000000000000000000000000000000000
T='(string,string,string,uint8,bytes32,uint8,address,uint256,bytes,bytes32,bytes,uint8,uint8,uint16,uint16,uint64,uint64,uint16,uint16,uint16,uint16,uint256,address,address,uint8,address,bytes)'
SIG="newTokenV6WithVault($T)(address)"

die() { echo "ERROR: $*" >&2; exit 2; }
is_addr() { [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]]; }
is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }

is_addr "$FACTORY"  || die "set FACTORY (or --factory 0x...) to the BacVaultFactory address"
is_addr "$BRIDGE"   || die "set BRIDGE (or --bridge 0x...) to the BacBridge address"
is_addr "$NODEFUND" || die "set NODEFUND (or --nodefund 0x...) to the BacNodeFund address"
is_addr "$LAUNCHER" || die "set LAUNCHER (or --launcher 0x...) — it must be the wallet that will press Launch"
is_addr "$VAULT_OWNER" || die "VAULT_OWNER must be an address (0x0 = the launching wallet)"
[ "$BRIDGE" != "$NODEFUND" ] || die "BRIDGE and NODEFUND must be two different contracts"
for v in BUY SELL MKT DEFL DIV LP MINSHARE ANTIFARMER TAXDURATION; do
  is_uint "${!v}" || die "$v must be a non-negative integer (got '${!v}')"
done
for s in "$NAME" "$SYMBOL" "$META"; do
  [[ "$s" == *'"'* ]] && die "names must not contain double quotes"
done
command -v cast >/dev/null 2>&1 || die "cast (Foundry) not found on PATH"

# ── RPC helper with retries (public endpoints answer 403/429 under load) ──
retryable() {
  case "$1" in
    *Cloudflare*|*cloudflare*|*" 403"*|*"403 "*|*" 429"*|*"429 "*|*"Too Many Requests"*|*"rate limit"*|*"Rate limit"*|\
    *"timed out"*|*"timeout"*|*"connection closed"*|*"error sending request"*|*"502 Bad Gateway"*|*"503"*|*"504"*|    *"HTTP error"*|*"empty body"*|*"os error"*) return 0 ;;
  esac
  return 1
}
rpc() {
  local out i
  for ((i = 1; i <= RETRIES; i++)); do
    out=$(cast "$@" --rpc-url "$RPC" 2>&1 | tr '\r\n' '  ')
    if retryable "$out" && [ "$i" -lt "$RETRIES" ]; then sleep $((i * 2)); continue; fi
    break
  done
  out="${out#"${out%%[![:space:]]*}"}"
  out="${out%"${out##*[![:space:]]}"}"
  printf '%s' "$out"
}
call() { rpc call "$@"; }
wei() { cast parse-units "$1" 18 2>/dev/null || die "cannot convert '$1' to wei"; }
QUOTE_WEI=$(wei "$QUOTE_AMT")

echo "== sim_launch: read-only eth_call launch simulation of BAC (nothing is sent) =="
CHAIN=$(rpc chain-id)
is_uint "$CHAIN" || die "RPC $RPC did not answer eth_chainId: $CHAIN"
echo "rpc            $RPC  (chain $CHAIN, block $(rpc block-number))"
[ "$CHAIN" = "56" ] || echo "WARNING: chain id is $CHAIN, not BSC mainnet (56); VaultPortal only exists on 56 / forks of it"
echo "factory        $FACTORY"
echo "launcher       $LAUNCHER"
[ "$(cast sig "newTokenV6WithVault($T)")" = "0x1b806220" ] || die "tuple signature drifted (selector != 0x1b806220)"

# ── factory pre-checks ──
PRE_FAIL=0
check() { # check <label> <got> <want>
  local mark=ok
  if [ "$(echo "$2" | tr 'A-F' 'a-f')" != "$(echo "$3" | tr 'A-F' 'a-f')" ]; then mark="MISMATCH (want $3)"; PRE_FAIL=1; fi
  printf '  %-36s %s  %s\n' "$1" "$(echo "$2" | cut -c1-90)" "$mark"
}
CODESIZE=$(rpc codesize "$FACTORY")
{ [ "$CODESIZE" != "0" ] && is_uint "$CODESIZE"; } || die "no contract at FACTORY $FACTORY (codesize: $CODESIZE)"
echo
echo "factory pre-checks"
check "factorySpecVersion()" "$(call "$FACTORY" 'factorySpecVersion()(string)')" '"v2.3"'
check "isQuoteTokenSupported(BNB)" "$(call "$FACTORY" 'isQuoteTokenSupported(address)(bool)' $ZERO)" "true"
check "isQuoteTokenSupported(USDT)" "$(call "$FACTORY" 'isQuoteTokenSupported(address)(bool)' $USDT)" "false"
check "LAUNCHER()" "$(call "$FACTORY" 'LAUNCHER()(address)')" "$LAUNCHER"
check "REQUIRED_MKT_BPS()" "$(call "$FACTORY" 'REQUIRED_MKT_BPS()(uint16)' | awk '{print $1}')" "10000"
check "REQUIRED_BUY_TAX_BPS()" "$(call "$FACTORY" 'REQUIRED_BUY_TAX_BPS()(uint16)' | awk '{print $1}')" "200"
check "REQUIRED_SELL_TAX_BPS()" "$(call "$FACTORY" 'REQUIRED_SELL_TAX_BPS()(uint16)' | awk '{print $1}')" "200"
BEACON=$(call "$FACTORY" 'beacon()(address)')
is_addr "$BEACON" || die "factory.beacon() failed: $BEACON"
check "beacon().owner() == factory" "$(call "$BEACON" 'owner()(address)')" "$FACTORY"
check "isVaultUpgradesLocked()" "$(call "$FACTORY" 'isVaultUpgradesLocked()(bool)')" "false"
printf '  %-36s %s\n' "beacon()" "$BEACON"
printf '  %-36s %s\n' "beaconImplementation()" "$(call "$FACTORY" 'beaconImplementation()(address)')"
SCHEMA=$(call "$FACTORY" 'vaultDataSchema()((string,(string,string,string,uint8)[],bool))')
FIELDS=$(echo "$SCHEMA" | grep -o '("[A-Za-z]*", "[a-z0-9]*"' | tr -d '"(' | tr '\n' ' ')
check "vaultDataSchema() fields" "$FIELDS" "owner, address bridge, address nodeFund, address "
POLICIES=$(call "$FACTORY" 'tokenCreationPolicies()((string,string,bytes,string)[])')
POL=$(echo "$POLICIES" | grep -o '("[A-Za-z]*", "[a-z]*"' | tr -d '"(' | tr '\n' ' ')
check "tokenCreationPolicies() (8 rules)" "$POL" \
  "quoteToken, eq tokenVersion, eq mktBps, eq dividendBps, eq buyTaxRate, eq sellTaxRate, eq deflationBps, eq lpBps, eq "
printf '  %-36s %s\n' "VaultPortal.getFactoryPolicy()" "$(call $VP 'getFactoryPolicy(address)(uint8,bytes32,string)' "$FACTORY" | cut -c1-90)"

# ── the launch-form vaultData and the three token immutables ──
VD=$(cast abi-encode 'f(address,address,address)' "$VAULT_OWNER" "$BRIDGE" "$NODEFUND")
echo
echo "vaultData      $VD"
echo "               owner=$VAULT_OWNER bridge=$BRIDGE nodeFund=$NODEFUND"

echo
echo "token-immutable pre-checks (section 9 step 9, item 1)"
BRIDGE_T=$(call "$BRIDGE" 'bacToken()(address)')
FUND_T=$(call "$NODEFUND" 'bacToken()(address)')
check "BacBridge.bacToken()" "$BRIDGE_T" "$BRIDGE_T"
check "BacNodeFund.bacToken() == bridge's" "$FUND_T" "$BRIDGE_T"
if is_addr "${STAKING:-}"; then
  check "ValidatorStaking.bacToken() == bridge's" "$(call "$STAKING" 'bacToken()(address)')" "$BRIDGE_T"
fi
if is_addr "${REGISTRY:-}"; then
  check "BacBridge.registry()" "$(call "$BRIDGE" 'registry()(address)')" "$REGISTRY"
fi

# ── vanity salt for the Tax Token V3 clone ──
HASH=$(cast keccak "0x3d602d80600a3d3981f3363d3d373d3d3d363d73${IMPL_V3#0x}5af43d82803e903d91602b57fd5bf3")
[ "$HASH" = "0x2f7f413fcc6c3812c665c15bd4a012e663f567d626112a81d401066fd5a771b4" ] || die "unexpected clone init-code hash $HASH"
predict() { local a; a=$(cast keccak "0xff${PORTAL#0x}${1#0x}${HASH#0x}"); cast to-check-sum-address "0x${a: -40}"; }
free_salt() {
  local s p st
  for _ in 1 2 3 4 5; do
    s=$(cast create2 --ends-with 7777 --deployer $PORTAL --init-code-hash "$HASH" 2>&1 | grep -i '^salt' | grep -o '0x[0-9a-fA-F]\{64\}' | head -1)
    [ -n "$s" ] || continue
    p=$(predict "$s")
    st=$(call $PORTAL 'getTokenV8Safe(address)(uint8)' "$p")
    if [[ "$st" == *revert* ]]; then st=0; else st=$(echo "$st" | awk '{print $1}'); fi
    if [ "$(rpc codesize "$p")" = "0" ] && [ "$st" = "0" ]; then echo "$s"; return 0; fi
  done
  return 1
}
if [ -z "$SALT" ]; then
  SALT=$(free_salt) || die "could not mine a free ...7777 salt"
fi
[[ "$SALT" =~ ^0x[0-9a-fA-F]{64}$ ]] || die "SALT must be 32 bytes hex"
PRED=$(predict "$SALT")
echo
echo "vanity salt    $SALT"
echo "token address  $PRED (predicted, CREATE2 from the Portal)"
[[ "$PRED" =~ 7777$ ]] || echo "WARNING: predicted address does not end in 7777 (custom SALT?)"

# THE check that decides whether the whole deployment is usable: the three immutables were
# written with T, and T must be exactly what this salt predicts.
if [ "$(echo "$BRIDGE_T" | tr 'A-F' 'a-f')" != "$(echo "$PRED" | tr 'A-F' 'a-f')" ]; then
  echo "  MISMATCH  BacBridge.bacToken()=$BRIDGE_T  but this salt predicts $PRED"
  echo "            -> launching with this salt reverts in newVault (\"Bridge is bound to another token\")."
  echo "            -> pass the locked salt with --salt, or the whole deployment must be redone."
  PRE_FAIL=1
else
  printf '  %-36s %s  ok\n' "bacToken() == predicted token" "$PRED"
fi
if is_addr "${TOKEN:-}" && [ "$(echo "$TOKEN" | tr 'A-F' 'a-f')" != "$(echo "$PRED" | tr 'A-F' 'a-f')" ]; then
  echo "  MISMATCH  --token $TOKEN != predicted $PRED"
  PRE_FAIL=1
fi
[ "$(rpc codesize "$PRED")" = "0" ] || { echo "  MISMATCH  predicted token address already has code"; PRE_FAIL=1; }

# ── parameter tuple ──
# mk <salt> <quoteToken> <quoteAmt> <buy> <sell> <mkt> <defl> <div> <lp> <tokenVersion> <factory> <vaultData>
mk() {
  echo "(\"$NAME\",\"$SYMBOL\",\"$META\",1,$1,1,$2,$3,0x,$Z32,0x,0,0,$4,$5,$TAXDURATION,$ANTIFARMER,$6,$7,$8,$9,$MINSHARE,$DIVTOKEN,$COMMISSION,${10},${11},${12})"
}
PLANNED=$(mk "$SALT" $ZERO "$QUOTE_WEI" "$BUY" "$SELL" "$MKT" "$DEFL" "$DIV" "$LP" 6 "$FACTORY" "$VD")

# ── Portal.lockSalt: the fee, read live, and whether this salt is still lockable ──
# Measured on BSC mainnet 2026-09-23: lockSalt(salt, TOKEN_TAXED_V3) demands exactly 0.01 BNB
# and costs about 150,641 gas. Calling it with value 0 reverts with
# SaltLockFeeMismatch(uint256 required, uint256 provided) = selector 0x20beb318, so the required
# fee can be read without sending anything.
LOCK_OUT=$(call $PORTAL 'lockSalt(bytes32,uint8)' "$SALT" 6 --from "$LAUNCHER" --value 0)
if [[ "$LOCK_OUT" == *20beb318* ]]; then
  # cast renders the revert differently depending on the node (raw hex blob on a public RPC,
  # "custom error 0x20beb318: <args>" on anvil), so take everything after the LAST occurrence of
  # the selector, drop the separators, and read the first 32-byte word.
  LOCK_HEX=$(printf '%s' "$LOCK_OUT" | sed 's/.*20beb318//' | tr -cd '0-9a-fA-F')
  LOCK_FEE=$(cast --to-dec "0x${LOCK_HEX:0:64}" 2>/dev/null)
  echo
  printf '  %-36s %s wei (%s BNB)\n' "Portal.lockSalt required fee" "${LOCK_FEE:-?}" "$(cast from-wei "${LOCK_FEE:-0}")"
  echo "                                       step 9-1: lock this salt BEFORE anything else, or a stranger can take T"
else
  echo
  echo "  NOTE  Portal.lockSalt(salt, 6) did not answer with SaltLockFeeMismatch:"
  echo "        $(echo "$LOCK_OUT" | cut -c1-160)"
  echo "        (already locked, or the Portal changed — check before launching)"
fi

echo
echo "planned form   name=\"$NAME\" symbol=\"$SYMBOL\" buy/sell=${BUY}/${SELL} bps  mkt/defl/div/lp=${MKT}/${DEFL}/${DIV}/${LP}"
echo "               taxDuration=${TAXDURATION}s antiFarmer=${ANTIFARMER}s minShare=${MINSHARE} firstBuy=${QUOTE_AMT} BNB"
echo "               vault factory=${FACTORY}  sender=${LAUNCHER}"
[ $((MKT + DEFL + DIV + LP)) -eq 10000 ] || echo "WARNING: split sums to $((MKT + DEFL + DIV + LP)), not 10000"
[ "$MKT" -eq 10000 ] || echo "WARNING: mktBps must be exactly 10000 (the factory rejects anything else)"
[ "$BUY" -eq 200 ] && [ "$SELL" -eq 200 ] || echo "WARNING: buy and sell tax must both be exactly 200 bps"
[ "$TAXDURATION" -ge 3153600000 ] || echo "WARNING: taxDuration below 100 years — after it expires the vault stops receiving tax FOREVER"

FAILS=0
hexof() { printf '%s' "$1" | od -An -tx1 | tr -d ' \n'; }
# row <label> <expect: ok|substring> <params> [value] [from]
row() {
  local label="$1" expect="$2" params="$3" value="${4:-0}" from="${5:-$LAUNCHER}" out verdict lo needle hex
  out=$(call $VP "$SIG" "$params" --from "$from" --value "$value")
  if [ "$expect" = "ok" ]; then
    if [ "$(echo "$out" | tr 'A-F' 'a-f' | xargs)" = "$(echo "$PRED" | tr 'A-F' 'a-f')" ]; then verdict="PASS"; else verdict="FAIL"; fi
  else
    lo=$(echo "$out" | tr 'A-F' 'a-f')
    needle=$(echo "$expect" | tr 'A-F' 'a-f')
    hex=$(hexof "$expect")
    if [[ "$out" == *"$expect"* || "$lo" == *"$needle"* || "$lo" == *"$hex"* ]] && [[ "$lo" == *revert* || "$lo" == *error* ]]; then
      verdict="PASS"
    else
      verdict="FAIL"
    fi
  fi
  [ "$verdict" = "PASS" ] || FAILS=$((FAILS + 1))
  printf '%-4s %-46s -> %s\n' "$verdict" "$label" "$(echo "$out" | cut -c1-200)"
}

echo
echo "== launch rows (eth_call VaultPortal.newTokenV6WithVault, from $LAUNCHER) =="
row "planned form" ok "$PLANNED" "$QUOTE_WEI"

if [ "$NEGATIVE" = "1" ]; then
  echo
  echo "== negative rows (each must fail, with the named reason) =="
  # Reasons below are the ones actually observed on a BSC fork, not the ones one would guess:
  # the factory hook tests vaultBps BEFORE dividend/deflation/lp, and because the four shares
  # must sum to 10000, any non-zero dividend/deflation/lp necessarily drags vaultBps off 10000.
  # So through the VaultPortal those three always surface as the vault-share reason. The three
  # branches are exercised one at a time in the hook block below instead.
  S1=0x0000000000000000000000000000000000000000000000000000000000000001
  STRANGER=0x000000000000000000000000000000000000dEaD
  VD_BAD_FUND=$(cast abi-encode 'f(address,address,address)' "$VAULT_OWNER" "$BRIDGE" "$BRIDGE")
  VD_EOA=$(cast abi-encode 'f(address,address,address)' "$VAULT_OWNER" "$STRANGER" "$NODEFUND")
  VD_NOTABRIDGE=$(cast abi-encode 'f(address,address,address)' "$VAULT_OWNER" "$VP" "$NODEFUND")
  VD_ZERO=$(cast abi-encode 'f(address,address,address)' "$VAULT_OWNER" "$ZERO" "$NODEFUND")

  row "sender is not the LAUNCHER"        "Launcher not allowed" \
    "$PLANNED" 0 "$STRANGER"
  row "buy tax 300 bps"                   "Buy tax must be exactly 2%" \
    "$(mk "$SALT" $ZERO 0 300 "$SELL" "$MKT" "$DEFL" "$DIV" "$LP" 6 "$FACTORY" "$VD")"
  row "sell tax 300 bps"                  "Sell tax must be exactly 2%" \
    "$(mk "$SALT" $ZERO 0 "$BUY" 300 "$MKT" "$DEFL" "$DIV" "$LP" 6 "$FACTORY" "$VD")"
  row "mktBps 8000 (vault share 80%)"     "Vault share must be exactly 100%" \
    "$(mk "$SALT" $ZERO 0 "$BUY" "$SELL" 8000 0 2000 0 6 "$FACTORY" "$VD")"
  row "dividendBps 2000 -> vault share"   "Vault share must be exactly 100%" \
    "$(mk "$SALT" $ZERO 0 "$BUY" "$SELL" 8000 0 2000 0 6 "$FACTORY" "$VD")"
  row "deflationBps 2000 -> vault share"  "Vault share must be exactly 100%" \
    "$(mk "$SALT" $ZERO 0 "$BUY" "$SELL" 8000 2000 0 0 6 "$FACTORY" "$VD")"
  row "lpBps 2000 -> vault share"         "Vault share must be exactly 100%" \
    "$(mk "$SALT" $ZERO 0 "$BUY" "$SELL" 8000 0 0 2000 6 "$FACTORY" "$VD")"
  # Flap's own UnsupportedQuoteToken fires before our hook is reached.
  row "USDT quote (Flap selector 1bdf902f)" "1bdf902f" \
    "$(mk "$SALT" $USDT 0 "$BUY" "$SELL" "$MKT" "$DEFL" "$DIV" "$LP" 6 "$FACTORY" "$VD")"
  row "tokenVersion 5 (Flap selector ac5f6092)" "ac5f6092" \
    "$(mk "$SALT" $ZERO 0 "$BUY" "$SELL" "$MKT" "$DEFL" "$DIV" "$LP" 5 "$FACTORY" "$VD")"
  row "bad vanity salt (Flap selector 7576ca0a)" "7576ca0a" \
    "$(mk $S1 $ZERO 0 "$BUY" "$SELL" "$MKT" "$DEFL" "$DIV" "$LP" 6 "$FACTORY" "$VD")"
  row "vaultData bridge == nodeFund"      "Bad bridge or node fund" \
    "$(mk "$SALT" $ZERO 0 "$BUY" "$SELL" "$MKT" "$DEFL" "$DIV" "$LP" 6 "$FACTORY" "$VD_BAD_FUND")"
  row "vaultData bridge = 0x0"            "Bad bridge or node fund" \
    "$(mk "$SALT" $ZERO 0 "$BUY" "$SELL" "$MKT" "$DEFL" "$DIV" "$LP" 6 "$FACTORY" "$VD_ZERO")"
  row "vaultData bridge = an EOA"         "Bridge or node fund has no code" \
    "$(mk "$SALT" $ZERO 0 "$BUY" "$SELL" "$MKT" "$DEFL" "$DIV" "$LP" 6 "$FACTORY" "$VD_EOA")"
  # A contract with no bacToken(): the call inside newVault reverts with empty data, so the
  # whole launch reverts with empty data too. We only assert that it does revert.
  row "vaultData bridge = a foreign contract" "revert" \
    "$(mk "$SALT" $ZERO 0 "$BUY" "$SELL" "$MKT" "$DEFL" "$DIV" "$LP" 6 "$FACTORY" "$VD_NOTABRIDGE")"

  echo
  echo "== hook rows (staticcall BacVaultFactory.onBeforeLaunch, one branch at a time) =="
  HOOK_T='(uint8,address,uint16,uint16,uint16,uint16,uint16,uint16,address,uint256)'
  MAGIC_DIVIDEND=0xC0Dec0dec0DeC0Dec0dEc0DEC0DEC0DEC0DEC0dE
  # hook <label> <want: ok|substring> <tokenVersion> <quote> <buy> <sell> <vaultBps> <defl> <div> <lp> <divToken>
  hook() {
    local label="$1" want="$2"; shift 2
    local enc out verdict
    enc=$(cast abi-encode "f($HOOK_T)" "($1,$2,$3,$4,$5,$6,$7,$8,$9,0)")
    out=$(call "$FACTORY" 'onBeforeLaunch(bytes)(bool,string)' "$enc" | tr '\r\n' '  ')
    if [ "$want" = "ok" ]; then
      [[ "$out" == true* ]] && verdict=PASS || verdict=FAIL
    else
      if [[ "$out" == false* ]] && [[ "$out" == *"$want"* ]]; then verdict=PASS; else verdict=FAIL; fi
    fi
    [ "$verdict" = "PASS" ] || FAILS=$((FAILS + 1))
    printf '%-4s %-46s -> %s\n' "$verdict" "$label" "$(echo "$out" | cut -c1-150)"
  }
  hook "planned form returns (true, \"\")" ok            6 $ZERO 200 200 10000 0 0 0 $ZERO
  hook "quoteToken USDT"        "BNB quote only"          6 $USDT 200 200 10000 0 0 0 $ZERO
  hook "tokenVersion 5"         "Tax Token V3 only"       5 $ZERO 200 200 10000 0 0 0 $ZERO
  hook "buyTaxRate 300"         "Buy tax must be exactly 2%"     6 $ZERO 300 200 10000 0 0 0 $ZERO
  hook "sellTaxRate 300"        "Sell tax must be exactly 2%"    6 $ZERO 200 300 10000 0 0 0 $ZERO
  hook "vaultBps 8000"          "Vault share must be exactly 100%" 6 $ZERO 200 200 8000 0 0 0 $ZERO
  hook "dividendBps 1"          "Holder dividend must be 0%"     6 $ZERO 200 200 10000 0 1 0 $ZERO
  hook "deflationBps 1"         "Deflation must be 0%"           6 $ZERO 200 200 10000 1 0 0 $ZERO
  hook "lpBps 1"                "LP share must be 0%"            6 $ZERO 200 200 10000 0 0 1 $ZERO
  hook "dividendToken = MAGIC"  "Computed dividend token not supported" \
    6 $ZERO 200 200 10000 0 0 0 $MAGIC_DIVIDEND
fi

echo
if [ "$PRE_FAIL" != "0" ]; then echo "RESULT: pre-check mismatch (see above)"; fi
if [ "$FAILS" = "0" ] && [ "$PRE_FAIL" = "0" ]; then
  echo "RESULT: all rows behaved as expected (nothing was sent)"
  echo "        launch salt to type into flap.sh: $SALT"
  exit 0
fi
echo "RESULT: $FAILS row(s) did not behave as expected (nothing was sent)"
exit 1
