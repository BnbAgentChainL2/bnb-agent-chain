#!/usr/bin/env bash
# 链上实测：把研究快照里的假设换成当前主网真值。只读，不广播。
RPC="${BSC_RPC_URL:-https://bsc-dataseed.bnbchain.org}"
AI=0xaEe3a7Ca6fe6b53f6c32a3e8407eC5A9dF8B7E39
TRIG=0xcf4EE25035CF883895110f367F5BA8172416a7F9
VP=0x90497450f2a706f1951b5bdda52B4E5d16f34C06
PORTAL=0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0
GUARD=0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b
say(){ printf '%-42s %s\n' "$1" "$2"; }
r(){ cast call --rpc-url "$RPC" "$1" "$2" 2>&1 | head -1; }

echo "== 区块与 gas =="
BN=$(cast block-number --rpc-url "$RPC" 2>&1); say "block number" "$BN"
T1=$(cast block "$BN" --rpc-url "$RPC" --field timestamp 2>/dev/null)
T2=$(cast block $((BN-1000)) --rpc-url "$RPC" --field timestamp 2>/dev/null)
if [ -n "$T1" ] && [ -n "$T2" ]; then say "block time (1000 blocks avg, s)" "$(python -c "print(round(($T1-$T2)/1000,3))")"; fi
say "gas price" "$(cast gas-price --rpc-url "$RPC" 2>&1 | head -1)"

echo; echo "== Flap AI Oracle $AI =="
say "callbackGasLimit()" "$(r $AI 'callbackGasLimit()(uint256)')"
say "getFee()" "$(r $AI 'getFee()(uint256)')"
say "fee()" "$(r $AI 'fee()(uint256)')"
say "getConsumerRateLimit(self)" "$(cast call --rpc-url "$RPC" $AI 'getConsumerRateLimit(address)(uint256)' $VP 2>&1 | head -1)"
say "paused()" "$(r $AI 'paused()(bool)')"

echo; echo "== Trigger Service $TRIG =="
say "getFee()" "$(r $TRIG 'getFee()(uint256)')"
say "getMaxCallbackGas()" "$(r $TRIG 'getMaxCallbackGas()(uint256)')"

echo; echo "== Portal / VaultPortal =="
say "Portal.version()" "$(r $PORTAL 'version()(string)')"
say "VaultPortal.version()" "$(r $VP 'version()(string)')"
say "VaultPortal.guardian()" "$(r $VP 'guardian()(address)')"
say "Guardian code size" "$(cast codesize --rpc-url "$RPC" $GUARD 2>&1 | head -1)"

echo; echo "== eth_getLogs 上限（公共 RPC）=="
for span in 500 1000 2000 5000 10000; do
  from=$((BN-span)); res=$(cast rpc --rpc-url "$RPC" eth_getLogs "{\"fromBlock\":\"$(printf '0x%x' $from)\",\"toBlock\":\"$(printf '0x%x' $BN)\",\"address\":\"$VP\"}" 2>&1 | head -c 120)
  case "$res" in *rror*|*imit*|*range*) say "span $span" "REJECTED: $(echo "$res" | head -c 80)";; *) say "span $span" "ok";; esac
done
