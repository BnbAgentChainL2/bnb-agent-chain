// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DeployBac} from "../../script/DeployBac.s.sol";

interface ISaltLockView {
    function getSaltLock(bytes32 salt) external view returns (address locker, uint8 tokenVersion);
}

/// @notice `DeployBac` must re-derive `T` before it sends anything (review finding, 2026-09-23).
///         Before the fix, a one-character typo in BAC_TOKEN_PREDICTED ran to the end: every
///         post-deploy "preflight 1" check compared the contracts with that same wrong value and
///         agreed, and all four `bacToken()` immutables / slots were bound to it.
/// @dev    A fork test (it reads the live Portal's salt lock), so it lives under `test/smoke/` and
///         is excluded from the non-fork run. Nothing is broadcast: the script runs in the forked
///         EVM only. The env vars are process-wide, so every case runs in ONE test function —
///         parallel test functions would race on them.
contract DeployBacPreflightTest is Test {
    address internal constant PORTAL = 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0;
    bytes32 internal constant LOCKED_SALT = 0xef6c0eb73e1df199c6585180a2ff54ce08a4be94de3c68d5de52ead1680b2af7;
    // decision #35
    address internal constant DEPLOYER = 0x934a6678120b85652D2CC818C69774ea17012844;
    address internal constant BAC_TOKEN = 0xA97452d175679B2bF5F25a9a382D22aff39b7777;
    address internal constant RELAYER = 0xD1437933839d67b6EA04b5466f3EAB87Fa91F6E4;
    address internal constant WATCHDOG = 0x51b6D9a3665c74FFef80ca8d3898edB9DeBcDb55;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BSC_RPC_URL", string("https://bsc-dataseed.bnbchain.org")));
    }

    function _env(string memory token, address launcher) internal {
        vm.setEnv("BAC_DEPLOYER_ADDRESS", vm.toString(DEPLOYER));
        vm.setEnv("BAC_ADMIN", vm.toString(DEPLOYER));
        vm.setEnv("BAC_VETO_KEY", vm.toString(DEPLOYER));
        vm.setEnv("BAC_RELAYER", vm.toString(RELAYER));
        vm.setEnv("BAC_WATCHDOG", vm.toString(WATCHDOG));
        vm.setEnv("BAC_NODE_FUND_OWNER", vm.toString(DEPLOYER));
        vm.setEnv("BAC_LAUNCHER", vm.toString(launcher));
        vm.setEnv("BAC_TOKEN_PREDICTED", token);
    }

    function test_fork_deployBacRederivesTBeforeSendingAnything() public {
        (address locker, uint8 version) = ISaltLockView(PORTAL).getSaltLock(LOCKED_SALT);
        if (BAC_TOKEN.code.length != 0 || locker != DEPLOYER || version != 6) {
            // After the launch the script's job is done and it refuses to run at all (T has code).
            emit log("BAC already exists or the salt lock is gone: nothing left to pre-check");
            vm.skip(true);
        }

        // 1. the finding's exact typo: the last hex digit of T, 7 -> 8, in lower case (forge's
        //    `envAddress` accepts it: it does not check the EIP-55 checksum)
        _env("0xa97452d175679b2bf5f25a9a382d22aff39b7778", DEPLOYER);
        DeployBac d = new DeployBac();
        vm.expectRevert(
            bytes(unicode"preflight 1: BAC_TOKEN_PREDICTED is not T of decision #35 / 预测代币地址不是决策 #35 锁定的 T")
        );
        d.run();

        // 2. the right T, but a launcher that does not hold the salt lock
        _env(vm.toString(BAC_TOKEN), makeAddr("notTheLocker"));
        d = new DeployBac();
        vm.expectRevert(bytes(unicode"preflight 3: the salt is not locked to BAC_LAUNCHER / salt 没有锁给发射钱包"));
        d.run();

        // 3. everything right: the whole deployment simulates and binds every contract to T
        _env(vm.toString(BAC_TOKEN), DEPLOYER);
        d = new DeployBac();
        d.run();
        assertEq(d.bridge().bacToken(), BAC_TOKEN);
        assertEq(d.nodeFund().bacToken(), BAC_TOKEN);
        assertEq(d.staking().bacToken(), BAC_TOKEN);
        assertEq(d.router().bacToken(), BAC_TOKEN);
    }
}
