#!/usr/bin/env bash
#
# chain/verify-genesis.sh - boot a throwaway node from a genesis file and read everything back.
#
# This is the other half of chain/build-genesis.sh (02-CHAIN-SPEC.md 3.3 steps 6-10).  build makes
# the file; this proves that a real client, starting from that file and nothing else, ends up with
# the chain we described: the right code at the right addresses, no storage anywhere, the right
# balances, the right validator set, cancun actually live, and a genesis hash we can publish.
#
# WHERE EACH STEP RUNS
#   Steps marked [SERVER] need Docker, which only the server has.  Run the whole script there:
#       scp -r chain ops@<server>:/opt/bac/     # or git pull on the server
#       cd /opt/bac && bash chain/verify-genesis.sh --boot --genesis chain/build/genesis.json
#   Steps marked [ANYWHERE] only need `cast` and a reachable RPC, so you can also point this at a
#   node somebody else is running:
#       bash chain/verify-genesis.sh --rpc https://95-179-183-132.sslip.io/rpc --genesis chain/build/genesis.json
#   In --rpc mode the script skips the two Docker-only cross-checks and says so at the end.
#
# NEVER BROADCASTS.  The cancun proof is an eth_call with no `to` address (see
# contracts/script/CancunProbe.sol): the node executes the init code and returns its result, no
# transaction, no key, no state change.  Nothing in this file signs anything.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHAIN="$ROOT/chain"
CONTRACTS="$ROOT/contracts"

GENESIS=""
RPC=""
BOOT=0
PORT="${BAC_VERIFY_PORT:-18546}"
IMAGE="${BAC_BESU_IMAGE:-hyperledger/besu:24.12.2}"
CONTAINER="${BAC_VERIFY_CONTAINER:-bac-genverify}"
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --genesis) GENESIS="$2"; shift 2 ;;
    --rpc)     RPC="$2"; shift 2 ;;
    --boot)    BOOT=1; shift ;;
    --keep)    KEEP=1; shift ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say()    { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()     { printf '   ok   %s\n' "$*"; }
info()   { printf '   ..   %s\n' "$*"; }
skip()   { printf '   --   SKIPPED (needs Docker): %s\n' "$*"; SKIPPED=$((SKIPPED+1)); }
die()    { printf '\n\033[1mVERIFY FAILED: %s\033[0m\n' "$*" >&2; exit 1; }
SKIPPED=0

[ -n "$GENESIS" ] || die "--genesis <file> is required"
[ -f "$GENESIS" ] || die "no such genesis file: $GENESIS"
GENESIS="$(cd "$(dirname "$GENESIS")" && pwd)/$(basename "$GENESIS")"

jget() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1]))
cur=d
for k in sys.argv[2].split("."):
    cur=cur[k]
print(cur if not isinstance(cur,(dict,list)) else json.dumps(cur))' "$GENESIS" "$1"; }

# --------------------------------------------------------------------------------- 0. preflight --

say "0. preflight"
for tool in cast python3; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found in PATH"
done
ok "cast, python3 present"
ok "genesis file $GENESIS"

EXPECT_STATE_ROOT="$(python3 "$CHAIN/scripts/statetrie.py" --genesis "$GENESIS")"
ok "expected state root (recomputed from the file, no client) $EXPECT_STATE_ROOT"

EXTRADATA="$(jget extraData)"
EXPECT_VALIDATORS="$(python3 "$CHAIN/scripts/qbft_extradata.py" --decode "$EXTRADATA" \
  | python3 -c 'import json,sys; print(" ".join(json.load(sys.stdin)["validators"]))')"
ok "genesis extraData commits to validator(s): $EXPECT_VALIDATORS"

# ----------------------------------------------------------------------------- 1. [SERVER] boot --

