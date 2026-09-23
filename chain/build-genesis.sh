#!/usr/bin/env bash
#
# chain/build-genesis.sh - build the BNB Agent Chain layer genesis from nothing.
#
# Implements 02-CHAIN-SPEC.md 3.3, adapted to what we actually have:
#   * geth is gone from the toolchain (see docs/research/10-consensus-client.md), so the system
#     contracts are deployed on a throwaway **anvil** and their runtime bytecode is read back out;
#   * Docker exists only on the server, so every Besu step is printed as an exact command marked
#     "RUN ON THE SERVER" instead of being faked locally;
#   * the genesis **state root** is computed here, with no client at all
#     (chain/scripts/statetrie.py), so the alloc can be verified by anyone; the genesis **block
#     hash** comes from Besu on the server, because it depends on header fields we have not measured.
#
# BROADCAST SAFETY (hard rule: this repo never broadcasts to a real chain)
#   This script has no mode that talks to a chain it did not start itself.  It launches its own
#   anvil on 127.0.0.1, then refuses to continue unless the RPC URL is loopback AND the chain id is
#   31337.  contracts/script/DeployLayerSystem.s.sol repeats the chain-id check inside the EVM, so a
#   mistyped --rpc-url reverts in simulation before anything is signed.  Nothing here ever reads a
#   private key: the local deploys use anvil's own unlocked account.
#
# USAGE
#   chain/build-genesis.sh                 # launch build: needs real inputs, produces genesis.json
#   chain/build-genesis.sh --rehearsal     # laptop dry run: placeholder inputs, produces
#                                          # genesis.rehearsal.json and never claims to have passed
#
# INPUTS (environment variable NAMES only - this file contains no addresses of record and no keys)
#   BAC_BSC_BRIDGE        BacBridge address on BSC. Becomes L2Bridge.BSC_BRIDGE (immutable).
#   BAC_ROTATION_SIGNER   Offline cold key ADDRESS. Becomes L2Bridge.ROTATION_SIGNER (immutable).
#   BAC_GENESIS_RELAYER   Relayer's layer EOA. Becomes L2Bridge.GENESIS_RELAYER AND the only
#                         externally owned account with a genesis balance (OPERATOR_FLOAT).
#   BAC_GENESIS_TS        Genesis timestamp, unix seconds, MUST be a UTC midnight. Default: the
#                         UTC midnight that starts tomorrow.
#   BAC_BSC_RPC_1/_2      Two independent BSC RPCs. Multicall3 and the CREATE2 deployer runtime are
#                         copied from BSC mainnet and are only accepted if both agree byte for byte.
#   BAC_EXTRADATA         QBFT extraData. Optional if chain/build/networkFiles/genesis.json exists
#                         (the output of `besu operator generate-blockchain-config`, step 0).
#   BAC_ANVIL_PORT        Default 18545.
#   BAC_OUT               Output directory. Default chain/build.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHAIN="$ROOT/chain"
CONTRACTS="$ROOT/contracts"
OUT="${BAC_OUT:-$CHAIN/build}"
PORT="${BAC_ANVIL_PORT:-18545}"
RPC="http://127.0.0.1:$PORT"

REHEARSAL=0
for arg in "$@"; do
  case "$arg" in
    --rehearsal) REHEARSAL=1 ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   ok   %s\n' "$*"; }
