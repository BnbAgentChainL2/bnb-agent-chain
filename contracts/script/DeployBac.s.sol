// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {UpgradeableBeacon} from "@openzeppelin/proxy/beacon/UpgradeableBeacon.sol";

import {AgentRegistry} from "../src/AgentRegistry.sol";
import {ChainAnchor} from "../src/ChainAnchor.sol";
import {ValidatorStaking} from "../src/ValidatorStaking.sol";
import {BacNodeFund} from "../src/BacNodeFund.sol";
import {BacBridge} from "../src/BacBridge.sol";
import {BacVaultFactory} from "../src/BacVaultFactory.sol";

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
///       What gets deployed, and by whom:
///         (2) src/lib/BacVaultUI.sol:BacVaultUI - forge deploys the linked library itself, as the
///             first transaction of the run, through the deterministic CREATE2 deployer
///             0x4e59b44847b379578588920cA78FbF26c0B4956C with salt 0, and links its address into
///             every contract that references it before any of them is sent. Pin it instead with
///             `--libraries src/lib/BacVaultUI.sol:BacVaultUI:0x...` once it exists on chain.
///         (3) AgentRegistry(admin, vetoKey)
///         (4) ChainAnchor(predicted BacBridge, relayer, admin, vetoKey, initialCirculating)
///         (5) ValidatorStaking(T, anchor, admin)
///         (6) BacNodeFund(T, nodeFundOwner)
///         (7) BacBridge(T, registry, anchor, watchdog)  - must land on the predicted address
///         (8) ChainAnchor.setValidatorStaking(5)        - one-shot, deployer only
///         (10) BacVaultFactory(launcher) - its CONSTRUCTOR creates the BacTreasuryVault
///             implementation and the UpgradeableBeacon that owns it. The implementation and the
///             beacon are deliberately NOT separate steps here: creating the beacon from a script
///             would make the deployer its owner, which is a rule-009 Critical finding
///             (docs/01-CONTRACT-SPEC.md section 1, src/BacVaultFactory.sol).
///
///       `T` (BAC_TOKEN_PREDICTED) is the ...7777 CREATE2 address mined in section 9 step 1 and
///       locked with `Portal.lockSalt`. It is an immutable of (5)(6)(7): if the launch form later
///       uses a different salt, all four contracts are scrap. The script refuses to run if `T`
///       already has code.
///
///       Steps (11) (the manual flap.sh launch) and (12) (`AgentRegistry.setVaultSink`) are not
///       here. (12) has its own script contract at the bottom of this file: `SetVaultSink`.
contract DeployBac is Script {
    /// @dev The answer the operator has to type into BAC_BROADCAST to arm a real send.
    string internal constant BROADCAST_PASSPHRASE = "I_HAVE_READ_SECTION_9";

    // -- the deployed stack --------------------------------------------------------------
    AgentRegistry public registry;
    ChainAnchor public anchor;
    ValidatorStaking public staking;
    BacNodeFund public nodeFund;
    BacBridge public bridge;
    BacVaultFactory public factory;

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
        address launcher = vm.envAddress("BAC_LAUNCHER");
        address vaultOwner = vm.envOr("BAC_VAULT_OWNER", address(0));
        address token = vm.envAddress("BAC_TOKEN_PREDICTED");
        uint128 initialCirculating = uint128(vm.envOr("BAC_INITIAL_CIRCULATING", uint256(1000e18)));

        _requireDistinctRoles(admin, vetoKey, relayer, watchdog, deployer);
        require(token != address(0), unicode"BAC_TOKEN_PREDICTED is zero / 预测代币地址为零");
        require(token.code.length == 0, unicode"BAC_TOKEN_PREDICTED already has code / 预测的代币地址已经被占用");
        require(launcher != address(0), unicode"BAC_LAUNCHER is zero / 发射钱包地址为零");
        require(nodeFundOwner != address(0), unicode"BAC_NODE_FUND_OWNER is zero / 节点基金 owner 为零");
        require(
            initialCirculating == 1000e18,
            unicode"BAC_INITIAL_CIRCULATING must be OPERATOR_FLOAT = 1000e18 / 必须等于 OPERATOR_FLOAT"
        );

        console2.log("== DeployBac: BSC side, docs/01-CONTRACT-SPEC.md section 9 ==");
        console2.log("mode                   :", wantsBroadcast ? "BROADCAST (armed)" : "DRY RUN (nothing is sent)");
        console2.log("chainId                :", block.chainid);
        console2.log("deployer               :", deployer);
        console2.log("predicted BAC token T  :", token);

        vm.startBroadcast(deployer);

        // (3) AgentRegistry
        registry = new AgentRegistry(admin, vetoKey);

        // (4) ChainAnchor - BacBridge does not exist yet, so its address comes from the
        //     deployer CREATE nonce: anchor (n), staking (n+1), nodeFund (n+2), bridge (n+3).
        uint256 n = vm.getNonce(deployer);
        address predictedBridge = vm.computeCreateAddress(deployer, n + 3);
        anchor = new ChainAnchor(predictedBridge, relayer, admin, vetoKey, initialCirculating);

        // (5)(6)(7) - the three contracts that pin `T` as an immutable
        staking = new ValidatorStaking(token, address(anchor), admin);
        nodeFund = new BacNodeFund(token, nodeFundOwner);
        bridge = new BacBridge(token, address(registry), address(anchor), watchdog);
        require(
            address(bridge) == predictedBridge,
            unicode"CREATE nonce prediction of BacBridge drifted / 桥地址预测失效，整轮部署作废"
        );

        // (8) one-shot binding, deployer only
        anchor.setValidatorStaking(address(staking));

        // (10) the factory: the beacon and the vault implementation are born in its constructor
        factory = new BacVaultFactory(launcher);

        vm.stopBroadcast();

        _postDeployChecks(token, launcher);
        _summary(deployer, admin, vetoKey, relayer, watchdog, nodeFundOwner, launcher, vaultOwner, token);
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
    function _postDeployChecks(address token, address launcher) internal view {
        require(bridge.bacToken() == token, unicode"preflight 1: BacBridge.bacToken() != T");
        require(nodeFund.bacToken() == token, unicode"preflight 1: BacNodeFund.bacToken() != T");
        require(staking.bacToken() == token, unicode"preflight 1: ValidatorStaking.bacToken() != T");
        require(anchor.bridge() == address(bridge), unicode"ChainAnchor.bridge() != BacBridge");
        require(anchor.validatorStaking() == address(staking), unicode"ChainAnchor.validatorStaking() != staking");
        require(anchor.lastFinalCirculating() == 1000e18, unicode"C5: lastFinalCirculating != OPERATOR_FLOAT");
        require(token.code.length == 0, unicode"preflight 2: T already has code / 代币地址已被占用");
        require(factory.LAUNCHER() == launcher, unicode"factory LAUNCHER mismatch");
        require(
            UpgradeableBeacon(factory.beacon()).owner() == address(factory),
            unicode"rule 009: beacon owner must be the factory / beacon 的 owner 必须是工厂"
        );
        require(
            keccak256(bytes(factory.factorySpecVersion())) == keccak256(bytes("v2.3")),
            unicode"factorySpecVersion must be v2.3"
        );
        require(factory.isQuoteTokenSupported(address(0)), unicode"factory must accept the BNB quote");
        require(!factory.isVaultUpgradesLocked(), unicode"vault upgrades must not be locked at deploy time");
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
        address vaultOwner,
        address token
    ) internal view {
        address impl = factory.beaconImplementation();
        bytes memory vaultData = abi.encode(vaultOwner, address(bridge), address(nodeFund));

        console2.log("");
        console2.log("== deployed (machine readable) ==");
        console2.log(string.concat("bac.chainId=", vm.toString(block.chainid)));
        console2.log(string.concat("bac.deployer=", vm.toString(deployer)));
        console2.log(string.concat("bac.tokenPredicted=", vm.toString(token)));
        console2.log(string.concat("bac.agentRegistry=", vm.toString(address(registry))));
        console2.log(string.concat("bac.chainAnchor=", vm.toString(address(anchor))));
        console2.log(string.concat("bac.validatorStaking=", vm.toString(address(staking))));
        console2.log(string.concat("bac.bacNodeFund=", vm.toString(address(nodeFund))));
        console2.log(string.concat("bac.bacBridge=", vm.toString(address(bridge))));
        console2.log(string.concat("bac.bacVaultFactory=", vm.toString(address(factory))));
        console2.log(string.concat("bac.beacon=", vm.toString(factory.beacon())));
        console2.log(string.concat("bac.vaultImplementation=", vm.toString(impl)));
        console2.log(string.concat("bac.admin=", vm.toString(admin)));
        console2.log(string.concat("bac.vetoKey=", vm.toString(vetoKey)));
        console2.log(string.concat("bac.relayer=", vm.toString(relayer)));
        console2.log(string.concat("bac.watchdog=", vm.toString(watchdog)));
        console2.log(string.concat("bac.nodeFundOwner=", vm.toString(nodeFundOwner)));
        console2.log(string.concat("bac.launcher=", vm.toString(launcher)));
        console2.log(string.concat("bac.vaultOwner=", vm.toString(vaultOwner)));
        console2.log(string.concat("bac.vaultData=", vm.toString(vaultData)));

        console2.log("");
        console2.log("== the flap.sh form (step 11, done by hand) ==");
        console2.log("  custom vault factory  :", address(factory));
        console2.log("  vaultData (hex)       :", vm.toString(vaultData));
        console2.log("  salt                  : the ...7777 salt locked in step 1, verbatim");
        console2.log("  sender                : BAC_LAUNCHER, and no other wallet");
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
                '","agentRegistry":"',
                vm.toString(address(registry)),
                '","chainAnchor":"',
                vm.toString(address(anchor)),
                '","validatorStaking":"',
                vm.toString(address(staking)),
                '","bacNodeFund":"',
                vm.toString(address(nodeFund)),
                '","bacBridge":"',
                vm.toString(address(bridge)),
                '","bacVaultFactory":"',
                vm.toString(address(factory)),
                '","beacon":"',
                vm.toString(factory.beacon()),
                '","vaultImplementation":"',
                vm.toString(impl),
                '","vaultData":"',
                vm.toString(vaultData),
                '"}'
            )
        );
    }
}