say "1. [SERVER] boot a throwaway node on this genesis"
BOOTED=0
if [ "$BOOT" = 1 ]; then
  command -v docker >/dev/null 2>&1 || die "--boot needs Docker; use --rpc against a running node instead"
  WORK="$(dirname "$GENESIS")"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  KEYFLAG=()
  KEYDIR="$(ls -d "$WORK"/networkFiles/keys/0x* 2>/dev/null | head -1 || true)"
  if [ -n "$KEYDIR" ]; then
    KEYFLAG=(--node-private-key-file="/g/networkFiles/keys/$(basename "$KEYDIR")/key")
    info "using the validator key from $KEYDIR - this node will PRODUCE BLOCKS"
  else
    info "no validator key next to the genesis: the node will sync but never propose."
    info "Block production checks will be skipped. Point --genesis at chain/build/genesis.json"
    info "on the server, where networkFiles/keys/0x<validator>/key lives, to exercise them."
  fi
  docker run -d --name "$CONTAINER" -u "$(id -u):$(id -g)" \
    -v "$WORK:/g" -p "127.0.0.1:$PORT:8545" "$IMAGE" \
    --data-path=/g/verifydata --genesis-file="/g/$(basename "$GENESIS")" \
    ${KEYFLAG[@]+"${KEYFLAG[@]}"} \
    --rpc-http-enabled --rpc-http-host=0.0.0.0 --rpc-http-api=ETH,NET,WEB3,QBFT \
    --host-allowlist="*" --min-gas-price=1000000000 --p2p-enabled=false \
    --data-storage-format=BONSAI --sync-mode=FULL >/dev/null
  BOOTED=1
  cleanup() {
    if [ "$BOOTED" = 1 ] && [ "$KEEP" = 0 ]; then
      docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
      rm -rf "$WORK/verifydata" 2>/dev/null || true
    fi
  }
  trap cleanup EXIT
  RPC="http://127.0.0.1:$PORT"
  for _ in $(seq 1 120); do
    cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
    sleep 1
  done
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 \
    || { docker logs --tail 60 "$CONTAINER"; die "Besu did not come up on this genesis"; }
  ok "container $CONTAINER up, RPC $RPC"
elif [ -n "$RPC" ]; then
  info "using the node you gave me: $RPC (nothing was booted here)"
else
  echo
  echo "   Neither --boot nor --rpc. On the server, run:"
  printf '   \033[1mRUN ON THE SERVER:\033[0m bash chain/verify-genesis.sh --boot --genesis %s\n' "$GENESIS"
  die "no node to verify against"
fi

CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"
[ "$CHAIN_ID" = "$(jget config.chainId)" ] || die "node reports chain id $CHAIN_ID, genesis says $(jget config.chainId)"
ok "chain id $CHAIN_ID"

# ------------------------------------------------------------------------ 2. the genesis header --

say "2. [ANYWHERE] genesis block header"
BLOCK0="$(cast rpc eth_getBlockByNumber '"0x0"' false --rpc-url "$RPC")"
b0() { printf '%s' "$BLOCK0" | python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1],"<absent>"))' "$1"; }
GENESIS_HASH="$(b0 hash)"
GOT_STATE_ROOT="$(b0 stateRoot)"
[ "$GOT_STATE_ROOT" = "$EXPECT_STATE_ROOT" ] \
  || die "state root mismatch: node says $GOT_STATE_ROOT, the alloc in $GENESIS computes to $EXPECT_STATE_ROOT"
ok "state root matches the one computed from the file alone: $GOT_STATE_ROOT"
for field in extraData gasLimit difficulty mixHash timestamp baseFeePerGas; do
  want="$(jget "$field")"
  got="$(b0 "$field")"
  [ "$(printf '%s' "$got" | tr 'A-F' 'a-f')" = "$(printf '%s' "$want" | tr 'A-F' 'a-f')" ] \
    || die "header.$field is $got, genesis says $want"
  ok "header.$field = $got"
done
printf '\n   \033[1mGENESIS HASH  %s\033[0m\n' "$GENESIS_HASH"
printf '   ^ this is the chain identity. Record it in chain/GENESIS.md and on the website.\n'