info() { printf '   ..   %s\n' "$*"; }
die()  { printf '\n\033[1mBUILD FAILED: %s\033[0m\n' "$*" >&2; exit 1; }
server() { printf '   \033[1mRUN ON THE SERVER:\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------------------------- 0. preflight --

say "0. preflight"
for tool in forge cast anvil python3; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found in PATH"
  ok "$tool $(command -v "$tool")"
done
command -v docker >/dev/null 2>&1 && HAVE_DOCKER=1 || HAVE_DOCKER=0
[ "$HAVE_DOCKER" = 1 ] && ok "docker present" || info "docker absent - Besu steps will be printed, not run"
mkdir -p "$OUT"

if [ "$REHEARSAL" = 1 ]; then
  printf '\n\033[1m*** REHEARSAL MODE ***\033[0m\n'
  printf '   Placeholder inputs, unverified extraData, output named genesis.rehearsal.json.\n'
  printf '   This run can never produce a launch genesis. It exercises the pipeline, nothing else.\n'
  # Obviously-not-real addresses. Valid hex and non-zero, which is all the constructor requires,
  # and nobody can mistake them for the real thing.
  : "${BAC_BSC_BRIDGE:=0x000000000000000000000000000000000000b51d}"
  : "${BAC_ROTATION_SIGNER:=0x000000000000000000000000000000000000c01d}"
  : "${BAC_GENESIS_RELAYER:=0x000000000000000000000000000000000000e1a4}"
  : "${BAC_REHEARSAL_VALIDATOR:=0x000000000000000000000000000000000000fa11}"
fi

for var in BAC_BSC_BRIDGE BAC_ROTATION_SIGNER BAC_GENESIS_RELAYER; do
  [ -n "${!var:-}" ] || die "$var is not set (see the INPUTS block at the top of this file)"
  value="${!var}"
  [[ "$value" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "$var is not a 20-byte address: $value"
  [ "$value" != "0x0000000000000000000000000000000000000000" ] || die "$var is the zero address"
  ok "$var = $value"
done

GENESIS_TS="${BAC_GENESIS_TS:-$(( ( $(date -u +%s) / 86400 + 1 ) * 86400 ))}"
[ $(( GENESIS_TS % 86400 )) -eq 0 ] || die "BAC_GENESIS_TS=$GENESIS_TS is not a UTC midnight"
ok "genesis timestamp $GENESIS_TS ($(date -u -d "@$GENESIS_TS" 2>/dev/null || echo 'UTC midnight'))"

BSC_RPC_1="${BAC_BSC_RPC_1:-https://bsc-dataseed.bnbchain.org}"
BSC_RPC_2="${BAC_BSC_RPC_2:-https://bsc-rpc.publicnode.com}"

# ------------------------------------------------------------ 1. FeeSplitter presence (decision #17)

say "1. genesis contract set"
FEESPLITTER_SRC="$CONTRACTS/src/layer/FeeSplitter.sol"
HAVE_FEESPLITTER=0
if [ -f "$FEESPLITTER_SRC" ]; then
  HAVE_FEESPLITTER=1
  grep -q 'BAC_ADDR_FEESPLITTER' "$CONTRACTS/script/DeployLayerSystem.s.sol" \
    && ! grep -q '// console2.log("BAC_ADDR_FEESPLITTER' "$CONTRACTS/script/DeployLayerSystem.s.sol" \
    || die "FeeSplitter.sol exists but contracts/script/DeployLayerSystem.s.sol still has it commented out - uncomment the three marked lines"
  ok "FeeSplitter.sol present and wired into the deploy script"
else
  if [ "$REHEARSAL" = 1 ]; then
    info "FeeSplitter.sol MISSING - rehearsal will stub 0x..0104 with a single INVALID opcode"
  else
    die "contracts/src/layer/FeeSplitter.sol does not exist.
     Decision #17 puts FeeSplitter at genesis address 0x0000000000000000000000000000000000000104 and
     01-CONTRACT-SPEC.md 11 specifies it in full. Genesis code cannot be added later: a chain built
     without it has an empty account there forever. Write the contract, or run --rehearsal."
  fi
fi

# --------------------------------------------------------------------------------- 2. extraData --

say "2. QBFT extraData"
NETWORK_GENESIS="$OUT/networkFiles/genesis.json"
EXTRADATA=""
VALIDATOR=""
if [ -n "${BAC_EXTRADATA:-}" ]; then
  EXTRADATA="$BAC_EXTRADATA"
  ok "extraData taken from BAC_EXTRADATA"
elif [ -f "$NETWORK_GENESIS" ]; then
  EXTRADATA="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["extraData"])' "$NETWORK_GENESIS")"
  VALIDATOR="$(basename "$(ls -d "$OUT"/networkFiles/keys/0x* 2>/dev/null | head -1)" 2>/dev/null || true)"
  ok "extraData taken from $NETWORK_GENESIS"
  [ -n "$VALIDATOR" ] && ok "validator address (key directory name) $VALIDATOR"
elif [ "$REHEARSAL" = 1 ]; then
  EXTRADATA="$(python3 "$CHAIN/scripts/qbft_extradata.py" --encode "$BAC_REHEARSAL_VALIDATOR" 2>/dev/null)"
  VALIDATOR="$BAC_REHEARSAL_VALIDATOR"
  info "extraData synthesised locally and UNVERIFIED against Besu (rehearsal only)"
else
  echo
  echo "   No extraData. Produce it first, then re-run. This step makes the validator private key,"
  echo "   so it happens once, on the server, and the key never leaves it:"
  server "docker run --rm -u \"\$(id -u):\$(id -g)\" -v \"\$PWD/chain:/cfg\" -v \"\$PWD/chain/build:/out\" \\"
  echo "        hyperledger/besu:24.12.2 operator generate-blockchain-config \\"
  echo "          --config-file=/cfg/qbftConfigFile.json --to=/out/networkFiles --private-key-file-name=key"
  server "chmod 600 chain/build/networkFiles/keys/0x*/key   # and take two offline copies"
  die "extraData missing"
fi
[[ "$EXTRADATA" =~ ^0x[0-9a-fA-F]*$ ]] || die "extraData is not hex: $EXTRADATA"
python3 "$CHAIN/scripts/qbft_extradata.py" --decode "$EXTRADATA" | sed 's/^/   /'

# -------------------------------------------------------------------- 3. throwaway local anvil --

say "3. throwaway anvil on $RPC"
case "$RPC" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) die "refusing to deploy to a non-loopback RPC: $RPC" ;;
esac
if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  die "something is already answering JSON-RPC on $RPC.
     Kill it (or set BAC_ANVIL_PORT to a free port) - this script must own the node it deploys to,
     and silently reusing a stranger's chain is how a genesis ends up with somebody else's state."
fi
anvil --hardfork cancun --chain-id 31337 --port "$PORT" --accounts 1 --balance 1000000 --silent \
  >"$OUT/anvil.log" 2>&1 &
ANVIL_PID=$!
cleanup() {
  kill "$ANVIL_PID" >/dev/null 2>&1 || true
  sleep 1
  kill -9 "$ANVIL_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT
for _ in $(seq 1 60); do
  cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.5
done
cast block-number --rpc-url "$RPC" >/dev/null 2>&1 || die "anvil did not come up (see $OUT/anvil.log)"
CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"
[ "$CHAIN_ID" = "31337" ] || die "RPC at $RPC reports chain id $CHAIN_ID, expected 31337 - refusing to deploy"
SENDER="$(cast rpc eth_accounts --rpc-url "$RPC" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0])')"
ok "anvil pid $ANVIL_PID, chain id 31337, unlocked deployer $SENDER (no private key used)"

# ---------------------------------------------------------- 4. deploy the system contracts here --

say "4. deploy the genesis system contracts"
DEPLOY_LOG="$OUT/deploy.log"
(
  cd "$CONTRACTS"
  BAC_BSC_BRIDGE="$BAC_BSC_BRIDGE" \
  BAC_ROTATION_SIGNER="$BAC_ROTATION_SIGNER" \
  BAC_GENESIS_RELAYER="$BAC_GENESIS_RELAYER" \
  BAC_DEPLOY_CHAINID=31337 \
  forge script script/DeployLayerSystem.s.sol:DeployLayerSystem \
    --rpc-url "$RPC" --broadcast --unlocked --sender "$SENDER" -vv
) >"$DEPLOY_LOG" 2>&1 || { tail -40 "$DEPLOY_LOG"; die "forge script failed (full log: $DEPLOY_LOG)"; }

get_addr() {
  grep -oE "BAC_ADDR_$1=0x[0-9a-fA-F]{40}" "$DEPLOY_LOG" | tail -1 | cut -d= -f2
}
A_L2BRIDGE="$(get_addr L2BRIDGE)"
A_L2GATE="$(get_addr L2GATE)"
A_AGENTBOOK="$(get_addr AGENTBOOK)"
A_FEESPLITTER="$(get_addr FEESPLITTER || true)"
for pair in "L2BRIDGE:$A_L2BRIDGE" "L2GATE:$A_L2GATE" "AGENTBOOK:$A_AGENTBOOK"; do
  [ -n "${pair#*:}" ] || die "deploy log has no address for ${pair%%:*} (see $DEPLOY_LOG)"
  ok "${pair%%:*} deployed at ${pair#*:}"
done
if [ "$HAVE_FEESPLITTER" = 1 ]; then
  [ -n "$A_FEESPLITTER" ] || die "FeeSplitter source exists but the deploy script printed no address"
  ok "FEESPLITTER deployed at $A_FEESPLITTER"
fi

# -------------------------------------------------- 5. runtime bytecode + stateless construction --

say "5. extract runtime bytecode and assert stateless construction"
CODES="$OUT/codes.txt"
: >"$CODES"
extract() {                       # extract NAME ADDRESS
  local name="$1" addr="$2"
  local code
  code="$(cast code "$addr" --rpc-url "$RPC")"
  [ -n "$code" ] && [ "$code" != "0x" ] || die "$name has no runtime code at $addr"
  local bytes=$(( (${#code} - 2) / 2 ))
  [ "$bytes" -le 24576 ] || die "$name runtime is $bytes bytes, over the EIP-170 limit"
  printf '%s=%s\n' "$name" "$code" >>"$CODES"
  ok "$name runtime $bytes bytes ($(( 24576 - bytes )) left under EIP-170)"
}
assert_stateless() {              # assert_stateless NAME ADDRESS
  local name="$1" addr="$2" slot v
  for slot in $(seq 0 15); do
    v="$(cast storage "$addr" "$slot" --rpc-url "$RPC")"
    [ "$v" = "0x0000000000000000000000000000000000000000000000000000000000000000" ] \
      || die "NON-ZERO STORAGE: $name slot $slot = $v - genesis must carry no storage at all"
  done
  ok "$name slots 0..15 all zero after construction"
}

extract L2BRIDGE  "$A_L2BRIDGE"
extract L2GATE    "$A_L2GATE"
extract AGENTBOOK "$A_AGENTBOOK"
assert_stateless L2BRIDGE  "$A_L2BRIDGE"
assert_stateless L2GATE    "$A_L2GATE"
assert_stateless AGENTBOOK "$A_AGENTBOOK"
if [ "$HAVE_FEESPLITTER" = 1 ]; then
  extract FEESPLITTER "$A_FEESPLITTER"
  assert_stateless FEESPLITTER "$A_FEESPLITTER"
else
  printf 'FEESPLITTER=0xfe\n' >>"$CODES"
  info "FEESPLITTER stubbed with a single INVALID opcode (rehearsal)"
fi

# The proof that the *constructor arguments* really landed in the bytes we are about to paste:
# these are immutables, so they are read out of the runtime code itself, not out of storage.
say "5b. read the immutables back out of the deployed code"
lc() { printf '%s' "$1" | tr 'A-F' 'a-f'; }
check_call() {                    # check_call LABEL ADDRESS EXPECTED SIG [ARGS...]
  local label="$1" addr="$2" want="$3"; shift 3
  local got
  got="$(cast call "$addr" "$@" --rpc-url "$RPC")"
  [ "$(lc "$got")" = "$(lc "$want")" ] || die "$label: got $got, expected $want"
  ok "$label = $want"
}
check_call "L2Bridge.BSC_BRIDGE()"      "$A_L2BRIDGE"  "$BAC_BSC_BRIDGE"      "BSC_BRIDGE()(address)"
check_call "L2Bridge.ROTATION_SIGNER()" "$A_L2BRIDGE"  "$BAC_ROTATION_SIGNER" "ROTATION_SIGNER()(address)"
check_call "L2Bridge.relayer()"         "$A_L2BRIDGE"  "$BAC_GENESIS_RELAYER" "relayer()(address)"
check_call "L2Bridge.rotationNonce()"   "$A_L2BRIDGE"  "0"                    "rotationNonce()(uint256)"
check_call "L2Bridge.totalCredited()"   "$A_L2BRIDGE"  "0"                    "totalCredited()(uint256)"
check_call "L2Bridge.exitCount()"       "$A_L2BRIDGE"  "0"                    "exitCount()(uint64)"
check_call "AgentBook.actionCount()"    "$A_AGENTBOOK" "0"                    "actionCount()(uint64)"
check_call "L2Gate.agentIdOf(relayer)"  "$A_L2GATE"    "0"                    "agentIdOf(address)(uint256)" "$BAC_GENESIS_RELAYER"
check_call "L2Gate.isAdmitted(relayer)" "$A_L2GATE"    "false"                "isAdmitted(address)(bool)"   "$BAC_GENESIS_RELAYER"

# ------------------------------------------------ 6. Multicall3 + CREATE2 deployer, copied, not typed

say "6. canonical predeploys, copied from BSC mainnet (never hand-transcribed)"
fetch_code() {                    # fetch_code LABEL ADDRESS
  local a="$2" c1 c2 c3
  c1="$(cast code "$a" --rpc-url "$BSC_RPC_1")"
  c2="$(cast code "$a" --rpc-url "$BSC_RPC_2")"
  [ -n "$c1" ] && [ "$c1" != "0x" ] || die "$1: $BSC_RPC_1 returned no code at $a"
  [ "$c1" = "$c2" ] || die "$1: the two BSC RPCs disagree about the code at $a - do not proceed"
  # anvil predeploys the CREATE2 deployer, so for that one we get a third independent source
  c3="$(cast code "$a" --rpc-url "$RPC")"
  if [ -n "$c3" ] && [ "$c3" != "0x" ]; then
    [ "$c3" = "$c1" ] || die "$1: anvil's predeploy at $a differs from BSC mainnet's code"
    ok "$1 agrees across BSC x2 and anvil ($(( (${#c1} - 2) / 2 )) bytes, keccak $(cast keccak "$c1"))"
  else
    ok "$1 agrees across both BSC RPCs ($(( (${#c1} - 2) / 2 )) bytes, keccak $(cast keccak "$c1"))"
  fi
  printf '%s=%s\n' "$1" "$c1" >>"$CODES"
}
fetch_code MULTICALL3       0xcA11bde05977b3631167028862bE2a173976CA11
fetch_code CREATE2_DEPLOYER 0x4e59b44847b379578588920cA78FbF26c0B4956C

# ------------------------------------------------------------------------- 7. fill the template --

say "7. fill chain/genesis.template.json"
GENESIS_OUT="$OUT/genesis.json"
MANIFEST="$OUT/genesis-manifest.json"
EXTRA_FLAGS=""
if [ "$REHEARSAL" = 1 ]; then
  GENESIS_OUT="$OUT/genesis.rehearsal.json"
  MANIFEST="$OUT/genesis-manifest.rehearsal.json"
  [ "$HAVE_FEESPLITTER" = 1 ] || EXTRA_FLAGS="--allow-stub-code"
fi

SOURCES="$OUT/placeholder-sources.json"
cat >"$SOURCES" <<JSON
{
  "GENESIS_TIMESTAMP_HEX": "BAC_GENESIS_TS, a UTC midnight; aligns layer epochs with the BSC side",
  "QBFT_EXTRADATA_RLP": "$( [ "$REHEARSAL" = 1 ] && [ -z "${BAC_EXTRADATA:-}" ] && [ ! -f "$NETWORK_GENESIS" ] && echo "REHEARSAL: chain/scripts/qbft_extradata.py, UNVERIFIED against Besu" || echo "besu operator generate-blockchain-config (chain/build/networkFiles/genesis.json)")",
  "L2BRIDGE_RUNTIME_BYTECODE": "cast code on the throwaway anvil, from contracts/src/layer/L2Bridge.sol; immutables read back in step 5b",
  "L2GATE_RUNTIME_BYTECODE": "cast code on the throwaway anvil, from contracts/src/layer/L2Gate.sol",
  "AGENTBOOK_RUNTIME_BYTECODE": "cast code on the throwaway anvil, from contracts/src/layer/AgentBook.sol",
  "FEESPLITTER_RUNTIME_BYTECODE": "$( [ "$HAVE_FEESPLITTER" = 1 ] && echo "cast code on the throwaway anvil, from contracts/src/layer/FeeSplitter.sol" || echo "REHEARSAL STUB 0xfe - FeeSplitter.sol is not written yet")",
  "MULTICALL3_RUNTIME_BYTECODE": "cast code at 0xcA11bde05977b3631167028862bE2a173976CA11 on BSC mainnet, two independent RPCs required to agree",
  "CREATE2_DEPLOYER_RUNTIME_BYTECODE": "cast code at 0x4e59b44847b379578588920cA78FbF26c0B4956C on BSC mainnet, two independent RPCs plus anvil's predeploy required to agree",
  "RELAYER_LAYER_ADDR": "BAC_GENESIS_RELAYER; the only EOA with a genesis balance, publicly disclosed"
}
JSON

STATE_ROOT_LINE="$(python3 "$CHAIN/scripts/fill_genesis.py" \
  --template "$CHAIN/genesis.template.json" \
  --codes "$CODES" \
  --extradata "$EXTRADATA" \
  --timestamp "$GENESIS_TS" \
  --relayer "$BAC_GENESIS_RELAYER" \
  --out "$GENESIS_OUT" \
  --manifest "$MANIFEST" \
  --sources "$SOURCES" \
  $EXTRA_FLAGS)" || die "fill_genesis.py rejected the result"
STATE_ROOT="${STATE_ROOT_LINE#STATE_ROOT=}"
ok "wrote $GENESIS_OUT"
ok "wrote $MANIFEST"
[ "$(grep -c '<' "$GENESIS_OUT")" = "0" ] || die "PLACEHOLDER LEFT in $GENESIS_OUT"
ok "no placeholder survives in the output"

# ------------------------------------------------------------------------- 8. the numbers ------

say "8. genesis identity"
printf '   chain id        56777\n'
printf '   timestamp       %s (0x%x)\n' "$GENESIS_TS" "$GENESIS_TS"
printf '   state root      %s\n' "$STATE_ROOT"
printf '                   ^ computed from alloc alone by chain/scripts/statetrie.py, no client\n'
printf '   genesis hash    (from Besu - see step 9)\n'

# ---------------------------------------------------------------------- 9. the Besu half -------

say "9. Besu steps"
BESU_CMD_FILE="$OUT/server-commands.sh"
cat >"$BESU_CMD_FILE" <<CMDS
#!/usr/bin/env bash
# Generated by chain/build-genesis.sh on $(date -u +%FT%TZ). Run these on the server, in order.
set -euo pipefail
cd /opt/bac

# 9.1 boot a throwaway node on this genesis and read the genesis hash out of it
docker run -d --name bac-genverify -u "\$(id -u):\$(id -g)" \\
  -v "\$PWD/chain/build:/g" -p 18546:8545 hyperledger/besu:24.12.2 \\
  --data-path=/g/verifydata --genesis-file=/g/$(basename "$GENESIS_OUT") \\
  --rpc-http-enabled --rpc-http-host=0.0.0.0 --rpc-http-api=ETH,NET,WEB3,QBFT \\
  --host-allowlist="*" --min-gas-price=1000000000 --p2p-enabled=false \\
  --data-storage-format=BONSAI --sync-mode=FULL
sleep 20
cast rpc eth_getBlockByNumber '"0x0"' false --rpc-url http://127.0.0.1:18546

# 9.2 the two numbers that must match what this build printed
#     stateRoot MUST equal $STATE_ROOT
#     genesis hash: record it in chain/GENESIS.md and on the website - it is the chain's identity

# 9.3 cross-check our extraData encoder against Besu's (settles the UNVERIFIED note in
#     chain/scripts/qbft_extradata.py; write the answer back into that file's header)
echo '["<VALIDATOR_ADDRESS>"]' > /tmp/toEncode.json
docker run --rm -v /tmp:/t hyperledger/besu:24.12.2 \\
  rlp encode --from=/t/toEncode.json --to=/t/extraData.txt --type=QBFT_EXTRA_DATA
cat /tmp/extraData.txt    # must equal the extraData in the genesis file

# 9.4 full read-back, cancun proof, validator set: chain/verify-genesis.sh
docker rm -f bac-genverify
CMDS
chmod +x "$BESU_CMD_FILE" 2>/dev/null || true
ok "wrote $BESU_CMD_FILE"
if [ "$HAVE_DOCKER" = 1 ]; then
  info "docker is available here; you may run $BESU_CMD_FILE now, then chain/verify-genesis.sh"
else
  server "bash chain/build/$(basename "$BESU_CMD_FILE")"
  server "bash chain/verify-genesis.sh --genesis chain/build/$(basename "$GENESIS_OUT")"
fi

# --------------------------------------------------------------------------------- 10. verdict --

echo
if [ "$REHEARSAL" = 1 ]; then
  printf '\033[1mGENESIS BUILD REHEARSAL COMPLETE - THIS IS NOT A LAUNCH GENESIS\033[0m\n'
  printf '  %s carries placeholder inputs%s.\n' "$(basename "$GENESIS_OUT")" \
    "$( [ "$HAVE_FEESPLITTER" = 1 ] || printf ' and a stub at 0x..0104')"
  printf '  What this run did prove: bytecode extraction, the zero-storage assertion, the immutable\n'
  printf '  read-back, two-source agreement on the canonical predeploys, template filling, the alloc\n'
  printf '  arithmetic, and the state root.\n'
  exit 0
fi
printf '\033[1mGENESIS BUILD PASSED\033[0m\n'
printf '  %s\n  state root %s\n' "$GENESIS_OUT" "$STATE_ROOT"
printf '  Not finished until chain/verify-genesis.sh has run against Besu on the server.\n'
