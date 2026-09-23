// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {ERC1967Proxy} from "@openzeppelin/proxy/ERC1967/ERC1967Proxy.sol";

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
///         forge script script/DeployBac.s.sol:DeployBac --fork-url "$BSC_RPC_URL" --sender 0x<deployer>
///
///       There is no scripted local rehearsal for this path yet: scripts/anvil_rehearsal.sh and
///       scripts/sim_launch.sh still drive the deleted factory / VaultPortal path (docs/04 marks
///       them stale). test/BacForkLaunch.t.sol reproduces this script's order on a mainnet fork,
///       and a dry run of this script against a fork is the rehearsal.
///
///       What gets deployed, and by whom (decision #30 removed the library, the vault factory,
///       the vault implementation and the beacon - there is no linked library left to deploy):
///         (3) - GONE. Decision #31 deleted our own `AgentRegistry`: the bridge's entry gate is
///             now the ERC-8004 Identity Registry, which is already deployed and which we only
///             read. Nothing to deploy, nothing to own, nothing to verify on BscScan.
///         (4) ChainAnchor(predicted BacBridge PROXY, relayer, admin, vetoKey, initialCirculating)
///         (5) ValidatorStaking(T, anchor, admin)
///         (6) BacNodeFund(T, nodeFundOwner)
///         (7a) BacBridge implementation - no constructor arguments. Its constructor disables
///             initializers and deploys `BacBridgeExtension` (with the IMPLEMENTATION's nonce,
///             not the deployer's), so this step costs the deployer exactly one nonce.
///         (7b) ERC1967Proxy(implementation, initialize(owner, T, ERC-8004 identity registry,
///             anchor, watchdog, flap Portal, PancakeSwap V2 router)) - initialised inside the
///             proxy's own constructor, so there is no block in which an uninitialised proxy
///             exists for someone else to initialise. It MUST land on the address (4) was given.
///         (8) ChainAnchor.setValidatorStaking(5)        - one-shot, deployer only
///         (10) BacTaxRouter(T, bridge PROXY, nodeFund) - the address we type into the launch
///             form as the beneficiary. It must be deployed LAST, because its constructor
///             staticcalls `bacToken()` on both downstreams and refuses to exist unless both are
///             already bound to the same `T` (the bare implementation answers address(0), so it
///             cannot be wired in by mistake).
///
///       Nonces, relative to the deployer's nonce `n` at step (4):
///         anchor n, staking n+1, nodeFund n+2, implementation n+3, PROXY n+4, (setValidatorStaking
///         n+5, a call), router n+6. The script predicts the proxy from `n + 4` and refuses to go on
///         if it lands anywhere else. Send nothing else from the deployer while this runs.
///
///       OWNER POWERS (decision #29). The proxy's owner - `BAC_BRIDGE_OWNER`, default the deployer
///       (decision #33: "一直用部署钱包") - can upgrade the bridge and withdraw its whole pool at any
///       time, with no timelock. 项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。
///       That sentence is `BacBridge.OWNER_POWER_NOTICE`, and this script refuses to finish unless
///       the deployed bridge says it word for word.
///
///       `T` (BAC_TOKEN_PREDICTED) is the ...7777 CREATE2 address mined in section 9 step 1 and
///       locked with `Portal.lockSalt` (decision #35: salt 0xef6c...0b2af7 locked to the deployment
///       wallet, T = 0xA97452d175679B2bF5F25a9a382D22aff39b7777). It is an immutable of (5)(6)(10)
///       and a write-once storage slot of (7b): if the launch uses a different salt, all of them
///       are scrap. The script refuses to run if `T` already has code.
///
///       Step (11) (the launch, through the PLAIN Portal's `newTokenV6` with `beneficiary` =
///       BacTaxRouter, from the wallet that locked the salt) is not here. `newTokenV7` is not an
///       alternative: the live v5.24.0 Portal refuses a TOKEN_TAXED_V3 there with
///       `NewTokenV7RuleViolation(4)` (measured in test/BacForkLaunch.t.sol).
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

    /// @dev EIP-1967 implementation slot.
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    /// @dev Decision #29a, verbatim. The deployed bridge must return exactly this.
    string internal constant NOTICE_29A = unicode"项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。";

    // -- the deployed stack --------------------------------------------------------------
    ChainAnchor public anchor;
    ValidatorStaking public staking;
    BacNodeFund public nodeFund;
    BacBridge public bridgeImpl;
    BacBridge public bridge; // the ERC1967 proxy - the ONLY bridge address anything else may use
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
        // Decision #33: the bridge owner (upgrade + emergency withdrawal of the whole pool) is the
        // deployment wallet unless this says otherwise.
        address bridgeOwner = vm.envOr("BAC_BRIDGE_OWNER", deployer);
        // The wallet that will send `newTokenV6`. Since decision #30 nothing on chain whitelists
        // it, but the Portal's salt lock does: only the wallet that paid `lockSalt` may launch on
        // that salt (FlapSaltLockedByAnotherUser otherwise - measured on a fork).
        address launcher = vm.envAddress("BAC_LAUNCHER");
        address token = vm.envAddress("BAC_TOKEN_PREDICTED");
        uint128 initialCirculating = uint128(vm.envOr("BAC_INITIAL_CIRCULATING", uint256(1000e18)));
        // The two buyback venues (decision #24a): the flap Portal while BAC is on the curve and
        // the PancakeSwap V2 router once it has graduated. Both are write-once storage in the
        // bridge; which one is used is decided per call from chain state, never from a flag.
        address flapPortal = vm.envOr("BAC_FLAP_PORTAL", address(0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0));
        address pancakeRouter = vm.envOr("BAC_PANCAKE_ROUTER", address(0x10ED43C718714eb63d5aA57B78B54704E256024E));

        address identityRegistry = vm.envOr("BAC_ERC8004_IDENTITY", _defaultIdentityRegistry());

        _requireRoles(admin, vetoKey, relayer, watchdog, deployer, bridgeOwner);
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
        // the bridge is sealed shut for everyone until an upgrade repoints it.
        require(
            identityRegistry.code.length > 0,
            unicode"ERC-8004 identity registry has no code on this chain / 该链上这个 ERC-8004 注册表地址没有代码"
        );
        require(flapPortal.code.length > 0, unicode"BAC_FLAP_PORTAL has no code / Portal 地址没有代码");
        require(pancakeRouter.code.length > 0, unicode"BAC_PANCAKE_ROUTER has no code / 路由地址没有代码");

        console2.log("== DeployBac: BSC side, docs/01-CONTRACT-SPEC.md section 9 ==");
        console2.log("mode                   :", wantsBroadcast ? "BROADCAST (armed)" : "DRY RUN (nothing is sent)");
        console2.log("chainId                :", block.chainid);
        console2.log("deployer               :", deployer);
        console2.log("bridge owner           :", bridgeOwner);
        console2.log("predicted BAC token T  :", token);
        console2.log("ERC-8004 identity reg. :", identityRegistry);
        if (admin == vetoKey) {
            console2.log("NOTE admin == vetoKey  : one key holds relayer rotation AND veto (decision #35)");
        }

        vm.startBroadcast(deployer);

        // (4) ChainAnchor - the bridge proxy does not exist yet, so its address comes from the
        //     deployer CREATE nonce: anchor (n), staking (n+1), nodeFund (n+2), implementation
        //     (n+3), proxy (n+4).
        uint256 n = vm.getNonce(deployer);
        address predictedBridge = vm.computeCreateAddress(deployer, n + 4);
        anchor = new ChainAnchor(predictedBridge, relayer, admin, vetoKey, initialCirculating);

        // (5)(6) - the two contracts that pin `T` as an immutable
        staking = new ValidatorStaking(token, address(anchor), admin);
        nodeFund = new BacNodeFund(token, nodeFundOwner);

        // (7a)(7b) - implementation, then the proxy that is initialised in its own constructor
        bridgeImpl = new BacBridge();
        bridge = BacBridge(
            address(
                new ERC1967Proxy(
                    address(bridgeImpl),
                    abi.encodeCall(
                        BacBridge.initialize,
                        (bridgeOwner, token, identityRegistry, address(anchor), watchdog, flapPortal, pancakeRouter)
                    )
                )
            )
        );
        require(
            address(bridge) == predictedBridge,
            unicode"CREATE nonce prediction of the BacBridge proxy drifted / 桥代理地址预测失效，整轮部署作废"
        );

        // (8) one-shot binding, deployer only
        anchor.setValidatorStaking(address(staking));

        // (10) the tax router: LAST, so its constructor can cross-check both downstreams
        router = new BacTaxRouter(token, address(bridge), address(nodeFund));

        vm.stopBroadcast();

        _postDeployChecks(token, identityRegistry, bridgeOwner, watchdog, flapPortal, pancakeRouter);
        _summary(deployer, admin, vetoKey, relayer, watchdog, nodeFundOwner, bridgeOwner, launcher, token, identityRegistry);
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

    /// @dev `admin == vetoKey` is allowed: decision #35 gives both roles to the deployment wallet.
    ///      The hot keys may never double as a cold role or as the bridge owner.
    function _requireRoles(
        address admin,
        address vetoKey,
        address relayer,
        address watchdog,
        address deployer,
        address bridgeOwner
    ) internal pure {
        require(admin != address(0), unicode"BAC_ADMIN is zero / admin 为零地址");
        require(vetoKey != address(0), unicode"BAC_VETO_KEY is zero / veto 钥为零地址");
        require(relayer != address(0), unicode"BAC_RELAYER is zero / 中继地址为零");
        require(watchdog != address(0), unicode"BAC_WATCHDOG is zero / 看门狗地址为零");
        require(deployer != address(0), unicode"deployer is zero / 部署者为零地址");
        require(bridgeOwner != address(0), unicode"BAC_BRIDGE_OWNER is zero / 桥 owner 为零地址");
        require(
            relayer != admin && relayer != vetoKey,
            unicode"relayer must be a hot key of its own / 中继必须是独立的热钥"
        );
        require(watchdog != relayer, unicode"watchdog must not be the relayer / 看门狗不能是中继自己");
        require(
            bridgeOwner != relayer && bridgeOwner != watchdog,
            unicode"bridge owner must not be a hot key / 桥 owner 不能是中继或看门狗"
        );
    }

    /// @dev The read-only half of section 9 step 9: everything checkable without the token existing.
    function _postDeployChecks(
        address token,
        address identityRegistry,
        address bridgeOwner,
        address watchdog,
        address flapPortal,
        address pancakeRouter
    ) internal view {
        // -- the proxy really is a proxy over this implementation, and only the proxy has state
        require(
            address(uint160(uint256(vm.load(address(bridge), IMPL_SLOT)))) == address(bridgeImpl),
            unicode"EIP-1967 implementation slot != BacBridge implementation / 代理的实现槽不对"
        );
        require(bridge.EXTENSION() == bridgeImpl.EXTENSION(), unicode"proxy extension != implementation extension");
        require(bridge.EXTENSION().code.length > 0, unicode"BacBridgeExtension has no code / 扩展合约没有代码");
        require(bridgeImpl.bacToken() == address(0), unicode"the bare implementation must hold no state");
        require(bridgeImpl.owner() == address(0), unicode"the bare implementation must have no owner");
        require(bridge.owner() == bridgeOwner, unicode"BacBridge.owner() != BAC_BRIDGE_OWNER / 桥 owner 不对");
        require(bridge.pendingOwner() == address(0), unicode"BacBridge has a pending owner / 桥有待定 owner");
        require(bridge.upgradeCount() == 0 && bridge.emergencyCount() == 0, unicode"bridge must start clean");
        // -- decision #29a: the bridge itself says what the owner can do, word for word
        require(
            keccak256(bytes(bridge.OWNER_POWER_NOTICE())) == keccak256(bytes(NOTICE_29A)),
            unicode"OWNER_POWER_NOTICE is not decision #29a verbatim / 桥的 owner 权限声明与 #29a 不一致"
        );
        // -- wiring
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
        require(bridge.watchdog() == watchdog, unicode"BacBridge.watchdog() != BAC_WATCHDOG");
        require(bridge.portal() == flapPortal, unicode"BacBridge.portal() != BAC_FLAP_PORTAL");
        require(bridge.router() == pancakeRouter, unicode"BacBridge.router() != BAC_PANCAKE_ROUTER");
        require(bridge.anchor() == address(anchor), unicode"BacBridge.anchor() != ChainAnchor");
        require(bridge.bacToken() == token, unicode"preflight 1: BacBridge.bacToken() != T");
        require(nodeFund.bacToken() == token, unicode"preflight 1: BacNodeFund.bacToken() != T");
        require(staking.bacToken() == token, unicode"preflight 1: ValidatorStaking.bacToken() != T");
        require(anchor.bridge() == address(bridge), unicode"ChainAnchor.bridge() != the BacBridge proxy");
        require(anchor.validatorStaking() == address(staking), unicode"ChainAnchor.validatorStaking() != staking");
        require(anchor.lastFinalCirculating() == 1000e18, unicode"C5: lastFinalCirculating != OPERATOR_FLOAT");
        require(token.code.length == 0, unicode"preflight 2: T already has code / 代币地址已被占用");
        // The router is what the launch form points at: if any of these is wrong the tax goes
        // somewhere we cannot reach, and `Portal.setTokenBeneficiary` is Flap's admin, not ours.
        require(router.bacToken() == token, unicode"preflight 1: BacTaxRouter.bacToken() != T");
        require(router.bridge() == address(bridge), unicode"BacTaxRouter.bridge() != the BacBridge proxy");
        require(router.nodeFund() == address(nodeFund), unicode"BacTaxRouter.nodeFund() != BacNodeFund");
        require(router.BRIDGE_BPS() == 5000, unicode"BacTaxRouter split must be 50/50");
        require(router.accountedQuote() == 0 && router.unsplitRevenue() == 0, unicode"router must start empty");
        // Decision #32: the immutable, ownerless router freezes no text. A router that still
        // answers `description()` is the pre-#32 build and must not become the beneficiary.
        (bool hasDesc,) = address(router).staticcall(abi.encodeWithSignature("description()"));
        require(!hasDesc, unicode"BacTaxRouter still has description() (decision #32) / 路由合约不得带 description()");
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
        address bridgeOwner,
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
        console2.log(string.concat("bac.bacBridgeImplementation=", vm.toString(address(bridgeImpl))));
        console2.log(string.concat("bac.bacBridgeExtension=", vm.toString(bridge.EXTENSION())));
        console2.log(string.concat("bac.bacTaxRouter=", vm.toString(address(router))));
        console2.log(string.concat("bac.bridgeOwner=", vm.toString(bridgeOwner)));
        console2.log(string.concat("bac.admin=", vm.toString(admin)));
        console2.log(string.concat("bac.vetoKey=", vm.toString(vetoKey)));
        console2.log(string.concat("bac.relayer=", vm.toString(relayer)));
        console2.log(string.concat("bac.watchdog=", vm.toString(watchdog)));
        console2.log(string.concat("bac.nodeFundOwner=", vm.toString(nodeFundOwner)));
        console2.log(string.concat("bac.launcher=", vm.toString(launcher)));

        console2.log("");
        console2.log("== BacBridge: use the PROXY address everywhere (relayer, indexer, site, SDK) ==");
        console2.log("  proxy (the bridge)    :", address(bridge));
        console2.log("  implementation        :", address(bridgeImpl));
        console2.log("  extension             :", bridge.EXTENSION());
        console2.log("  owner (upgrade + emergency withdrawal, no timelock):", bridgeOwner);

        console2.log("");
        console2.log("== the launch (step 11, PLAIN Portal newTokenV6, no vault) ==");
        console2.log("  beneficiary           :", address(router));
        console2.log("  ^ check the first 6 and last 6 hex characters by eye before you press Launch.");
        console2.log("    Flap's admin can change this field afterwards. We cannot.");
        console2.log("  salt                  : the ...7777 salt locked in step 1, verbatim");
        console2.log("  sender                : the wallet that locked the salt (BAC_LAUNCHER), no other");
        console2.log("  dexThresh             : FOUR_FIFTHS (80%) - measured: the live Portal takes no other value");
        console2.log("  migratorType          : V2_MIGRATOR - measured: the live Portal takes no other value");
        console2.log("  quoteToken            : native BNB (0x0)");
        console2.log("  tokenVersion          : TOKEN_TAXED_V3 (newTokenV7 refuses it: NewTokenV7RuleViolation(4))");
        console2.log("  tax buy/sell          : 200 / 200 bps, mkt/defl/div/lp 10000 / 0 / 0 / 0");
        console2.log("  taxDuration           : 3153600000 (100 years, docs/04 section 4.1) - set it EXPLICITLY");
        console2.log("  antiFarmerDuration    : 86400 (1 day, docs/04 section 4.1) - set it EXPLICITLY");

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
                '","bacBridgeImplementation":"',
                vm.toString(address(bridgeImpl)),
                '","bacBridgeExtension":"',
                vm.toString(bridge.EXTENSION()),
                '","bacTaxRouter":"',
                vm.toString(address(router)),
                '","bridgeOwner":"',
                vm.toString(bridgeOwner),
                '"}'
            )
        );
    }
}

// There is no `SetVaultSink` any more. It wrote `AgentRegistry.vaultSink`, the destination for
// forfeited agent entry deposits — and decision #31 deleted `AgentRegistry`, its 0.02 BNB entry
// deposit and the timed signature challenge that could forfeit one. Entry is now "hold an ERC-8004
// identity": nothing is deposited, so nothing can be forfeited and there is nothing to point
// anywhere. The only address that still has to be typed by hand is the `beneficiary` of the
// `newTokenV6` launch, and that is `BacTaxRouter` (step 11 above).
