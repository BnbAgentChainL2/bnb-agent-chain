#!/usr/bin/env bash
# anvil_rehearsal.sh — local launch rehearsal of BNB Agent Chain on an anvil fork of BSC mainnet.
# Adapted from rat/scripts/anvil_rehearsal.sh.
#
#   1. starts anvil (fork of BSC at FORK_BLOCK) on 127.0.0.1:PORT
#   2. mines the vanity ...7777 CREATE2 salt and predicts the BAC token address T
#   3. deploys the whole BSC-side stack with `forge script script/DeployBac.s.sol:DeployBac`
#      (anvil's well-known dev key, local only) — library, AgentRegistry, ChainAnchor,
#      ValidatorStaking, BacNodeFund, BacBridge, setValidatorStaking, BacVaultFactory
#   4. runs scripts/sim_launch.sh against the fork (positive + negative rows), BEFORE launching
#   5. launches BAC through the REAL Flap VaultPortal code with `cast send` (planned form values)
#   6. buys 0.5 BNB on the curve, dispatches the tax, settles the vault and checks the 50/50 split
#   7. sets the vault sink (step 12) with `forge script ...:SetVaultSink`
#   8. negative checks: the broadcast gate, a wrong-launcher sim, a wrong-salt sim
#   9. stops anvil and prints PASS/FAIL per step plus the measured gas and the BNB cost
#
# Only 127.0.0.1 receives transactions; the upstream RPC is only read by anvil. The broadcast log
# goes to OUT_DIR (never web/ or contracts/broadcast/).
#
#   scripts/anvil_rehearsal.sh                                          # defaults below
#   PORT=18655 OUT_DIR=/tmp/bac-rehearsal KEEP=1 scripts/anvil_rehearsal.sh   # KEEP=1 leaves anvil up
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
PORT="${PORT:-18655}"
FORK_RPC="${FORK_RPC:-https://bsc-mainnet.public.blastapi.io}"
FORK_BLOCK="${FORK_BLOCK:-123497440}"
OUT_DIR="${OUT_DIR:-$(mktemp -d)}"
KEEP="${KEEP:-0}"
PYTHON="${PYTHON:-python}"
GAS_PRICE_GWEI="${GAS_PRICE_GWEI:-0.05}"
LOCAL="http://127.0.0.1:${PORT}"

# anvil dev accounts 0 and 1 (public test keys; they only ever sign for the local fork)
DEV0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
DEV0_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
DEV1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
DEV1_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d

VP=0x90497450f2a706f1951b5bdda52B4E5d16f34C06
PORTAL=0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0
HASH=0x2f7f413fcc6c3812c665c15bd4a012e663f567d626112a81d401066fd5a771b4
ZERO=0x0000000000000000000000000000000000000000
Z32=0x0000000000000000000000000000000000000000000000000000000000000000
T='(string,string,string,uint8,bytes32,uint8,address,uint256,bytes,bytes32,bytes,uint8,uint8,uint16,uint16,uint64,uint64,uint16,uint16,uint16,uint16,uint256,address,address,uint8,address,bytes)'

# the planned launch form (contracts/test/BacForkLaunch.t.sol, docs/01-CONTRACT-SPEC.md §1.3)
NAME="BNB Agent Chain"
SYMBOL="BAC"
TAXDURATION=3153600000     # 100 years
ANTIFARMER=86400           # 1 day
BUY=200
SELL=200

# roles for the rehearsal only (never real keys)
R_ADMIN=0x1000000000000000000000000000000000000001
R_VETO=0x1000000000000000000000000000000000000002
R_RELAYER=0x1000000000000000000000000000000000000003
R_WATCHDOG=0x1000000000000000000000000000000000000004
R_FUNDOWNER=0x1000000000000000000000000000000000000005
R_VAULTOWNER=0x1000000000000000000000000000000000000006

say() { printf '\n== %s ==\n' "$*"; }
die() { echo "REHEARSAL FAIL (fatal): $*" >&2; exit 1; }
FAILED=0
expect() { # expect <label> <want-exit> <got-exit>
  if [ "$2" = "$3" ]; then echo "REHEARSAL OK   $1 (exit $3)"; else echo "REHEARSAL FAIL $1 (exit $3, wanted $2)"; FAILED=1; fi
}
ok() { echo "REHEARSAL OK   $1"; }
bad() { echo "REHEARSAL FAIL $1"; FAILED=1; }