# ------------------------------------------------------------------- 3. alloc: code and balances --

say "3. [ANYWHERE] alloc read back at block 0, byte for byte"
python3 - "$GENESIS" >"${TMPDIR:-/tmp}/bac-alloc.txt" <<'PY'
import json, sys
g = json.load(open(sys.argv[1]))
for addr, entry in g["alloc"].items():
    print("%s %s %s" % (addr, entry.get("balance", "0x0"), entry.get("code", "0x")))
PY
while read -r ADDR BAL CODE; do
  got_bal="$(cast rpc eth_getBalance "\"$ADDR\"" '"0x0"' --rpc-url "$RPC" | tr -d '"')"
  [ "$(cast to-dec "$got_bal")" = "$(cast to-dec "$BAL")" ] \
    || die "$ADDR balance at block 0 is $got_bal, genesis says $BAL"
  got_code="$(cast code "$ADDR" --block 0 --rpc-url "$RPC")"
  [ "$(printf '%s' "$got_code" | tr 'A-F' 'a-f')" = "$(printf '%s' "$CODE" | tr 'A-F' 'a-f')" ] \
    || die "$ADDR code at block 0 differs from the genesis file ($(( (${#got_code} - 2) / 2 )) vs $(( (${#CODE} - 2) / 2 )) bytes)"
  ok "$ADDR balance $(cast to-dec "$BAL") wei, code $(( (${#CODE} - 2) / 2 )) bytes - identical"
done < "${TMPDIR:-/tmp}/bac-alloc.txt"

SUM="$(python3 -c '
import json,sys
g=json.load(open(sys.argv[1]))
print(sum(int(e.get("balance","0x0"),16) for e in g["alloc"].values()))' "$GENESIS")"
[ "$SUM" = "1000000000000000000000000000" ] \
  || die "alloc balances sum to $SUM, expected TOTAL_SUPPLY = 1000000000000000000000000000"
ok "alloc sums to exactly 1e27 wei = 1,000,000,000 BAC (the fixed supply on the BSC side)"

# EIP-4788 is deliberately NOT predeployed (02-CHAIN-SPEC 3.2): this chain has no beacon chain.
[ "$(cast code 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02 --block 0 --rpc-url "$RPC")" = "0x" ] \
  || die "something is deployed at the EIP-4788 beacon-root address; genesis was supposed to leave it empty"
ok "0x000F3df6...Beac02 is empty, as designed (no beacon chain here)"

# ------------------------------------------------------------------------- 4. no storage at all --

say "4. [ANYWHERE] no storage slot anywhere in the system contracts"
for ADDR in 0x0000000000000000000000000000000000000101 \
            0x0000000000000000000000000000000000000102 \
            0x0000000000000000000000000000000000000103 \
            0x0000000000000000000000000000000000000104 \
            0x0000000000000000000000000000000000000106; do
  for SLOT in $(seq 0 15); do
    V="$(cast storage "$ADDR" "$SLOT" --block 0 --rpc-url "$RPC")"
    [ "$V" = "0x0000000000000000000000000000000000000000000000000000000000000000" ] \
      || die "NON-ZERO STORAGE at genesis: $ADDR slot $SLOT = $V"
  done
  ok "$ADDR slots 0..15 all zero"
done

# --------------------------------------------------------------------------- 5. every view back --

say "5. [ANYWHERE] system contract views"
L2BRIDGE=0x0000000000000000000000000000000000000101
L2GATE=0x0000000000000000000000000000000000000102
AGENTBOOK=0x0000000000000000000000000000000000000103
FEESPLITTER=0x0000000000000000000000000000000000000104
WBAC=0x0000000000000000000000000000000000000106
MULTICALL3=0xcA11bde05977b3631167028862bE2a173976CA11

