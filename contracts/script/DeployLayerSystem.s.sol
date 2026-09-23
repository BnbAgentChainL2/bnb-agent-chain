// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {L2Bridge} from "../src/layer/L2Bridge.sol";
import {L2Gate} from "../src/layer/L2Gate.sol";
import {AgentBook} from "../src/layer/AgentBook.sol";
import {WBAC} from "../src/layer/WBAC.sol";

/// @title DeployLayerSystem
/// @notice Deploys the layer genesis system contracts onto a THROWAWAY local anvil so that
///         `chain/build-genesis.sh` can read their runtime bytecode back out with `cast code`
///         and paste it into `genesis.alloc` (02-CHAIN-SPEC 3.3, steps 2-3).
///
/// @dev THIS SCRIPT NEVER TOUCHES A REAL CHAIN.
///      * It refuses to run unless `block.chainid` equals `BAC_DEPLOY_CHAINID` (default 31337,
///        i.e. anvil).  A fat-fingered `--rpc-url` at a mainnet endpoint reverts in simulation,
///        before any signing.
///      * `build-genesis.sh` additionally refuses any RPC URL that is not 127.0.0.1 and starts the
///        anvil it talks to itself.
///      * Broadcasting still requires an explicit `--broadcast` on the command line; without it
///        this is a pure simulation, which is the default everywhere in this repo.
///
///      The deployed addresses are NOT the genesis addresses (0x...0101 etc.) and do not need to be:
///      only the runtime bytecode is copied, and none of these contracts reads its own address.
///      Cross-contract references are compile-time `constant`s pointing at the genesis addresses
///      (see L2Gate.L2_BRIDGE, AgentBook.L2_GATE), so the code is position-independent by design.
///
///      FeeSplitter (decision #17, genesis address 0x...0104, spec 01-CONTRACT-SPEC 11) is NOT
///      deployed here because `contracts/src/layer/FeeSplitter.sol` does not exist yet.  When it is
///      written, uncomment the three marked lines below; `build-genesis.sh` already refuses to
///      produce a launch genesis while FEESPLITTER is missing, so the two cannot drift apart.
///
///      WBAC (decision #22, genesis address 0x...0106, spec 01-CONTRACT-SPEC 8.4) IS deployed here.
///      It is a neutral tool, not a system contract - no constructor arguments, no immutables, and
///      nothing on this chain calls it. It is in the genesis only because a Uniswap-V2-style pair
///      needs an ERC-20 on both sides, and a chain without one canonical wrapper ends up with
///      several incompatible ones.
contract DeployLayerSystem is Script {
    function run() external {
        uint256 expectedChainId = vm.envOr("BAC_DEPLOY_CHAINID", uint256(31337));
        require(
            block.chainid == expectedChainId,
            unicode"DeployLayerSystem: wrong chain, this script is local-only / 链不对，本脚本只在本地 anvil 上跑"
        );

        // Constructor arguments are baked into L2Bridge's runtime code as immutables, so these three
        // values become part of the genesis bytecode.  They are addresses, never keys.
        address bscBridge = vm.envAddress("BAC_BSC_BRIDGE");
        address rotationSigner = vm.envAddress("BAC_ROTATION_SIGNER");
        address genesisRelayer = vm.envAddress("BAC_GENESIS_RELAYER");

        vm.startBroadcast();

        L2Bridge bridge = new L2Bridge(bscBridge, rotationSigner, genesisRelayer);
        L2Gate gate = new L2Gate();
        AgentBook book = new AgentBook();
        WBAC wbac = new WBAC();
        // FeeSplitter splitter = new FeeSplitter();                       // <-- uncomment with 11

        vm.stopBroadcast();

        // Machine-readable handoff to build-genesis.sh: it greps these exact `KEY=0x...` lines.
        console2.log("BAC_ADDR_L2BRIDGE=%s", vm.toString(address(bridge)));
        console2.log("BAC_ADDR_L2GATE=%s", vm.toString(address(gate)));
        console2.log("BAC_ADDR_AGENTBOOK=%s", vm.toString(address(book)));
        console2.log("BAC_ADDR_WBAC=%s", vm.toString(address(wbac)));
        // console2.log("BAC_ADDR_FEESPLITTER=%s", vm.toString(address(splitter)));  // <-- uncomment
    }
}