/// @title SetVaultSink
/// @notice Step (12) of section 9, run AFTER the flap.sh launch: the only trusted one-shot write
///         of the whole project. It must be sent by the same wallet that deployed `AgentRegistry`.
/// @dev Same gate as `DeployBac`: dry run unless `--broadcast` AND
///      `BAC_BROADCAST=I_HAVE_READ_SECTION_9`.
///        BAC_AGENT_REGISTRY=0x... BAC_VAULT=0x... \
///        forge script script/DeployBac.s.sol:SetVaultSink --rpc-url "$BSC_RPC_URL" --sender 0x<deployer>
contract SetVaultSink is Script {
    function run() external {
        bool wantsBroadcast =
            vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
        if (wantsBroadcast) {
            require(
                keccak256(bytes(vm.envOr("BAC_BROADCAST", string("")))) == keccak256(bytes("I_HAVE_READ_SECTION_9")),
                unicode"--broadcast needs BAC_BROADCAST=I_HAVE_READ_SECTION_9 / 要真的广播必须同时设置该环境变量"
            );
        }

        AgentRegistry registry = AgentRegistry(vm.envAddress("BAC_AGENT_REGISTRY"));
        address vault = vm.envAddress("BAC_VAULT");
        address deployer = vm.envOr("BAC_DEPLOYER_ADDRESS", msg.sender);

        require(vault.code.length > 0, unicode"vault has no code / 金库地址没有代码");
        require(registry.vaultSink() == address(0), unicode"vault sink already set / 金库地址已设置");

        vm.startBroadcast(deployer);
        registry.setVaultSink(vault);
        vm.stopBroadcast();

        require(registry.vaultSink() == vault, unicode"vault sink did not stick");
        console2.log(string.concat("bac.vaultSink=", vm.toString(vault)));
    }
}