RELAYER="$(python3 -c '
import json,sys
g=json.load(open(sys.argv[1]))
fixed={"0000000000000000000000000000000000000101","0000000000000000000000000000000000000102",
       "0000000000000000000000000000000000000103","0000000000000000000000000000000000000104",
       "0000000000000000000000000000000000000106",
       "ca11bde05977b3631167028862be2a173976ca11","4e59b44847b379578588920ca78fbf26c0b4956c",
       "000000000000000000000000000000000000dead"}
for a in g["alloc"]:
    if a.lower().replace("0x","") not in fixed:
        print(a)' "$GENESIS")"
ok "relayer (the one EOA with a genesis balance) $RELAYER"

lc() { printf '%s' "$1" | tr 'A-F' 'a-f' | tr -d '"'; }   # cast quotes string returns
expect() {                       # expect LABEL ADDRESS EXPECTED SIG [ARGS...]
  local label="$1" addr="$2" want="$3"; shift 3
  local got
  got="$(cast call "$addr" "$@" --rpc-url "$RPC")" || die "$label reverted"
  [ "$(lc "$got")" = "$(lc "$want")" ] || die "$label: got $got, expected $want"
  ok "$label = $want"
}

expect "L2Bridge.relayer()"        "$L2BRIDGE" "$RELAYER" "relayer()(address)"
expect "L2Bridge.reserve()"        "$L2BRIDGE" "999999000000000000000000000" "reserve()(uint256)"
expect "L2Bridge.rotationNonce()"  "$L2BRIDGE" "0" "rotationNonce()(uint256)"
expect "L2Bridge.totalCredited()"  "$L2BRIDGE" "0" "totalCredited()(uint256)"
expect "L2Bridge.totalExited()"    "$L2BRIDGE" "0" "totalExited()(uint256)"
expect "L2Bridge.totalBurnedFloat()" "$L2BRIDGE" "0" "totalBurnedFloat()(uint256)"
expect "L2Bridge.exitCount()"      "$L2BRIDGE" "0" "exitCount()(uint64)"
expect "L2Gate.isAdmitted(relayer)" "$L2GATE" "false" "isAdmitted(address)(bool)" "$RELAYER"
expect "L2Gate.agentIdOf(relayer)"  "$L2GATE" "0" "agentIdOf(address)(uint256)" "$RELAYER"
expect "L2Gate.statusOf(relayer)"   "$L2GATE" "0" "statusOf(address)(uint8)" "$RELAYER"
expect "AgentBook.actionCount()"    "$AGENTBOOK" "0" "actionCount()(uint64)"
cast call "$MULTICALL3" "getBlockNumber()(uint256)" --rpc-url "$RPC" >/dev/null \
  || die "Multicall3.getBlockNumber() reverted - the canonical predeploy is not working"
ok "Multicall3.getBlockNumber() answers"

# WBAC (decision #22): the wrapped native coin, a neutral tool sitting next to Multicall3 and the
# CREATE2 deployer. Nothing on this chain calls it and nobody can change it, so all we verify is
# that the genesis really holds an empty WETH9 with the literal name and symbol that were frozen,
# and that no coin stands behind it yet (totalSupply() IS address(this).balance, so a non-zero
# reading here would mean the alloc handed it a balance it must never have).
expect "WBAC.name()"        "$WBAC" "Wrapped BAC" "name()(string)"
expect "WBAC.symbol()"      "$WBAC" "WBAC"        "symbol()(string)"
expect "WBAC.decimals()"    "$WBAC" "18"          "decimals()(uint8)"
expect "WBAC.totalSupply()" "$WBAC" "0"           "totalSupply()(uint256)"
expect "WBAC.balanceOf(relayer)" "$WBAC" "0" "balanceOf(address)(uint256)" "$RELAYER"

FEECODE="$(cast code "$FEESPLITTER" --block 0 --rpc-url "$RPC")"
if [ "$(( (${#FEECODE} - 2) / 2 ))" -lt 32 ]; then
  die "0x..0104 holds $(( (${#FEECODE} - 2) / 2 )) bytes of code - that is the rehearsal stub, not
     FeeSplitter. Decision #17 requires the real contract at genesis; code cannot be added later."
