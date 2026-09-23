// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {ChainAnchor} from "../src/ChainAnchor.sol";
import {ValidatorStaking} from "../src/ValidatorStaking.sol";
import {BacNodeFund} from "../src/BacNodeFund.sol";
import {BacBridge} from "../src/BacBridge.sol";
import {BacTaxRouter} from "../src/BacTaxRouter.sol";

/// @title DeployBac
/// @notice The BSC-side deployment of BNB Agent Chain, in the exact order of
///         docs/01-CONTRACT-SPEC.md section 9 (steps 2 through 10).
///
/// @dev  DRY RUN IS THE DEFAULT. Running this without `--broadcast` only simulates; forge
///       sends nothing. Broadcasting needs BOTH of these, and the script reverts if the
///       flag is present without the env var:
///
///         1. the CLI flag        --broadcast
///         2. the env var         BAC_BROADCAST=I_HAVE_READ_SECTION_9
///
///       Dry run (this is what you normally want):
///         forge script script/DeployBac.s.sol:DeployBac --rpc-url "$BSC_RPC_URL" --sender 0x<deployer>
///
///       Local rehearsal against an anvil fork: scripts/anvil_rehearsal.sh
///
///       What gets deployed, and by whom (decision #30 removed the library, the vault factory,
///       the vault implementation and the beacon - there is no linked library left to deploy):
///         (3) - GONE. Decision #31 deleted our own `AgentRegistry`: the bridge's entry gate is
///             now BNB Chain's ERC-8004 Identity Registry, which is already deployed and which we
///             only read. Nothing to deploy, nothing to own, nothing to verify on BscScan.
///         (4) ChainAnchor(predicted BacBridge, relayer, admin, vetoKey, initialCirculating)
///         (5) ValidatorStaking(T, anchor, admin)
///         (6) BacNodeFund(T, nodeFundOwner)
///         (7) BacBridge(T, ERC-8004 identity registry, anchor, watchdog) - must land on the
///             predicted address
///         (8) ChainAnchor.setValidatorStaking(5)        - one-shot, deployer only
///         (10) BacTaxRouter(T, bridge, nodeFund) - the address we type into the flap.sh launch
///             form as the beneficiary. It must be deployed LAST, because its constructor
///             staticcalls `bacToken()` on both downstreams and refuses to exist unless both are
///             already bound to the same `T`. That cross-check is all that is left of the launch
///             hook the vault factory used to run (decision #30).
///
///       `T` (BAC_TOKEN_PREDICTED) is the ...7777 CREATE2 address mined in section 9 step 1 and
///       locked with `Portal.lockSalt`. It is an immutable of (5)(6)(7)(10): if the launch form
///       later uses a different salt, all of them are scrap. The script refuses to run if `T`
///       already has code.
///
///       Step (11) (the manual flap.sh launch, now through the PLAIN Portal's `newTokenV6` with
///       `beneficiary` = BacTaxRouter, NOT through VaultPortal) is not here, and there is no step
///       (12) any more: `setVaultSink` belonged to `AgentRegistry`, which decision #31 deleted
///       together with its entry deposit, so there are no forfeited deposits to point anywhere.
///
///       ENTRY GATE (decision #31). `BAC_ERC8004_IDENTITY` defaults to the registry that the
///       erc-8004/erc-8004-contracts address table lists for this chain — 0x8004A169…a432 on BSC
///       mainnet, 0x8004A818…BD9e on BSC testnet. Two things about it are ours to disclose, not to
///       hide: it is a UUPS proxy whose owner can change what `ownerOf` means at any time without
///       asking us, and holding one of its ERC-721s does not make anybody an AI — registration is
///       open, free and unlimited. 「我们要求持有 agent 身份，我们不能证明它是 AI」。
contract DeployBac is Script {
    /// @dev The answer the operator has to type into BAC_BROADCAST to arm a real send.
    string internal constant BROADCAST_PASSPHRASE = "I_HAVE_READ_SECTION_9";

    /// @dev ERC-8004 Identity Registry, per chain, from the erc-8004/erc-8004-contracts address
    ///      table and re-read on chain on 2026-09-23. NOT hard-coded to one address: a script that
    ///      pins mainnet's registry would silently gate a testnet rehearsal on a contract that is
    ///      not there.
    address internal constant ERC8004_IDENTITY_BSC = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant ERC8004_IDENTITY_BSC_TESTNET = 0x8004A818BFB912233c491871b3d84c89A494BD9e;

    // -- the deployed stack --------------------------------------------------------------
    ChainAnchor public anchor;
    ValidatorStaking public staking;
    BacNodeFund public nodeFund;
    BacBridge public bridge;
    BacTaxRouter public router;

    function run() external {
        // -- chain guard -----------------------------------------------------------------
        require(
            block.chainid == 56 || block.chainid == 97 || block.chainid == 31337,
            unicode"BSC mainnet (56), BSC testnet (97) or a local fork (31337) only / 只允许 BSC 主网、测试网或本地分叉"
        );

        // -- the broadcast gate: dry run unless BOTH the flag and the env var are present --
        bool wantsBroadcast =
            vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
        if (wantsBroadcast) {
            string memory armed = vm.envOr("BAC_BROADCAST", string(""));
            require(
                keccak256(bytes(armed)) == keccak256(bytes(BROADCAST_PASSPHRASE)),
                unicode"--broadcast needs BAC_BROADCAST=I_HAVE_READ_SECTION_9 / 要真的广播必须同时设置该环境变量"
            );
        }

        // -- parameters, every one of them by env var name -------------------------------
        address deployer = vm.envOr("BAC_DEPLOYER_ADDRESS", msg.sender);
        address admin = vm.envAddress("BAC_ADMIN");
        address vetoKey = vm.envAddress("BAC_VETO_KEY");
        address relayer = vm.envAddress("BAC_RELAYER");
        address watchdog = vm.envAddress("BAC_WATCHDOG");
        address nodeFundOwner = vm.envAddress("BAC_NODE_FUND_OWNER");
        // The wallet that will press Launch on flap.sh. Since decision #30 it is no longer burned
        // into anything on chain (there is no factory to whitelist it), so it is informational:
        // the launch form is what binds it, and the form is filled in by hand.
        address launcher = vm.envAddress("BAC_LAUNCHER");
        address token = vm.envAddress("BAC_TOKEN_PREDICTED");
        uint128 initialCirculating = uint128(vm.envOr("BAC_INITIAL_CIRCULATING", uint256(1000e18)));
        // The two buyback venues (decision #24a): the flap Portal while BAC is on the curve and
        // the PancakeSwap V2 router once it has graduated. Both are immutable in `BacBridge` and
        // which one is used is decided per call from chain state, never from a stored flag.
        address flapPortal = vm.envOr("BAC_FLAP_PORTAL", address(0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0));
        address pancakeRouter = vm.envOr("BAC_PANCAKE_ROUTER", address(0x10ED43C718714eb63d5aA57B78B54704E256024E));

        address identityRegistry = vm.envOr("BAC_ERC8004_IDENTITY", _defaultIdentityRegistry());

        _requireDistinctRoles(admin, vetoKey, relayer, watchdog, deployer);
        require(token != address(0), unicode"BAC_TOKEN_PREDICTED is zero / 预测代币地址为零");
        require(token.code.length == 0, unicode"BAC_TOKEN_PREDICTED already has code / 预测的代币地址已经被占用");
        require(launcher != address(0), unicode"BAC_LAUNCHER is zero / 发射钱包地址为零");
        require(nodeFundOwner != address(0), unicode"BAC_NODE_FUND_OWNER is zero / 节点基金 owner 为零");
        require(
            initialCirculating == 1000e18,
            unicode"BAC_INITIAL_CIRCULATING must be OPERATOR_FLOAT = 1000e18 / 必须等于 OPERATOR_FLOAT"
        );
        require(identityRegistry != address(0), unicode"BAC_ERC8004_IDENTITY is zero / ERC-8004 注册表地址为零");
        // If this address has no code, `Erc8004Gate` answers "not a holder" to every caller and
        // the bridge is sealed shut for everyone, forever, with no setter to fix it.
        require(
            identityRegistry.code.length > 0,
            unicode"ERC-8004 identity registry has no code on this chain / 该链上这个 ERC-8004 注册表地址没有代码"
        );

        console2.log("== DeployBac: BSC side, docs/01-CONTRACT-SPEC.md section 9 ==");
        console2.log("mode                   :", wantsBroadcast ? "BROADCAST (armed)" : "DRY RUN (nothing is sent)");
        console2.log("chainId                :", block.chainid);
        console2.log("deployer               :", deployer);
        console2.log("predicted BAC token T  :", token);
        console2.log("ERC-8004 identity reg. :", identityRegistry);

        vm.startBroadcast(deployer);

        // (4) ChainAnchor - BacBridge does not exist yet, so its address comes from the
        //     deployer CREATE nonce: anchor (n), staking (n+1), nodeFund (n+2), bridge (n+3).
        uint256 n = vm.getNonce(deployer);
        address predictedBridge = vm.computeCreateAddress(deployer, n + 3);
        anchor = new ChainAnchor(predictedBridge, relayer, admin, vetoKey, initialCirculating);

        // (5)(6)(7) - the three contracts that pin `T` as an immutable
        staking = new ValidatorStaking(token, address(anchor), admin);
        nodeFund = new BacNodeFund(token, nodeFundOwner);
        bridge = new BacBridge(token, identityRegistry, address(anchor), watchdog, flapPortal, pancakeRouter);
        require(
            address(bridge) == predictedBridge,
            unicode"CREATE nonce prediction of BacBridge drifted / 桥地址预测失效，整轮部署作废"
        );

        // (8) one-shot binding, deployer only
        anchor.setValidatorStaking(address(staking));

        // (10) the tax router: LAST, so its constructor can cross-check both downstreams
        router = new BacTaxRouter(token, address(bridge), address(nodeFund));

        vm.stopBroadcast();

        _postDeployChecks(token, identityRegistry);
        _summary(deployer, admin, vetoKey, relayer, watchdog, nodeFundOwner, launcher, token, identityRegistry);
    }

    /// @dev The registry for this chain. Reverts rather than guessing on an unknown chain id.
    function _defaultIdentityRegistry() internal view returns (address) {
        if (block.chainid == 56) return ERC8004_IDENTITY_BSC;
        if (block.chainid == 97) return ERC8004_IDENTITY_BSC_TESTNET;
        revert(
            unicode"Set BAC_ERC8004_IDENTITY for this chain / 这条链上必须显式设置 BAC_ERC8004_IDENTITY"
        );
    }

    // ------------------------------------------------------------------------------------

    function _requireDistinctRoles(address admin, address vetoKey, address relayer, address watchdog, address deployer)
        internal
        pure
    {
        require(admin != address(0), unicode"BAC_ADMIN is zero / admin 为零地址");
        require(vetoKey != address(0), unicode"BAC_VETO_KEY is zero / veto 钥为零地址");
        require(relayer != address(0), unicode"BAC_RELAYER is zero / 中继地址为零");
        require(watchdog != address(0), unicode"BAC_WATCHDOG is zero / 看门狗地址为零");
        require(admin != vetoKey, unicode"admin and veto key must differ / admin 与 veto 钥必须是两把不同的钥匙");
        require(
            relayer != admin && relayer != vetoKey,
            unicode"relayer must be a hot key of its own / 中继必须是独立的热钥"
        );
        require(watchdog != relayer, unicode"watchdog must not be the relayer / 看门狗不能是中继自己");
        require(deployer != address(0), unicode"deployer is zero / 部署者为零地址");
    }

    /// @dev The read-only half of section 9 step 9: everything checkable without the token existing.
    function _postDeployChecks(address token, address identityRegistry) internal view {
        require(
            bridge.identityRegistry() == identityRegistry,
            unicode"BacBridge.identityRegistry() != BAC_ERC8004_IDENTITY / 桥绑定的身份注册表不对"
        );
        // A live registry answers `ownerOf(1)` with a non-zero address (agent #1 has existed on BSC
        // since 2026-02-04). A zero answer means wrong address, wrong chain, or a registry that has
        // been upgraded into something else — in every case, do not launch on top of it.
        require(
            bridge.identityOwner(1) != address(0),
            unicode"ERC-8004 registry does not resolve agent #1 / 该注册表解析不出 1 号 agent"
        );
        require(bridge.bacToken() == token, unicode"preflight 1: BacBridge.bacToken() != T");
        require(nodeFund.bacToken() == token, unicode"preflight 1: BacNodeFund.bacToken() != T");
        require(staking.bacToken() == token, unicode"preflight 1: ValidatorStaking.bacToken() != T");
        require(anchor.bridge() == address(bridge), unicode"ChainAnchor.bridge() != BacBridge");
        require(anchor.validatorStaking() == address(staking), unicode"ChainAnchor.validatorStaking() != staking");
        require(anchor.lastFinalCirculating() == 1000e18, unicode"C5: lastFinalCirculating != OPERATOR_FLOAT");
        require(token.code.length == 0, unicode"preflight 2: T already has code / 代币地址已被占用");
        // The router is what the launch form points at: if any of these four is wrong the tax goes
        // somewhere we cannot reach, and `Portal.setTokenBeneficiary` is Flap's admin, not ours.
        require(router.bacToken() == token, unicode"preflight 1: BacTaxRouter.bacToken() != T");
        require(router.bridge() == address(bridge), unicode"BacTaxRouter.bridge() != BacBridge");
        require(router.nodeFund() == address(nodeFund), unicode"BacTaxRouter.nodeFund() != BacNodeFund");
        require(router.BRIDGE_BPS() == 5000, unicode"BacTaxRouter split must be 50/50");
        require(router.accountedQuote() == 0 && router.unsplitRevenue() == 0, unicode"router must start empty");
        require(bytes(router.description()).length > 0, unicode"router description() is empty");
    }

    /// @dev A machine-readable summary. Every line is `bac.<key>=<value>`, so a shell can do
    ///      `grep -oE 'bac\.[a-zA-Z]+=0x[0-9a-fA-F]+'`, and the last line is one JSON object
    ///      prefixed with `BAC_DEPLOY_JSON `.
    function _summary(
        address deployer,
        address admin,
        address vetoKey,
        address relayer,
        address watchdog,
        address nodeFundOwner,
        address launcher,
        address token,
        address identityRegistry
    ) internal view {
        console2.log("");
        console2.log("== deployed (machine readable) ==");
        console2.log(string.concat("bac.chainId=", vm.toString(block.chainid)));
        console2.log(string.concat("bac.deployer=", vm.toString(deployer)));
        console2.log(string.concat("bac.tokenPredicted=", vm.toString(token)));
        console2.log(string.concat("bac.erc8004Identity=", vm.toString(identityRegistry)));
        console2.log(string.concat("bac.chainAnchor=", vm.toString(address(anchor))));
        console2.log(string.concat("bac.validatorStaking=", vm.toString(address(staking))));
        console2.log(string.concat("bac.bacNodeFund=", vm.toString(address(nodeFund))));
        console2.log(string.concat("bac.bacBridge=", vm.toString(address(bridge))));
        console2.log(string.concat("bac.bacTaxRouter=", vm.toString(address(router))));
        console2.log(string.concat("bac.admin=", vm.toString(admin)));
        console2.log(string.concat("bac.vetoKey=", vm.toString(vetoKey)));
        console2.log(string.concat("bac.relayer=", vm.toString(relayer)));
        console2.log(string.concat("bac.watchdog=", vm.toString(watchdog)));
        console2.log(string.concat("bac.nodeFundOwner=", vm.toString(nodeFundOwner)));
        console2.log(string.concat("bac.launcher=", vm.toString(launcher)));

        console2.log("");
        console2.log("== the flap.sh form (step 11, done by hand; PLAIN Portal, no vault) ==");
        console2.log("  beneficiary / recipient:", address(router));
        console2.log("  ^ check the first 6 and last 6 hex characters by eye before you press Launch.");
        console2.log("    Flap's admin can change this field afterwards. We cannot.");
        console2.log("  salt                  : the ...7777 salt locked in step 1, verbatim");
        console2.log("  sender                : BAC_LAUNCHER, and no other wallet");
        console2.log("  dexThresh             : FOUR_FIFTHS (80%) - measured: the live Portal takes no other value");
        console2.log("  migratorType          : V2_MIGRATOR - measured: the live Portal takes no other value");
        console2.log("  quoteToken            : native BNB (0x0)");
        console2.log("  tokenVersion          : TOKEN_TAXED_V3");
        console2.log("  tax buy/sell          : 200 / 200 bps, mkt/defl/div/lp 10000 / 0 / 0 / 0");
        console2.log("  taxDuration+antiFarmer: set them EXPLICITLY (see scripts/sim_launch.sh)");

        console2.log("");
        console2.log(
            string.concat(
                "BAC_DEPLOY_JSON {",
                '"chainId":',
                vm.toString(block.chainid),
                ',"deployer":"',
                vm.toString(deployer),
                '","tokenPredicted":"',
                vm.toString(token),
                '","erc8004Identity":"',
                vm.toString(identityRegistry),
                '","chainAnchor":"',
                vm.toString(address(anchor)),
                '","validatorStaking":"',
                vm.toString(address(staking)),
                '","bacNodeFund":"',
                vm.toString(address(nodeFund)),
                '","bacBridge":"',
                vm.toString(address(bridge)),
                '","bacTaxRouter":"',
                vm.toString(address(router)),
                '"}'
            )
        );
    }
}

// There is no `SetVaultSink` any more. It wrote `AgentRegistry.vaultSink`, the destination for
// forfeited agent entry deposits — and decision #31 deleted `AgentRegistry`, its 0.02 BNB entry
// deposit and the timed signature challenge that could forfeit one. Entry is now "hold an ERC-8004
// identity": nothing is deposited, so nothing can be forfeited and there is nothing to point
// anywhere. The only address that still has to be typed by hand is the `beneficiary` on the
// flap.sh form, and that is `BacTaxRouter` (step 11 above).
