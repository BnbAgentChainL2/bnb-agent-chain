// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";

import {L2Bridge} from "../src/layer/L2Bridge.sol";
import {L2Gate} from "../src/layer/L2Gate.sol";
import {AgentBook} from "../src/layer/AgentBook.sol";

/// @dev An `agentWallet` that refuses BAC. attack-funds #12: it must never be able to wedge the
///      relayer's strictly single-threaded outbox.
contract RejectingWallet {
    receive() external payable {
        revert("nope");
    }

    function exitVia(address bridge, address bscRecipient, uint256 amount) external returns (uint256) {
        return L2Bridge(payable(bridge)).exit{value: amount}(bscRecipient);
    }

    function fund() external payable {}
}

/// @notice GROUP E — the layer's three genesis contracts (01-CONTRACT-SPEC §8, 02-CHAIN-SPEC §2/§3).
///
/// @dev Every test runs against the contracts AT THEIR GENESIS ADDRESSES: the runtime bytecode is
///      lifted off a throwaway deployment with `address(x).code` and `vm.etch`-ed to
///      0x…0101 / 0x…0102 / 0x…0103, exactly the way `chain/scripts/build-genesis.sh` fills
///      `genesis.alloc`. That makes the etched instances carry zero storage, which is the property
///      the genesis file depends on, and it exercises the hard-wired cross-references between them.
contract LayerTest is Test {
    // ------------------------------------------------------------------------ genesis addresses ---

    address internal constant L2_BRIDGE = 0x0000000000000000000000000000000000000101;
    address internal constant L2_GATE = 0x0000000000000000000000000000000000000102;
    address internal constant AGENT_BOOK = 0x0000000000000000000000000000000000000103;
    address internal constant FEE_SINK = 0x000000000000000000000000000000000000dEaD;

    /// @dev 1e27 − OPERATOR_FLOAT (02-CHAIN-SPEC §2).
    uint256 internal constant GENESIS_FLOAT = 999_999_000_000_000_000_000_000_000;

    // ---------------------------------------------------------------------------------- fixture ---

    L2Bridge internal bridge;
    L2Gate internal gate;
    AgentBook internal book;

    address internal constant BSC_BRIDGE = address(0xBAC1BA1D6E);

    uint256 internal rotationPk = 0xC01D;
    address internal rotationSigner;

    address internal relayer = address(0xBEEF);
    address internal newRelayer = address(0xCAFE);

    address internal agentWallet = address(0xA11CE);
    address internal bannedWallet = address(0xB0B);
    address internal stranger = address(0x5EED);

    uint8 internal constant STATUS_ACTIVE = 2;
    uint8 internal constant STATUS_BANNED = 4;

    // ------------------------------------------------------------------------------ event decls ---

    event CreditsMinted(bytes32 indexed depositId, uint256 indexed agentId, address indexed to, uint256 amount);
    event CreditsWithdrawn(address indexed to, uint256 amount);
    event ExitBurned(
        uint256 indexed exitId, uint256 indexed agentId, address indexed bscRecipient, uint256 amount, uint64 epoch
    );
    event FloatBurned(address indexed from, uint256 amount);
    event RelayerRotated(address indexed from, address indexed to, uint256 nonce);
    event AgentSynced(uint256 indexed agentId, address indexed wallet, uint8 status, uint64 bscBlock);

    function setUp() public {
        rotationSigner = vm.addr(rotationPk);

        // Deploy once on a throwaway address, then paste the runtime bytecode at the fixed genesis
        // addresses — the exact shape of 02-CHAIN-SPEC §3.3 steps 2-5.
        L2Bridge bridgeImpl = new L2Bridge(BSC_BRIDGE, rotationSigner, relayer);
        L2Gate gateImpl = new L2Gate();
        AgentBook bookImpl = new AgentBook();

        vm.etch(L2_BRIDGE, address(bridgeImpl).code);
        vm.etch(L2_GATE, address(gateImpl).code);
        vm.etch(AGENT_BOOK, address(bookImpl).code);

        bridge = L2Bridge(payable(L2_BRIDGE));
        gate = L2Gate(L2_GATE);
        book = AgentBook(AGENT_BOOK);

        vm.deal(L2_BRIDGE, GENESIS_FLOAT);
        vm.deal(address(this), 100 ether);

        // Anything well past 0 so `floor(ts / 86400)` is a realistic epoch number.
        vm.warp(1_790_000_000);
    }

    // =============================================================== stateless construction (§8) ===

    /// @notice The genesis file carries NO storage slots, so the contracts must be stateless at
    ///         construction: every configuration value is an immutable or a constant.
    function test_statelessConstruction_noNonZeroSlots() public {
        L2Bridge freshBridge = new L2Bridge(BSC_BRIDGE, rotationSigner, relayer);
        L2Gate freshGate = new L2Gate();
        AgentBook freshBook = new AgentBook();

        _assertAllSlotsZero(address(freshBridge), "L2Bridge (fresh)");
        _assertAllSlotsZero(address(freshGate), "L2Gate (fresh)");
        _assertAllSlotsZero(address(freshBook), "AgentBook (fresh)");

        // The etched genesis instances: same property, now at the addresses genesis will use.
        _assertAllSlotsZero(L2_BRIDGE, "L2Bridge @0x101");
        _assertAllSlotsZero(L2_GATE, "L2Gate @0x102");
        _assertAllSlotsZero(AGENT_BOOK, "AgentBook @0x103");
    }

    /// @notice Storage writes only ever happen at runtime, never during construction.
    function test_statelessConstruction_constructorWritesNoSlots() public {
        vm.record();
        L2Bridge freshBridge = new L2Bridge(BSC_BRIDGE, rotationSigner, relayer);
        (, bytes32[] memory bridgeWrites) = vm.accesses(address(freshBridge));
        assertEq(bridgeWrites.length, 0, "L2Bridge constructor wrote storage");

        vm.record();
        L2Gate freshGate = new L2Gate();
        (, bytes32[] memory gateWrites) = vm.accesses(address(freshGate));
        assertEq(gateWrites.length, 0, "L2Gate constructor wrote storage");

        vm.record();
        AgentBook freshBook = new AgentBook();
        (, bytes32[] memory bookWrites) = vm.accesses(address(freshBook));
        assertEq(bookWrites.length, 0, "AgentBook constructor wrote storage");
    }

    /// @notice Genesis read-back (02-CHAIN-SPEC §3.3 step 7): every view returns its expected default
    ///         from runtime bytecode alone.
    function test_genesisReadBack() public view {
        assertEq(bridge.relayer(), relayer, "relayer()");
        assertEq(bridge.reserve(), GENESIS_FLOAT, "reserve()");
        assertEq(bridge.rotationNonce(), 0, "rotationNonce()");
        assertEq(bridge.totalCredited(), 0, "totalCredited()");
        assertEq(bridge.totalExited(), 0, "totalExited()");
        assertEq(bridge.totalBurnedFloat(), 0, "totalBurnedFloat()");
        assertEq(uint256(bridge.exitCount()), 0, "exitCount()");
        assertEq(L2_BRIDGE.balance, GENESIS_FLOAT, "genesis balance");

        assertEq(gate.isAdmitted(agentWallet), false, "isAdmitted()");
        assertEq(gate.agentIdOf(agentWallet), 0, "agentIdOf()");
        assertEq(uint256(gate.statusOf(agentWallet)), 0, "statusOf()");

        assertEq(uint256(book.actionCount()), 0, "actionCount()");
        assertEq(uint256(book.countInEpoch(agentWallet, 0)), 0, "countInEpoch()");
    }

    /// @notice The constructor arguments survive the bytecode lift as immutables, and no immutable
    ///         depends on the deploy address (which would be the throwaway anvil address).
    function test_immutablesSurviveTheBytecodeLift() public view {
        assertEq(bridge.BSC_BRIDGE(), BSC_BRIDGE, "BSC_BRIDGE");
        assertEq(bridge.ROTATION_SIGNER(), rotationSigner, "ROTATION_SIGNER");
        assertEq(bridge.GENESIS_RELAYER(), relayer, "GENESIS_RELAYER");
        assertEq(bridge.BSC_CHAIN_ID(), 56, "BSC_CHAIN_ID");
        assertEq(bridge.LAYER_CHAIN_ID(), 56777, "LAYER_CHAIN_ID");
        assertEq(uint256(bridge.EPOCH()), 86400, "EPOCH");
        assertEq(bridge.L2_GATE(), L2_GATE, "L2_GATE");

        // The EIP-712 domain is computed at runtime, so it binds to 0x…0101, not to the anvil address.
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("BNB Agent Chain L2Bridge")),
                keccak256(bytes("1")),
                block.chainid,
                L2_BRIDGE
            )
        );
        assertEq(bridge.domainSeparator(), expected, "domainSeparator binds to the genesis address");
    }

    /// @notice The exit leaf is byte-identical to the BSC-side `EXIT_TYPEHASH` layout and has no
    ///         `epoch` field (attack-funds #13).
    function test_exitLeafMatchesBscLayout() public view {
        bytes32 typeHash = keccak256(
            "Exit(uint256 exitId,uint256 agentId,address to,uint256 credits,uint256 layerChainId,address bridge)"
        );
        assertEq(bridge.EXIT_TYPEHASH(), typeHash, "EXIT_TYPEHASH");
        assertEq(
            bridge.exitLeaf(41, 17, address(0xAbc), 20_000 ether),
            keccak256(
                abi.encode(
                    typeHash,
                    uint256(41),
                    uint256(17),
                    address(0xAbc),
                    uint256(20_000 ether),
                    uint256(56777),
                    BSC_BRIDGE
                )
            ),
            "leaf layout"
        );
    }

    // ====================================================================== credit accounting ======

    function test_credit_onlyRelayer() public {
        vm.prank(stranger);
        vm.expectRevert(unicode"Only relayer / 仅限中继调用");
        bridge.credit(keccak256("d1"), 17, agentWallet, 1 ether);
    }

    function test_credit_isIdempotentOnDepositId() public {
        bytes32 depositId = keccak256("d1");
        vm.prank(relayer);
        bridge.credit(depositId, 17, agentWallet, 5 ether);

        assertTrue(bridge.seen(depositId), "seen");
        assertEq(bridge.creditable(agentWallet), 5 ether, "creditable");
        assertEq(bridge.totalCredited(), 5 ether, "totalCredited");

        vm.prank(relayer);
        vm.expectRevert(unicode"Deposit already credited / 该存款已入账");
        bridge.credit(depositId, 17, agentWallet, 5 ether);

        assertEq(bridge.totalCredited(), 5 ether, "totalCredited unchanged");
    }

    /// @notice attack-funds #12: a wallet whose `receive()` reverts must not be able to fail `credit`.
    function test_credit_cannotBeWedgedByARevertingWallet() public {
        RejectingWallet bad = new RejectingWallet();

        vm.prank(relayer);
        bridge.credit(keccak256("bad"), 9, address(bad), 3 ether);
        assertEq(bridge.creditable(address(bad)), 3 ether, "credited anyway");

        // The failure is isolated to delivery, not to the relayer's queue.
        vm.expectRevert(unicode"Credit transfer failed / 积分转账失败");
        bridge.withdrawCredits(address(bad));

        // And the next agent's credit sails straight through.
        vm.prank(relayer);
        bridge.credit(keccak256("good"), 17, agentWallet, 2 ether);
        assertEq(bridge.creditable(agentWallet), 2 ether, "unaffected");
    }

    function test_withdrawCredits_isPermissionlessAndMovesTheFloat() public {
        vm.prank(relayer);
        bridge.credit(keccak256("d1"), 17, agentWallet, 7 ether);

        uint256 reserveBefore = bridge.reserve();

        // A third party delivers on the agent's behalf.
        vm.expectEmit(true, false, false, true, L2_BRIDGE);
        emit CreditsWithdrawn(agentWallet, 7 ether);
        vm.prank(stranger);
        uint256 amount = bridge.withdrawCredits(agentWallet);

        assertEq(amount, 7 ether, "returned amount");
        assertEq(agentWallet.balance, 7 ether, "delivered");
        assertEq(bridge.creditable(agentWallet), 0, "zeroed");
        assertEq(bridge.reserve(), reserveBefore - 7 ether, "reserve shrank by exactly the amount");

        vm.expectRevert(unicode"Nothing to withdraw / 没有可提取的积分");
        bridge.withdrawCredits(agentWallet);
    }

    function test_credit_rejectsZeroRecipientAndZeroAmount() public {
        vm.prank(relayer);
        vm.expectRevert(unicode"Zero recipient / 收款地址为零");
        bridge.credit(keccak256("a"), 1, address(0), 1 ether);

        vm.prank(relayer);
        vm.expectRevert(unicode"Amount must be positive / 金额必须为正");
        bridge.credit(keccak256("b"), 1, agentWallet, 0);
    }

    // ========================================================================= exit accounting ======

    function test_exit_accountingAndEventFields() public {
        _sync(17, agentWallet, STATUS_ACTIVE, 100);
        _credit(keccak256("d1"), 17, agentWallet, 10 ether);
        bridge.withdrawCredits(agentWallet);

        uint256 reserveBefore = bridge.reserve();
        uint64 epoch = uint64(block.timestamp / 86400);

        vm.expectEmit(true, true, true, true, L2_BRIDGE);
        emit ExitBurned(1, 17, address(0xB5C), 4 ether, epoch);
        vm.prank(agentWallet);
        uint256 exitId = bridge.exit{value: 4 ether}(address(0xB5C));

        assertEq(exitId, 1, "exitId");
        assertEq(uint256(bridge.exitCount()), 1, "exitCount");
        assertEq(bridge.totalExited(), 4 ether, "totalExited");
        // "Burning" is a transfer back under this contract's name.
        assertEq(bridge.reserve(), reserveBefore + 4 ether, "reserve grew by the burned amount");

        vm.prank(agentWallet);
        uint256 second = bridge.exit{value: 1 ether}(address(0xB5C));
        assertEq(second, 2, "exitId increments");
        assertEq(bridge.totalExited(), 5 ether, "totalExited accumulates");
    }

    /// @notice G11: exit is the one action no status may gate. A BANNED agent still exits, and still
    ///         exits under its own agentId.
    function test_exit_isNeverGatedByStatus() public {
        _sync(42, bannedWallet, STATUS_BANNED, 100);
        _credit(keccak256("d2"), 42, bannedWallet, 3 ether);
        vm.prank(stranger);
        bridge.withdrawCredits(bannedWallet);

        assertFalse(gate.isAdmitted(bannedWallet), "banned is not admitted");

        uint64 epoch = uint64(block.timestamp / 86400);
        vm.expectEmit(true, true, true, true, L2_BRIDGE);
        emit ExitBurned(1, 42, address(0xB5C), 3 ether, epoch);
        vm.prank(bannedWallet);
        bridge.exit{value: 3 ether}(address(0xB5C));
    }

    /// @notice attack-funds #4: `agentId` comes from the gate's table, never from the caller. There is
    ///         no argument through which agent A could exit under agent B's id.
    function test_exit_agentIdIsNotCallerSupplied() public {
        _sync(17, agentWallet, STATUS_ACTIVE, 100);
        _sync(42, bannedWallet, STATUS_ACTIVE, 100);

        vm.deal(bannedWallet, 1 ether);
        uint64 epoch = uint64(block.timestamp / 86400);

        // bannedWallet exits; the leaf must carry ITS id (42), never 17.
        vm.recordLogs();
        vm.prank(bannedWallet);
        bridge.exit{value: 1 ether}(address(0xB5C));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 1, "one ExitBurned");
        assertEq(uint256(logs[0].topics[2]), 42, "agentId is the caller's own");
        (, uint64 loggedEpoch) = abi.decode(logs[0].data, (uint256, uint64));
        assertEq(uint256(loggedEpoch), uint256(epoch), "epoch");

        // The ABI has no agentId parameter at all: there is only `exit(address)`.
        assertTrue(bytes4(keccak256("exit(address)")) == L2Bridge.exit.selector, "exit takes only a bscRecipient");
    }

    function test_exit_unregisteredWalletGetsAgentIdZero() public {
        vm.deal(stranger, 1 ether);
        vm.expectEmit(true, true, true, true, L2_BRIDGE);
        emit ExitBurned(1, 0, address(0xB5C), 1 ether, uint64(block.timestamp / 86400));
        vm.prank(stranger);
        bridge.exit{value: 1 ether}(address(0xB5C));
    }

    function test_exit_rejectsZeroValueAndZeroRecipient() public {
        vm.deal(agentWallet, 1 ether);
        vm.prank(agentWallet);
        vm.expectRevert(unicode"Exit amount must be positive / 退出金额必须为正");
        bridge.exit{value: 0}(address(0xB5C));

        vm.prank(agentWallet);
        vm.expectRevert(unicode"Zero BSC recipient / BSC 收款地址为零");
        bridge.exit{value: 1 ether}(address(0));
    }

    function test_exit_rejectsBackwardsTimestamps() public {
        vm.deal(agentWallet, 3 ether);
        vm.warp(1_790_000_000 + 86400 * 3);
        vm.prank(agentWallet);
        bridge.exit{value: 1 ether}(address(0xB5C));

        vm.warp(1_790_000_000);
        vm.prank(agentWallet);
        vm.expectRevert(unicode"Timestamp went backwards / 时间戳回退");
        bridge.exit{value: 1 ether}(address(0xB5C));
    }

    /// @notice A contract whose `receive()` reverts can still exit: exit never pushes value out.
    function test_exit_worksForAContractThatRefusesBac() public {
        RejectingWallet bad = new RejectingWallet();
        _sync(9, address(bad), STATUS_BANNED, 100);
        bad.fund{value: 2 ether}();

        uint256 exitId = bad.exitVia(L2_BRIDGE, address(0xB5C), 2 ether);
        assertEq(exitId, 1, "exited");
        assertEq(bridge.totalExited(), 2 ether, "totalExited");
    }

    // ================================================================== refund / burnFloat path ======

    /// @notice The refund path for a credited-but-undeliverable balance: the value never left the
    ///         bridge, so once the agent's wallet is deliverable the same permissionless
    ///         `withdrawCredits` settles it. Nothing is ever stranded and `totalCredited` never has
    ///         to be walked back.
    function test_refundPath_creditSurvivesAFailedDeliveryAndSettlesLater() public {
        RejectingWallet bad = new RejectingWallet();
        _credit(keccak256("d3"), 9, address(bad), 6 ether);

        uint256 reserveBefore = bridge.reserve();
        vm.expectRevert(unicode"Credit transfer failed / 积分转账失败");
        bridge.withdrawCredits(address(bad));

        // The failed delivery moved nothing at all.
        assertEq(bridge.creditable(address(bad)), 6 ether, "still owed");
        assertEq(bridge.reserve(), reserveBefore, "reserve untouched");

        // Same claim, deliverable recipient after the relayer re-syncs the wallet on BSC.
        _credit(keccak256("d4"), 9, agentWallet, 6 ether);
        bridge.withdrawCredits(agentWallet);
        assertEq(agentWallet.balance, 6 ether, "settled");
    }

    function test_burnFloat_shrinksSupplyAndProducesNoExitLeaf() public {
        vm.deal(stranger, 5 ether);
        uint256 reserveBefore = bridge.reserve();

        vm.recordLogs();
        vm.expectEmit(true, false, false, true, L2_BRIDGE);
        emit FloatBurned(stranger, 5 ether);
        vm.prank(stranger);
        bridge.burnFloat{value: 5 ether}();

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(
                logs[i].topics[0] != keccak256("ExitBurned(uint256,uint256,address,uint256,uint64)"),
                "burnFloat must not produce an exit leaf"
            );
        }

        assertEq(bridge.totalBurnedFloat(), 5 ether, "totalBurnedFloat");
        assertEq(bridge.totalExited(), 0, "not an exit");
        assertEq(uint256(bridge.exitCount()), 0, "no exit id consumed");
        assertEq(bridge.reserve(), reserveBefore + 5 ether, "value stays under the bridge's name");

        vm.prank(stranger);
        vm.expectRevert(unicode"Burn amount must be positive / 销毁金额必须为正");
        bridge.burnFloat{value: 0}();
    }

    /// @notice C7: anyone may transfer straight into the bridge and nothing breaks.
    function test_plainTransferIsAcceptedAndWritesNoState() public {
        vm.deal(stranger, 1 ether);
        uint256 reserveBefore = bridge.reserve();

        vm.prank(stranger);
        (bool ok,) = L2_BRIDGE.call{value: 1 ether}("");
        assertTrue(ok, "plain transfer accepted");

        assertEq(bridge.reserve(), reserveBefore + 1 ether, "reserve");
        assertEq(bridge.totalBurnedFloat(), 0, "not counted as a burn");
        assertEq(bridge.totalCredited(), 0, "not counted as a credit");
    }

    // ================================================================= relayer rotation (G12) ======

    function test_rotateRelayer_permissionlessSubmissionColdKeyAuthority() public {
        bytes memory sig = _signRotation(newRelayer, 0);

        // Anybody may submit; the old relayer is not consulted.
        vm.expectEmit(true, true, false, true, L2_BRIDGE);
        emit RelayerRotated(relayer, newRelayer, 0);
        vm.prank(stranger);
        bridge.rotateRelayer(newRelayer, 0, sig);

        assertEq(bridge.relayer(), newRelayer, "rotated");
        assertEq(bridge.rotationNonce(), 1, "nonce advanced");

        // The old relayer immediately loses both relayer-gated entry points.
        vm.prank(relayer);
        vm.expectRevert(unicode"Only relayer / 仅限中继调用");
        bridge.credit(keccak256("x"), 1, agentWallet, 1 ether);

        vm.prank(relayer);
        vm.expectRevert(unicode"Only relayer / 仅限中继调用");
        gate.applySync(17, agentWallet, STATUS_ACTIVE, 100);

        // The new one has them.
        vm.prank(newRelayer);
        bridge.credit(keccak256("x"), 1, agentWallet, 1 ether);
        vm.prank(newRelayer);
        gate.applySync(17, agentWallet, STATUS_ACTIVE, 100);
        assertTrue(gate.isAdmitted(agentWallet), "gate follows the same rotation");
    }

    function test_rotateRelayer_rejectsWrongSignerReplayAndNonceSkew() public {
        // Wrong signer.
        bytes32 digest = _rotationDigest(newRelayer, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(0xBAD), digest);
        vm.expectRevert(unicode"Not rotation signer / 不是轮换签名者");
        bridge.rotateRelayer(newRelayer, 0, abi.encodePacked(r, s, v));

        // Wrong nonce.
        bytes memory nonceOneSig = _signRotation(newRelayer, 1);
        vm.expectRevert(unicode"Bad rotation nonce / 轮换随机数不对");
        bridge.rotateRelayer(newRelayer, 1, nonceOneSig);

        // Good.
        bytes memory sig = _signRotation(newRelayer, 0);
        bridge.rotateRelayer(newRelayer, 0, sig);

        // Replay of the very same message.
        vm.expectRevert(unicode"Relayer unchanged / 中继未变化");
        bridge.rotateRelayer(newRelayer, 0, sig);

        // Replaying the consumed nonce against a different target.
        bytes memory staleSig = _signRotation(address(0xF00D), 0);
        vm.expectRevert(unicode"Bad rotation nonce / 轮换随机数不对");
        bridge.rotateRelayer(address(0xF00D), 0, staleSig);

        // Zero address.
        vm.expectRevert(unicode"Zero relayer / 中继地址为零");
        bridge.rotateRelayer(address(0), 1, sig);

        // Malformed signature.
        vm.expectRevert(unicode"Bad signature length / 签名长度不对");
        bridge.rotateRelayer(address(0xF00D), 1, hex"1234");
    }

    // ============================================================================ L2Gate mirror ======

    function test_applySync_onlyRelayerAndMirrorsStatus() public {
        vm.prank(stranger);
        vm.expectRevert(unicode"Only relayer / 仅限中继调用");
        gate.applySync(17, agentWallet, STATUS_ACTIVE, 100);

        vm.expectEmit(true, true, false, true, L2_GATE);
        emit AgentSynced(17, agentWallet, STATUS_ACTIVE, 100);
        vm.prank(relayer);
        gate.applySync(17, agentWallet, STATUS_ACTIVE, 100);

        assertEq(gate.agentIdOf(agentWallet), 17, "agentIdOf");
        assertEq(uint256(gate.statusOf(agentWallet)), uint256(STATUS_ACTIVE), "statusOf");
        assertTrue(gate.isAdmitted(agentWallet), "isAdmitted");

        // BANNED still resolves to the agentId (so exits stay attributable) but is not admitted.
        _sync(17, agentWallet, STATUS_BANNED, 101);
        assertEq(gate.agentIdOf(agentWallet), 17, "id survives a ban");
        assertFalse(gate.isAdmitted(agentWallet), "ban closes publishing");
    }

    function test_applySync_rejectsStaleAndCrossBoundWallets() public {
        _sync(17, agentWallet, STATUS_ACTIVE, 200);

        vm.prank(relayer);
        vm.expectRevert(unicode"Stale sync / 同步消息过期");
        gate.applySync(17, agentWallet, STATUS_BANNED, 199);

        vm.prank(relayer);
        vm.expectRevert(unicode"Wallet bound to another agent / 钱包已绑定别的 agent");
        gate.applySync(42, agentWallet, STATUS_ACTIVE, 300);

        vm.prank(relayer);
        vm.expectRevert(unicode"Zero agent id / agent 编号为零");
        gate.applySync(0, agentWallet, STATUS_ACTIVE, 300);

        vm.prank(relayer);
        vm.expectRevert(unicode"Unknown agent status / 未知的 agent 状态");
        gate.applySync(43, stranger, 6, 300);
    }

    function test_applySync_walletRotationUnbindsTheOldWallet() public {
        _sync(17, agentWallet, STATUS_ACTIVE, 200);
        _sync(17, bannedWallet, STATUS_ACTIVE, 300);

        assertEq(gate.agentIdOf(bannedWallet), 17, "new wallet bound");
        assertEq(gate.agentIdOf(agentWallet), 0, "old wallet unbound");
        assertEq(gate.walletOf(17), bannedWallet, "walletOf");
        assertEq(uint256(gate.syncedAt(17)), 300, "syncedAt");
    }

    // =========================================================================== AgentBook (§8.3) ===

    function test_announce_requiresAdmissionFeeAndSummaryLength() public {
        vm.deal(agentWallet, 1 ether);
        bytes32 join = book.KIND_JOIN();

        vm.prank(agentWallet);
        vm.expectRevert(unicode"Agent not admitted / agent 未获准入");
        book.announce{value: 0.001 ether}(join, address(0), bytes32(0), "hi", "");

        _sync(17, agentWallet, STATUS_ACTIVE, 100);

        vm.prank(agentWallet);
        vm.expectRevert(unicode"Publish fee too low / 发布费不足");
        book.announce{value: 0.0009 ether}(join, address(0), bytes32(0), "hi", "");

        string memory tooLong = new string(121);
        vm.prank(agentWallet);
        vm.expectRevert(unicode"Summary too long / 摘要过长");
        book.announce{value: 0.001 ether}(join, address(0), bytes32(0), tooLong, "");

        // 120 bytes is fine.
        string memory exactly120 = new string(120);
        vm.prank(agentWallet);
        uint64 seq = book.announce{value: 0.001 ether}(join, address(0), bytes32(0), exactly120, "");
        assertEq(uint256(seq), 1, "seq");
    }

    function test_announce_burnsTheWholeFeeToFeeSink() public {
        _sync(17, agentWallet, STATUS_ACTIVE, 100);
        vm.deal(agentWallet, 1 ether);

        uint256 sinkBefore = FEE_SINK.balance;
        bytes32 publishKind = book.KIND_PUBLISH();
        vm.prank(agentWallet);
        book.announce{value: 0.01 ether}(publishKind, address(0), bytes32(0), "x", "");

        assertEq(FEE_SINK.balance, sinkBefore + 0.01 ether, "whole value burned");
        assertEq(AGENT_BOOK.balance, 0, "book never holds value");
    }

    /// @notice The publish cap: 20 per address per epoch, and it resets on the epoch boundary.
    function test_announce_publishCapIsTwentyPerEpochAndResets() public {
        _sync(17, agentWallet, STATUS_ACTIVE, 100);
        vm.deal(agentWallet, 100 ether);

        assertEq(uint256(book.MAX_PER_EPOCH()), 20, "MAX_PER_EPOCH");
        uint64 epoch = uint64(block.timestamp / 86400);
        bytes32 noteKind = book.KIND_NOTE();

        for (uint256 i = 0; i < 20; i++) {
            vm.prank(agentWallet);
            book.announce{value: 0.001 ether}(noteKind, address(0), bytes32(0), "x", "");
        }
        assertEq(uint256(book.countInEpoch(agentWallet, epoch)), 20, "cap consumed");

        vm.prank(agentWallet);
        vm.expectRevert(unicode"Publish cap reached / 已达本纪元发布上限");
        book.announce{value: 0.001 ether}(noteKind, address(0), bytes32(0), "x", "");

        // A second agent in the same epoch is unaffected: the cap is per address.
        _sync(42, bannedWallet, STATUS_ACTIVE, 100);
        vm.deal(bannedWallet, 1 ether);
        vm.prank(bannedWallet);
        book.announce{value: 0.001 ether}(noteKind, address(0), bytes32(0), "x", "");

        // Next epoch, the first agent is free again.
        vm.warp(block.timestamp + 86400);
        vm.prank(agentWallet);
        uint64 seq = book.announce{value: 0.001 ether}(noteKind, address(0), bytes32(0), "x", "");
        assertEq(uint256(seq), 22, "seq is global and monotonic");
        assertEq(uint256(book.countInEpoch(agentWallet, epoch + 1)), 1, "new epoch bucket");
    }

    function test_heartbeatNote_requiresAnAgentWalletAndSharesTheCap() public {
        vm.prank(stranger);
        vm.expectRevert(unicode"Not an agent wallet / 不是 agent 钱包");
        book.heartbeatNote(20718, bytes32("alive"));

        _sync(17, agentWallet, STATUS_ACTIVE, 100);
        vm.recordLogs();
        vm.prank(agentWallet);
        book.heartbeatNote(20718, bytes32("alive"));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs[0].topics[0], keccak256("Note(uint256,uint64,bytes32)"), "Note signature");
        assertEq(uint256(logs[0].topics[1]), 17, "agentId");
        assertEq(uint256(logs[0].topics[2]), 20718, "epoch");
        assertEq(abi.decode(logs[0].data, (bytes32)), bytes32("alive"), "note");

        assertEq(uint256(book.countInEpoch(agentWallet, uint64(block.timestamp / 86400))), 1, "consumes the cap");
    }

    // ================================================ canonical event schema (03-INTERFACES §4) ====

    /// @notice The explorer's whole feed is decoded from this one event. Topics and decoded fields
    ///         must match 03-INTERFACES §4.1 verbatim.
    function test_actionEventSchemaMatchesInterfacesSpecVerbatim() public {
        _sync(17, agentWallet, STATUS_ACTIVE, 100);
        vm.deal(agentWallet, 1 ether);

        bytes32 kind = keccak256("PUBLISH");
        address subject = address(0x5B1EC7);
        bytes32 contentHash = keccak256("content");
        string memory summary = unicode"我造了一个池子";
        string memory uri = "ipfs://bafy";
        uint64 epoch = uint64(block.timestamp / 86400);

        vm.recordLogs();
        vm.prank(agentWallet);
        book.announce{value: 0.001 ether}(kind, subject, contentHash, summary, uri);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        Vm.Log memory a = logs[0];
        assertEq(a.emitter, AGENT_BOOK, "emitted by AgentBook @0x103");

        // topic0 — the signature string is copied character for character from §4.1.
        assertEq(
            a.topics[0],
            keccak256("Action(uint256,bytes32,address,address,bytes32,string,string,uint64,uint64)"),
            "Action topic0"
        );
        assertEq(a.topics.length, 4, "exactly three indexed fields");

        // topic1..3 — agentId, kind, subject, in that order.
        assertEq(uint256(a.topics[1]), 17, "topic1 = agentId (resolved by L2Gate)");
        assertEq(a.topics[2], kind, "topic2 = kind");
        assertEq(address(uint160(uint256(a.topics[3]))), subject, "topic3 = subject");

        // data — actor, contentHash, summary, uri, seq, epoch.
        (
            address actor,
            bytes32 decodedHash,
            string memory decodedSummary,
            string memory decodedUri,
            uint64 seq,
            uint64 decodedEpoch
        ) = abi.decode(a.data, (address, bytes32, string, string, uint64, uint64));

        assertEq(actor, agentWallet, "actor = msg.sender");
        assertEq(decodedHash, contentHash, "contentHash");
        assertEq(decodedSummary, summary, "summary");
        assertEq(decodedUri, uri, "uri");
        assertEq(uint256(seq), 1, "seq");
        assertEq(uint256(decodedEpoch), uint256(epoch), "epoch");
    }

    /// @notice The 11 frozen `kind` constants the indexer and the SDK share (03-INTERFACES §4.2).
    function test_kindConstantSetMatchesInterfacesSpec() public view {
        assertEq(book.KIND_JOIN(), keccak256("JOIN"), "JOIN");
        assertEq(book.KIND_DEPLOY(), keccak256("DEPLOY"), "DEPLOY");
        assertEq(book.KIND_PUBLISH(), keccak256("PUBLISH"), "PUBLISH");
        assertEq(book.KIND_SERVICE(), keccak256("SERVICE"), "SERVICE");
        assertEq(book.KIND_TRADE(), keccak256("TRADE"), "TRADE");
        assertEq(book.KIND_LIST(), keccak256("LIST"), "LIST");
        assertEq(book.KIND_POOL(), keccak256("POOL"), "POOL");
        assertEq(book.KIND_STRATEGY(), keccak256("STRATEGY"), "STRATEGY");
        assertEq(book.KIND_MESSAGE(), keccak256("MESSAGE"), "MESSAGE");
        assertEq(book.KIND_CLAIM(), keccak256("CLAIM"), "CLAIM");
        assertEq(book.KIND_NOTE(), keccak256("NOTE"), "NOTE");
    }

    /// @notice The five `L2Bridge` events and the one `L2Gate` event the indexer subscribes to.
    function test_bridgeAndGateEventSignatures() public {
        _sync(17, agentWallet, STATUS_ACTIVE, 100);

        vm.recordLogs();
        vm.prank(relayer);
        bridge.credit(keccak256("d1"), 17, agentWallet, 2 ether);
        bridge.withdrawCredits(agentWallet);
        vm.prank(agentWallet);
        bridge.exit{value: 1 ether}(address(0xB5C));
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        bridge.burnFloat{value: 1 ether}();
        bridge.rotateRelayer(newRelayer, 0, _signRotation(newRelayer, 0));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs[0].topics[0], keccak256("CreditsMinted(bytes32,uint256,address,uint256)"), "CreditsMinted");
        assertEq(logs[0].topics[1], keccak256("d1"), "depositId is the relayer keccak key");
        assertEq(uint256(logs[0].topics[2]), 17, "agentId");
        assertEq(address(uint160(uint256(logs[0].topics[3]))), agentWallet, "to");
        assertEq(abi.decode(logs[0].data, (uint256)), 2 ether, "amount");

        assertEq(logs[1].topics[0], keccak256("CreditsWithdrawn(address,uint256)"), "CreditsWithdrawn");

        assertEq(logs[2].topics[0], keccak256("ExitBurned(uint256,uint256,address,uint256,uint64)"), "ExitBurned");
        assertEq(uint256(logs[2].topics[1]), 1, "exitId");
        assertEq(uint256(logs[2].topics[2]), 17, "agentId");
        assertEq(address(uint160(uint256(logs[2].topics[3]))), address(0xB5C), "bscRecipient");
        (uint256 amount, uint64 exitEpoch) = abi.decode(logs[2].data, (uint256, uint64));
        assertEq(amount, 1 ether, "amount");
        assertEq(uint256(exitEpoch), block.timestamp / 86400, "epoch");

        assertEq(logs[3].topics[0], keccak256("FloatBurned(address,uint256)"), "FloatBurned");
        assertEq(logs[4].topics[0], keccak256("RelayerRotated(address,address,uint256)"), "RelayerRotated");

        vm.recordLogs();
        vm.prank(newRelayer);
        gate.applySync(43, stranger, STATUS_ACTIVE, 400);
        Vm.Log[] memory gateLogs = vm.getRecordedLogs();
        assertEq(gateLogs[0].topics[0], keccak256("AgentSynced(uint256,address,uint8,uint64)"), "AgentSynced");
        assertEq(gateLogs[0].emitter, L2_GATE, "emitted by L2Gate @0x102");
        (uint8 status, uint64 bscBlock) = abi.decode(gateLogs[0].data, (uint8, uint64));
        assertEq(uint256(status), uint256(STATUS_ACTIVE), "status");
        assertEq(uint256(bscBlock), 400, "bscBlock");
    }

    // ==================================================================================== fuzz ======

    /// @notice Solvency of the layer float under arbitrary credit/exit/burn traffic:
    ///         reserve == GENESIS_FLOAT - delivered + exited + burned.
    function testFuzz_floatAccountingIsSelfConsistent(uint96 creditAmount, uint96 exitAmount, uint96 burnAmount)
        public
    {
        creditAmount = uint96(bound(creditAmount, 1, 1_000 ether));
        exitAmount = uint96(bound(exitAmount, 1, creditAmount));
        burnAmount = uint96(bound(burnAmount, 0, 1_000 ether));

        _sync(17, agentWallet, STATUS_ACTIVE, 100);
        _credit(keccak256("f"), 17, agentWallet, creditAmount);
        bridge.withdrawCredits(agentWallet);

        vm.prank(agentWallet);
        bridge.exit{value: exitAmount}(address(0xB5C));

        if (burnAmount > 0) {
            vm.deal(stranger, burnAmount);
            vm.prank(stranger);
            bridge.burnFloat{value: burnAmount}();
        }

        assertEq(bridge.reserve(), GENESIS_FLOAT - creditAmount + exitAmount + burnAmount, "reserve identity");
        assertEq(bridge.totalCredited(), creditAmount, "totalCredited");
        assertEq(bridge.totalExited(), exitAmount, "totalExited");
        assertEq(bridge.totalBurnedFloat(), burnAmount, "totalBurnedFloat");
        assertEq(agentWallet.balance, uint256(creditAmount) - exitAmount, "agent holds the rest");
    }

    // ------------------------------------------------------------------------------- helpers ------

    function _sync(uint256 agentId, address wallet, uint8 status, uint64 bscBlock) internal {
        address who = bridge.relayer();
        vm.prank(who);
        gate.applySync(agentId, wallet, status, bscBlock);
    }

    function _credit(bytes32 depositId, uint256 agentId, address to, uint256 amount) internal {
        address who = bridge.relayer();
        vm.prank(who);
        bridge.credit(depositId, agentId, to, amount);
    }

    function _rotationDigest(address target, uint256 nonce) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                bridge.domainSeparator(),
                keccak256(abi.encode(keccak256("Rotate(address newRelayer,uint256 nonce)"), target, nonce))
            )
        );
    }

    function _signRotation(address target, uint256 nonce) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(rotationPk, _rotationDigest(target, nonce));
        return abi.encodePacked(r, s, v);
    }

    function _assertAllSlotsZero(address who, string memory label) internal view {
        for (uint256 slot = 0; slot < 16; slot++) {
            assertEq(vm.load(who, bytes32(slot)), bytes32(0), string.concat(label, ": non-zero storage slot"));
        }
    }
}
