// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

/// @dev 金库 receive() 的替身：冷路径一次 SSTORE，远超 2300 gas。
contract GoodSink {
    uint256 public hits;

    receive() external payable {
        hits = hits + 1;
    }
}

/// @dev 拒收 BNB 的下游，用来断言 sweepForfeited 会带着双语字符串失败。
contract BadSink {
    receive() external payable {
        revert("nope");
    }
}

contract AgentRegistryTest is Test {
    using stdStorage for StdStorage;

    uint256 internal constant TARGET = 2 ** 236;

    AgentRegistry internal reg;

    address internal admin = address(0xA11CE);
    address internal veto = address(0xBEEF);
    address internal stranger = address(0xCAFE);

    uint256 internal ctrlPk = 0xC0FFEE01;
    uint256 internal walletPk = 0xC0FFEE02;
    uint256 internal newCtrlPk = 0xC0FFEE03;
    uint256 internal wallet2Pk = 0xC0FFEE04;

    address internal ctrl;
    address internal wallet;
    address internal newCtrl;

    function setUp() public {
        ctrl = vm.addr(ctrlPk);
        wallet = vm.addr(walletPk);
        newCtrl = vm.addr(newCtrlPk);
        vm.roll(1_000);
        vm.warp(1_800_000_000);
        reg = new AgentRegistry(admin, veto);
        vm.deal(ctrl, 10 ether);
        vm.deal(stranger, 10 ether);
        vm.deal(address(this), 10 ether);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    function _mine(bytes32 seed) internal pure returns (uint256) {
        unchecked {
            for (uint256 n = 0; n < 200_000_000; n++) {
                bytes32 h;
                assembly {
                    mstore(0x00, seed)
                    mstore(0x20, n)
                    h := keccak256(0x00, 0x40)
                }
                if (uint256(h) < TARGET) return n;
            }
        }
        revert("no nonce found");
    }

    function _sign(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", reg.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _bindSig(uint256 pk, address w, address c, uint256 deadline) internal view returns (bytes memory) {
        return _sign(pk, keccak256(abi.encode(reg.BIND_WALLET_TYPEHASH(), w, c, deadline)));
    }

    function _register() internal returns (uint256 id) {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _bindSig(walletPk, wallet, ctrl, dl);
        vm.prank(ctrl);
        (id,) = reg.register{value: 0.02 ether}(
            "https://agent.example/agent.json", keccak256("endpoint"), keccak256("model"), wallet, dl, sig
        );
    }

    /// @dev 任何人都可以提交解答，签名必须来自 controller。
    function _solveOnce(uint256 id, uint256 pk) internal {
        (bytes32 cid, bytes32 seed,,,) = reg.currentChallenge(id);
        uint256 nonce = _mine(seed);
        bytes memory sig = _sign(pk, keccak256(abi.encode(reg.CHALLENGE_TYPEHASH(), id, cid, seed, nonce)));
        vm.prank(stranger);
        reg.solveChallenge(id, cid, nonce, sig);
    }

    function _activate() internal returns (uint256 id) {
        id = _register();
        for (uint256 i = 0; i < reg.ROUNDS(); i++) {
            _solveOnce(id, ctrlPk);
        }
        assertEq(uint8(reg.getAgent(id).status), uint8(AgentRegistry.Status.ACTIVE), "not active");
    }

    /// @dev 任意状态变更调用，用来锚定当前纪元。
    function _anchor(uint256 id) internal {
        vm.prank(ctrl);
        reg.publish(id, keccak256("NOTE"), keccak256("x"), "");
    }

    function _sealNow(uint64 e) internal {
        vm.roll(block.number + reg.SEED_SEAL_DELAY() + 1);
        reg.sealEpochSeed(e);
    }

    // ------------------------------------------------------------------
    // register
    // ------------------------------------------------------------------

    function test_Register_MintsSoulboundAndIssuesChallenge() public {
        uint256 id = _register();
        assertEq(id, 1);
        assertEq(reg.ownerOf(id), ctrl);
        assertEq(reg.totalAgents(), 1);
        assertEq(reg.agentAt(0), 1);
        assertEq(reg.agentIdOfController(ctrl), 1);
        assertEq(reg.agentIdOfWallet(wallet), 1);
        assertEq(address(reg).balance, 0.02 ether);

        AgentRegistry.Agent memory a = reg.getAgent(id);
        assertEq(uint8(a.status), uint8(AgentRegistry.Status.CHALLENGED));
        assertEq(a.deposit, 0.02 ether);
        assertEq(a.endpointHash, keccak256("endpoint"));
        assertEq(a.modelFingerprint, keccak256("model"));
        assertEq(reg.tokenURI(id), "https://agent.example/agent.json");

        (bytes32 cid, bytes32 seed, uint64 db, uint64 dt, uint8 round) = reg.currentChallenge(id);
        assertTrue(cid != bytes32(0));
        assertEq(cid, keccak256(abi.encode(id, uint8(1), seed)));
        assertEq(db, uint64(block.number) + reg.K_BLOCKS());
        assertEq(dt, uint64(block.timestamp) + reg.K_SECONDS());
        assertEq(round, 1);
        assertFalse(reg.isActive(id));
    }

    function test_Register_RevertsOnWrongDeposit() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _bindSig(walletPk, wallet, ctrl, dl);
        vm.prank(ctrl);
        vm.expectRevert(bytes(unicode"Entry deposit must be exactly 0.02 BNB / 入场押金必须正好 0.02 BNB"));
        reg.register{value: 0.01 ether}("u", bytes32(0), bytes32(0), wallet, dl, sig);
    }

    /// R7：没有新钱包自己的 EIP-712 签名，agentIdOfWallet 不可能变成非零。
    function test_Register_RevertsWithoutWalletSignature() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory wrong = _bindSig(ctrlPk, wallet, ctrl, dl); // controller 自己签的
        vm.prank(ctrl);
        vm.expectRevert(bytes(unicode"Bad wallet signature / 钱包签名不正确"));
        reg.register{value: 0.02 ether}("u", bytes32(0), bytes32(0), wallet, dl, wrong);
        assertEq(reg.agentIdOfWallet(wallet), 0);
    }

    function test_Register_RevertsOnDuplicateWallet() public {
        _register();
        uint256 dl = block.timestamp + 1 hours;
        address other = vm.addr(0xDEAD01);
        vm.deal(other, 1 ether);
        bytes memory sig = _bindSig(walletPk, wallet, other, dl);
        vm.prank(other);
        vm.expectRevert(bytes(unicode"Wallet already bound / 该钱包已绑定"));
        reg.register{value: 0.02 ether}("u", bytes32(0), bytes32(0), wallet, dl, sig);
    }

    function test_Register_RevertsOnDuplicateController() public {
        _register();
        address w2 = vm.addr(wallet2Pk);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _bindSig(wallet2Pk, w2, ctrl, dl);
        vm.prank(ctrl);
        vm.expectRevert(bytes(unicode"Controller already bound / 该 controller 已有 agent"));
        reg.register{value: 0.02 ether}("u", bytes32(0), bytes32(0), w2, dl, sig);
    }

    function test_Register_RevertsOnLongUri() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _bindSig(walletPk, wallet, ctrl, dl);
        string memory long = string(new bytes(513));
        vm.prank(ctrl);
        vm.expectRevert(bytes(unicode"agentURI too long / agentURI 过长"));
        reg.register{value: 0.02 ether}(long, bytes32(0), bytes32(0), wallet, dl, sig);
    }

    function test_Register_RevertsOnExpiredDeadline() public {
        uint256 dl = block.timestamp - 1;
        bytes memory sig = _bindSig(walletPk, wallet, ctrl, dl);
        vm.prank(ctrl);
        vm.expectRevert(bytes(unicode"Signature expired / 签名已过期"));
        reg.register{value: 0.02 ether}("u", bytes32(0), bytes32(0), wallet, dl, sig);
    }

    // ------------------------------------------------------------------
    // challenge
    // ------------------------------------------------------------------

    /// 一个程序能在截止之前算出答案并连过 3 轮。
    function test_Solve_ThreeRoundsActivates() public {
        uint256 id = _register();
        _solveOnce(id, ctrlPk);
        (,,,, uint8 r2) = reg.currentChallenge(id);
        assertEq(r2, 2);
        _solveOnce(id, ctrlPk);
        (,,,, uint8 r3) = reg.currentChallenge(id);
        assertEq(r3, 3);
        _solveOnce(id, ctrlPk);

        (bytes32 cid,,,,) = reg.currentChallenge(id);
        assertEq(cid, bytes32(0), "challenge not cleared");
        assertTrue(reg.isActive(id));
        AgentRegistry.Agent memory a = reg.getAgent(id);
        assertEq(a.solvedChallenges, 3);
        assertEq(a.lastHeartbeatEpoch, reg.currentEpoch());
        assertTrue(reg.everActivated(id));
    }

    function test_Solve_RevertsAfterBlockDeadline() public {
        uint256 id = _register();
        (bytes32 cid, bytes32 seed,,,) = reg.currentChallenge(id);
        uint256 nonce = _mine(seed);
        bytes memory sig = _sign(ctrlPk, keccak256(abi.encode(reg.CHALLENGE_TYPEHASH(), id, cid, seed, nonce)));
        vm.roll(block.number + uint256(reg.K_BLOCKS()) + 1);
        vm.expectRevert(bytes(unicode"Challenge block deadline passed / 挑战区块截止已过"));
        reg.solveChallenge(id, cid, nonce, sig);
    }

    function test_Solve_RevertsAfterTimeDeadline() public {
        uint256 id = _register();
        (bytes32 cid, bytes32 seed,,,) = reg.currentChallenge(id);
        uint256 nonce = _mine(seed);
        bytes memory sig = _sign(ctrlPk, keccak256(abi.encode(reg.CHALLENGE_TYPEHASH(), id, cid, seed, nonce)));
        vm.warp(block.timestamp + uint256(reg.K_SECONDS()) + 1);
        vm.expectRevert(bytes(unicode"Challenge time deadline passed / 挑战时间截止已过"));
        reg.solveChallenge(id, cid, nonce, sig);
    }

    function test_Solve_RevertsOnBadAnswer() public {
        uint256 id = _register();
        (bytes32 cid, bytes32 seed,,,) = reg.currentChallenge(id);
        bytes memory sig = _sign(ctrlPk, keccak256(abi.encode(reg.CHALLENGE_TYPEHASH(), id, cid, seed, uint256(1))));
        vm.expectRevert(bytes(unicode"Answer above target / 答案不满足难度"));
        reg.solveChallenge(id, cid, 1, sig);
    }

    function test_Solve_RevertsOnForeignSignature() public {
        uint256 id = _register();
        (bytes32 cid, bytes32 seed,,,) = reg.currentChallenge(id);
        uint256 nonce = _mine(seed);
        bytes memory sig = _sign(newCtrlPk, keccak256(abi.encode(reg.CHALLENGE_TYPEHASH(), id, cid, seed, nonce)));
        vm.expectRevert(bytes(unicode"Bad controller signature / controller 签名不正确"));
        reg.solveChallenge(id, cid, nonce, sig);
    }

    /// 重放一个已经被换掉的种子/挑战一定失败。
    function test_Solve_ReplayedSeedFails() public {
        uint256 id = _register();
        (bytes32 cid1, bytes32 seed1,,,) = reg.currentChallenge(id);
        uint256 nonce1 = _mine(seed1);
        bytes memory sig1 = _sign(ctrlPk, keccak256(abi.encode(reg.CHALLENGE_TYPEHASH(), id, cid1, seed1, nonce1)));

        // 超时 + 冷却之后任何人重发：种子和 id 都必须换新。
        vm.warp(block.timestamp + 61);
        vm.roll(block.number + 10);
        vm.prank(stranger);
        reg.reissueChallenge(id);
        (bytes32 cid2, bytes32 seed2,,,) = reg.currentChallenge(id);
        assertTrue(seed2 != seed1, "seed reused");
        assertTrue(cid2 != cid1, "challenge id reused");

        vm.expectRevert(bytes(unicode"Challenge id mismatch / 挑战 ID 不匹配"));
        reg.solveChallenge(id, cid1, nonce1, sig1);

        // 旧的答案也不满足新种子。
        bytes memory sig2 = _sign(ctrlPk, keccak256(abi.encode(reg.CHALLENGE_TYPEHASH(), id, cid2, seed2, nonce1)));
        vm.expectRevert(bytes(unicode"Answer above target / 答案不满足难度"));
        reg.solveChallenge(id, cid2, nonce1, sig2);
    }

    function test_Solve_RevertsWhenNoLiveChallenge() public {
        uint256 id = _activate();
        vm.expectRevert(bytes(unicode"No live challenge / 没有进行中的挑战"));
        reg.solveChallenge(id, keccak256("x"), 0, hex"00");
    }

    // ------------------------------------------------------------------
    // reissue
    // ------------------------------------------------------------------

    function test_Reissue_RevertsWhileLive() public {
        uint256 id = _register();
        vm.expectRevert(bytes(unicode"Challenge still live / 挑战尚未超时"));
        reg.reissueChallenge(id);
    }

    function test_Reissue_Cooldown() public {
        uint256 id = _register();
        vm.warp(block.timestamp + 61);
        vm.prank(stranger);
        reg.reissueChallenge(id);
        vm.warp(block.timestamp + 6); // 挑战已超时，但冷却没到
        vm.expectRevert(bytes(unicode"Reissue cooldown / 重发冷却中"));
        reg.reissueChallenge(id);
    }

    /// R5：第三方 reissue 不改变 failedRounds / deposit / status。
    function test_Reissue_ThirdPartyTouchesNoCounter() public {
        uint256 id = _register();
        uint256 before = reg.forfeitedPending();
        for (uint256 i = 0; i < 12; i++) {
            vm.warp(block.timestamp + 61);
            vm.prank(stranger);
            reg.reissueChallenge(id);
            assertEq(reg.failedRounds(id), 0, "failedRounds moved");
            AgentRegistry.Agent memory a = reg.getAgent(id);
            assertEq(a.deposit, 0.02 ether, "deposit moved");
            assertEq(uint8(a.status), uint8(AgentRegistry.Status.CHALLENGED), "status moved");
        }
        assertEq(reg.forfeitedPending(), before);
    }

    /// controller 自己失败满 MAX_FAILED_ROUNDS 才没收押金。
    function test_Reissue_ControllerForfeitsAfterMaxFailedRounds() public {
        uint256 id = _register();
        for (uint256 i = 0; i < reg.MAX_FAILED_ROUNDS(); i++) {
            vm.warp(block.timestamp + 61);
            vm.prank(ctrl);
            reg.reissueChallenge(id);
        }
        assertEq(reg.failedRounds(id), reg.MAX_FAILED_ROUNDS());
        AgentRegistry.Agent memory a = reg.getAgent(id);
        assertEq(uint8(a.status), uint8(AgentRegistry.Status.BANNED));
        assertEq(a.deposit, 0);
        assertEq(reg.forfeitedPending(), 0.02 ether);
        (bytes32 cid,,,,) = reg.currentChallenge(id);
        assertEq(cid, bytes32(0));
    }

    function test_Reissue_RevertsOnBannedAgent() public {
        uint256 id = _register();
        vm.prank(veto);
        reg.banNow(id, keccak256("bad"));
        vm.warp(block.timestamp + 61);
        vm.expectRevert(bytes(unicode"Agent cannot be challenged / 该 agent 不能被挑战"));
        reg.reissueChallenge(id);
    }

    // ------------------------------------------------------------------
    // abandon
    // ------------------------------------------------------------------

    function test_AbandonRegistration_RefundsPayer() public {
        uint256 id = _register();
        uint256 balBefore = ctrl.balance;
        vm.warp(block.timestamp + 24 hours);
        reg.abandonRegistration(id);
        assertEq(ctrl.balance, balBefore + 0.02 ether);
        assertEq(reg.forfeitedPending(), 0, "abandon must not forfeit");
        assertEq(uint8(reg.getAgent(id).status), uint8(AgentRegistry.Status.RETIRED));
    }

    function test_AbandonRegistration_RevertsTooEarly() public {
        uint256 id = _register();
        vm.warp(block.timestamp + 23 hours);
        vm.expectRevert(bytes(unicode"Abandon delay not elapsed / 放弃延迟未到"));
        reg.abandonRegistration(id);
    }

    function test_AbandonRegistration_RevertsAfterActivation() public {
        uint256 id = _activate();
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(bytes(unicode"Agent is not in challenge / 该 agent 不在挑战中"));
        reg.abandonRegistration(id);
    }

    // ------------------------------------------------------------------
    // epoch seed
    // ------------------------------------------------------------------

    function test_EpochSeed_TwoPhaseSeal() public {
        uint256 id = _register();
        uint64 e = reg.currentEpoch();
        assertEq(reg.seedAnchorBlock(e), uint64(vm.getBlockNumber()), "not anchored");
        id;

        vm.expectRevert(bytes(unicode"Seal delay not elapsed / 封存延迟未到"));
        reg.sealEpochSeed(e);

        uint64 anchor = reg.seedAnchorBlock(e);
        vm.roll(block.number + uint256(reg.SEED_SEAL_DELAY()) + 1);
        reg.sealEpochSeed(e);

        // R6：封存值只可能等于规范公式。
        assertEq(reg.epochSeed(e), keccak256(abi.encode(blockhash(anchor + reg.SEED_SEAL_DELAY()), e)));
        assertEq(reg.sealedAtBlock(e), uint64(vm.getBlockNumber()));

        vm.expectRevert(bytes(unicode"Already sealed / 已封存"));
        reg.sealEpochSeed(e);
    }

    function test_EpochSeed_RevertsWhenNotAnchored() public {
        uint64 future = reg.currentEpoch() + 5;
        vm.expectRevert(bytes(unicode"Epoch not anchored yet / 该纪元尚未锚定"));
        reg.sealEpochSeed(future);
    }

    function test_EpochSeed_WindowMissed() public {
        _register();
        uint64 e = reg.currentEpoch();
        vm.roll(block.number + uint256(reg.SEED_SEAL_DELAY()) + 257);
        vm.expectRevert(bytes(unicode"Seal window missed / 封存窗口已过"));
        reg.sealEpochSeed(e);
        assertEq(reg.epochSeed(e), bytes32(0), "fail-open: no spot check this epoch");
    }

    // ------------------------------------------------------------------
    // heartbeat / dormancy
    // ------------------------------------------------------------------

    function _hbSig(uint256 id, uint64 e, bytes32 note, uint256 pk) internal view returns (bytes memory) {
        return _sign(pk, keccak256(abi.encode(reg.HEARTBEAT_TYPEHASH(), id, e, reg.epochSeed(e), note)));
    }

    function _heartbeat(uint256 id, uint64 e, bytes32 note, uint256 pk) internal {
        bytes memory sig = _hbSig(id, e, note, pk);
        vm.prank(stranger);
        reg.heartbeat(id, e, note, sig);
    }

    function test_Heartbeat_InsideWindow() public {
        uint256 id = _activate();
        vm.warp(block.timestamp + 86400);
        vm.roll(block.number + 100);
        _anchor(id); // 锚定新纪元
        uint64 e = reg.currentEpoch();
        _sealNow(e);

        _heartbeat(id, e, keccak256("ok"), ctrlPk);
        assertEq(reg.getAgent(id).lastHeartbeatEpoch, e);
        assertEq(reg.getAgent(id).missedEpochs, 0);

        bytes memory again = _hbSig(id, e, keccak256("ok"), ctrlPk);
        vm.expectRevert(bytes(unicode"Heartbeat already recorded / 本纪元已心跳"));
        reg.heartbeat(id, e, keccak256("ok"), again);
    }

    function test_Heartbeat_RevertsOutsideWindow() public {
        uint256 id = _activate();
        vm.warp(block.timestamp + 86400);
        vm.roll(block.number + 100);
        _anchor(id);
        uint64 e = reg.currentEpoch();
        _sealNow(e);
        vm.roll(block.number + uint256(reg.HB_WINDOW_BLOCKS()) + 1);
        bytes memory sig = _hbSig(id, e, bytes32(0), ctrlPk);
        vm.expectRevert(bytes(unicode"Outside heartbeat window / 不在心跳窗口内"));
        reg.heartbeat(id, e, bytes32(0), sig);
    }

    function test_Heartbeat_FailOpenWhenUnsealed() public {
        uint256 id = _activate();
        vm.warp(block.timestamp + 86400);
        vm.roll(block.number + 5);
        uint64 e = reg.currentEpoch();
        assertEq(reg.epochSeed(e), bytes32(0));
        _heartbeat(id, e, keccak256("open"), ctrlPk);
        assertEq(reg.getAgent(id).lastHeartbeatEpoch, e);
    }

    function test_Heartbeat_RevertsOnWrongEpochAndBadSigner() public {
        uint256 id = _activate();
        vm.warp(block.timestamp + 86400);
        vm.roll(block.number + 5);
        uint64 e = reg.currentEpoch();

        bytes memory sigNext = _hbSig(id, e + 1, bytes32(0), ctrlPk);
        vm.expectRevert(bytes(unicode"Wrong epoch / 纪元不匹配"));
        reg.heartbeat(id, e + 1, bytes32(0), sigNext);

        bytes memory sigWrongSigner = _hbSig(id, e, bytes32(0), newCtrlPk);
        vm.expectRevert(bytes(unicode"Bad controller signature / controller 签名不正确"));
        reg.heartbeat(id, e, bytes32(0), sigWrongSigner);
    }

    function test_MarkDormant_AfterMissedEpochs() public {
        uint256 id = _activate();
        vm.expectRevert(bytes(unicode"Agent is still live / agent 仍在线"));
        reg.markDormant(id);

        vm.warp(block.timestamp + 4 * 86400);
        vm.roll(block.number + 400);
        reg.markDormant(id);
        AgentRegistry.Agent memory a = reg.getAgent(id);
        assertEq(uint8(a.status), uint8(AgentRegistry.Status.DORMANT));
        assertEq(a.missedEpochs, 3);
        assertFalse(reg.isActive(id));

        vm.expectRevert(bytes(unicode"Agent is not active / agent 未激活"));
        reg.markDormant(id);
    }

    /// 被抽中（epochSeed % 32 == agentId % 32）却没在那个纪元过挑战 → 任何人可 markDormant。
    function test_MarkDormant_SpotCheckMissed() public {
        uint256 id = _activate();
        assertEq(id % 32, 1);

        vm.warp(block.timestamp + 2 * 86400);
        vm.roll(block.number + 200);
        uint64 p = reg.currentEpoch() - 1;
        stdstore.target(address(reg)).sig(reg.epochSeed.selector).with_key(uint256(p))
            .checked_write(bytes32(uint256(33))); // 33 % 32 == 1 == agentId % 32
        assertEq(uint256(reg.epochSeed(p)) % reg.SPOT_RATE(), id % reg.SPOT_RATE());

        reg.markDormant(id);
        assertEq(uint8(reg.getAgent(id).status), uint8(AgentRegistry.Status.DORMANT));
    }

    /// DORMANT 靠 reissue + 一次 solve 复活。
    function test_Dormant_RevivesWithOneSolve() public {
        uint256 id = _activate();
        vm.warp(block.timestamp + 4 * 86400);
        vm.roll(block.number + 400);
        reg.markDormant(id);

        vm.prank(stranger);
        reg.reissueChallenge(id);
        (,,,, uint8 round) = reg.currentChallenge(id);
        assertEq(round, reg.ROUNDS());
        _solveOnce(id, ctrlPk);
        assertTrue(reg.isActive(id));
        assertEq(reg.getAgent(id).missedEpochs, 0);
    }

    // ------------------------------------------------------------------
    // publish / retire / withdraw
    // ------------------------------------------------------------------

    function test_Publish_OnlyActiveController() public {
        uint256 id = _activate();
        vm.prank(ctrl);
        reg.publish(id, keccak256("DEPLOY"), keccak256("code"), "https://x/1");

        vm.prank(stranger);
        vm.expectRevert(bytes(unicode"Only controller / 仅限 controller"));
        reg.publish(id, keccak256("DEPLOY"), keccak256("code"), "");

        vm.warp(block.timestamp + 4 * 86400);
        vm.roll(block.number + 400);
        reg.markDormant(id);
        vm.prank(ctrl);
        vm.expectRevert(bytes(unicode"Agent is not active / agent 未激活"));
        reg.publish(id, keccak256("DEPLOY"), keccak256("code"), "");
    }

    function test_SetAgentURI_AndWallet() public {
        uint256 id = _activate();
        vm.prank(ctrl);
        reg.setAgentURI(id, "https://agent.example/v2.json");
        assertEq(reg.getAgent(id).agentURI, "https://agent.example/v2.json");

        address w2 = vm.addr(wallet2Pk);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory okSig = _bindSig(wallet2Pk, w2, ctrl, dl);
        vm.prank(ctrl);
        reg.setAgentWallet(id, w2, dl, okSig);
        assertEq(reg.getAgent(id).agentWallet, w2);
        assertEq(reg.agentIdOfWallet(w2), id);

        // R7：换钱包同样需要新钱包自己的签名。
        address w3 = vm.addr(0xDEAD03);
        bytes memory wrongSig = _bindSig(ctrlPk, w3, ctrl, dl);
        vm.prank(ctrl);
        vm.expectRevert(bytes(unicode"Bad wallet signature / 钱包签名不正确"));
        reg.setAgentWallet(id, w3, dl, wrongSig);
        assertEq(reg.agentIdOfWallet(w3), 0);
    }

    function test_RetireAndWithdrawDeposit() public {
        uint256 id = _activate();
        vm.prank(stranger);
        vm.expectRevert(bytes(unicode"Only controller / 仅限 controller"));
        reg.retire(id);

        vm.prank(ctrl);
        reg.retire(id);
        assertEq(uint8(reg.getAgent(id).status), uint8(AgentRegistry.Status.RETIRED));

        vm.prank(ctrl);
        vm.expectRevert(bytes(unicode"Retire delay not elapsed / 退休冷却未到"));
        reg.withdrawDeposit(id, ctrl);

        vm.warp(block.timestamp + 7 days);
        uint256 balBefore = stranger.balance;
        vm.prank(ctrl);
        reg.withdrawDeposit(id, stranger);
        assertEq(stranger.balance, balBefore + 0.02 ether);
        assertEq(address(reg).balance, 0);

        vm.prank(ctrl);
        vm.expectRevert(bytes(unicode"Nothing to withdraw / 没有可提取的押金"));
        reg.withdrawDeposit(id, ctrl);
    }

    // ------------------------------------------------------------------
    // rotateController
    // ------------------------------------------------------------------

    function test_RotateController_NeedsNewKeySigAndFreshChallenge() public {
        uint256 id = _activate();
        uint256 dl = block.timestamp + 1 hours;

        bytes32 sh = keccak256(abi.encode(reg.ROTATE_TYPEHASH(), id, newCtrl, dl));
        bytes memory badSig = _sign(ctrlPk, sh);
        bytes memory goodSig = _sign(newCtrlPk, sh);
        vm.prank(ctrl);
        vm.expectRevert(bytes(unicode"Bad new key signature / 新钥签名不正确"));
        reg.rotateController(id, newCtrl, dl, badSig);

        vm.prank(ctrl);
        reg.rotateController(id, newCtrl, dl, goodSig);

        assertEq(reg.ownerOf(id), newCtrl);
        assertEq(reg.getAgent(id).controller, newCtrl);
        assertEq(reg.agentIdOfController(newCtrl), id);
        assertEq(reg.agentIdOfController(ctrl), 0);
        // 必须重过一轮挑战：买一个已激活的号不成立。
        assertFalse(reg.isActive(id));
        assertEq(uint8(reg.getAgent(id).status), uint8(AgentRegistry.Status.CHALLENGED));
        (,,,, uint8 round) = reg.currentChallenge(id);
        assertEq(round, reg.ROUNDS());

        _solveOnce(id, newCtrlPk);
        assertTrue(reg.isActive(id));
    }

    function test_RotateController_OnlyController() public {
        uint256 id = _activate();
        uint256 dl = block.timestamp + 1 hours;
        bytes32 sh = keccak256(abi.encode(reg.ROTATE_TYPEHASH(), id, newCtrl, dl));
        bytes memory sig = _sign(newCtrlPk, sh);
        vm.prank(stranger);
        vm.expectRevert(bytes(unicode"Only controller / 仅限 controller"));
        reg.rotateController(id, newCtrl, dl, sig);
    }

    // ------------------------------------------------------------------
    // soulbound
    // ------------------------------------------------------------------

    function test_Soulbound_AllTransferPathsRevert() public {
        uint256 id = _register();
        bytes memory err = bytes(unicode"Agent identity is not transferable / agent 身份不可转让");

        vm.prank(ctrl);
        vm.expectRevert(err);
        reg.transferFrom(ctrl, stranger, id);

        vm.prank(ctrl);
        vm.expectRevert(err);
        reg.safeTransferFrom(ctrl, stranger, id);

        vm.prank(ctrl);
        vm.expectRevert(err);
        reg.safeTransferFrom(ctrl, stranger, id, "");

        vm.prank(ctrl);
        vm.expectRevert(err);
        reg.approve(stranger, id);

        vm.prank(ctrl);
        vm.expectRevert(err);
        reg.setApprovalForAll(stranger, true);
    }

    // ------------------------------------------------------------------
    // ban / veto
    // ------------------------------------------------------------------

    function test_Ban_TimelockPath() public {
        uint256 id = _activate();

        vm.expectRevert(bytes(unicode"Only admin / 仅限 admin"));
        reg.proposeBan(id, keccak256("r"));

        vm.prank(admin);
        reg.proposeBan(id, keccak256("r"));
        assertEq(reg.banEta(id), uint64(block.timestamp) + reg.ADMIN_TIMELOCK());

        vm.prank(admin);
        vm.expectRevert(bytes(unicode"Ban already proposed / 已有待执行的封禁"));
        reg.proposeBan(id, keccak256("r"));

        vm.prank(admin);
        vm.expectRevert(bytes(unicode"Timelock not elapsed / 时锁未到"));
        reg.executeBan(id);

        vm.warp(block.timestamp + 48 hours);
        vm.prank(admin);
        reg.executeBan(id);

        AgentRegistry.Agent memory a = reg.getAgent(id);
        assertEq(uint8(a.status), uint8(AgentRegistry.Status.BANNED));
        assertEq(a.deposit, 0);
        assertEq(reg.forfeitedPending(), 0.02 ether);
        assertFalse(reg.isActive(id));
    }

    function test_Ban_CancelByVetoAndByAdmin() public {
        uint256 id = _activate();
        vm.prank(admin);
        reg.proposeBan(id, keccak256("r"));
        vm.prank(veto);
        reg.cancelBan(id);
        assertEq(reg.banEta(id), 0);

        vm.prank(admin);
        reg.proposeBan(id, keccak256("r"));
        vm.prank(admin);
        reg.cancelBan(id);
        assertEq(reg.banEta(id), 0);

        vm.warp(block.timestamp + 48 hours);
        vm.prank(admin);
        vm.expectRevert(bytes(unicode"No pending ban / 没有待执行的封禁"));
        reg.executeBan(id);
        assertTrue(reg.isActive(id));

        vm.prank(stranger);
        vm.expectRevert(bytes(unicode"Only admin or veto key / 仅限 admin 或 veto 钥"));
        reg.cancelBan(id);
    }

    function test_Ban_VetoKeyBansNow() public {
        uint256 id = _activate();
        vm.expectRevert(bytes(unicode"Only veto key / 仅限 veto 钥"));
        reg.banNow(id, keccak256("r"));

        vm.prank(veto);
        reg.banNow(id, keccak256("r"));
        assertEq(uint8(reg.getAgent(id).status), uint8(AgentRegistry.Status.BANNED));
        assertEq(reg.forfeitedPending(), 0.02 ether);

        vm.prank(veto);
        vm.expectRevert(bytes(unicode"Already banned / 已被封禁"));
        reg.banNow(id, keccak256("r"));
    }

    /// R3：admin / veto 没有任何路径能移动 BNB。
    function test_Admin_CannotMoveFunds() public {
        uint256 id = _activate();
        vm.prank(veto);
        reg.banNow(id, keccak256("r"));
        assertEq(address(reg).balance, 0.02 ether);
        assertEq(reg.forfeitedPending(), 0.02 ether);

        GoodSink sink = new GoodSink();
        reg.setVaultSink(address(sink));
        // 没收的押金只有一个出口：金库。
        reg.sweepForfeited();
        assertEq(address(sink).balance, 0.02 ether);
        assertEq(address(reg).balance, 0);
        assertEq(admin.balance, 0);
        assertEq(veto.balance, 0);
    }

    // ------------------------------------------------------------------
    // vault sink / sweep
    // ------------------------------------------------------------------

    function test_SetVaultSink_OnceAndOnlyDeployer() public {
        GoodSink sink = new GoodSink();

        vm.prank(stranger);
        vm.expectRevert(bytes(unicode"Only deployer / 仅限部署者"));
        reg.setVaultSink(address(sink));

        vm.expectRevert(bytes(unicode"Vault sink has no code / 金库地址没有代码"));
        reg.setVaultSink(stranger);

        reg.setVaultSink(address(sink));
        assertEq(reg.vaultSink(), address(sink));

        vm.expectRevert(bytes(unicode"Vault sink already set / 金库地址已设置"));
        reg.setVaultSink(address(sink));
    }

    function test_Sweep_ForwardsAllGas_And2300Fails() public {
        uint256 id = _register();
        vm.prank(veto);
        reg.banNow(id, keccak256("r"));
        GoodSink sink = new GoodSink();
        reg.setVaultSink(address(sink));

        // 2300 gas（transfer/send 的口径）必然失败 —— 这就是规格禁止它的理由。
        (bool ok,) = payable(address(sink)).call{gas: 2300, value: 1 wei}("");
        assertFalse(ok, "2300 gas should not be enough");

        reg.sweepForfeited();
        assertEq(address(sink).balance, 0.02 ether);
        assertEq(sink.hits(), 1);
        assertEq(reg.forfeitedPending(), 0);

        vm.expectRevert(bytes(unicode"Nothing to sweep / 没有可清扫的押金"));
        reg.sweepForfeited();
    }

    function test_Sweep_RevertsWhenSinkRejects() public {
        uint256 id = _register();
        vm.prank(veto);
        reg.banNow(id, keccak256("r"));
        BadSink bad = new BadSink();
        reg.setVaultSink(address(bad));
        vm.expectRevert(bytes(unicode"Vault sink rejected / 金库拒收"));
        reg.sweepForfeited();
        assertEq(reg.forfeitedPending(), 0.02 ether, "state must roll back");
    }

    function test_Sweep_RevertsWithoutSink() public {
        uint256 id = _register();
        vm.prank(veto);
        reg.banNow(id, keccak256("r"));
        vm.expectRevert(bytes(unicode"Vault sink not set / 金库地址未设置"));
        reg.sweepForfeited();
    }

    function test_Sweep_RevertsOnLowGas() public {
        uint256 id = _register();
        vm.prank(veto);
        reg.banNow(id, keccak256("r"));
        GoodSink sink = new GoodSink();
        reg.setVaultSink(address(sink));
        vm.expectRevert(bytes(unicode"Not enough gas / gas 不足"));
        reg.sweepForfeited{gas: 120_000}();
    }

    // ------------------------------------------------------------------
    // views
    // ------------------------------------------------------------------

    function test_Views() public {
        assertEq(reg.totalAgents(), 0);
        uint256 id = _register();
        assertEq(reg.currentEpoch(), uint64(block.timestamp / 86400));
        uint256[] memory recent = reg.recentAgents(5);
        assertEq(recent.length, 1);
        assertEq(recent[0], id);
        vm.expectRevert(bytes(unicode"Index out of range / 下标越界"));
        reg.agentAt(1);
    }
}