fi
expect "FeeSplitter.relayer()" "$FEESPLITTER" "$RELAYER" "relayer()(address)"
expect "FeeSplitter.rotationNonce()" "$FEESPLITTER" "0" "rotationNonce()(uint256)"
expect "FeeSplitter.lifetimeOfficialGross()" "$FEESPLITTER" "0" "lifetimeOfficialGross()(uint256)"
expect "FeeSplitter.foundationBalance()" "$FEESPLITTER" "0" "foundationBalance()(uint256)"

# 0x...0105 is RESERVED for the v2 validator-contract mode (02-CHAIN-SPEC 6.3) and must be empty
# at genesis. Genesis code can never be added later, but an address left empty can still be taken
# by an ordinary deploy when the time comes - which is the whole point of reserving it.
[ "$(cast code 0x0000000000000000000000000000000000000105 --block 0 --rpc-url "$RPC")" = "0x" ] \
  || die "0x..0105 holds code; it is reserved for the v2 validator-set mirror and must be empty"
ok "0x..0105 is empty, as reserved"

# ------------------------------------------------------------------------- 6. the validator set --

say "6. [ANYWHERE] QBFT validator set"
GOT_VALIDATORS="$(cast rpc qbft_getValidatorsByBlockNumber '"latest"' --rpc-url "$RPC" \
  | python3 -c 'import json,sys; print(" ".join(v.lower() for v in json.load(sys.stdin)))')"
WANT_VALIDATORS="$(printf '%s' "$EXPECT_VALIDATORS" | tr 'A-F' 'a-f')"
[ "$GOT_VALIDATORS" = "$WANT_VALIDATORS" ] \
  || die "validator set is [$GOT_VALIDATORS], the genesis extraData commits to [$WANT_VALIDATORS]"
ok "qbft_getValidatorsByBlockNumber(latest) = [$GOT_VALIDATORS], and it matches extraData"
COUNT="$(printf '%s\n' $GOT_VALIDATORS | wc -l | tr -d ' ')"
[ "$COUNT" = "1" ] || info "validator count is $COUNT - v1 is supposed to be exactly 1 (decision #6)"

# ----------------------------------------------------------------------------- 7. cancun is on --

say "7. [ANYWHERE] cancun really executes (MCOPY + TSTORE/TLOAD)"
PROBE=""
if command -v forge >/dev/null 2>&1 && [ -d "$CONTRACTS" ]; then
  PROBE="$(cd "$CONTRACTS" && forge inspect CancunProbe bytecode 2>/dev/null | tail -1 || true)"
fi
[ -n "$PROBE" ] && [ "$PROBE" != "0x" ] \
  || die "could not build contracts/script/CancunProbe.sol (needs forge and the repo)"
RESULT="$(cast call --rpc-url "$RPC" --create "$PROBE")" \
  || die "the cancun probe REVERTED. MCOPY/TSTORE are not available on this chain, which means every
     layer contract compiled with evm_version=cancun is illegal code at an address genesis froze."
EXPECT_PROBE="0x000000000000000000000000000000000000000000000000000000000000002a"
EXPECT_PROBE="${EXPECT_PROBE}00c0ffee00000000000000000000000000000000000000000000000000c0ffee"
[ "$(lc "$RESULT")" = "$(lc "$EXPECT_PROBE")" ] \
  || die "cancun probe returned $RESULT, expected $EXPECT_PROBE"
ok "TSTORE/TLOAD and MCOPY both work; cancunTime is live"

# ------------------------------------------------------- 8. liveness, coinbase, and zeroBaseFee --

say "8. [ANYWHERE] block production"
H1="$(cast block-number --rpc-url "$RPC")"
if [ "$H1" = "0" ]; then
  info "height is still 0 - this node has no validator key, so it cannot propose. Block-period,"
  info "coinbase and fee checks skipped; run this on the server with the real key to exercise them."