mkdir -p "$OUT_DIR"
case "$LOCAL" in http://127.0.0.1:*|http://localhost:*) ;; *) die "refusing non-local RPC $LOCAL" ;; esac
if (echo > "/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then die "port $PORT is already in use; pick another PORT"; fi
command -v anvil >/dev/null || die "anvil not on PATH"
command -v cast  >/dev/null || die "cast not on PATH"
command -v forge >/dev/null || die "forge not on PATH"

say "anvil fork of BSC @ ${FORK_BLOCK} on ${LOCAL} (log: ${OUT_DIR}/anvil.log)"
anvil --fork-url "$FORK_RPC" --fork-block-number "$FORK_BLOCK" --port "$PORT" --hardfork prague \
  --retries 8 > "$OUT_DIR/anvil.log" 2>&1 &
ANVIL_PID=$!
cleanup() {
  if [ "$KEEP" = "1" ]; then echo "anvil left running (pid $ANVIL_PID, $LOCAL)"; return; fi
  kill "$ANVIL_PID" 2>/dev/null && wait "$ANVIL_PID" 2>/dev/null
  echo "anvil stopped (pid $ANVIL_PID)"
}
trap cleanup EXIT
for _ in $(seq 1 90); do
  CHAIN=$(cast chain-id --rpc-url "$LOCAL" 2>/dev/null) && break
  sleep 1
done
[ "${CHAIN:-}" = "56" ] || die "anvil did not come up with chain id 56 (got '${CHAIN:-}'), see $OUT_DIR/anvil.log"
echo "chain id $CHAIN, block $(cast block-number --rpc-url "$LOCAL")"

# On BSC mainnet the anvil dev accounts carry EIP-7702 delegations (sweeper code). Clear them here only.
for a in $DEV0 $DEV1; do cast rpc anvil_setCode "$a" 0x --rpc-url "$LOCAL" > /dev/null; done
cast rpc anvil_setBalance "$DEV0" 0x56BC75E2D63100000 --rpc-url "$LOCAL" > /dev/null   # 100 BNB
cast rpc anvil_setBalance "$DEV1" 0x56BC75E2D63100000 --rpc-url "$LOCAL" > /dev/null

say "step 1: mine the vanity ...7777 salt and predict T"
SALT=$(cast create2 --ends-with 7777 --deployer $PORTAL --init-code-hash $HASH 2>&1 | grep -i '^salt' | grep -o '0x[0-9a-fA-F]\{64\}' | head -1)
[[ "$SALT" =~ ^0x[0-9a-fA-F]{64}$ ]] || die "could not mine a ...7777 salt"
A=$(cast keccak "0xff${PORTAL#0x}${SALT#0x}${HASH#0x}")
TOKEN=$(cast to-check-sum-address "0x${A: -40}")
echo "salt     $SALT"
echo "token T  $TOKEN"
[ "$(cast code "$TOKEN" --rpc-url "$LOCAL")" = "0x" ] && ok "T is free" || bad "T already has code"

say "step 2: forge script DeployBac (broadcast log in ${OUT_DIR}/broadcast)"
(
  cd "$ROOT/contracts" &&
    BAC_ADMIN=$R_ADMIN BAC_VETO_KEY=$R_VETO BAC_RELAYER=$R_RELAYER BAC_WATCHDOG=$R_WATCHDOG \
    BAC_NODE_FUND_OWNER=$R_FUNDOWNER BAC_LAUNCHER=$DEV1 BAC_VAULT_OWNER=$R_VAULTOWNER \
    BAC_TOKEN_PREDICTED="$TOKEN" BAC_BROADCAST=I_HAVE_READ_SECTION_9 \
    FOUNDRY_BROADCAST="$OUT_DIR/broadcast" FOUNDRY_LINT_LINT_ON_BUILD=false \
      forge script script/DeployBac.s.sol:DeployBac --rpc-url "$LOCAL" --private-key "$DEV0_KEY" \
      --broadcast --slow --out out-fork --cache-path cache-fork
) > "$OUT_DIR/forge-script.log" 2>&1
RC=$?
grep -E "^  bac\.|Estimated|ONCHAIN EXECUTION|Error" "$OUT_DIR/forge-script.log" | sed 's/^/  /'
expect "DeployBac forge script" 0 "$RC"
[ "$RC" = "0" ] || die "forge script failed (see $OUT_DIR/forge-script.log)"

RUN_JSON="$OUT_DIR/broadcast/DeployBac.s.sol/56/run-latest.json"
[ -f "$RUN_JSON" ] || die "broadcast log not found at $RUN_JSON"
get() { grep -oE "bac\.$1=0x[0-9a-fA-F]{40}" "$OUT_DIR/forge-script.log" | head -1 | cut -d= -f2; }
REGISTRY=$(get agentRegistry); ANCHOR=$(get chainAnchor); STAKING=$(get validatorStaking)
NODEFUND=$(get bacNodeFund); BRIDGE=$(get bacBridge); FACTORY=$(get bacVaultFactory)
BEACON=$(get beacon); IMPL=$(get vaultImplementation)
for v in REGISTRY ANCHOR STAKING NODEFUND BRIDGE FACTORY BEACON IMPL; do
  [[ "${!v}" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "could not read $v out of the script log"
done

"$PYTHON" - "$RUN_JSON" "$GAS_PRICE_GWEI" > "$OUT_DIR/gas.txt" <<'PYEOF'
import json, sys
run = json.load(open(sys.argv[1], encoding="utf-8"))
gwei = float(sys.argv[2])
for lib in run.get("libraries", []):
    print("  library  " + lib)
total = 0
for tx, rc in zip(run["transactions"], run.get("receipts", [])):
    g = int(rc.get("gasUsed", "0x0"), 16)
    total += g
    print(f'  {tx.get("transactionType"):8} {str(tx.get("contractName")):18} {str(tx.get("contractAddress")):44} gas={g:,}')
    for e in tx.get("additionalContracts") or []:
        print(f'           + {e.get("transactionType",""):6} {e.get("address")}')
print(f'  TOTAL GAS {total:,}')
print(f'  COST AT {gwei} GWEI: {total * gwei / 1e9:.8f} BNB')
PYEOF
cat "$OUT_DIR/gas.txt"
TOTAL_GAS=$(grep -oE 'TOTAL GAS [0-9,]+' "$OUT_DIR/gas.txt" | tr -d ', ' | sed 's/TOTALGAS//')
[ -n "$TOTAL_GAS" ] && ok "measured deploy gas $TOTAL_GAS" || bad "could not measure the deploy gas"

say "step 3: scripts/sim_launch.sh against the fork (pre-launch, the real gate)"
TAXDURATION=$TAXDURATION ANTIFARMER=$ANTIFARMER \
  bash "$HERE/sim_launch.sh" --rpc "$LOCAL" --factory "$FACTORY" --bridge "$BRIDGE" --nodefund "$NODEFUND" \
    --launcher "$DEV1" --registry "$REGISTRY" --staking "$STAKING" --vault-owner "$R_VAULTOWNER" \
    --salt "$SALT" --token "$TOKEN" --name "$NAME" --symbol "$SYMBOL" 2>&1 | tee "$OUT_DIR/sim_launch.log"
expect "sim_launch.sh (planned form + negative rows)" 0 "${PIPESTATUS[0]}"

say "step 4: sim_launch.sh must FAIL on a wrong sender and on a wrong salt"
TAXDURATION=$TAXDURATION ANTIFARMER=$ANTIFARMER \
  bash "$HERE/sim_launch.sh" --rpc "$LOCAL" --factory "$FACTORY" --bridge "$BRIDGE" --nodefund "$NODEFUND" \
    --launcher "$DEV0" --salt "$SALT" --no-negative > "$OUT_DIR/sim_wrong_sender.log" 2>&1
expect "sim_launch.sh rejects a sender that is not the LAUNCHER" 1 "$?"
TAXDURATION=$TAXDURATION ANTIFARMER=$ANTIFARMER \
  bash "$HERE/sim_launch.sh" --rpc "$LOCAL" --factory "$FACTORY" --bridge "$BRIDGE" --nodefund "$NODEFUND" \
    --launcher "$DEV1" --no-negative > "$OUT_DIR/sim_wrong_salt.log" 2>&1
expect "sim_launch.sh rejects a freshly mined salt (immutables pin the locked one)" 1 "$?"
TAXDURATION="" ANTIFARMER=$ANTIFARMER \
  bash "$HERE/sim_launch.sh" --rpc "$LOCAL" --factory "$FACTORY" --bridge "$BRIDGE" --nodefund "$NODEFUND" \
    --launcher "$DEV1" > "$OUT_DIR/sim_no_taxduration.log" 2>&1
expect "sim_launch.sh refuses to run without an explicit TAXDURATION" 1 "$?"

say "step 5: the real launch through the live VaultPortal code (cast send, sender = LAUNCHER)"
VD=$(cast abi-encode 'f(address,address,address)' "$R_VAULTOWNER" "$BRIDGE" "$NODEFUND")
P="(\"$NAME\",\"$SYMBOL\",\"bac-rehearsal\",1,$SALT,1,$ZERO,0,0x,$Z32,0x,0,0,$BUY,$SELL,$TAXDURATION,$ANTIFARMER,10000,0,0,0,0,$ZERO,$ZERO,6,$FACTORY,$VD)"
cast send $VP "newTokenV6WithVault($T)" "$P" --value 0 --gas-limit 15000000 \
  --private-key "$DEV1_KEY" --rpc-url "$LOCAL" > "$OUT_DIR/launch.log" 2>&1
expect "newTokenV6WithVault sent" 0 "$?"
grep -E "^(status|gasUsed|transactionHash)" "$OUT_DIR/launch.log" | sed 's/^/  /'
grep -q "^status *1" "$OUT_DIR/launch.log" && ok "launch status 1" || bad "launch reverted (see $OUT_DIR/launch.log)"
GAS_LAUNCH=$(grep -E "^gasUsed" "$OUT_DIR/launch.log" | awk '{print $2}')
VAULT=$(cast call $VP 'getVault(address)((address,address,string,bool,uint8))' "$TOKEN" --rpc-url "$LOCAL" | grep -o '0x[0-9a-fA-F]\{40\}' | head -1)
echo "  token  $TOKEN"
echo "  vault  $VAULT"
[ "$(cast code "$TOKEN" --rpc-url "$LOCAL")" != "0x" ] && ok "token T has code and is the predicted address" || bad "token T has no code"
[ "$(cast call "$VAULT" 'taxToken()(address)' --rpc-url "$LOCAL" | tr 'A-F' 'a-f')" = "$(echo "$TOKEN" | tr 'A-F' 'a-f')" ] \
  && ok "vault.taxToken() == T" || bad "vault.taxToken() != T"
[ "$(cast call "$BEACON" 'owner()(address)' --rpc-url "$LOCAL" | tr 'A-F' 'a-f')" = "$(echo "$FACTORY" | tr 'A-F' 'a-f')" ] \
  && ok "rule 009: beacon.owner() == factory" || bad "beacon owner is not the factory"

say "step 6: a 0.5 BNB buy, the tax dispatch and the 50/50 settle"
cast send $PORTAL 'swapExactInput((address,address,uint256,uint256,bytes))' "($ZERO,$TOKEN,500000000000000000,0,0x)" \
  --value 500000000000000000 --gas-limit 3000000 --private-key "$DEV0_KEY" --rpc-url "$LOCAL" > "$OUT_DIR/buy.log" 2>&1
expect "buy 0.5 BNB on the curve" 0 "$?"
TP=$(cast call "$TOKEN" 'taxProcessor()(address)' --rpc-url "$LOCAL")
cast send "$TP" 'dispatch()' --gas-limit 1000000 --private-key "$DEV0_KEY" --rpc-url "$LOCAL" > "$OUT_DIR/dispatch.log" 2>&1
expect "TaxProcessor.dispatch()" 0 "$?"
VAULT_BAL=$(cast balance "$VAULT" --rpc-url "$LOCAL")
echo "  vault balance after dispatch: $VAULT_BAL wei"
[ "$VAULT_BAL" != "0" ] && ok "tax reached the vault" || bad "the vault received nothing"
cast send "$VAULT" 'settle()' --gas-limit 1000000 --private-key "$DEV0_KEY" --rpc-url "$LOCAL" > "$OUT_DIR/settle.log" 2>&1
expect "BacTreasuryVault.settle()" 0 "$?"
B_BAL=$(cast balance "$BRIDGE" --rpc-url "$LOCAL")
N_BAL=$(cast balance "$NODEFUND" --rpc-url "$LOCAL")
echo "  bridge pool $B_BAL wei   node fund $N_BAL wei"
[ "$B_BAL" = "$N_BAL" ] && [ "$B_BAL" != "0" ] && ok "50/50 split is exact" || bad "split is not 50/50 (bridge $B_BAL, fund $N_BAL)"

say "step 7: step 12 — AgentRegistry.setVaultSink through forge script"
(
  cd "$ROOT/contracts" &&
    BAC_AGENT_REGISTRY="$REGISTRY" BAC_VAULT="$VAULT" BAC_BROADCAST=I_HAVE_READ_SECTION_9 \
    FOUNDRY_BROADCAST="$OUT_DIR/broadcast" FOUNDRY_LINT_LINT_ON_BUILD=false \
      forge script script/DeployBac.s.sol:SetVaultSink --rpc-url "$LOCAL" --private-key "$DEV0_KEY" \
      --broadcast --out out-fork --cache-path cache-fork
) > "$OUT_DIR/setvaultsink.log" 2>&1
expect "SetVaultSink forge script" 0 "$?"
[ "$(cast call "$REGISTRY" 'vaultSink()(address)' --rpc-url "$LOCAL" | tr 'A-F' 'a-f')" = "$(echo "$VAULT" | tr 'A-F' 'a-f')" ] \
  && ok "AgentRegistry.vaultSink() == vault" || bad "vault sink was not set"

say "step 8: the broadcast gate must refuse --broadcast without BAC_BROADCAST"
(
  cd "$ROOT/contracts" &&
    BAC_ADMIN=$R_ADMIN BAC_VETO_KEY=$R_VETO BAC_RELAYER=$R_RELAYER BAC_WATCHDOG=$R_WATCHDOG \
    BAC_NODE_FUND_OWNER=$R_FUNDOWNER BAC_LAUNCHER=$DEV1 BAC_TOKEN_PREDICTED="$TOKEN" \
    FOUNDRY_BROADCAST="$OUT_DIR/broadcast-should-not-exist" FOUNDRY_LINT_LINT_ON_BUILD=false \
      forge script script/DeployBac.s.sol:DeployBac --rpc-url "$LOCAL" --private-key "$DEV0_KEY" \
      --broadcast --out out-fork --cache-path cache-fork
) > "$OUT_DIR/gate.log" 2>&1
expect "DeployBac refuses --broadcast without BAC_BROADCAST" 1 "$?"
grep -q "BAC_BROADCAST=I_HAVE_READ_SECTION_9" "$OUT_DIR/gate.log" && ok "the gate names the env var" || bad "the gate message is missing"

say "step 9: a plain dry run sends nothing"
(
  cd "$ROOT/contracts" &&
    BAC_ADMIN=$R_ADMIN BAC_VETO_KEY=$R_VETO BAC_RELAYER=$R_RELAYER BAC_WATCHDOG=$R_WATCHDOG \
    BAC_NODE_FUND_OWNER=$R_FUNDOWNER BAC_LAUNCHER=$DEV1 \
    BAC_TOKEN_PREDICTED=0x0000000000000000000000000000000000007777 \
    FOUNDRY_BROADCAST="$OUT_DIR/broadcast-dry" FOUNDRY_LINT_LINT_ON_BUILD=false \
      forge script script/DeployBac.s.sol:DeployBac --rpc-url "$LOCAL" --sender "$DEV0" \
      --out out-fork --cache-path cache-fork
) > "$OUT_DIR/dryrun.log" 2>&1
expect "DeployBac dry run (no --broadcast)" 0 "$?"
grep -q "DRY RUN (nothing is sent)" "$OUT_DIR/dryrun.log" && ok "dry run is the default mode" || bad "dry run did not report itself"
grep -q "ONCHAIN EXECUTION COMPLETE" "$OUT_DIR/dryrun.log" && bad "the dry run broadcast something" || ok "the dry run broadcast nothing"

echo
echo "== addresses =="
printf '  %-22s %s\n' AgentRegistry "$REGISTRY" ChainAnchor "$ANCHOR" ValidatorStaking "$STAKING" \
  BacNodeFund "$NODEFUND" BacBridge "$BRIDGE" BacVaultFactory "$FACTORY" UpgradeableBeacon "$BEACON" \
  BacTreasuryVault_impl "$IMPL" BAC_token "$TOKEN" BacTreasuryVault "$VAULT"
echo
grep -E "TOTAL GAS|COST AT" "$OUT_DIR/gas.txt" | sed 's/^ */  /'
echo "  launch tx gas (flap.sh, paid by the launching wallet): ${GAS_LAUNCH:-?}"

echo
if [ "$FAILED" = "0" ]; then echo "REHEARSAL PASSED (outputs in $OUT_DIR)"; else echo "REHEARSAL FAILED (outputs in $OUT_DIR)"; fi
exit "$FAILED"