else
  sleep 7
  H2="$(cast block-number --rpc-url "$RPC")"
  [ "$H2" -gt "$H1" ] || die "no new block in 7 seconds (height stuck at $H1); the chain is not producing"
  ok "height $H1 -> $H2 in 7s (blockperiodseconds is 3)"
  MINER="$(cast rpc eth_getBlockByNumber '"latest"' false --rpc-url "$RPC" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["miner"].lower())')"
  case " $WANT_VALIDATORS " in
    *" $MINER "*) ok "header.miner = $MINER, which is in the validator set (this is where gas fees land)" ;;
    *) die "header.miner is $MINER, not one of the validators [$WANT_VALIDATORS]" ;;
  esac
  BF="$(cast rpc eth_getBlockByNumber '"latest"' false --rpc-url "$RPC" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("baseFeePerGas","<absent>"))')"
  [ "$BF" = "0x0" ] || die "latest block has baseFeePerGas=$BF; zeroBaseFee (decision #16) is not in effect"
  ok "baseFeePerGas stays 0x0 on new blocks - all gas becomes tips to the proposer"
fi

# ------------------------------------------------------- 9. [SERVER] extraData cross-check ------

say "9. [SERVER] cross-check our extraData encoder against Besu's"
if command -v docker >/dev/null 2>&1; then
  TMPD="$(mktemp -d)"
  printf '[%s]\n' "$(printf '"%s",' $EXPECT_VALIDATORS | sed 's/,$//')" >"$TMPD/toEncode.json"
  docker run --rm -v "$TMPD:/t" "$IMAGE" \
    rlp encode --from=/t/toEncode.json --to=/t/extraData.txt --type=QBFT_EXTRA_DATA >/dev/null 2>&1 \
    || die "besu rlp encode failed"
  BESU_EXTRA="$(tr -d '\r\n' <"$TMPD/extraData.txt")"
  OUR_EXTRA="$(python3 "$CHAIN/scripts/qbft_extradata.py" --encode $EXPECT_VALIDATORS 2>/dev/null)"
  rm -rf "$TMPD"
  if [ "$(lc "$BESU_EXTRA")" = "$(lc "$EXTRADATA")" ]; then
    ok "besu rlp encode reproduces the genesis extraData exactly"
  else
    die "besu rlp encode gives $BESU_EXTRA but the genesis says $EXTRADATA"
  fi
  if [ "$(lc "$BESU_EXTRA")" = "$(lc "$OUR_EXTRA")" ]; then
    ok "chain/scripts/qbft_extradata.py agrees with Besu - remove the UNVERIFIED note in that file"
  else
    info "our encoder gives $OUR_EXTRA, Besu gives $BESU_EXTRA."
    info "Besu is right. Fix chain/scripts/qbft_extradata.py and record the real layout there."
  fi
else
  skip "besu rlp encode --type=QBFT_EXTRA_DATA cross-check"
  printf '   \033[1mRUN ON THE SERVER:\033[0m bash chain/verify-genesis.sh --boot --genesis %s\n' "$GENESIS"
fi

# ----------------------------------------------------------------------------------- 10. verdict --

say "10. verdict"
printf '   genesis file    %s\n' "$GENESIS"
printf '   chain id        %s\n' "$CHAIN_ID"
printf '   state root      %s\n' "$GOT_STATE_ROOT"
printf '   genesis hash    %s\n' "$GENESIS_HASH"
printf '   validators      %s\n' "$GOT_VALIDATORS"
echo
if [ "$SKIPPED" -gt 0 ]; then
  printf '\033[1mGENESIS VERIFY PASSED (%d Docker-only step(s) skipped)\033[0m\n' "$SKIPPED"
  printf '  Not final until those run on the server.\n'
else
  printf '\033[1mGENESIS VERIFY PASSED\033[0m\n'
fi
