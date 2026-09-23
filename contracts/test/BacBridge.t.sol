// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/proxy/ERC1967/ERC1967Proxy.sol";
import {BacBridge, BacBridgeExtension} from "../src/BacBridge.sol";
import {BacNodeFund} from "../src/BacNodeFund.sol";
import {IChainAnchor} from "../src/interfaces/IChainAnchor.sol";

// ============================================================================
//                                  MOCKS
// ============================================================================

/// @dev Minimal ERC20 stand-in for BAC. Returns bool like FlapTaxTokenV3 does.
contract MockBAC {
    string public constant name = "BNB Agent Chain";
    string public constant symbol = "BAC";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) internal returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Minimal ERC-8004 Identity Registry stand-in. Two behaviours are copied deliberately from
///      the live registry on BSC (docs/research/12-erc8004-and-portal.md §1.2/§1.4), because the
///      gate is written around them:
///        * `ownerOf` REVERTS for an id that was never minted, so the bridge has to staticcall it;
///        * `getMetadata(id, "agentWallet")` answers with 20 BARE bytes, not an encoded address.
///      Every other metadata key answers empty, mirroring the fact that no other key is trusted.
contract MockErc8004 {
    mapping(uint256 => address) private _owners;
    mapping(uint256 => address) private _wallets;

    function mint(uint256 agentId, address to) external {
        _owners[agentId] = to;
    }

    /// @dev The identity is a plain transferable ERC-721 — this is the whole of decision #31a.
    function transfer(uint256 agentId, address to) external {
        _owners[agentId] = to;
    }

    function setAgentWallet(uint256 agentId, address wallet) external {
        _wallets[agentId] = wallet;
    }

    function ownerOf(uint256 agentId) external view returns (address owner_) {
        owner_ = _owners[agentId];
        require(owner_ != address(0), "ERC721NonexistentToken");
    }

    function getMetadata(uint256 agentId, string calldata key) external view returns (bytes memory) {
        if (keccak256(bytes(key)) != keccak256(bytes("agentWallet"))) return bytes("");
        address w = _wallets[agentId];
        if (w == address(0)) return bytes("");
        return abi.encodePacked(w); // 20 bare bytes, exactly as measured on mainnet
    }
}

/// @dev Minimal `ChainAnchor` stand-in. `releaseBpsFor` reproduces §6.3 at the new cadence:
///      the tiers 200 / 350 / 500 are now PER DAY and the bridge divides them by 144.
contract MockAnchor {
    mapping(uint64 => IChainAnchor.Anchor) private anchors;

    address public vetoKey;
    uint8 public haltReason;
    uint64 public lastFinalAt;

    constructor(address vetoKey_) {
        vetoKey = vetoKey_;
        lastFinalAt = uint64(block.timestamp);
    }

    function setAnchor(uint64 epoch, bytes32 root, uint32 agreeingCount, IChainAnchor.State state) external {
        IChainAnchor.Anchor storage a = anchors[epoch];
        a.exitRoot = root;
        a.agreeingCount = agreeingCount;
        a.state = state;
        if (state == IChainAnchor.State.FINAL) lastFinalAt = uint64(block.timestamp);
    }

    function setHaltReason(uint8 r) external {
        haltReason = r;
    }

    function getAnchor(uint64 epoch) external view returns (IChainAnchor.Anchor memory) {
        return anchors[epoch];
    }

    function releaseBpsFor(uint64 epoch) external view returns (uint16) {
        uint32 n = anchors[epoch].agreeingCount;
        if (n == 0) return 200;
        if (n < 3) return 350;
        return 500;
    }
}

/// @dev Flap Portal stand-in. `getTokenV8Safe` returns the real 18-field STATIC struct, so the
///      bridge's hand-rolled three-word decode is exercised against the genuine layout.
contract MockPortal {
    struct TokenStateV8Safe {
        uint8 status;
        uint256 reserve;
        uint256 circulatingSupply;
        uint256 price;
        uint8 tokenVersion;
        uint256 r;
        uint256 h;
        uint256 k;
        uint256 dexSupplyThresh;
        address quoteTokenAddress;
        bool nativeToQuoteSwapEnabled;
        bytes32 extensionID;
        uint256 buyTaxRate;
        uint256 sellTaxRate;
        address pool;
        uint256 progress;
        uint8 lpFeeProfile;
        uint8 dexId;
    }

    uint8 public status = 1; // Tradable == still on the bonding curve
    uint256 public price = 2e10; // quote per token, 18 decimals (the simulation's p0 = 2e-8 BNB)
    uint256 public buyTaxRate = 200; // 2%
    bool public broken; // the read itself reverts
    bool public buyReverts;
    uint256 public extraSlipBps; // how much worse than spot the fill comes back

    function setStatus(uint8 s) external {
        status = s;
    }

    function setPrice(uint256 p) external {
        price = p;
    }

    function setBuyTax(uint256 b) external {
        buyTaxRate = b;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function setBuyReverts(bool b) external {
        buyReverts = b;
    }

    function setExtraSlip(uint256 bps) external {
        extraSlipBps = bps;
    }

    function getTokenV8Safe(address) external view returns (TokenStateV8Safe memory s) {
        require(!broken, "portal broken");
        s.status = status;
        s.price = price;
        s.buyTaxRate = buyTaxRate;
        s.tokenVersion = 6;
    }

    function quote(uint256 valueIn) public view returns (uint256 out) {
        out = (valueIn * 1e18) / price;
        out = (out * (10000 - buyTaxRate)) / 10000;
        out = (out * (10000 - extraSlipBps)) / 10000;
    }

    struct ExactInputParams {
        address inputToken;
        address outputToken;
        uint256 inputAmount;
        uint256 minOutputAmount;
        bytes permitData;
    }

    /// @dev The live curve entry point. `IPortalTrade.buy` reverts `FeatureDisabled()` on the
    ///      real Portal, so the bridge must use this one and the mock only offers this one.
    function swapExactInput(ExactInputParams calldata p) external payable returns (uint256 out) {
        require(!buyReverts, "curve closed");
        require(p.inputToken == address(0), "input must be BNB");
        require(p.inputAmount == msg.value, "amount != value");
        out = quote(msg.value);
        require(out >= p.minOutputAmount, "slippage");
        MockBAC(p.outputToken).mint(msg.sender, out);
    }
}

/// @dev PancakeSwap V2 router stand-in for the post-graduation venue.
contract MockRouter {
    MockPortal public portal;
    bool public broken;
    bool public swapReverts;

    constructor(MockPortal p) {
        portal = p;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function setSwapReverts(bool b) external {
        swapReverts = b;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory a) {
        require(!broken, "router broken");
        a = new uint256[](2);
        a[0] = amountIn;
        a[1] = (amountIn * 1e18) / portal.price(); // gross of the token's own tax, like the real one
        require(path.length == 2, "path");
    }

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external payable {
        require(!swapReverts, "pair empty");
        uint256 out = portal.quote(msg.value);
        require(out >= amountOutMin, "slippage");
        MockBAC(path[1]).mint(to, out);
    }
}

// ============================================================================
//                          DEPLOYMENT + UPGRADE MOCK
// ============================================================================

/// @dev The one way a bridge is ever deployed: an `ERC1967Proxy` over an implementation, with
///      `initialize` run by the proxy's constructor in the same transaction. Shared with the
///      invariant suite so both test what production runs.
function deployBacBridge(
    BacBridge impl,
    address owner_,
    address bac_,
    address identity_,
    address anchor_,
    address watchdog_,
    address portal_,
    address router_
) returns (BacBridge) {
    bytes memory init = abi.encodeCall(
        BacBridge.initialize, (owner_, bac_, identity_, anchor_, watchdog_, portal_, router_)
    );
    return BacBridge(address(new ERC1967Proxy(address(impl), init)));
}

/// @dev A V2 written the way the storage comment in `BacBridgeCore` prescribes: its one new
///      variable takes the FIRST slot of `__gap`. In a real V2 that is a source change —
///      `uint256 public v2Marker;` declared just above the gap and `__gap` shrunk to 39. A mock
///      that inherits V1 cannot shrink V1's private gap, so it addresses that slot explicitly;
///      `BacBridgeUpgradeTest` pins `GAP_START` against the live layout, so the day somebody
///      inserts a variable above the gap, that test fails instead of this mock silently
///      writing over it.
contract BacBridgeV2Mock is BacBridge {
    /// @dev 350 in the first deployed version; v1.1 took 350 (`claimHistory`) and 351 (`owedPaid`).
    uint256 internal constant GAP_START = 352;

    function initializeV2(uint256 marker) external reinitializer(2) {
        assembly {
            sstore(GAP_START, marker)
        }
    }

    function v2Marker() external view returns (uint256 m) {
        assembly {
            m := sload(GAP_START)
        }
    }

    function version() external pure returns (uint256) {
        return 2;
    }
}

// ============================================================================
//                                 FIXTURE
// ============================================================================

contract BacBridgeTestBase is Test {
    BacBridge internal impl;
    BacBridge internal bridge;
    MockBAC internal bac;
    MockErc8004 internal identity;
    MockAnchor internal anchor;
    MockPortal internal portal;
    MockRouter internal router;

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal stranger = makeAddr("stranger");
    address internal watchdog = makeAddr("watchdog");
    address internal vetoKey = makeAddr("vetoKey");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint64 internal constant E = 600; // decision #20
    uint64 internal constant T0 = 1_800_000_000; // a realistic wall clock, epoch 3,000,000

    function setUp() public virtual {
        vm.warp(T0);
        bac = new MockBAC();
        identity = new MockErc8004();
        anchor = new MockAnchor(vetoKey);
        portal = new MockPortal();
        router = new MockRouter(portal);
        impl = new BacBridge();
        bridge = _newBridge();

        // alice / bob / carol each hold one ERC-8004 identity. Nothing else is needed: there is
        // no status, no deposit, no challenge and no heartbeat any more (decision #31).
        identity.mint(1, alice);
        identity.mint(2, bob);
        identity.mint(3, carol);
    }

    /// @dev A fresh proxy over the shared implementation, initialised in the same transaction.
    function _newBridge() internal returns (BacBridge) {
        return deployBacBridge(
            impl, owner, address(bac), address(identity), address(anchor), watchdog, address(portal), address(router)
        );
    }

    // ---- helpers ----

    function _lock(address who, uint256 agentId, uint256 amount) internal {
        bac.mint(who, amount);
        vm.startPrank(who);
        bac.approve(address(bridge), amount);
        bridge.lock(agentId, amount);
        vm.stopPrank();
    }

    /// @dev Fills `buybackBac` without going through the market: a donation, folded in by the
    ///      permissionless rule-010 sweep. Exits are paid from this bucket and only this one.
    function _seedBuyback(BacBridge b, uint256 amount) internal {
        bac.mint(address(b), amount);
        b.sweepUntrackedBac();
    }

    function _seedBuyback(uint256 amount) internal {
        _seedBuyback(bridge, amount);
    }

    function _leaf(uint256 exitId, uint256 agentId, address to, uint256 credits) internal view returns (bytes32) {
        return keccak256(
            abi.encode(bridge.EXIT_TYPEHASH(), exitId, agentId, to, credits, bridge.LAYER_CHAIN_ID(), address(bridge))
        );
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @dev Single-leaf tree: the root IS the leaf and the proof is empty.
    function _postSingle(uint64 epoch, bytes32 leaf, uint32 agreeing) internal {
        anchor.setAnchor(epoch, leaf, agreeing, IChainAnchor.State.FINAL);
    }

    function _claim(uint64 epoch, uint256 exitId, uint256 agentId, address to, uint256 credits)
        internal
        returns (uint256)
    {
        bytes32[] memory proof = new bytes32[](0);
        return bridge.claimExit(epoch, exitId, agentId, to, credits, proof);
    }

    function _curEpoch() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp() / E);
    }

    /// @dev Settle the next epoch as FINAL with `agreeing` witnesses.
    function _settleNext(uint32 agreeing) internal returns (uint256 pot) {
        uint64 e = bridge.lastSettledEpoch() + 1;
        anchor.setAnchor(e, bytes32(uint256(1)), agreeing, IChainAnchor.State.FINAL);
        bridge.settleEpoch(e);
        (pot,,) = bridge.lastEpochRelease();
    }

    function _warpEpochs(uint64 n) internal {
        vm.warp(vm.getBlockTimestamp() + uint256(n) * E);
    }

    /// @dev `collect`'s per-address cap for `span` epochs: 10% of what the last settled daily rate
    ///      releases from the whole bucket in one epoch. Deliberately NOT a share of the last pot.
    function _cap(uint256 span) internal view returns (uint256) {
        (,, uint16 bps) = bridge.lastEpochRelease();
        return (bridge.buybackBac() * bps * bridge.MAX_EXIT_SHARE_BPS() * span) / (1e8 * 144);
    }

    /// @dev What `who` has been released and not yet collected, before the speed limit.
    function _released(address who) internal view returns (uint256) {
        return bridge.owed(who) - bridge.unreleasedOwed(who);
    }

    /// @dev The release the contract must compute: a DAILY rate divided down to one epoch.
    function _expectedPot(uint256 assets, uint256 reserved, uint16 dailyBps) internal pure returns (uint256) {
        return ((assets - reserved) * dailyBps) / (10000 * 144);
    }

    /// @dev B6 / rule 010 on the BAC side, asserted after every state-changing test.
    function _assertBacBooks() internal view {
        assertEq(
            bac.balanceOf(address(bridge)),
            bridge.lockedBac() + bridge.buybackBac() - bridge.totalBurned(),
            "BAC books: balance != lockedBac + buybackBac - burned"
        );
        assertLe(bridge.owedTotal(), bridge.buybackBac(), "B1: owed exceeds the buyback bucket");
    }
}

// ============================================================================
//                               ENTRY SIDE
// ============================================================================

contract BacBridgeEntryTest is BacBridgeTestBase {
    function test_EpochAndWaitAreTheDecidedNumbers() public {
        assertEq(uint256(bridge.EPOCH()), 600, "decision #20: 10-minute epoch");
        assertEq(uint256(bridge.EPOCHS_PER_DAY()), 144, "144 epochs per day");
        assertEq(uint256(bridge.ANCHOR_WAIT()), 120, "decision #25: 2-minute anchor wait");
        assertEq(uint256(bridge.MAX_CATCHUP_EPOCHS()), 144, "one collect a day must suffice");
        assertEq(uint256(bridge.OWED_MATURITY()), 14 days, "maturity must NOT shrink with the epoch");
        // the name 'CHALLENGE_WINDOW' must be gone from the ABI (decision #18)
        (bool ok,) = address(bridge).call(abi.encodeWithSignature("CHALLENGE_WINDOW()"));
        assertFalse(ok, "the waiting period must not be called a challenge window");
    }

    function test_LockMintsCreditsOneToOne() public {
        _lock(alice, 1, 100e18);
        assertEq(bridge.lockedBac(), 100e18);
        assertEq(bridge.buybackBac(), 0, "a deposit must never land in the buyback bucket");
        assertEq(bridge.totalCreditsIssued(), 100e18);
        assertEq(bridge.credited(1), 100e18);
        assertEq(bridge.creditsOutstanding(), 100e18);
        assertEq(bac.balanceOf(address(bridge)), 100e18);
        _assertBacBooks();
    }

    /// An id that was never minted must be a clean refusal, not a bubbled `ERC721NonexistentToken`.
    function test_LockRejectsUnmintedIdentity() public {
        bac.mint(alice, 1e18);
        vm.startPrank(alice);
        bac.approve(address(bridge), 1e18);
        vm.expectRevert(unicode"Not the ERC-8004 identity holder / 不是该 ERC-8004 身份的持有人");
        bridge.lock(999_999, 1e18);
        vm.stopPrank();
        assertFalse(bridge.holdsIdentity(alice, 999_999));
        assertEq(bridge.identityOwner(999_999), address(0), "an unminted id must read as zero, not revert");
    }

    /// The identity is transferable, so entry rights move with it — in both directions.
    function test_LockRejectsFormerHolderAndAcceptsNewOne() public {
        vm.prank(alice);
        identity.transfer(1, bob);

        bac.mint(alice, 1e18);
        vm.startPrank(alice);
        bac.approve(address(bridge), 1e18);
        vm.expectRevert(unicode"Not the ERC-8004 identity holder / 不是该 ERC-8004 身份的持有人");
        bridge.lock(1, 1e18);
        vm.stopPrank();

        _lock(bob, 1, 1e18);
        assertEq(bridge.credited(1), 1e18);
    }

    /// The cold-key-holds-the-NFT, hot-key-does-the-work shape. Safe only because that key is
    /// written through `setAgentWallet`, which demands the wallet's own signature.
    function test_LockAcceptsTheProvenAgentWallet() public {
        address hot = makeAddr("aliceHotWallet");
        identity.setAgentWallet(1, hot);
        assertTrue(bridge.holdsIdentity(hot, 1));
        assertEq(bridge.identityWallet(1), hot);

        _lock(hot, 1, 5e18);
        assertEq(bridge.credited(1), 5e18);
    }

    /// Agent id 0 is never a real identity and must not reach the registry at all.
    function test_LockRejectsZeroAgentId() public {
        bac.mint(alice, 1e18);
        vm.startPrank(alice);
        bac.approve(address(bridge), 1e18);
        vm.expectRevert(unicode"Zero agent id / agent 身份编号为零");
        bridge.lock(0, 1e18);
        vm.stopPrank();
    }

    function test_LockRejectsStranger() public {
        bac.mint(bob, 1e18);
        vm.startPrank(bob);
        bac.approve(address(bridge), 1e18);
        vm.expectRevert(unicode"Not the ERC-8004 identity holder / 不是该 ERC-8004 身份的持有人");
        bridge.lock(1, 1e18); // identity 1 belongs to alice
        vm.stopPrank();
    }

    function test_AgentWalletMayAlsoLock() public {
        address wallet = makeAddr("aliceWallet");
        identity.setAgentWallet(1, wallet);
        bac.mint(wallet, 5e18);
        vm.startPrank(wallet);
        bac.approve(address(bridge), 5e18);
        bridge.lock(1, 5e18);
        vm.stopPrank();
        assertEq(bridge.credited(1), 5e18);
    }

    function test_AcceptReleaseAndSweepUntracked() public {
        vm.deal(address(this), 10 ether);
        bridge.acceptRelease{value: 4 ether}();
        assertEq(bridge.bnbBalance(), 4 ether);

        // simulate a force-pushed balance (selfdestruct / coinbase)
        vm.deal(address(bridge), address(bridge).balance + 1 ether);
        assertEq(bridge.bnbBalance(), 4 ether);
        uint256 swept = bridge.sweepUntracked();
        assertEq(swept, 1 ether);
        assertEq(bridge.bnbBalance(), 5 ether);
        assertEq(bridge.sweepUntracked(), 0);
    }

    /// `BacTaxRouter` pushes the bridge half with `call{gas: PUSH_GAS = 100_000}`. Behind the
    /// proxy `acceptRelease` pays for one extra hop (the EIP-1967 slot read and a DELEGATECALL
    /// into a cold implementation), so pin it well below that stipend, including the heavier
    /// post-halt path that also feeds the junior accumulator.
    function test_AcceptReleaseThroughTheProxyFitsTheRouterStipend() public {
        vm.deal(address(this), 10 ether);
        uint256 g = gasleft();
        (bool ok,) = address(bridge).call{value: 1 ether, gas: 100_000}(abi.encodeWithSignature("acceptRelease()"));
        uint256 used = g - gasleft();
        assertTrue(ok, "acceptRelease failed inside the router's stipend");
        assertLt(used, 60_000, "first (cold, zero-to-nonzero) acceptRelease too expensive");

        _lock(alice, 1, 1e18);
        vm.prank(watchdog);
        bridge.armEscape();
        vm.warp(vm.getBlockTimestamp() + bridge.ESCAPE_ARM_DELAY());
        bridge.checkHalt();
        g = gasleft();
        (ok,) = address(bridge).call{value: 1 ether, gas: 100_000}(abi.encodeWithSignature("acceptRelease()"));
        used = g - gasleft();
        assertTrue(ok, "post-halt acceptRelease failed inside the router's stipend");
        assertLt(used, 60_000, "post-halt acceptRelease too expensive");
    }

    function test_PlainSendReverts() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(bridge).call{value: 1 ether}("");
        assertFalse(ok, "bridge must have no receive()");
    }
}

// ============================================================================
//           THE TWO BUCKETS  (decision #24a②, requirement 1)
// ============================================================================

contract BacBridgeBucketTest is BacBridgeTestBase {
    /// The whole promise in one test: with a full `lockedBac` and an empty `buybackBac`,
    /// there is no exit rate at all — the deposit is simply not reachable.
    function test_ExitCannotBePaidFromLockedBac() public {
        _lock(alice, 1, 1000e18);
        assertEq(bridge.lockedBac(), 1000e18);
        assertEq(bridge.buybackBac(), 0);
        assertEq(bridge.currentRate(), 0, "a deposit must not create a redemption rate");

        bytes32 leaf = _leaf(1, 1, alice, 500e18);
        _postSingle(_curEpoch(), leaf, 3);
        vm.expectRevert(
            unicode"Rate too low, exit not worth claiming / 当前兑付率过低，本次退出不值得领取"
        );
        _claim(_curEpoch(), 1, 1, alice, 500e18);
        _assertBacBooks();
    }

    /// Only the bought-back bucket ever backs an exit, and paying one shrinks only that bucket.
    function test_ExitIsPaidOnlyOutOfBuybackBac() public {
        _lock(alice, 1, 1000e18);
        _seedBuyback(40e18);
        assertEq(bridge.currentRate(), (40e18 * 1e18) / 1000e18, "rate is a share of buybackBac");

        _postSingle(_curEpoch(), _leaf(1, 1, alice, 1000e18), 3);
        uint256 lockedAmt = _claim(_curEpoch(), 1, 1, alice, 1000e18);
        assertEq(lockedAmt, 40e18, "the whole free buyback bucket");

        uint256 lockedBefore = bridge.lockedBac();
        _warpEpochs(1);
        _settleNext(3);
        vm.prank(alice);
        uint256 paid = bridge.collect(alice);
        assertGt(paid, 0);
        assertEq(bac.balanceOf(alice), paid, "the exit is paid in BAC");
        assertEq(bridge.lockedBac(), lockedBefore, "lockedBac must not move on a payout");
        assertEq(bridge.buybackBac(), 40e18 - paid, "only the buyback bucket pays");
        _assertBacBooks();
    }

    /// `burnLocked` burns exactly the locked bucket and leaves the payout bucket alone.
    function test_BurnLockedOnlyBurnsDepositsAndOnlyToDead() public {
        _lock(alice, 1, 100e18);
        _seedBuyback(30e18);

        uint256 burned = bridge.burnLocked();
        assertEq(burned, 100e18, "burn must take the deposits and nothing else");
        assertEq(bac.balanceOf(DEAD), 100e18);
        assertEq(bridge.buybackBac(), 30e18, "the buyback bucket survives the burn");
        assertEq(bac.balanceOf(address(bridge)), 30e18);
        assertEq(bridge.totalBurned(), 100e18);
        _assertBacBooks();

        vm.expectRevert(unicode"Nothing to burn / 没有可销毁的 BAC");
        bridge.burnLocked();

        // a later deposit is burnable again, the buyback bucket still is not
        _lock(bob, 2, 7e18);
        assertEq(bridge.burnLocked(), 7e18);
        assertEq(bridge.buybackBac(), 30e18);
        _assertBacBooks();
    }

    /// Rule 010 on the BAC side: a stray transfer is recognised as a donation to the payout
    /// bucket, never as a deposit, and the books match the balance exactly afterwards.
    function test_SweepUntrackedBacOnlyEverFeedsTheBuybackBucket() public {
        _lock(alice, 1, 10e18);
        bac.mint(address(bridge), 3e18);
        assertEq(bridge.bacAccounted(), 10e18, "an unswept transfer is not yet on the books");
        assertGt(bac.balanceOf(address(bridge)), bridge.bacAccounted(), "balance >= accounted");

        uint256 swept = bridge.sweepUntrackedBac();
        assertEq(swept, 3e18);
        assertEq(bridge.buybackBac(), 3e18);
        assertEq(bridge.lockedBac(), 10e18, "a donation must never become a deposit");
        assertEq(bridge.sweepUntrackedBac(), 0);
        _assertBacBooks();
    }

    /// The escape path is the only other way BAC leaves, and it too pays from the payout bucket.
    function test_HaltDoesNotUnlockDeposits() public {
        _lock(alice, 1, 1000e18);
        _seedBuyback(50e18);
        vm.prank(watchdog);
        bridge.armEscape();
        vm.warp(vm.getBlockTimestamp() + bridge.ESCAPE_ARM_DELAY());
        bridge.checkHalt();

        vm.prank(alice);
        (uint256 bacPaid,) = bridge.escapeCollect(1, alice);
        assertEq(bacPaid, 50e18, "the junior pot is the buyback bucket, not the deposits");
        assertEq(bridge.lockedBac(), 1000e18, "deposits are still locked after a halt");
        assertEq(bac.balanceOf(address(bridge)), 1000e18);
        _assertBacBooks();
    }
}

// ============================================================================
//                                BUYBACK
// ============================================================================

contract BacBridgeBuybackTest is BacBridgeTestBase {
    function setUp() public override {
        super.setUp();
        vm.deal(address(this), 1000 ether);
        bridge.acceptRelease{value: 10 ether}();
    }

    function _accrue(uint64 epochs) internal {
        _warpEpochs(epochs);
    }

    function test_BuybackIsPermissionlessAndFillsTheBuybackBucket() public {
        _accrue(144); // one full day of accrual: 20% of 10 BNB = 2 BNB, capped at MAX per call
        uint256 bnbBefore = bridge.bnbBalance();

        vm.prank(carol); // anybody
        uint256 bought = bridge.buyback(0, 0);

        assertGt(bought, 0, "buyback bought nothing");
        assertEq(bridge.buybackBac(), bought);
        assertEq(bridge.lockedBac(), 0, "a buyback must never touch the deposit bucket");
        assertEq(bridge.bnbBalance(), bnbBefore - bridge.MAX_BUYBACK_BNB(), "per-call BNB cap");
        assertEq(bridge.buybackBnbSpent(), bridge.MAX_BUYBACK_BNB());
        assertEq(bridge.buybackBacBought(), bought);
        assertEq(bought, portal.quote(bridge.MAX_BUYBACK_BNB()), "fill must match the venue quote");
        _assertBacBooks();
    }

    function test_BuybackAccruesTwentyPercentOfTheBnbBucketPerDay() public {
        // a small bucket, so the daily budget stays under MAX_BUYBACK_BNB and the cap does not bite
        BacBridge b = _newBridge();
        vm.deal(address(this), 10 ether);
        b.acceptRelease{value: 1 ether}();
        _warpEpochs(144);
        (uint256 budget, uint256 spendable,,) = b.buybackState();
        assertEq(budget, 0.2 ether, "20% of 1 BNB per day");
        assertEq(spendable, 0.2 ether);
        b.buyback(0, 0);
        assertEq(b.bnbBalance(), 0.8 ether);
        assertEq(b.buybackBudget(), 0);
    }

    function test_BuybackHonoursTheMinimumFloorAndAccumulatesInstead() public {
        BacBridge b = _newBridge();
        vm.deal(address(this), 10 ether);
        b.acceptRelease{value: 0.1 ether}(); // 20%/day of 0.1 = 0.02 BNB per day
        _warpEpochs(1); // one epoch accrues 0.1 * 2000 / 10000 / 144 = 0.0001389 BNB

        vm.expectEmit(false, false, false, false, address(b));
        emit BacBridge.BuybackSkipped(3, 0);
        assertEq(b.buyback(0, 0), 0, "below MIN_BUYBACK_BNB the call must be a no-op, not a revert");
        assertGt(b.buybackBudget(), 0, "the accrual is kept, not lost");

        _warpEpochs(144);
        assertGt(b.buyback(0, 0), 0, "once the budget clears the floor the buy happens");
    }

    function test_BuybackRespectsTheMinimumInterval() public {
        _accrue(144);
        bridge.buyback(0, 0);
        vm.expectEmit(false, false, false, false, address(bridge));
        emit BacBridge.BuybackSkipped(2, 0);
        assertEq(bridge.buyback(0, 0), 0, "same epoch: no second buy");
        _warpEpochs(1);
        assertGt(bridge.buyback(0, 0), 0, "one epoch later it is allowed again");
    }

    /// The whole point of requirement 2: an unavailable venue is a no-op, never a revert.
    function test_BuybackNoOpsWhenTheVenueIsUnavailable() public {
        _accrue(144);
        uint256 bnbBefore = bridge.bnbBalance();

        portal.setBroken(true);
        vm.expectEmit(false, false, false, false, address(bridge));
        emit BacBridge.BuybackSkipped(4, 0);
        assertEq(bridge.buyback(0, 0), 0);
        portal.setBroken(false);

        portal.setStatus(5); // Staged: neither the curve nor the DEX
        assertEq(bridge.buyback(0, 0), 0);

        portal.setStatus(1);
        portal.setPrice(0);
        assertEq(bridge.buyback(0, 0), 0);
        portal.setPrice(2e10);

        portal.setBuyReverts(true);
        vm.expectEmit(false, false, false, false, address(bridge));
        emit BacBridge.BuybackSkipped(5, 0);
        assertEq(bridge.buyback(0, 0), 0);

        assertEq(bridge.bnbBalance(), bnbBefore, "a skipped buyback must not lose a single wei");
        assertEq(bridge.buybackBac(), 0);
        _assertBacBooks();
    }

    function test_BuybackRevertsWhenTheFillIsWorseThanTheSlippageBound() public {
        _accrue(144);
        portal.setExtraSlip(bridge.MAX_BUY_SLIPPAGE_BPS() + 1); // 3.01% worse than spot
        vm.expectRevert(unicode"Buyback slippage too high / 回购滑点超过上限");
        bridge.buyback(0, 0);

        portal.setExtraSlip(bridge.MAX_BUY_SLIPPAGE_BPS() - 1);
        assertGt(bridge.buyback(0, 0), 0, "just inside the bound must go through");
    }

    function test_BuybackHonoursACallerSuppliedFloorOnTopOfItsOwn() public {
        _accrue(144);
        uint256 fair = portal.quote(bridge.MAX_BUYBACK_BNB());
        // An unreachable caller floor makes the venue refuse the fill, which is a no-op and not
        // a revert - the same rule as any other unavailable venue.
        assertEq(bridge.buyback(fair * 2, 0), 0, "an unreachable floor must not buy");
        assertEq(bridge.buybackBac(), 0);
        _warpEpochs(1);
        assertEq(bridge.buyback(fair, 0), fair, "an exactly-met floor passes");
    }

    /// Venue detection is read from chain state on every call, never from a stored flag.
    function test_BuybackSwitchesToPancakeWhenTheTokenGraduates() public {
        _accrue(144);
        (,,, uint8 venueBefore) = bridge.buybackState();
        assertEq(uint256(venueBefore), 1, "curve while status == Tradable");

        portal.setStatus(4); // DEX
        (,,, uint8 venueAfter) = bridge.buybackState();
        assertEq(uint256(venueAfter), 2, "PancakeSwap once status == DEX");

        vm.expectEmit(true, false, false, false, address(bridge));
        emit BacBridge.BoughtBack(address(this), 2, 0, 0, 0);
        uint256 bought = bridge.buyback(0, 0);
        assertEq(bought, portal.quote(bridge.MAX_BUYBACK_BNB()));
        assertEq(bridge.buybackBac(), bought);

        // and a broken router after graduation is still a no-op
        _warpEpochs(1);
        router.setBroken(true);
        assertEq(bridge.buyback(0, 0), 0);
        router.setBroken(false);
        router.setSwapReverts(true);
        assertEq(bridge.buyback(0, 0), 0);
        _assertBacBooks();
    }

    function test_BuybackIsDisabledOnceHalted() public {
        _accrue(144);
        anchor.setHaltReason(1);
        bridge.checkHalt();
        vm.warp(vm.getBlockTimestamp() + bridge.ESCAPE_ARM_DELAY());
        bridge.checkHalt();
        assertTrue(bridge.isHalted());

        vm.expectEmit(false, false, false, false, address(bridge));
        emit BacBridge.BuybackSkipped(1, 0);
        assertEq(bridge.buyback(0, 0), 0, "after a halt the BNB belongs to the junior pot");
    }

    /// No exit path may ever fire a buy: that is what makes the exit timing ungameable.
    function test_NoExitPathTriggersABuy() public {
        _lock(alice, 1, 1000e18);
        _seedBuyback(20e18);
        _accrue(144);
        uint256 bnbBefore = bridge.bnbBalance();

        _postSingle(_curEpoch(), _leaf(1, 1, alice, 1000e18), 3);
        _claim(_curEpoch(), 1, 1, alice, 1000e18);
        assertEq(bridge.bnbBalance(), bnbBefore, "claimExit must not spend BNB");

        _warpEpochs(1);
        _settleNext(3);
        assertEq(bridge.bnbBalance(), bnbBefore, "settleEpoch must not spend BNB");
        vm.prank(alice);
        bridge.collect(alice);
        assertEq(bridge.bnbBalance(), bnbBefore, "collect must not spend BNB");
        assertEq(bridge.buybackBacBought(), 0, "nothing was ever bought on an exit path");
    }

    /// The slippage bound is the guard that binds; `maxSpend` is how the keeper splits around it.
    function test_MaxSpendLetsTheKeeperSplitAroundTheSlippageBound() public {
        _accrue(144);
        // a pool thin enough that a full MAX_BUYBACK_BNB buy breaches the 3% bound
        portal.setExtraSlip(bridge.MAX_BUY_SLIPPAGE_BPS() + 100);
        vm.expectRevert(unicode"Buyback slippage too high / 回购滑点超过上限");
        bridge.buyback(0, 0);

        // the same call, split down: the mock's impact does not depend on size, so this test
        // only proves the plumbing - the live-fork test proves the economics.
        portal.setExtraSlip(0);
        uint256 bought = bridge.buyback(0, 0.02 ether);
        assertEq(bought, portal.quote(0.02 ether), "maxSpend must bound the spend");
        assertEq(bridge.buybackBnbSpent(), 0.02 ether);

        // and a maxSpend under the floor is a no-op, never a dust trade
        _warpEpochs(1);
        assertEq(bridge.buyback(0, bridge.MIN_BUYBACK_BNB() - 1), 0, "no dust trades");
    }

    function test_BuybackBudgetNeverExceedsTheBnbBucket() public {
        _warpEpochs(10_000); // far more than one day of accrual
        (uint256 budget,,,) = bridge.buybackState();
        assertLe(budget, bridge.bnbBalance(), "the budget is bounded by the bucket");
        bridge.buyback(0, 0);
        assertLe(bridge.buybackBudget(), bridge.bnbBalance());
    }
}

// ============================================================================
//                           EXIT SIDE / THE MONEY
// ============================================================================

contract BacBridgeExitTest is BacBridgeTestBase {
    function setUp() public override {
        super.setUp();
        _lock(alice, 1, 1000e18);
        _seedBuyback(10e18);
    }

    /// B10: two different-sized exits in the SAME epoch get an identical lockedBac/credits ratio.
    function test_B10_SameEpochDifferentSizesShareOneRate() public {
        bytes32 leafA = _leaf(1, 1, alice, 100e18);
        bytes32 leafB = _leaf(2, 1, bob, 300e18);
        anchor.setAnchor(_curEpoch(), _hashPair(leafA, leafB), 3, IChainAnchor.State.FINAL);

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafB;
        bytes32[] memory proofB = new bytes32[](1);
        proofB[0] = leafA;

        uint256 lockedA = bridge.claimExit(_curEpoch(), 1, 1, alice, 100e18, proofA);
        uint256 lockedB = bridge.claimExit(_curEpoch(), 2, 1, bob, 300e18, proofB);

        assertGt(lockedA, 0);
        assertGt(lockedB, 0);
        // identical per-credit rate, exact cross-multiplication
        assertEq(lockedA * 300e18, lockedB * 100e18, "B10: first-mover advantage");
        assertEq(lockedA, 1e18);
        assertEq(lockedB, 3e18);
        assertEq(bridge.owedTotal(), 4e18);
        assertLe(bridge.owedTotal(), bridge.buybackBac(), "B1");
    }

    /// B10, awkward numbers: the per-credit rate may differ only by integer-division dust.
    function testFuzz_B10_RateIsSizeIndependent(uint256 cA, uint256 cB) public {
        cA = bound(cA, 1e15, 400e18);
        cB = bound(cB, 1e15, 400e18);
        bytes32 leafA = _leaf(1, 1, alice, cA);
        bytes32 leafB = _leaf(2, 1, bob, cB);
        anchor.setAnchor(_curEpoch(), _hashPair(leafA, leafB), 3, IChainAnchor.State.FINAL);

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leafB;
        bytes32[] memory proofB = new bytes32[](1);
        proofB[0] = leafA;

        uint256 lockedA = bridge.claimExit(_curEpoch(), 1, 1, alice, cA, proofA);
        uint256 lockedB = bridge.claimExit(_curEpoch(), 2, 1, bob, cB, proofB);

        uint256 rateA = (lockedA * 1e18) / cA;
        uint256 rateB = (lockedB * 1e18) / cB;
        uint256 diff = rateA > rateB ? rateA - rateB : rateB - rateA;
        assertLe(diff, 1e6, "B10: per-credit rate drifted beyond rounding dust");
    }

    function test_ClaimExitLocksRateAndBurnsCredits() public {
        bytes32 leaf = _leaf(7, 1, alice, 200e18);
        _postSingle(_curEpoch(), leaf, 3);
        uint256 locked = _claim(_curEpoch(), 7, 1, alice, 200e18);
        assertEq(locked, 2e18); // 200/1000 of 10 BAC
        assertEq(bridge.owed(alice), 2e18);
        assertEq(bridge.epochOwed(_curEpoch(), alice), 2e18, "the per-epoch ledger records it");
        assertEq(bridge.totalCreditsExited(), 200e18);
        assertEq(bridge.exitedCredits(1), 200e18);
        assertEq(bridge.unattributedExited(), 0);
        assertEq(bridge.creditsOutstanding(), 800e18);
    }

    function test_ExitIdCannotBeClaimedTwice() public {
        bytes32 leaf = _leaf(7, 1, alice, 200e18);
        _postSingle(_curEpoch(), leaf, 3);
        _claim(_curEpoch(), 7, 1, alice, 200e18);
        vm.expectRevert(unicode"Exit already claimed / 该退出已领取");
        _claim(_curEpoch(), 7, 1, alice, 200e18);
    }

    function test_ClaimExitRejectsNonFinalAnchor() public {
        bytes32 leaf = _leaf(7, 1, alice, 200e18);
        anchor.setAnchor(_curEpoch(), leaf, 3, IChainAnchor.State.POSTED);
        vm.expectRevert(unicode"Anchor not final / 锚点尚未定案");
        _claim(_curEpoch(), 7, 1, alice, 200e18);
    }

    function test_ClaimExitRejectsBadProof() public {
        _postSingle(_curEpoch(), _leaf(7, 1, alice, 200e18), 3);
        vm.expectRevert(unicode"Bad merkle proof / merkle 证明无效");
        _claim(_curEpoch(), 7, 1, alice, 201e18); // credits tampered
    }

    function test_ClaimExitRejectsZeroRate() public {
        BacBridge dry = _newBridge();
        bac.mint(alice, 10e18);
        vm.startPrank(alice);
        bac.approve(address(dry), 10e18);
        dry.lock(1, 10e18);
        vm.stopPrank();

        bytes32 leaf = keccak256(
            abi.encode(
                dry.EXIT_TYPEHASH(), uint256(1), uint256(1), alice, uint256(1e18), dry.LAYER_CHAIN_ID(), address(dry)
            )
        );
        anchor.setAnchor(_curEpoch(), leaf, 3, IChainAnchor.State.FINAL);
        bytes32[] memory proof = new bytes32[](0);
        vm.expectRevert(
            unicode"Rate too low, exit not worth claiming / 当前兑付率过低，本次退出不值得领取"
        );
        dry.claimExit(_curEpoch(), 1, 1, alice, 1e18, proof);
    }

    /// G11: `claimExit` never reads the identity registry at all, so losing the identity — sold,
    ///      transferred, or the registry upgraded out from under us — cannot strand an exit that
    ///      is already in an anchor.
    function test_ExitWorksAfterTheIdentityIsGone() public {
        vm.prank(alice);
        identity.transfer(1, address(0xdead));
        bytes32 leaf = _leaf(7, 1, alice, 200e18);
        _postSingle(_curEpoch(), leaf, 3);
        uint256 locked = _claim(_curEpoch(), 7, 1, alice, 200e18);
        assertEq(locked, 2e18);

        _warpEpochs(1);
        _settleNext(3);
        vm.prank(alice);
        uint256 paid = bridge.collect(alice);
        assertGt(paid, 0, "an exit already in an anchor must still be collectable");
    }

    function test_ExitWorksForAnIdentityHeldBySomebodyElse() public {
        vm.prank(alice);
        identity.transfer(1, bob);
        bytes32 leaf = _leaf(8, 1, alice, 100e18);
        _postSingle(_curEpoch(), leaf, 3);
        assertGt(_claim(_curEpoch(), 8, 1, alice, 100e18), 0);
    }

    /// Anyone may submit someone else's exit; `to` is in the leaf and cannot be changed.
    function test_ThirdPartyMaySubmitExit() public {
        bytes32 leaf = _leaf(9, 1, alice, 100e18);
        _postSingle(_curEpoch(), leaf, 3);
        vm.prank(carol);
        _claim(_curEpoch(), 9, 1, alice, 100e18);
        assertEq(bridge.owed(alice), 1e18);
        assertEq(bridge.owed(carol), 0);
    }

    /// Attribution is truncated at what the agent actually locked; the rest is global.
    function test_OverEarningAgentTruncatesAttribution() public {
        _lock(bob, 2, 100e18); // agent 2 credited 100
        // agent 2 exits 300 credits (it earned more inside the layer than it deposited)
        bytes32 leaf = _leaf(11, 2, bob, 300e18);
        _postSingle(_curEpoch(), leaf, 3);
        _claim(_curEpoch(), 11, 2, bob, 300e18);
        assertEq(bridge.exitedCredits(2), 100e18, "B11: exited must be capped by credited");
        assertEq(bridge.unattributedExited(), 200e18);
        assertLe(bridge.exitedCredits(2), bridge.credited(2), "B11");
    }
}

// ============================================================================
//                          SETTLE / COLLECT MECHANICS
// ============================================================================

contract BacBridgeSettleTest is BacBridgeTestBase {
    function setUp() public override {
        super.setUp();
        _lock(alice, 1, 1000e18);
        _seedBuyback(10e18);
        bytes32 leaf = _leaf(1, 1, alice, 1000e18);
        _postSingle(_curEpoch(), leaf, 3);
        _claim(_curEpoch(), 1, 1, alice, 1000e18); // owed[alice] = 10 BAC
        assertEq(bridge.owed(alice), 10e18);
    }

    function test_SettleEpochMustBeSequential() public {
        _warpEpochs(3);
        uint64 next = bridge.lastSettledEpoch() + 1;
        anchor.setAnchor(next + 1, bytes32(uint256(1)), 3, IChainAnchor.State.FINAL);
        vm.expectRevert(unicode"Settle epochs in order / 纪元必须按序结算");
        bridge.settleEpoch(next + 1);

        anchor.setAnchor(next, bytes32(uint256(1)), 3, IChainAnchor.State.FINAL);
        bridge.settleEpoch(next);
        assertEq(bridge.lastSettledEpoch(), next);

        vm.expectRevert(unicode"Settle epochs in order / 纪元必须按序结算");
        bridge.settleEpoch(next); // no replay of the same epoch either
    }

    /// B16: a veto / dispute can never freeze the cursor.
    function test_SettleSkipsTerminalNonFinalEpochs() public {
        _warpEpochs(2);
        uint64 e = bridge.lastSettledEpoch() + 1;
        anchor.setAnchor(e, bytes32(0), 0, IChainAnchor.State.VETOED);
        bridge.settleEpoch(e);
        assertEq(bridge.skippedEpochs(), 1);
        assertEq(bridge.lastSettledEpoch(), e);

        e = bridge.lastSettledEpoch() + 1;
        anchor.setAnchor(e, bytes32(0), 0, IChainAnchor.State.DISPUTED);
        bridge.settleEpoch(e);
        assertEq(bridge.skippedEpochs(), 2);

        // and a FINAL epoch after them still releases
        e = bridge.lastSettledEpoch() + 1;
        anchor.setAnchor(e, bytes32(uint256(1)), 3, IChainAnchor.State.FINAL);
        bridge.settleEpoch(e);
        (uint256 pot,,) = bridge.lastEpochRelease();
        assertEq(pot, _expectedPot(10e18, 0, 500));
    }

    /// B16: an epoch that is neither FINAL nor terminal advances after SETTLE_GRACE.
    function test_SettleWaitsGraceThenSkipsUnresolvedEpoch() public {
        uint64 e = bridge.lastSettledEpoch() + 1;
        _warpEpochs(1);
        vm.expectRevert(unicode"Epoch not resolved yet / 该纪元尚未定案");
        bridge.settleEpoch(e);

        vm.warp((uint256(e) + 1) * E + uint256(bridge.SETTLE_GRACE()));
        bridge.settleEpoch(e);
        assertEq(bridge.lastSettledEpoch(), e);
        assertEq(bridge.skippedEpochs(), 1);
    }

    /// The release tiers are PER DAY and are divided by 144 here. Read as per-epoch they would
    /// be 288%/day and would empty the bucket the same day.
    function test_ReleaseBpsTiersAreDailyRatesDividedByEpochsPerDay() public {
        _warpEpochs(1);
        assertEq(_settleNext(0), _expectedPot(10e18, 0, 200), "0 witnesses -> 200 bps/day");
        uint256 r1 = bridge.reservedTotal();
        _warpEpochs(1);
        assertEq(_settleNext(2), _expectedPot(10e18, r1, 350), "1-2 witnesses -> 350 bps/day");
        uint256 r2 = bridge.reservedTotal();
        _warpEpochs(1);
        assertEq(_settleNext(3), _expectedPot(10e18, r2, 500), "3+ witnesses -> 500 bps/day");

        // sanity on magnitude: one epoch at the top tier is ~0.0347% of the bucket
        assertLt(_expectedPot(10e18, 0, 500), 10e18 / 2000, "a single epoch must be a sliver");
    }

    /// A full day of releases at the zero-witness tier must land on the simulation's published
    /// figure: linear division instead of exact compounding realises 1.9803% against a 2.00%
    /// target, i.e. 1% conservative. 144 epochs of `pot = (assets - reserved) * r` leave
    /// `1 - (1 - r)^144` released, with `r = 200 / (10000 * 144)`.
    function test_ADayOfReleasesMatchesTheSimulatedDailyRate() public {
        uint256 start = bridge.buybackBac();
        uint256 released;
        for (uint64 i = 0; i < 144; i++) {
            _warpEpochs(1);
            released += _settleNext(0);
        }
        assertLe(released, (start * 200) / 10000, "a day must never exceed the daily tier");
        // 1.9803% of the bucket, to four decimal places
        assertGe(released * 1e6 / start, 19_800, "realised daily rate below 1.980%");
        assertLe(released * 1e6 / start, 19_810, "realised daily rate above 1.981%");
    }

    /// The per-address cap truncates, and the remainder stays in `owed` forever (never forfeited).
    function test_CapTruncationLeavesRemainderInOwedForever() public {
        // the first collect of an address may claim a full day's worth of allowance, so take it
        // first and measure the cap on the SECOND one, which is the steady-state case
        _warpEpochs(1);
        _settleNext(3);
        vm.prank(alice);
        bridge.collect(alice);

        _warpEpochs(1);
        _settleNext(3);
        uint256 cap = _cap(1);
        assertGt(_released(alice), cap, "the release outruns one epoch's allowance here");
        assertEq(bridge.pendingCollect(alice), cap, "pendingCollect must already be truncated");

        uint256 owedBefore = bridge.owed(alice);
        vm.prank(alice);
        uint256 paid = bridge.collect(alice);
        assertEq(paid, cap);
        assertEq(bridge.owed(alice), owedBefore - cap, "remainder stays in owed");
        assertGt(bridge.unclaimed(alice), 0, "truncated wei stays in unclaimed, never forfeited");
        assertLe(bridge.reservedTotal(), bridge.owedTotal(), "B14");
        _assertBacBooks();
    }

    /// MAX_CATCHUP_EPOCHS: one call a day must claim exactly what 144 calls would have.
    function test_CatchupLetsOneDailyCollectMatchTheDailyAllowance() public {
        _warpEpochs(1);
        _settleNext(3);
        vm.prank(alice);
        bridge.collect(alice); // establish lastCollectEpoch

        // 20 epochs of releases with nobody collecting
        for (uint64 i = 0; i < 20; i++) {
            _warpEpochs(1);
            _settleNext(3);
        }
        assertGt(_released(alice), _cap(20), "released more than 20 epochs of allowance");
        assertEq(bridge.pendingCollect(alice), _cap(20), "20 epochs of allowance are claimable at once");

        // beyond one day the multiplier stops growing
        for (uint64 i = 0; i < 400; i++) {
            _warpEpochs(1);
            _settleNext(3);
        }
        assertEq(_cap(144), _cap(bridge.MAX_CATCHUP_EPOCHS()));
        assertLe(bridge.pendingCollect(alice), _cap(144), "MAX_CATCHUP_EPOCHS bounds the multiplier");
    }

    function test_DoubleCollectInSameEpochRejected() public {
        _warpEpochs(1);
        _settleNext(3);
        vm.prank(alice);
        bridge.collect(alice);
        vm.prank(alice);
        vm.expectRevert(unicode"Already collected this epoch / 本纪元已领取");
        bridge.collect(alice);

        // a new epoch unlocks it again
        _warpEpochs(1);
        _settleNext(3);
        vm.prank(alice);
        assertGt(bridge.collect(alice), 0);
    }

    /// B15: a freshly locked `owed` gets nothing from releases that happened before it existed.
    function test_NewOwedGetsNothingFromEarlierReleases() public {
        _warpEpochs(1);
        _settleNext(3); // all of it belongs to alice

        // bob locks and exits AFTER that release (fresh stock, otherwise the rate is 0)
        _seedBuyback(10e18);
        _lock(bob, 2, 1000e18);
        bytes32 leaf = _leaf(2, 2, bob, 1000e18);
        _postSingle(_curEpoch(), leaf, 3);
        _claim(_curEpoch(), 2, 2, bob, 1000e18);
        assertGt(bridge.owed(bob), 0);

        assertEq(bridge.pendingCollect(bob), 0, "B15: no share of a pre-existing release");
        vm.prank(bob);
        vm.expectRevert(unicode"Nothing to collect / 没有可领取的金额");
        bridge.collect(bob);

        // alice, whose debt predates the release, can still collect
        vm.prank(alice);
        assertGt(bridge.collect(alice), 0);
    }

    /// Zero-witness ceiling: the window is 30 DAY buckets. As 30 epochs it would be 5 hours,
    /// i.e. 15% per 5 hours = 72% a day = no ceiling at all.
    function test_ZeroWitnessCeilingIsThirtyDaysNotThirtyEpochs() public {
        uint256 start = bridge.buybackBac();
        uint256 released;
        // 30 days of zero-witness epochs, sampled one epoch per day to keep the run short
        for (uint64 d = 0; d < 30; d++) {
            for (uint64 i = 0; i < 4; i++) {
                _warpEpochs(1);
                released += _settleNext(0);
            }
            _warpEpochs(140); // jump to the next day bucket
            // keep the settle cursor moving without releasing
            for (uint64 i = 0; i < 140; i++) {
                uint64 e = bridge.lastSettledEpoch() + 1;
                anchor.setAnchor(e, bytes32(0), 0, IChainAnchor.State.VETOED);
                bridge.settleEpoch(e);
            }
        }
        uint256 capTotal = (start * uint256(bridge.NO_ATTEST_WINDOW_BPS())) / 10000;
        assertLe(released, capTotal + 30, "30 day buckets must cap at 15% of the bucket");
        assertLe(bridge.releasedInWindow(), capTotal + 30);
    }

    /// The oldest day bucket must actually age out, otherwise the ceiling would be permanent.
    function test_ZeroWitnessWindowBucketsExpire() public {
        _warpEpochs(1);
        uint256 first = _settleNext(0);
        assertGt(first, 0);
        assertEq(bridge.releasedInWindow(), first);

        // 30 days later the same slot is reused and the old figure leaves the window
        uint64 target = bridge.lastSettledEpoch() + 30 * 144;
        vm.warp(uint256(target + 1) * E);
        while (bridge.lastSettledEpoch() < target - 1) {
            uint64 e = bridge.lastSettledEpoch() + 1;
            anchor.setAnchor(e, bytes32(0), 0, IChainAnchor.State.VETOED);
            bridge.settleEpoch(e);
        }
        uint256 next = _settleNext(0);
        assertEq(bridge.releasedInWindow(), next, "the 30-day-old bucket must have expired");
    }

    /// I2 / B14: reservations can never ratchet past the debt they serve.
    function test_ReservedNeverExceedsOwed() public {
        for (uint64 i = 0; i < 40; i++) {
            _warpEpochs(1);
            _settleNext(3);
            assertLe(bridge.reservedTotal(), bridge.owedTotal(), "B14");
            assertLe(bridge.owedTotal(), bridge.buybackBac(), "B1");
        }
    }

    function test_SettleWithZeroOwedClearsRoundingDust() public {
        BacBridge fresh = _newBridge();
        _seedBuyback(fresh, 5e18);
        _warpEpochs(1);
        uint64 e = fresh.lastSettledEpoch() + 1;
        anchor.setAnchor(e, bytes32(uint256(1)), 3, IChainAnchor.State.FINAL);
        fresh.settleEpoch(e);
        assertEq(fresh.reservedTotal(), 0);
        (uint160 p, uint48 scale, uint48 gen) = fresh.releaseIndex();
        assertEq(uint256(p), fresh.RELEASE_ONE(), "nothing owed: the release index must not move");
        assertEq(uint256(scale) + uint256(gen), 0);
    }
}

// ============================================================================
//        RELEASE INDEX + COLLECT CAP  (review findings of 2026-09-23)
// ============================================================================

/// @notice Regression tests for the two release bugs of the pre-fix accumulator:
///         (1) `collect` capped at 10% of `lastPot`, and a pot is 0 once every owed wei has been
///             released, so the last exiters were locked out of BAC already reserved for them;
///         (2) each pot was spread over the WHOLE `owedTotal`, released owed included, so part of
///             every pot went to addresses that could never collect it (`collect` clamps at `owed`)
///             and sat in `reservedTotal` while later exiters starved — the B3 invariant failure.
///         Numbers follow the finding: two agents lock 1,000,000 BAC each, 100,000 BAC bought back.
contract BacBridgeReleaseTest is BacBridgeTestBase {
    function setUp() public override {
        super.setUp();
        _lock(alice, 1, 1_000_000e18);
        _lock(bob, 2, 1_000_000e18);
        _seedBuyback(100_000e18);
    }

    function _exit(address to, uint256 exitId, uint256 agentId, uint256 credits) internal returns (uint256) {
        _postSingle(_curEpoch(), _leaf(exitId, agentId, to, credits), 3);
        return _claim(_curEpoch(), exitId, agentId, to, credits);
    }

    function _next() internal returns (uint256 pot) {
        _warpEpochs(1);
        pot = _settleNext(3);
    }

    /// Finding 1 (T1): a lone exiter fully released by one pot must still be paid after the next
    /// pot comes out 0 — immediately, and after any number of keeper settles.
    function test_FullReleaseThenAZeroPotStillCollects() public {
        uint256 amt = _exit(alice, 1, 1, 100e18);
        assertEq(amt, 5e18);
        assertEq(_next(), 5e18, "one pot releases everything owed");
        assertEq(_next(), 0, "nothing left to release: the pot is 0");
        (uint256 lastPot,,) = bridge.lastEpochRelease();
        assertEq(lastPot, 0, "lastPot stays honest");
        for (uint256 i = 0; i < 144; i++) {
            _next();
        }
        assertEq(bridge.pendingCollect(alice), 5e18);
        vm.prank(alice);
        assertEq(bridge.collect(alice), 5e18, "reserved BAC must stay collectable");
        assertEq(bridge.owedTotal(), 0);
        assertEq(bridge.reservedTotal(), 0);
        _assertBacBooks();
    }

    /// Finding 1 (T2): two FINAL epochs settled in the same block (a keeper catching up) left no
    /// window at all under the old cap. Now the reserved BAC is collectable regardless.
    function test_CatchUpSettlesInOneBlockDoNotLockTheExiterOut() public {
        _exit(alice, 1, 1, 100e18);
        _warpEpochs(3);
        _settleNext(3);
        _settleNext(3);
        vm.prank(alice);
        assertEq(bridge.collect(alice), 5e18);
    }

    /// Finding 1 (T4): an exiter whose owed is larger than the per-epoch speed limit, collecting
    /// every epoch, is paid every wei — not frozen once the headroom reaches 0 after ~30 epochs.
    function test_ALargeExiterCollectingEveryEpochIsPaidInFull() public {
        uint256 amt = _exit(alice, 1, 1, 20_000e18); // 1% of the credits: owed 1,000 BAC
        assertEq(amt, 1000e18);
        vm.prank(alice);
        vm.expectRevert(unicode"Nothing to collect / 没有可领取的金额");
        bridge.collect(alice); // nothing released yet

        uint256 paid;
        uint256 epochs;
        bool sawZeroPot;
        while (bridge.owed(alice) > 0) {
            if (_next() == 0) sawZeroPot = true;
            vm.prank(alice);
            try bridge.collect(alice) returns (uint256 got) {
                paid += got;
            } catch {}
            epochs++;
            assertLt(epochs, 2000, "the exit must finish");
        }
        assertTrue(sawZeroPot, "the headroom did run out while BAC was still reserved");
        assertEq(paid, amt, "every wei owed was paid");
        assertEq(bridge.owedTotal(), 0);
        assertEq(bridge.reservedTotal(), 0);
        _assertBacBooks();
    }

    /// Finding 2 (T2): alice is fully released and does not collect; bob exits the same size
    /// afterwards; one settle. The pot must go to bob only — alice's released owed takes no share
    /// of it — and both are then payable in full, leaving no reservation behind.
    function test_APotIsSharedOnlyOverUnreleasedOwed() public {
        _exit(alice, 1, 1, 100e18);
        _next(); // alice fully released
        assertEq(_released(alice), 5e18);
        uint256 bobAmt = _exit(bob, 2, 2, 100e18);
        assertEq(bridge.unreleasedOwed(bob), bobAmt);

        uint256 pot = _next();
        assertEq(pot, bobAmt, "the headroom is exactly bob's owed");
        assertEq(_released(alice), 5e18, "alice took nothing of bob's pot");
        assertEq(_released(bob), bobAmt, "bob got all of it");
        assertEq(bridge.reservedTotal(), 5e18 + bobAmt);

        vm.prank(alice);
        assertEq(bridge.collect(alice), 5e18);
        vm.prank(bob);
        assertEq(bridge.collect(bob), bobAmt);
        assertEq(bridge.unclaimed(alice), 0, "no dead reservation left with alice");
        assertEq(bridge.owedTotal(), 0);
        assertEq(bridge.reservedTotal(), 0);
        _assertBacBooks();
    }

    /// A pot smaller than the headroom releases the SAME fraction of every address's unreleased
    /// part, whatever each address has already been released.
    function test_APartialPotReleasesTheSameFractionOfEveryUnreleasedPart() public {
        // a bucket small enough that one pot cannot release everything
        bridge = _newBridge();
        _lock(alice, 1, 1000e18);
        _lock(bob, 2, 1000e18);
        _seedBuyback(10e18);
        _exit(alice, 1, 1, 1000e18); // owed 5e18
        _next(); // alice partly released
        uint256 relA0 = _released(alice);
        assertGt(relA0, 0);
        assertLt(relA0, bridge.owed(alice));
        _exit(bob, 2, 2, 1000e18);
        uint256 uA = bridge.unreleasedOwed(alice);
        uint256 uB = bridge.unreleasedOwed(bob);
        uint256 headroom = bridge.owedTotal() - bridge.reservedTotal();
        assertApproxEqAbs(uA + uB, headroom, 1, "the headroom is the sum of the unreleased parts");

        uint256 pot = _next();
        assertLt(pot, headroom);
        uint256 gotA = _released(alice) - relA0;
        uint256 gotB = _released(bob);
        assertApproxEqAbs(gotA + gotB, pot, 2, "the pot is released, all of it and no more");
        // same fraction: gotA / uA == gotB / uB == pot / headroom
        assertApproxEqAbs(gotA, (uA * pot) / headroom, 1);
        assertApproxEqAbs(gotB, (uB * pot) / headroom, 1);
    }

    /// The shape of the persisted B3 counterexample: claim, full release, a second claim, a settle,
    /// then the watchdog revokes the second one. The reservation must still back exactly the
    /// claims that can be paid — no more (a phantom), no less (a shortfall).
    function test_RevokeAfterAFullReleaseKeepsTheReservationExact() public {
        _exit(alice, 1, 1, 100e18);
        _next();
        uint64 bad = _curEpoch();
        _exit(bob, 2, 2, 100_000e18);
        _next(); // a partial pot, over bob only
        assertEq(_released(alice), 5e18);
        assertGt(_released(bob), 0);

        vm.prank(watchdog);
        bridge.pause();
        address[] memory who = new address[](1);
        who[0] = bob;
        vm.prank(watchdog);
        assertGt(bridge.revokeEpochOwed(bad, who), 0);

        uint256 claims = _released(alice) + _released(bob);
        assertLe(claims, bridge.reservedTotal() + 2, "reserved below the claims it backs");
        assertLe(bridge.reservedTotal(), claims + 2, "a reservation nobody can collect");
        assertEq(bridge.owed(bob), 0);
    }
}

/// @dev Exposes the release-index internals of `BacBridgeCore` on a bare contract with its own
///      storage, so rescales and generations can be driven directly. Through `settleEpoch` one
///      rescale needs the unreleased owed to shrink a billion-fold without ever being released
///      in full, which the release rate never produces in a test-sized run.
contract ReleaseHarness is BacBridge {
    constructor() {
        releaseIndex.p = uint160(RELEASE_ONE);
    }

    function give(address who, uint256 amount) external {
        _harvest(who);
        owed[who] += amount;
        owedTotal += amount;
    }

    function release(uint256 pot) external {
        _advanceRelease(pot, owedTotal - reservedTotal);
        reservedTotal += pot;
    }

    function harvest(address who) external {
        _harvest(who);
    }

    function released(address who) external view returns (uint256) {
        return owed[who] - _unreleased(who);
    }

    function headroom() external view returns (uint256) {
        return owedTotal - reservedTotal;
    }
}

contract BacBridgeReleaseIndexTest is Test {
    ReleaseHarness internal h;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        h = new ReleaseHarness();
    }

    /// Whatever the sequence of partial pots, full releases, late entrants and harvests, the
    /// released amounts add up to the pots (up to 1 wei per address) and nobody is ever
    /// released more than it is owed.
    function testFuzz_PotsReleaseExactlyWhatTheyAddUpTo(uint256 a, uint256 b, uint256[8] memory fr) public {
        a = bound(a, 1, 1e27);
        b = bound(b, 1, 1e27);
        h.give(alice, a);
        for (uint256 i = 0; i < 8; i++) {
            if (i == 3) h.give(bob, b); // a late entrant: no share of the first three pots
            if (i == 5) h.harvest(alice);
            uint256 room = h.headroom();
            if (room == 0) continue;
            // mostly partial pots, sometimes a full release
            uint256 f = bound(fr[i], 1, 1e18);
            uint256 pot = (room * f) / 1e18;
            if (pot == 0) pot = 1;
            if (i == 2) assertEq(h.released(bob), 0);
            h.release(pot);
        }
        uint256 relA = h.released(alice);
        uint256 relB = h.released(bob);
        assertLe(relA, h.owed(alice));
        assertLe(relB, h.owed(bob));
        assertApproxEqAbs(relA + relB, h.reservedTotal(), 2, "released != the pots");
        assertApproxEqAbs(h.unreleasedOwed(alice) + h.unreleasedOwed(bob), h.headroom(), 2);
    }

    /// `p` falls a billion-fold several times: every step is a rescale, the unreleased part keeps
    /// tracking the headroom exactly, and a full release afterwards resets `scale` without any
    /// older snapshot (taken at a HIGHER scale) underflowing.
    function test_RescalesThenAFullReleaseNeverUnderflow() public {
        h.give(alice, 1e27); // a billion BAC
        for (uint256 i = 0; i < 4; i++) {
            uint256 room = h.headroom();
            h.release(room - room / 1e5); // keep 1e-5 of it
            assertEq(h.unreleasedOwed(alice), h.headroom(), "alice alone is the headroom");
        }
        (, uint48 scale,) = h.releaseIndex();
        assertGe(uint256(scale), 2, "p was rescaled");
        assertEq(h.headroom(), 1e7, "1e27 * 1e-20");

        h.give(bob, 5e18); // snapshot at scale >= 2
        h.release(h.headroom() / 2);
        assertApproxEqAbs(h.released(bob), 2.5e18, 1, "half of bob's part");

        h.release(h.headroom()); // a full release
        (uint160 p, uint48 scale2, uint48 gen) = h.releaseIndex();
        assertEq(uint256(p), h.RELEASE_ONE());
        assertEq(uint256(scale2), 0);
        assertEq(uint256(gen), 1);
        assertEq(h.unreleasedOwed(bob), 0, "an older generation reads as fully released");
        assertEq(h.released(bob), 5e18);
        assertEq(h.released(alice), 1e27);
        assertEq(h.reservedTotal(), h.owedTotal());
    }

    /// A snapshot four or more rescales old has less than 1e-27 of its part left: it reads 0.
    function test_FourRescalesOldReadsAsFullyReleased() public {
        h.give(alice, 1e18);
        for (uint256 i = 0; i < 8; i++) {
            h.give(bob, 1e27); // new owed refills the headroom without touching `p`
            uint256 room = h.headroom();
            h.release(room - room / 1e5); // `p` shrinks ~1e5-fold each time
        }
        (,, uint48 gen) = h.releaseIndex();
        assertEq(uint256(gen), 0, "never a full release");
        (, uint48 scale,) = h.releaseIndex();
        assertGe(uint256(scale), 4);
        assertEq(h.unreleasedOwed(alice), 0);
        assertEq(h.released(alice), 1e18);
    }
}
// ============================================================================
//                    revokeEpochOwed  (decision #25a)
// ============================================================================

contract BacBridgeRevokeTest is BacBridgeTestBase {
    function setUp() public override {
        super.setUp();
        _lock(alice, 1, 1000e18);
        _seedBuyback(10e18);
    }

    function _exit(address to, uint256 exitId, uint256 credits, uint64 epoch) internal returns (uint256) {
        bytes32 leaf = _leaf(exitId, 1, to, credits);
        _postSingle(epoch, leaf, 3);
        return _claim(epoch, exitId, 1, to, credits);
    }

    address[] internal holders;

    function test_RevokeVoidsOneEpochAndReturnsItToTheBucket() public {
        uint64 bad = _curEpoch();
        uint256 lockedAmt = _exit(alice, 1, 500e18, bad);
        assertEq(bridge.owedTotal(), lockedAmt);
        uint256 bucketBefore = bridge.buybackBac();

        vm.prank(watchdog);
        bridge.pause();

        holders = [alice];
        vm.prank(watchdog);
        uint256 revoked = bridge.revokeEpochOwed(bad, holders);

        assertEq(revoked, lockedAmt);
        assertEq(bridge.owed(alice), 0);
        assertEq(bridge.owedTotal(), 0);
        assertEq(bridge.epochOwed(bad, alice), 0);
        assertEq(bridge.buybackBac(), bucketBefore, "the BAC never left the bucket");
        assertEq(bac.balanceOf(alice), 0, "no BAC reached the forged exit");
        _assertBacBooks();
    }

    /// Only the named epoch: a claim locked against a different anchor survives untouched.
    function test_RevokeTouchesOnlyTheNamedEpoch() public {
        uint64 good = _curEpoch();
        uint256 goodAmt = _exit(alice, 1, 200e18, good);
        _warpEpochs(1);
        uint64 bad = _curEpoch();
        uint256 badAmt = _exit(alice, 2, 200e18, bad);
        assertEq(bridge.owed(alice), goodAmt + badAmt);

        vm.prank(watchdog);
        bridge.pause();
        holders = [alice];
        vm.prank(watchdog);
        assertEq(bridge.revokeEpochOwed(bad, holders), badAmt);

        assertEq(bridge.owed(alice), goodAmt, "the honest epoch must survive");
        assertEq(bridge.epochOwed(good, alice), goodAmt);
    }

    function test_RevokeIsWatchdogOnlyAndOnlyWhilePaused() public {
        uint64 bad = _curEpoch();
        _exit(alice, 1, 500e18, bad);
        holders = [alice];

        vm.expectRevert(unicode"Only watchdog / 仅限看门狗");
        bridge.revokeEpochOwed(bad, holders);

        vm.prank(watchdog);
        vm.expectRevert(unicode"Bridge not paused / 桥未处于暂停");
        bridge.revokeEpochOwed(bad, holders);

        vm.prank(watchdog);
        bridge.pause();
        vm.prank(watchdog);
        assertGt(bridge.revokeEpochOwed(bad, holders), 0);
    }

    /// A matured claim is senior and untouchable — the only remaining time guard after the wait
    /// dropped to 120 seconds.
    function test_RevokeSkipsMaturedOwed() public {
        uint64 bad = _curEpoch();
        uint256 amt = _exit(alice, 1, 500e18, bad);
        vm.warp(vm.getBlockTimestamp() + bridge.OWED_MATURITY() + 1);

        vm.prank(watchdog);
        bridge.pause();
        holders = [alice];
        vm.prank(watchdog);
        assertEq(bridge.revokeEpochOwed(bad, holders), 0, "a matured claim must not be revocable");
        assertEq(bridge.owed(alice), amt);
    }

    /// The watchdog can void debt, never take it: there is no recipient and no balance change.
    function test_RevokeGivesTheWatchdogNothing() public {
        uint64 bad = _curEpoch();
        _exit(alice, 1, 500e18, bad);
        vm.prank(watchdog);
        bridge.pause();
        holders = [alice];
        uint256 wdBnb = watchdog.balance;
        vm.prank(watchdog);
        bridge.revokeEpochOwed(bad, holders);
        assertEq(watchdog.balance, wdBnb);
        assertEq(bac.balanceOf(watchdog), 0);
    }

    /// Revoking after a partial payout only voids what is still owed, and never underflows.
    function test_RevokeAfterAPartialCollect() public {
        uint64 bad = _curEpoch();
        _exit(alice, 1, 1000e18, bad);
        _warpEpochs(1);
        _settleNext(3);
        vm.prank(alice);
        uint256 paid = bridge.collect(alice);
        assertGt(paid, 0);

        uint256 left = bridge.owed(alice);
        vm.prank(watchdog);
        bridge.pause();
        holders = [alice];
        vm.prank(watchdog);
        assertEq(bridge.revokeEpochOwed(bad, holders), left);
        assertEq(bridge.owed(alice), 0);
        assertEq(bridge.owedTotal(), 0);
        assertLe(bridge.reservedTotal(), bridge.owedTotal(), "B14 after a revoke");
        _assertBacBooks();
    }
}

// ============================================================================
//                            PAUSE / HALT / ESCAPE
// ============================================================================

contract BacBridgeHaltTest is BacBridgeTestBase {
    function setUp() public override {
        super.setUp();
        _lock(alice, 1, 600e18);
        _lock(bob, 2, 400e18);
        _seedBuyback(10e18);
        vm.deal(address(this), 1000 ether);
    }

    function _aliceExits(uint256 credits, uint256 exitId) internal returns (uint256) {
        bytes32 leaf = _leaf(exitId, 1, alice, credits);
        _postSingle(_curEpoch(), leaf, 3);
        return _claim(_curEpoch(), exitId, 1, alice, credits);
    }

    /// `pause()` freezes `collect` and nothing else. B19: `claimExit` does not depend on it.
    function test_PauseBlocksCollectButNeverClaimExit() public {
        _aliceExits(100e18, 1);
        _warpEpochs(1);
        _settleNext(3);

        vm.prank(watchdog);
        bridge.pause();
        (bool paused,,) = bridge.isPaused();
        assertTrue(paused);

        vm.prank(alice);
        vm.expectRevert(unicode"Bridge paused / 桥已暂停");
        bridge.collect(alice);

        // claimExit still works while paused
        assertGt(_aliceExits(100e18, 2), 0, "claimExit must not be pausable");

        vm.prank(watchdog);
        bridge.unpause();
        vm.prank(alice);
        assertGt(bridge.collect(alice), 0);
    }

    function test_OnlyWatchdogCanPause() public {
        vm.expectRevert(unicode"Only watchdog / 仅限看门狗");
        bridge.pause();
        vm.prank(vetoKey);
        vm.expectRevert(unicode"Only watchdog / 仅限看门狗");
        bridge.unpause();
    }

    /// B17: the pause budget is bounded, and exhausting it IS halt cause 5.
    function test_PauseBudgetExhaustionBecomesHaltCause5() public {
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(watchdog);
            bridge.pause();
            vm.warp(vm.getBlockTimestamp() + 7 days);
        }
        (,, uint64 cumulative) = bridge.isPaused();
        assertGe(cumulative, bridge.MAX_PAUSE_TOTAL(), "B17");
        assertEq(bridge.pendingCause(), 5);

        vm.prank(watchdog);
        vm.expectRevert(unicode"Pause budget exhausted / 暂停额度已用尽");
        bridge.pause();

        // and the escape hatch opens on its own
        bridge.checkHalt();
        assertEq(bridge.armedCause(), 5);
        vm.warp(vm.getBlockTimestamp() + bridge.ESCAPE_ARM_DELAY());
        bridge.checkHalt();
        assertTrue(bridge.isHalted());
        assertEq(bridge.haltCause(), 5);
    }

    function test_ArmingIsNeverAnImmediateHalt() public {
        anchor.setHaltReason(1);
        bridge.checkHalt();
        assertEq(bridge.armedCause(), 1);
        assertFalse(bridge.isHalted());

        vm.expectRevert(unicode"Arming delay not elapsed / 武装期未满");
        bridge.checkHalt();

        vm.warp(vm.getBlockTimestamp() + bridge.ESCAPE_ARM_DELAY());
        bridge.checkHalt();
        assertTrue(bridge.isHalted());
    }

    function test_CancelEscapeArmOnlyWhenConditionCleared() public {
        anchor.setHaltReason(2);
        bridge.checkHalt();

        vm.prank(alice);
        vm.expectRevert(unicode"Only veto key / 仅限 veto 钥");
        bridge.cancelEscapeArm();

        vm.prank(vetoKey);
        vm.expectRevert(unicode"Condition still true / 触发条件仍然成立");
        bridge.cancelEscapeArm();

        anchor.setHaltReason(0);
        vm.prank(vetoKey);
        bridge.cancelEscapeArm();
        assertEq(bridge.escapeArmedAt(), 0);
        assertEq(bridge.armedCause(), 0);
    }

    function test_ManualArmIsCancellableAtDiscretion() public {
        vm.prank(watchdog);
        bridge.armEscape();
        assertEq(bridge.armedCause(), 4);
        vm.prank(vetoKey);
        bridge.cancelEscapeArm();
        assertEq(bridge.escapeArmedAt(), 0);
    }

    function _haltWith(uint8 cause) internal {
        if (cause == 4) {
            vm.prank(watchdog);
            bridge.armEscape();
        } else {
            anchor.setHaltReason(cause);
            bridge.checkHalt();
        }
        vm.warp(vm.getBlockTimestamp() + bridge.ESCAPE_ARM_DELAY());
        bridge.checkHalt();
        assertTrue(bridge.isHalted());
        assertEq(bridge.haltCause(), cause);
    }

    function test_HaltFreezesNormalPathAndOpensEscape() public {
        _aliceExits(100e18, 1);
        _haltWith(1);

        vm.prank(alice);
        vm.expectRevert(unicode"Bridge halted / 桥已停机");
        bridge.collect(alice);
        uint64 nextEpoch = bridge.lastSettledEpoch() + 1; // hoisted: an inline call would eat the expectation
        vm.expectRevert(unicode"Bridge halted / 桥已停机");
        bridge.settleEpoch(nextEpoch);
        bytes32[] memory proof = new bytes32[](0);
        vm.expectRevert(unicode"Bridge halted / 桥已停机");
        bridge.claimExit(_curEpoch(), 99, 1, alice, 1e18, proof);

        bac.mint(alice, 1e18);
        vm.startPrank(alice);
        bac.approve(address(bridge), 1e18);
        vm.expectRevert(unicode"Bridge halted / 桥已停机");
        bridge.lock(1, 1e18);
        vm.stopPrank();

        (uint256 weight,,,,) = bridge.escapeState();
        assertEq(weight, 900e18, "junior weight = outstanding credits at halt");
    }

    /// @dev Arms first, exits inside the arming window, then halts: `owed` is younger than
    ///      `OWED_MATURITY` at `haltedAt` — exactly what a stolen relayer key could produce.
    function _armExitThenHalt(uint8 cause) internal {
        anchor.setHaltReason(cause);
        bridge.checkHalt();
        vm.warp(vm.getBlockTimestamp() + bridge.ESCAPE_ARM_DELAY());
        _aliceExits(100e18, 1);
        bridge.checkHalt();
        assertTrue(bridge.isHalted());
        assertEq(bridge.haltCause(), cause);
        assertGt(bridge.owed(alice), 0);
    }

    /// cause 1: an immature owed is still paid in full, `OWED_MATURITY` after the halt.
    function test_Cause1ImmatureOwedStillPaidAfterMaturity() public {
        _armExitThenHalt(1);

        vm.prank(alice);
        vm.expectRevert(unicode"Owed not matured / 债权尚未成熟");
        bridge.claimOwedAfterHalt(alice);

        vm.warp(vm.getBlockTimestamp() + bridge.OWED_MATURITY());
        uint256 expected = bridge.owed(alice);
        vm.prank(alice);
        uint256 paid = bridge.claimOwedAfterHalt(alice);
        assertEq(paid, expected);
        assertEq(bac.balanceOf(alice), paid, "the senior claim is paid in BAC");
        assertEq(bridge.owed(alice), 0);
        assertEq(bridge.owedTotal(), 0);
        _assertBacBooks();
    }

    /// A matured owed is senior and paid immediately at the halt.
    function test_MaturedOwedIsPaidImmediately() public {
        _aliceExits(100e18, 1);
        vm.warp(vm.getBlockTimestamp() + 20 days); // owed matures
        _haltWith(1);
        uint256 expected = bridge.owed(alice);
        vm.prank(alice);
        assertEq(bridge.claimOwedAfterHalt(alice), expected);
    }

    /// cause 2/3: an immature owed loses priority forever and is demoted to the junior pot.
    function test_Cause2ImmatureOwedIsDemoted() public {
        _armExitThenHalt(2);

        vm.expectRevert(unicode"Owed not matured / 债权尚未成熟");
        bridge.sweepImmatureOwed(alice);
        vm.warp(vm.getBlockTimestamp() + bridge.OWED_MATURITY());

        vm.prank(alice);
        vm.expectRevert(unicode"Owed not matured / 债权尚未成熟");
        bridge.claimOwedAfterHalt(alice);

        uint256 accBefore = bridge.accPerWeightBac();
        uint256 demoted = bridge.owed(alice);
        bridge.sweepImmatureOwed(alice); // permissionless
        assertEq(bridge.owed(alice), 0);
        assertEq(bridge.owedTotal(), 0);
        assertGt(bridge.accPerWeightBac(), accBefore, "demoted BAC went to the junior accumulator");
        assertGt(demoted, 0);
    }

    function test_MaturedOwedIsNotDemotableUnderCause2() public {
        _aliceExits(100e18, 1);
        vm.warp(vm.getBlockTimestamp() + 20 days);
        _haltWith(2);
        vm.warp(vm.getBlockTimestamp() + bridge.OWED_MATURITY());
        vm.expectRevert(unicode"Owed already matured / 该债权已成熟");
        bridge.sweepImmatureOwed(alice);
    }

    /// The junior path pays BOTH assets: the leftover stock AND the BNB that was never converted.
    function test_EscapeCollectPaysJuniorProRataInBothAssets() public {
        bridge.acceptRelease{value: 5 ether}(); // BNB that the buyback had not spent yet
        _haltWith(4);
        (uint256 weight,,,,) = bridge.escapeState();
        assertEq(weight, 1000e18);

        // alice locked first for identity #1, so she is its `agentController` — the only
        // address `escapeCollect` asks about. The registry itself is never consulted on exit.
        uint256 bnbBefore = alice.balance;
        vm.prank(alice);
        (uint256 bacPaid, uint256 bnbPaid) = bridge.escapeCollect(1, alice);
        assertEq(bacPaid, 6e18, "600/1000 of the 10 BAC stock");
        assertEq(bnbPaid, 3 ether, "600/1000 of the 5 BNB that never became BAC");
        assertEq(bac.balanceOf(alice), bacPaid);
        assertEq(alice.balance - bnbBefore, bnbPaid);

        vm.prank(bob);
        (uint256 bacB, uint256 bnbB) = bridge.escapeCollect(2, bob);
        assertEq(bacB, 4e18);
        assertEq(bnbB, 2 ether);

        vm.prank(alice);
        vm.expectRevert(unicode"Nothing to collect / 没有可领取的金额");
        bridge.escapeCollect(1, alice);
        _assertBacBooks();
    }

    /// The escape claim does NOT follow the identity. It is pinned to the address that first
    /// entered (`agentController`) and moves only when that address says so. Selling, losing or
    /// having the ERC-8004 registry upgraded under an identity can neither strand the deposit
    /// behind it nor hand it to the buyer.
    function test_EscapeClaimDoesNotFollowTheIdentity() public {
        _haltWith(4);
        vm.prank(alice);
        identity.transfer(1, bob);
        assertEq(bridge.agentController(1), alice, "a transfer of the NFT must not move the claim");

        vm.prank(bob);
        vm.expectRevert(unicode"Only the agent controller / 仅限该 agent 的控制地址");
        bridge.escapeCollect(1, bob);

        vm.prank(alice);
        (uint256 bacPaid,) = bridge.escapeCollect(1, alice);
        assertEq(bacPaid, 6e18, "the entering address still collects agent 1's junior share");
    }

    /// Nor does the escape path break when the registry itself is gone or broken: it is never read.
    function test_EscapeWorksWithTheRegistryBroken() public {
        _haltWith(4);
        vm.etch(address(identity), hex"fe"); // every call into the registry now reverts
        vm.prank(bob);
        (uint256 bacPaid,) = bridge.escapeCollect(2, bob);
        assertEq(bacPaid, 4e18);
    }

    /// B13 + attack-funds #11: revenue received after a halt reaches the junior claimants.
    function test_PostHaltRevenueFlowsToJunior() public {
        _haltWith(4);
        vm.prank(alice);
        bridge.escapeCollect(1, alice);

        bridge.acceptRelease{value: 2 ether}();
        assertEq(bridge.bnbBalance(), 2 ether);
        vm.prank(alice);
        (, uint256 bnbPaid) = bridge.escapeCollect(1, alice);
        assertEq(bnbPaid, 1.2 ether, "600/1000 of the new 2 BNB");

        // and the same for a BAC donation after the halt
        bac.mint(address(bridge), 1e18);
        bridge.sweepUntrackedBac();
        vm.prank(bob);
        (uint256 bacPaid,) = bridge.escapeCollect(2, bob);
        assertEq(bacPaid, 4e18 + 0.4e18, "400/1000 of the stock plus of the donation");
        _assertBacBooks();
    }

    /// B13: with no outstanding credits at the halt, money still lands on the books.
    function test_ZeroWeightHaltKeepsAccumulatorsZero() public {
        _postSingle(_curEpoch(), _leaf(1, 1, alice, 600e18), 3);
        _claim(_curEpoch(), 1, 1, alice, 600e18);
        _postSingle(_curEpoch(), _leaf(2, 2, bob, 400e18), 3);
        _claim(_curEpoch(), 2, 2, bob, 400e18);
        assertEq(bridge.creditsOutstanding(), 0);
        assertEq(bridge.unattributedExited(), 0);
        _haltWith(4);
        (uint256 weight, uint256 accBac, uint256 accBnb,,) = bridge.escapeState();
        assertEq(weight, 0);
        assertEq(accBac, 0, "B13");
        assertEq(accBnb, 0, "B13");

        bridge.acceptRelease{value: 1 ether}();
        assertEq(bridge.bnbBalance(), 1 ether, "B13");
        assertEq(bridge.accPerWeightBnb(), 0, "B13");
    }

    /// Regression (found by the invariant run): with an over-earning agent the junior weights
    /// sum to MORE than `issued - exited`, so the spec's literal denominator over-distributes.
    function test_EscapeWeightCoversOverEarningAgents() public {
        bytes32 leaf = _leaf(1, 2, bob, 600e18);
        _postSingle(_curEpoch(), leaf, 3);
        _claim(_curEpoch(), 1, 2, bob, 600e18);
        assertEq(bridge.unattributedExited(), 200e18);
        assertEq(bridge.creditsOutstanding(), 400e18);

        _haltWith(4);
        (uint256 weight,,,,) = bridge.escapeState();
        uint256 sumOfWeights =
            (bridge.credited(1) - bridge.exitedCredits(1)) + (bridge.credited(2) - bridge.exitedCredits(2));
        assertEq(weight, sumOfWeights, "escape denominator must be the sum of the weights");
        assertEq(weight, 600e18);

        uint256 stockAtHalt = bridge.buybackBac();
        vm.prank(alice);
        (uint256 paidA,) = bridge.escapeCollect(1, alice);
        vm.prank(bob);
        (bool ok, bytes memory ret) =
            address(bridge).call(abi.encodeWithSignature("escapeCollect(uint256,address)", uint256(2), bob));
        uint256 paidB = ok ? abi.decode(ret, (uint256)) : 0; // weight 0 -> nothing to collect
        assertLe(paidA + paidB, stockAtHalt, "junior pot over-distributed");
        assertLe(bridge.owedTotal(), bridge.buybackBac(), "B1");

        // the senior claim must still be payable in full afterwards
        vm.warp(vm.getBlockTimestamp() + bridge.OWED_MATURITY());
        uint256 senior = bridge.owed(bob);
        vm.prank(bob);
        assertEq(bridge.claimOwedAfterHalt(bob), senior);
        _assertBacBooks();
    }

    /// B8: the watchdog and the veto key have no path to the money. (The OWNER does, by design —
    /// decision #29 — and that is tested on its own in `BacBridgeEmergencyTest`.)
    function test_WatchdogAndVetoKeyHaveNoPathToFunds() public {
        _aliceExits(100e18, 1);
        uint256 wdBefore = watchdog.balance;
        uint256 vkBefore = vetoKey.balance;

        vm.startPrank(watchdog);
        bridge.pause();
        bridge.unpause();
        bridge.armEscape();
        vm.stopPrank();

        vm.prank(vetoKey);
        bridge.cancelEscapeArm();

        assertEq(watchdog.balance, wdBefore);
        assertEq(vetoKey.balance, vkBefore);
        assertEq(bac.balanceOf(watchdog), 0);
        assertEq(bac.balanceOf(vetoKey), 0);
        // the owner is a separate key, and neither role can use the owner's powers
        assertEq(bridge.owner(), owner, "decision #29: the bridge has an owner");
        vm.prank(watchdog);
        vm.expectRevert(unicode"Only owner / 仅限 owner");
        bridge.emergencyWithdrawBnb(payable(watchdog), 0);
        vm.prank(vetoKey);
        vm.expectRevert(unicode"Only owner / 仅限 owner");
        bridge.emergencyWithdrawToken(address(bac), vetoKey, 0);
        (bool ok,) = address(bridge).call(abi.encodeWithSignature("admin()"));
        assertFalse(ok, "no second admin role");
    }

    /// The watchdog cannot stop the escape path once halted.
    function test_PauseCannotFreezeEscapePath() public {
        _aliceExits(100e18, 1);
        vm.prank(watchdog);
        bridge.pause();
        _haltWith(4);
        vm.warp(vm.getBlockTimestamp() + bridge.OWED_MATURITY());

        vm.prank(alice);
        assertGt(bridge.claimOwedAfterHalt(alice), 0, "pause must not freeze the senior claim");
        vm.prank(bob);
        (uint256 bacB,) = bridge.escapeCollect(2, bob);
        assertGt(bacB, 0, "pause must not freeze the junior claim");
    }
}

// ============================================================================
//          PER-DEBT MATURITY  (v1.1, review finding 2026-09-23: dust reset)
// ============================================================================

/// @dev v1 kept ONE `lastClaimAt` per address and let every `claimExit` in its favour reset it
///      for the address's WHOLE owed. `L2Bridge.exit` lets any exiter name any BSC recipient and
///      `claimExit` is permissionless, so a 101-wei-credit exit sent to a victim during a cause-2/3
///      arming window made the victim's long-matured claim immature: `claimOwedAfterHalt`
///      refused it and anyone could `sweepImmatureOwed` it into the junior pot, where the
///      attacker's own escape weight collected it. Maturity is now per debt.
contract BacBridgeMaturityTest is BacBridgeTestBase {
    address[] internal holders;
    uint256 internal carolOwed;

    function setUp() public override {
        super.setUp();
        _lock(alice, 1, 600e18); // alice: the attacker, keeps her whole escape weight
        _lock(carol, 3, 400e18); // carol: exits everything, so her only claim is her owed
        _seedBuyback(10e18);
        carolOwed = _exit(carol, 3, 1, 400e18);
        assertGt(carolOwed, 0);
        vm.warp(vm.getBlockTimestamp() + 20 days); // carol's claim is now mature
    }

    function _exit(address to, uint256 agentId, uint256 exitId, uint256 credits) internal returns (uint256) {
        uint64 e = _curEpoch();
        _postSingle(e, _leaf(exitId, agentId, to, credits), 3);
        return _claim(e, exitId, agentId, to, credits);
    }

    /// Arms a cause-2 halt, lets `beforeDust` pass, has the ATTACKER route a dust exit to carol,
    /// then halts at the earliest moment.
    function _dustDuringArming(uint256 beforeDust) internal returns (uint256 dust) {
        anchor.setHaltReason(2);
        bridge.checkHalt();
        vm.warp(vm.getBlockTimestamp() + beforeDust);
        vm.prank(alice); // permissionless: the attacker submits it herself
        dust = _exit(carol, 1, 99, 101);
        assertGt(dust, 0, "the dust exit locked something for carol");
        vm.warp(vm.getBlockTimestamp() + bridge.ESCAPE_ARM_DELAY() - beforeDust);
        bridge.checkHalt();
        assertTrue(bridge.isHalted());
        assertEq(bridge.haltCause(), 2);
    }

    /// The exact attack of the finding, replayed: carol keeps her senior claim.
    function test_DustExitDuringArmingCannotDemoteAMaturedClaim() public {
        uint256 dust = _dustDuringArming(1 days);
        assertEq(bridge.owed(carol), carolOwed + dust);
        assertEq(bridge.maturedOwed(carol), carolOwed, "only the dust is young");

        // carol is paid her matured claim at once - v1 reverted "Owed not matured" here
        vm.prank(carol);
        assertEq(bridge.claimOwedAfterHalt(carol), carolOwed);
        assertEq(bac.balanceOf(carol), carolOwed, "the senior claim is paid in BAC");
        assertEq(bridge.owed(carol), dust, "the young dust is still owed");

        vm.prank(carol);
        vm.expectRevert(unicode"Owed not matured / 债权尚未成熟");
        bridge.claimOwedAfterHalt(carol);

        // after the maturity window only the dust can be demoted, never the paid claim
        vm.warp(vm.getBlockTimestamp() + bridge.OWED_MATURITY());
        vm.prank(alice);
        bridge.sweepImmatureOwed(carol);
        assertEq(bridge.owed(carol), 0);

        // alice's escape share is her own weight's share, NOT carol's claim on top
        (uint256 aliceBac,) = bridge.escapeClaimable(1);
        assertLt(aliceBac, 10e18 - carolOwed + dust + 1, "the attacker must not collect carol's claim");
        _assertBacBooks();
    }

    /// Order does not matter: the victim can also claim AFTER the sweep. A sweep of an address
    /// whose whole owed is matured is refused, and a sweep with dust takes only the dust.
    function test_SweepBeforeTheVictimClaimsTakesOnlyTheYoungPart() public {
        uint256 dust = _dustDuringArming(3 days);
        vm.warp(vm.getBlockTimestamp() + bridge.OWED_MATURITY());
        uint256 accBefore = bridge.accPerWeightBac();
        bridge.sweepImmatureOwed(carol);
        assertEq(bridge.owed(carol), carolOwed, "the matured claim stayed owed");
        assertEq(bridge.owedTotal(), carolOwed);
        (uint256 w,,,,) = bridge.escapeState();
        assertEq(bridge.accPerWeightBac() - accBefore, (dust * 1e18) / w, "only the dust went junior");

        vm.expectRevert(unicode"Owed already matured / 该债权已成熟");
        bridge.sweepImmatureOwed(carol);
        vm.prank(carol);
        assertEq(bridge.claimOwedAfterHalt(carol), carolOwed);
        vm.expectRevert(unicode"Nothing to demote / 没有可降级的债权");
        bridge.sweepImmatureOwed(carol);
        _assertBacBooks();
    }

    /// The rule the maturity check exists for still holds: debt claimed inside the arming window
    /// (what a forged root produces) is demoted under cause 2, even when the SAME address also
    /// holds an older matured claim that stays senior.
    function test_OwnYoungDebtIsStillDemotedNextToAMaturedClaim() public {
        anchor.setHaltReason(2);
        bridge.checkHalt();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        uint256 young = _exit(carol, 1, 7, 300e18); // a big, young claim in carol's favour
        vm.warp(vm.getBlockTimestamp() + bridge.ESCAPE_ARM_DELAY() - 1 days); // halt at the earliest
        bridge.checkHalt();
        assertEq(bridge.maturedOwed(carol), carolOwed);

        vm.prank(carol);
        assertEq(bridge.claimOwedAfterHalt(carol), carolOwed, "only the matured part is senior");
        vm.warp(vm.getBlockTimestamp() + bridge.OWED_MATURITY());
        vm.prank(carol);
        vm.expectRevert(unicode"Owed not matured / 债权尚未成熟");
        bridge.claimOwedAfterHalt(carol); // cause 2: the young part never becomes senior
        bridge.sweepImmatureOwed(carol);
        assertEq(bridge.owed(carol), 0);
        assertGt(young, 0);
        _assertBacBooks();
    }

    /// Under a cause that keeps priority (1, 4, 5) the matured part is paid at once and the young
    /// part `OWED_MATURITY` after the halt, in a second call.
    function test_Cause1PaysTheMaturedPartNowAndTheRestLater() public {
        anchor.setHaltReason(1);
        bridge.checkHalt();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        uint256 dust = _exit(carol, 1, 99, 101);
        vm.warp(vm.getBlockTimestamp() + bridge.ESCAPE_ARM_DELAY() - 1 days); // halt at the earliest
        bridge.checkHalt();

        vm.prank(carol);
        assertEq(bridge.claimOwedAfterHalt(carol), carolOwed);
        vm.warp(vm.getBlockTimestamp() + bridge.OWED_MATURITY());
        vm.prank(carol);
        assertEq(bridge.claimOwedAfterHalt(carol), dust);
        assertEq(bridge.owed(carol), 0);
        assertEq(bac.balanceOf(carol), carolOwed + dust);
        _assertBacBooks();
    }

    /// The watchdog side of the same bug: in v1 a dust exit in a later epoch made the whole
    /// address young, and `revokeEpochOwed` on the OLD epoch then voided carol's matured claim.
    function test_DustCannotOpenAMaturedClaimToTheWatchdog() public {
        uint64 oldEpoch = uint64((vm.getBlockTimestamp() - 20 days) / E);
        assertEq(bridge.epochOwed(oldEpoch, carol), carolOwed);
        uint64 dustEpoch = _curEpoch();
        uint256 dust = _exit(carol, 1, 99, 101);

        assertEq(bridge.maturedOwed(carol), carolOwed, "the dust did not make the old claim young");

        vm.prank(watchdog);
        bridge.pause();
        holders = [carol];
        // v1 revoked all of carol's 4e18 here. Now at most the young dust can go, never the
        // matured claim (the revoke is bounded by the address's young part).
        vm.prank(watchdog);
        assertLe(bridge.revokeEpochOwed(oldEpoch, holders), dust, "the matured claim is untouchable");
        assertGe(bridge.owed(carol), carolOwed);
        vm.prank(watchdog);
        bridge.revokeEpochOwed(dustEpoch, holders);
        assertEq(bridge.owed(carol), carolOwed, "exactly the matured claim is left");
        // and with nothing young left, even the old epoch's record cannot be used again
        vm.prank(watchdog);
        assertEq(bridge.revokeEpochOwed(oldEpoch, holders), 0);
        assertEq(bridge.owed(carol), carolOwed);
        _assertBacBooks();
    }

    /// Payments count against the oldest debt first: collecting can only shrink the matured part.
    function test_CollectCountsAgainstTheOldestDebtFirst() public {
        uint256 young = _exit(carol, 1, 8, 200e18);
        assertEq(bridge.maturedOwed(carol), carolOwed);
        _warpEpochs(1);
        _settleNext(3);
        vm.prank(carol);
        uint256 paid = bridge.collect(carol);
        assertGt(paid, 0);
        assertLt(paid, carolOwed, "test premise: a partial payment");
        assertEq(bridge.owedPaid(carol), paid);
        assertEq(bridge.maturedOwed(carol), carolOwed - paid, "the payment came off the oldest debt");
        assertEq(bridge.owed(carol), carolOwed + young - paid);
        // and once the young debt ages, everything left is matured
        vm.warp(vm.getBlockTimestamp() + bridge.OWED_MATURITY());
        assertEq(bridge.maturedOwed(carol), bridge.owed(carol));
    }

    /// Two claims in one block are one history point; a later block adds a point.
    function test_ClaimHistoryIsOnePointPerBlock() public {
        uint256 slot = uint256(keccak256(abi.encode(carol, uint256(350))));
        assertEq(uint256(vm.load(address(bridge), bytes32(slot))), 1, "carol's first claim: one point");
        _exit(carol, 1, 10, 1e18);
        _exit(carol, 1, 11, 1e18);
        assertEq(uint256(vm.load(address(bridge), bytes32(slot))), 2, "same block: one more point");
        vm.warp(vm.getBlockTimestamp() + 1);
        _exit(carol, 1, 12, 1e18);
        assertEq(uint256(vm.load(address(bridge), bytes32(slot))), 3);
    }

    /// Owed that predates the history (an upgrade over live claims) is dated by its old
    /// `lastClaimAt`, and a later claim can never make it young: the upgrade itself is safe.
    function test_OwedFromBeforeTheHistoryKeepsItsAge() public {
        // carol's claim, as a v1 bridge would have stored it: owed + lastClaimAt, no history
        uint256 slot = uint256(keccak256(abi.encode(carol, uint256(350))));
        vm.store(address(bridge), bytes32(slot), bytes32(0));
        assertEq(bridge.maturedOwed(carol), carolOwed, "dated by lastClaimAt");

        uint256 dust = _exit(carol, 1, 99, 101);
        assertEq(uint256(vm.load(address(bridge), bytes32(slot))), 2, "the old debt was entered first");
        assertEq(bridge.maturedOwed(carol), carolOwed, "and kept its age");
        assertEq(bridge.owed(carol), carolOwed + dust);
        vm.warp(vm.getBlockTimestamp() + bridge.OWED_MATURITY());
        assertEq(bridge.maturedOwed(carol), carolOwed + dust);
    }
}

// ============================================================================
//                     PROXY / UUPS UPGRADES  (decision #29, #29c)
// ============================================================================

contract BacBridgeUpgradeTest is BacBridgeTestBase {
    /// @dev Pinned from `forge inspect BacBridge storageLayout`. `test_StorageLayoutIsPinned`
    ///      re-derives each of them from live state, so a layout change fails loudly here.
    uint256 internal constant FIRST_SLOT = 301; // bacToken
    uint256 internal constant COUNTERS_SLOT = 349; // emergencyCount | lastEmergencyAt | upgradeCount | lastUpgradeAt
    /// @dev v1.1 (the first upgrade of the deployed bridge) appended two mappings out of the gap.
    uint256 internal constant CLAIM_HISTORY_SLOT = 350;
    uint256 internal constant OWED_PAID_SLOT = 351;
    uint256 internal constant GAP_START = 352;
    uint256 internal constant GAP_LEN = 40;
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    function _implOf(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, IMPL_SLOT))));
    }

    function _counters()
        internal
        view
        returns (uint64 emergencyCount, uint64 lastEmergencyAt, uint64 upgradeCount, uint64 lastUpgradeAt)
    {
        uint256 w = uint256(vm.load(address(bridge), bytes32(COUNTERS_SLOT)));
        return (uint64(w), uint64(w >> 64), uint64(w >> 128), uint64(w >> 192));
    }

    /// @dev Touches as much of the storage as one test can: both buckets, a real buyback, an
    ///      exit, a release, a collect, a pause, a burn, a controller hand-over and an owner
    ///      withdrawal, so the upgrade test has live values in nearly every slot.
    function _busyBridge() internal returns (uint64 exitEpoch) {
        _lock(alice, 1, 600e18);
        _lock(bob, 2, 400e18);
        vm.deal(address(this), 100 ether);
        bridge.acceptRelease{value: 10 ether}();
        _warpEpochs(144);
        assertGt(bridge.buyback(0, 0), 0);
        _seedBuyback(10e18);
        exitEpoch = _curEpoch();
        _postSingle(exitEpoch, _leaf(1, 1, alice, 100e18), 3);
        _claim(exitEpoch, 1, 1, alice, 100e18);
        _warpEpochs(1);
        _settleNext(3);
        vm.prank(alice);
        bridge.collect(alice);
        vm.startPrank(watchdog);
        bridge.pause();
        _warpEpochs(3);
        bridge.unpause();
        vm.stopPrank();
        bridge.burnLocked();
        vm.prank(bob);
        bridge.setAgentController(2, carol);
        vm.prank(owner);
        bridge.emergencyWithdrawBnb(payable(treasury), 1 ether);
    }

    function _sampleMappings(uint64 exitEpoch) internal view returns (uint256[12] memory) {
        return [
            bridge.owedPaid(alice),
            bridge.maturedOwed(alice),
            bridge.credited(1),
            bridge.credited(2),
            bridge.exitedCredits(1),
            bridge.owed(alice),
            bridge.unclaimed(alice),
            bridge.unreleasedOwed(alice),
            uint256(bridge.lastClaimAt(alice)),
            uint256(bridge.lastCollectEpoch(alice)),
            bridge.epochOwed(exitEpoch, alice),
            bridge.escapeDebtBac(1)
        ];
    }

    function test_ImplementationCanNeverBeInitialisedOrUpgraded() public {
        vm.expectRevert("Initializable: contract is already initialized");
        impl.initialize(
            owner, address(bac), address(identity), address(anchor), watchdog, address(portal), address(router)
        );
        assertEq(impl.owner(), address(0), "the bare implementation has no owner");

        BacBridgeV2Mock v2 = new BacBridgeV2Mock();
        vm.expectRevert("Function must be called through delegatecall");
        impl.upgradeTo(address(v2));
    }

    function test_InitializeRunsExactlyOnce() public {
        vm.expectRevert("Initializable: contract is already initialized");
        bridge.initialize(
            stranger, address(bac), address(identity), address(anchor), watchdog, address(portal), address(router)
        );
        assertEq(bridge.owner(), owner);
    }

    function test_InitializeWiresEverythingAndStartsTheCursors() public view {
        assertEq(bridge.owner(), owner);
        assertEq(bridge.pendingOwner(), address(0));
        assertEq(bridge.bacToken(), address(bac));
        assertEq(bridge.identityRegistry(), address(identity));
        assertEq(bridge.anchor(), address(anchor));
        assertEq(bridge.watchdog(), watchdog);
        assertEq(bridge.portal(), address(portal));
        assertEq(bridge.router(), address(router));
        assertEq(uint256(bridge.lastSettledEpoch()), T0 / E, "settle cursor starts at the deploy epoch");
        assertEq(uint256(bridge.lastBuybackEpoch()), T0 / E);
        assertEq(_implOf(address(bridge)), address(impl));
        assertEq(bridge.EXTENSION(), impl.EXTENSION(), "the proxy reads the implementation's extension");
        assertGt(bridge.EXTENSION().code.length, 0);
        assertEq(uint256(bridge.upgradeCount()), 0);
        assertEq(uint256(bridge.emergencyCount()), 0);
    }

    function test_InitializeRejectsEveryZeroAddress() public {
        address[7] memory a =
            [owner, address(bac), address(identity), address(anchor), watchdog, address(portal), address(router)];
        string[7] memory why = [
            unicode"Zero owner / owner 地址为零",
            unicode"Zero BAC token / BAC 代币地址为零",
            unicode"Zero identity registry / 身份注册表地址为零",
            unicode"Zero anchor / 锚点地址为零",
            unicode"Zero watchdog / 看门狗地址为零",
            unicode"Zero portal / Portal 地址为零",
            unicode"Zero router / 路由地址为零"
        ];
        for (uint256 i = 0; i < 7; i++) {
            address[7] memory b;
            for (uint256 j = 0; j < 7; j++) {
                b[j] = i == j ? address(0) : a[j];
            }
            vm.expectRevert(bytes(why[i]));
            deployBacBridge(impl, b[0], b[1], b[2], b[3], b[4], b[5], b[6]);
        }
    }

    function test_UpgradeIsOwnerOnly() public {
        BacBridgeV2Mock v2 = new BacBridgeV2Mock();
        address[3] memory nope = [stranger, watchdog, vetoKey];
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(nope[i]);
            vm.expectRevert(unicode"Only owner / 仅限 owner");
            bridge.upgradeTo(address(v2));
        }
        assertEq(_implOf(address(bridge)), address(impl));
    }

    /// OpenZeppelin's UUPS check: an implementation that cannot itself be upgraded is refused, so
    /// a slip of the owner's finger cannot strand the proxy.
    function test_UpgradeRefusesANonUupsImplementation() public {
        vm.prank(owner);
        vm.expectRevert("ERC1967Upgrade: new implementation is not UUPS");
        bridge.upgradeTo(address(bac));

        // nor can the proxy be pointed at its own extension, which would strand it
        address ext = bridge.EXTENSION();
        vm.prank(owner);
        vm.expectRevert("ERC1967Upgrade: new implementation is not UUPS");
        bridge.upgradeTo(ext);
    }

    /// The extension's copies of the events must be the very same events the ABI of `BacBridge`
    /// promises, or the indexer would miss everything the extension emits.
    function test_ExtensionEmitsTheSameEventsAsTheBridge() public pure {
        assertEq(BacBridgeExtension.EpochSettled.selector, BacBridge.EpochSettled.selector);
        assertEq(BacBridgeExtension.EpochOwedRevoked.selector, BacBridge.EpochOwedRevoked.selector);
        assertEq(BacBridgeExtension.EscapeArmed.selector, BacBridge.EscapeArmed.selector);
        assertEq(BacBridgeExtension.EscapeArmCancelled.selector, BacBridge.EscapeArmCancelled.selector);
        assertEq(BacBridgeExtension.Halted.selector, BacBridge.Halted.selector);
        assertEq(BacBridgeExtension.OwedPaidAfterHalt.selector, BacBridge.OwedPaidAfterHalt.selector);
        assertEq(BacBridgeExtension.OwedDemoted.selector, BacBridge.OwedDemoted.selector);
        assertEq(BacBridgeExtension.EscapeCollected.selector, BacBridge.EscapeCollected.selector);
        assertEq(BacBridgeExtension.Paused.selector, BacBridge.Paused.selector);
        assertEq(BacBridgeExtension.Unpaused.selector, BacBridge.Unpaused.selector);
        assertEq(BacBridgeExtension.AgentControllerSet.selector, BacBridge.AgentControllerSet.selector);
        assertEq(BacBridgeExtension.EmergencyWithdraw.selector, BacBridge.EmergencyWithdraw.selector);
    }

    /// Guards the constants above against the live layout: if a variable is ever inserted above
    /// `__gap`, one of these reads moves and this test (and the V2 mock's premise) fails.
    function test_StorageLayoutIsPinned() public {
        _busyBridge();
        assertEq(address(uint160(uint256(vm.load(address(bridge), bytes32(FIRST_SLOT))))), address(bac));
        (uint64 ec, uint64 lea, uint64 uc, uint64 lua) = _counters();
        assertEq(uint256(ec), uint256(bridge.emergencyCount()));
        assertEq(uint256(lea), uint256(bridge.lastEmergencyAt()));
        assertEq(uint256(uc), uint256(bridge.upgradeCount()));
        assertEq(uint256(lua), uint256(bridge.lastUpgradeAt()));
        assertEq(uint256(ec), 1);
        // v1.1's two mappings sit exactly where the upgrade put them
        assertEq(uint256(vm.load(address(bridge), keccak256(abi.encode(alice, CLAIM_HISTORY_SLOT)))), 1, "claimHistory");
        assertGt(bridge.owedPaid(alice), 0, "test premise: alice collected");
        assertEq(uint256(vm.load(address(bridge), keccak256(abi.encode(alice, OWED_PAID_SLOT)))), bridge.owedPaid(alice));
        // a mapping's own slot is never written
        assertEq(vm.load(address(bridge), bytes32(CLAIM_HISTORY_SLOT)), bytes32(0));
        assertEq(vm.load(address(bridge), bytes32(OWED_PAID_SLOT)), bytes32(0));
        for (uint256 s = GAP_START; s < GAP_START + GAP_LEN; s++) {
            assertEq(vm.load(address(bridge), bytes32(s)), bytes32(0), "the gap must be unused");
        }
    }

    /// Requirement 1: every existing slot survives an upgrade to a V2 that adds a variable by the
    /// `__gap` rule; only the upgrade counters move, and V2's variable lands in the old gap.
    function test_EveryExistingSlotSurvivesAnUpgradeToV2() public {
        uint64 exitEpoch = _busyBridge();

        // raw snapshot of every sequential slot, OpenZeppelin's included
        uint256 n = GAP_START + GAP_LEN;
        bytes32[] memory before = new bytes32[](n);
        for (uint256 s = 0; s < n; s++) {
            before[s] = vm.load(address(bridge), bytes32(s));
        }
        // and a sample of the hashed (mapping) slots through their getters
        (address dFrom, uint64 dAt, uint256 dAgent, uint256 dAmount) = bridge.deposits(1);
        uint256[12] memory m = _sampleMappings(exitEpoch);
        address ext1 = bridge.EXTENSION();

        BacBridgeV2Mock v2 = new BacBridgeV2Mock();
        vm.prank(owner);
        bridge.upgradeToAndCall(address(v2), abi.encodeCall(BacBridgeV2Mock.initializeV2, (0xBEEF)));

        assertEq(_implOf(address(bridge)), address(v2));
        for (uint256 s = 1; s < GAP_START; s++) {
            if (s == COUNTERS_SLOT) continue; // checked below
            assertEq(vm.load(address(bridge), bytes32(s)), before[s], string.concat("slot moved: ", vm.toString(s)));
        }
        // slot 0: Initializable's `_initialized` goes 1 -> 2 (the reinitializer) and nothing else
        assertEq(uint256(before[0]), 1);
        assertEq(uint256(vm.load(address(bridge), bytes32(0))), 2);
        // the counters slot: only the upgrade half moved
        (uint64 ec, uint64 lea, uint64 uc, uint64 lua) = _counters();
        assertEq(uint256(ec), uint256(before[COUNTERS_SLOT]) & type(uint64).max);
        assertEq(uint256(lea), (uint256(before[COUNTERS_SLOT]) >> 64) & type(uint64).max);
        assertEq(uint256(uc), 1);
        assertEq(uint256(lua), vm.getBlockTimestamp());
        // V2's new variable took exactly the first gap slot, and the rest of the gap is untouched
        assertEq(uint256(vm.load(address(bridge), bytes32(GAP_START))), 0xBEEF);
        assertEq(BacBridgeV2Mock(address(bridge)).v2Marker(), 0xBEEF);
        for (uint256 s = GAP_START + 1; s < n; s++) {
            assertEq(vm.load(address(bridge), bytes32(s)), bytes32(0));
        }

        (address dFrom2, uint64 dAt2, uint256 dAgent2, uint256 dAmount2) = bridge.deposits(1);
        assertEq(dFrom2, dFrom);
        assertEq(uint256(dAt2), uint256(dAt));
        assertEq(dAgent2, dAgent);
        assertEq(dAmount2, dAmount);
        uint256[12] memory m2 = _sampleMappings(exitEpoch);
        for (uint256 i = 0; i < 12; i++) {
            assertEq(m2[i], m[i], "a mapping slot moved");
        }
        assertEq(bridge.agentController(2), carol);
        assertEq(BacBridgeV2Mock(address(bridge)).version(), 2);

        // a new implementation brings its own extension, and the delegated paths still work
        assertTrue(bridge.EXTENSION() != ext1, "V2 deployed its own extension");
        vm.prank(watchdog);
        bridge.pause();
        vm.prank(watchdog);
        bridge.unpause();

        // and the bridge simply keeps running on the old books
        _warpEpochs(1);
        _settleNext(3);
        vm.prank(alice);
        assertGt(bridge.collect(alice), 0, "an exit locked under V1 pays under V2");
        _lock(carol, 3, 1e18);
        assertEq(bridge.agentController(3), carol);

        // neither initializer can be replayed
        vm.expectRevert("Initializable: contract is already initialized");
        BacBridgeV2Mock(address(bridge)).initializeV2(1);
        vm.expectRevert("Initializable: contract is already initialized");
        bridge.initialize(
            stranger, address(bac), address(identity), address(anchor), watchdog, address(portal), address(router)
        );
    }

    /// Decision #29c: the event names the implementation being REPLACED and snapshots the books.
    function test_BridgeUpgradedCarriesThePreviousImplementationAndTheBooks() public {
        _busyBridge();
        BacBridgeV2Mock v2 = new BacBridgeV2Mock();
        assertGt(bridge.totalBurned(), 0, "the snapshot must show the held deposits, not the lifetime ones");

        vm.expectEmit(true, true, true, true, address(bridge));
        emit BacBridge.BridgeUpgraded(
            address(v2),
            address(impl),
            owner,
            1,
            uint64(vm.getBlockTimestamp()),
            bridge.bnbBalance(),
            bridge.lockedBac() - bridge.totalBurned(),
            bridge.buybackBac(),
            bridge.owedTotal()
        );
        vm.prank(owner);
        bridge.upgradeTo(address(v2));

        // and back again: now V2 is the one being replaced
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.expectEmit(true, true, true, true, address(bridge));
        emit BacBridge.BridgeUpgraded(
            address(impl),
            address(v2),
            owner,
            2,
            uint64(vm.getBlockTimestamp()),
            bridge.bnbBalance(),
            bridge.lockedBac() - bridge.totalBurned(),
            bridge.buybackBac(),
            bridge.owedTotal()
        );
        vm.prank(owner);
        bridge.upgradeTo(address(impl));
        assertEq(uint256(bridge.upgradeCount()), 2);
        assertEq(uint256(bridge.lastUpgradeAt()), vm.getBlockTimestamp());
        assertEq(_implOf(address(bridge)), address(impl));
    }

    /// Owner powers sit above the halt: the rules can still be changed after an escape.
    function test_UpgradeStillWorksWhenHalted() public {
        vm.prank(watchdog);
        bridge.armEscape();
        vm.warp(vm.getBlockTimestamp() + bridge.ESCAPE_ARM_DELAY());
        bridge.checkHalt();
        assertTrue(bridge.isHalted());
        BacBridgeV2Mock v2 = new BacBridgeV2Mock();
        vm.prank(owner);
        bridge.upgradeTo(address(v2));
        assertTrue(bridge.isHalted(), "the halt itself survives the upgrade");
    }

    /// The extension only ever runs in the bridge's storage; called directly it refuses.
    function test_ExtensionRefusesDirectCalls() public {
        BacBridgeExtension ext = BacBridgeExtension(bridge.EXTENSION());
        vm.prank(watchdog);
        vm.expectRevert(unicode"Call the bridge, not the extension / 请调用桥合约，而非扩展合约");
        ext.pause();
        vm.prank(owner);
        vm.expectRevert(unicode"Call the bridge, not the extension / 请调用桥合约，而非扩展合约");
        ext.emergencyWithdrawBnb(payable(owner), 0);
        vm.expectRevert(unicode"Call the bridge, not the extension / 请调用桥合约，而非扩展合约");
        ext.checkHalt();
    }
}

// ============================================================================
//                    OWNERSHIP  (Ownable2Step, no renounce)
// ============================================================================

contract BacBridgeOwnershipTest is BacBridgeTestBase {
    function test_OwnershipTransferIsTwoStep() public {
        address next = makeAddr("nextOwner");
        vm.prank(stranger);
        vm.expectRevert(unicode"Only owner / 仅限 owner");
        bridge.transferOwnership(next);

        vm.prank(owner);
        bridge.transferOwnership(next);
        assertEq(bridge.owner(), owner, "nothing changes until the new owner accepts");
        assertEq(bridge.pendingOwner(), next);

        vm.prank(stranger);
        vm.expectRevert(unicode"Only pending owner / 仅限待定 owner");
        bridge.acceptOwnership();

        vm.prank(next);
        bridge.acceptOwnership();
        assertEq(bridge.owner(), next);
        assertEq(bridge.pendingOwner(), address(0));

        // the powers moved with it
        vm.deal(address(this), 1 ether);
        bridge.acceptRelease{value: 1 ether}();
        vm.prank(owner);
        vm.expectRevert(unicode"Only owner / 仅限 owner");
        bridge.emergencyWithdrawBnb(payable(owner), 0);
        vm.prank(next);
        bridge.emergencyWithdrawBnb(payable(next), 0);
        assertEq(next.balance, 1 ether);
    }

    /// A conscious choice (decision #29): renouncing would freeze upgrades and both emergency
    /// withdrawals forever — exactly the "money stuck, game over" case the owner powers exist
    /// for. So it is disabled for everybody, the owner included.
    function test_RenounceOwnershipIsDisabled() public {
        vm.prank(owner);
        vm.expectRevert(unicode"Renounce disabled / 已禁用放弃所有权");
        bridge.renounceOwnership();
        assertEq(bridge.owner(), owner);

        vm.prank(stranger);
        vm.expectRevert(unicode"Renounce disabled / 已禁用放弃所有权");
        bridge.renounceOwnership();
    }

    /// `transferOwnership(0)` is OpenZeppelin's way of cancelling a pending transfer; it can never
    /// be used to renounce by the back door, because address zero can never accept.
    function test_TransferToZeroOnlyCancelsAPendingTransfer() public {
        address next = makeAddr("nextOwner");
        vm.startPrank(owner);
        bridge.transferOwnership(next);
        bridge.transferOwnership(address(0));
        vm.stopPrank();
        assertEq(bridge.pendingOwner(), address(0));
        assertEq(bridge.owner(), owner);
        vm.prank(next);
        vm.expectRevert(unicode"Only pending owner / 仅限待定 owner");
        bridge.acceptOwnership();
    }
}

// ============================================================================
//             EMERGENCY WITHDRAWALS  (decision #29: books NOT written down)
// ============================================================================

contract BacBridgeEmergencyTest is BacBridgeTestBase {
    function setUp() public override {
        super.setUp();
        _lock(alice, 1, 1000e18);
        _seedBuyback(10e18);
        vm.deal(address(this), 1000 ether);
        bridge.acceptRelease{value: 10 ether}();
    }

    function _haltNow() internal {
        vm.prank(watchdog);
        bridge.armEscape();
        vm.warp(vm.getBlockTimestamp() + bridge.ESCAPE_ARM_DELAY());
        bridge.checkHalt();
        assertTrue(bridge.isHalted());
    }

    /// The whole design in one test: BNB leaves, the book does not move, and the difference is
    /// reported exactly and counted on its own.
    function test_WithdrawBnbLeavesTheBooksAndCountsItself() public {
        vm.expectEmit(true, true, true, true, address(bridge));
        emit BacBridge.EmergencyWithdraw(
            owner, treasury, address(0), 4 ether, 6 ether, 10 ether, 4 ether, 1, uint64(vm.getBlockTimestamp())
        );
        vm.prank(owner);
        bridge.emergencyWithdrawBnb(payable(treasury), 4 ether);

        assertEq(treasury.balance, 4 ether);
        assertEq(address(bridge).balance, 6 ether);
        assertEq(bridge.bnbBalance(), 10 ether, "the book is deliberately NOT written down");
        (uint256 bnbShort, uint256 bacShort) = bridge.shortfall();
        assertEq(bnbShort, 4 ether);
        assertEq(bacShort, 0);
        assertEq(bridge.emergencyBnbWithdrawn(), 4 ether);
        assertEq(uint256(bridge.emergencyCount()), 1);
        assertEq(uint256(bridge.lastEmergencyAt()), vm.getBlockTimestamp());

        vm.prank(owner);
        bridge.emergencyWithdrawBnb(payable(treasury), 0); // 0 == everything
        assertEq(address(bridge).balance, 0);
        (bnbShort,) = bridge.shortfall();
        assertEq(bnbShort, 10 ether);
        assertEq(bridge.emergencyBnbWithdrawn(), 10 ether);
        assertEq(uint256(bridge.emergencyCount()), 2);
    }

    function test_WithdrawBnbGuards() public {
        vm.prank(stranger);
        vm.expectRevert(unicode"Only owner / 仅限 owner");
        bridge.emergencyWithdrawBnb(payable(stranger), 0);

        vm.startPrank(owner);
        vm.expectRevert(unicode"Zero recipient / 收款地址为零");
        bridge.emergencyWithdrawBnb(payable(address(0)), 1);
        vm.expectRevert(unicode"Amount exceeds balance / 金额超过余额");
        bridge.emergencyWithdrawBnb(payable(treasury), 10 ether + 1);
        bridge.emergencyWithdrawBnb(payable(treasury), 0);
        vm.expectRevert(unicode"Nothing to withdraw / 没有可提取的金额");
        bridge.emergencyWithdrawBnb(payable(treasury), 0);
        vm.stopPrank();
    }

    /// It takes the physical balance — force-pushed wei nobody booked yet included.
    function test_WithdrawBnbTakesUntrackedWeiToo() public {
        vm.deal(address(bridge), 11 ether); // 1 BNB force-pushed, not yet swept
        vm.prank(owner);
        bridge.emergencyWithdrawBnb(payable(treasury), 0);
        assertEq(treasury.balance, 11 ether);
        assertEq(bridge.emergencyBnbWithdrawn(), 11 ether);
        (uint256 bnbShort,) = bridge.shortfall();
        assertEq(bnbShort, 10 ether, "the shortfall is measured against the book, not the counter");
    }

    /// BAC is one asset to the owner: deposits and the buyback bucket alike.
    function test_WithdrawBacTakesDepositsAndBuybackAlikeAndCountsIt() public {
        vm.expectEmit(true, true, true, true, address(bridge));
        emit BacBridge.EmergencyWithdraw(
            owner, treasury, address(bac), 1010e18, 0, 1010e18, 1010e18, 1, uint64(vm.getBlockTimestamp())
        );
        vm.prank(owner);
        bridge.emergencyWithdrawToken(address(bac), treasury, 0);

        assertEq(bac.balanceOf(treasury), 1010e18);
        assertEq(bridge.lockedBac(), 1000e18, "books untouched");
        assertEq(bridge.buybackBac(), 10e18, "books untouched");
        assertEq(bridge.emergencyBacWithdrawn(), 1010e18);
        (uint256 bnbShort, uint256 bacShort) = bridge.shortfall();
        assertEq(bnbShort, 0);
        assertEq(bacShort, 1010e18);
    }

    function test_WithdrawForeignTokenKeepsNoBooks() public {
        MockBAC other = new MockBAC();
        other.mint(address(bridge), 5e18);
        vm.expectEmit(true, true, true, true, address(bridge));
        emit BacBridge.EmergencyWithdraw(
            owner, treasury, address(other), 5e18, 0, 0, 0, 1, uint64(vm.getBlockTimestamp())
        );
        vm.prank(owner);
        bridge.emergencyWithdrawToken(address(other), treasury, 0);
        assertEq(other.balanceOf(treasury), 5e18);
        assertEq(bridge.emergencyBacWithdrawn(), 0, "only BAC counts into the BAC counter");
        assertEq(uint256(bridge.emergencyCount()), 1, "but every withdrawal counts on the timeline");
    }

    function test_WithdrawTokenGuards() public {
        vm.prank(watchdog);
        vm.expectRevert(unicode"Only owner / 仅限 owner");
        bridge.emergencyWithdrawToken(address(bac), watchdog, 1);

        address notAToken = makeAddr("notAToken");
        MockBAC empty = new MockBAC();
        vm.startPrank(owner);
        vm.expectRevert(unicode"Zero recipient / 收款地址为零");
        bridge.emergencyWithdrawToken(address(bac), address(0), 1);
        vm.expectRevert(unicode"Amount exceeds balance / 金额超过余额");
        bridge.emergencyWithdrawToken(address(bac), treasury, 1010e18 + 1);
        vm.expectRevert(); // a "token" without code must not look like a successful transfer
        bridge.emergencyWithdrawToken(notAToken, treasury, 1);
        vm.expectRevert(unicode"Nothing to withdraw / 没有可提取的金额");
        bridge.emergencyWithdrawToken(address(empty), treasury, 0);
        vm.stopPrank();
    }

    /// Review finding (2026-09-23): a "withdrawal" to the bridge itself moved nothing yet emitted
    /// `EmergencyWithdraw` with `balanceAfter` 0 and inflated the lifetime counters, repeatably.
    /// Both functions now refuse the bridge as recipient and nothing is logged or counted.
    function test_WithdrawToTheBridgeItselfIsRefused() public {
        uint256 bacBefore = bac.balanceOf(address(bridge));
        vm.recordLogs();
        vm.startPrank(owner);
        vm.expectRevert(unicode"Recipient is the bridge / 收款地址不能是桥本身");
        bridge.emergencyWithdrawToken(address(bac), address(bridge), 0);
        vm.expectRevert(unicode"Recipient is the bridge / 收款地址不能是桥本身");
        bridge.emergencyWithdrawToken(address(bac), address(bridge), 1e18);
        vm.expectRevert(unicode"Recipient is the bridge / 收款地址不能是桥本身");
        bridge.emergencyWithdrawBnb(payable(address(bridge)), 0);
        vm.expectRevert(unicode"Recipient is the bridge / 收款地址不能是桥本身");
        bridge.emergencyWithdrawBnb(payable(address(bridge)), 1 ether);
        vm.stopPrank();
        assertEq(vm.getRecordedLogs().length, 0, "nothing may be logged for a self-send");

        assertEq(uint256(bridge.emergencyCount()), 0);
        assertEq(bridge.emergencyBacWithdrawn(), 0);
        assertEq(bridge.emergencyBnbWithdrawn(), 0);
        assertEq(bac.balanceOf(address(bridge)), bacBefore);
        assertEq(address(bridge).balance, 10 ether);

        // a real withdrawal still works right after, and is counted once
        vm.prank(owner);
        bridge.emergencyWithdrawToken(address(bac), treasury, 1e18);
        assertEq(uint256(bridge.emergencyCount()), 1);
        assertEq(bridge.emergencyBacWithdrawn(), 1e18);
    }

    /// Decision #29b: the owner sits above pause and halt alike.
    function test_EmergencyPowersIgnorePauseAndHalt() public {
        vm.prank(watchdog);
        bridge.pause();
        vm.prank(owner);
        bridge.emergencyWithdrawBnb(payable(treasury), 1 ether);
        _haltNow();
        vm.startPrank(owner);
        bridge.emergencyWithdrawBnb(payable(treasury), 1 ether);
        bridge.emergencyWithdrawToken(address(bac), treasury, 1e18);
        vm.stopPrank();
        assertEq(treasury.balance, 2 ether);
        assertEq(uint256(bridge.emergencyCount()), 3);
    }

    /// Requirement 2: the BNB sweep must not underflow when the balance sits below the book; a
    /// force-send first narrows the hole, and only a real excess is ever booked.
    function test_SweepUntrackedNeverUnderflowsAfterAWithdrawal() public {
        vm.prank(owner);
        bridge.emergencyWithdrawBnb(payable(treasury), 0);
        assertEq(bridge.sweepUntracked(), 0, "balance < book: nothing untracked, no underflow");

        vm.deal(address(bridge), 3 ether); // the owner force-sends part of it back
        assertEq(bridge.sweepUntracked(), 0);
        (uint256 bnbShort,) = bridge.shortfall();
        assertEq(bnbShort, 7 ether, "a refill narrows the hole");
        assertEq(bridge.bnbBalance(), 10 ether);

        vm.deal(address(bridge), 12 ether); // more than was taken
        assertEq(bridge.sweepUntracked(), 2 ether, "only the real excess becomes revenue");
        assertEq(bridge.bnbBalance(), 12 ether);
        (bnbShort,) = bridge.shortfall();
        assertEq(bnbShort, 0);
    }

    function test_SweepUntrackedBacRefillsTheHoleBeforeBookingAnything() public {
        vm.prank(owner);
        bridge.emergencyWithdrawToken(address(bac), treasury, 30e18);
        assertEq(bridge.sweepUntrackedBac(), 0);

        vm.prank(treasury);
        bac.transfer(address(bridge), 20e18);
        assertEq(bridge.sweepUntrackedBac(), 0, "a partial refill is not revenue");
        (, uint256 bacShort) = bridge.shortfall();
        assertEq(bacShort, 10e18);

        vm.prank(treasury);
        bac.transfer(address(bridge), 10e18); // the rest of it back
        bac.mint(address(bridge), 5e18); // plus a genuine donation on top
        assertEq(bridge.sweepUntrackedBac(), 5e18, "only what exceeds the book is booked");
        assertEq(bridge.buybackBac(), 15e18);
        (, bacShort) = bridge.shortfall();
        assertEq(bacShort, 0);
        _assertBacBooks();
    }

    /// Requirement 2: buyback skips (reason 6) instead of bricking when the BNB is gone, and once
    /// new revenue arrives it spends what is physically there without deepening the hole.
    function test_BuybackSkipsInsteadOfBrickingWhenTheBnbIsGone() public {
        _warpEpochs(144); // a day of accrual: 20% of 10 BNB
        vm.prank(owner);
        bridge.emergencyWithdrawBnb(payable(treasury), 0);

        (, uint256 spendable,,) = bridge.buybackState();
        assertEq(spendable, 0, "the view already knows");
        vm.expectEmit(false, false, false, true, address(bridge));
        emit BacBridge.BuybackSkipped(6, 2 ether);
        assertEq(bridge.buyback(0, 0), 0);
        assertEq(bridge.bnbBalance(), 10 ether, "a skip changes no book");
        assertEq(bridge.buybackBudget(), 2 ether, "the accrual is kept");

        // tax keeps arriving: the next buyback spends real BNB and the hole stays the same size
        bridge.acceptRelease{value: 1 ether}();
        _warpEpochs(1);
        uint256 bought = bridge.buyback(0, 0);
        assertEq(bought, portal.quote(0.5 ether), "MAX_BUYBACK_BNB of physically present BNB");
        (uint256 bnbShort,) = bridge.shortfall();
        assertEq(bnbShort, 10 ether, "the buyback neither deepened nor hid the hole");
        _assertBacBooks();
    }

    function test_BuybackSpendsOnlyWhatIsPhysicallyThere() public {
        _warpEpochs(144);
        vm.prank(owner);
        bridge.emergencyWithdrawBnb(payable(treasury), 9.8 ether); // 0.2 BNB left, budget 2 BNB
        (, uint256 spendable,,) = bridge.buybackState();
        assertEq(spendable, 0.2 ether);
        assertEq(bridge.buyback(0, 0), portal.quote(0.2 ether));
        assertEq(bridge.buybackBnbSpent(), 0.2 ether);
        assertEq(address(bridge).balance, 0);
        (uint256 bnbShort,) = bridge.shortfall();
        assertEq(bnbShort, 9.8 ether);
    }

    /// Requirement 2 + 5: `collect` fails on its transfer only because the bought-back BAC is
    /// gone — and it never "succeeds" by paying the exit out of the deposits sitting next to it.
    function test_CollectFailsOnlyWhenTheBoughtBackBacIsGone() public {
        _postSingle(_curEpoch(), _leaf(1, 1, alice, 1000e18), 3);
        assertEq(_claim(_curEpoch(), 1, 1, alice, 1000e18), 10e18);
        _warpEpochs(1);
        _settleNext(3);
        assertGt(bridge.pendingCollect(alice), 0);

        // the owner takes exactly the buyback part: what is left is exactly the deposits
        vm.prank(owner);
        bridge.emergencyWithdrawToken(address(bac), treasury, 10e18);
        assertEq(bac.balanceOf(address(bridge)), bridge.lockedBac() - bridge.totalBurned());

        vm.prank(alice);
        vm.expectRevert(unicode"Bridge short of BAC / 桥内 BAC 不足");
        bridge.collect(alice);
        (, uint256 bacShort) = bridge.shortfall();
        assertEq(bacShort, 10e18);

        // sent back, it pays again
        vm.prank(treasury);
        bac.transfer(address(bridge), 10e18);
        vm.prank(alice);
        assertGt(bridge.collect(alice), 0);
        _assertBacBooks();
    }

    /// A partial withdrawal: exits keep being paid while bought-back BAC is physically there, and
    /// no payout ever leaves the balance below the unburned deposits.
    function test_PartialWithdrawalExitsNeverDipIntoDeposits() public {
        _postSingle(_curEpoch(), _leaf(1, 1, alice, 1000e18), 3);
        _claim(_curEpoch(), 1, 1, alice, 1000e18);
        vm.prank(owner);
        bridge.emergencyWithdrawToken(address(bac), treasury, 5e18);

        for (uint256 i = 0; i < 5; i++) {
            _warpEpochs(1);
            _settleNext(3);
            vm.prank(alice);
            assertGt(bridge.collect(alice), 0);
            assertGe(bac.balanceOf(address(bridge)), bridge.lockedBac() - bridge.totalBurned(), "dipped into deposits");
        }
    }

    /// Requirement 2 + review finding (2026-09-23): the escape settles its two legs one by one.
    /// With every BNB gone, the BAC leg — physically here — is still paid; the BNB leg keeps its
    /// debt, `shortfall()` says by how much, and a refill makes exactly that leg payable again.
    function test_EscapeBnbHoleNeverStrandsTheBac() public {
        _haltNow();
        vm.prank(owner);
        bridge.emergencyWithdrawBnb(payable(treasury), 0);
        (uint256 bac_, uint256 bnb_) = bridge.escapeClaimable(1);
        assertEq(bac_, 10e18);
        assertEq(bnb_, 10 ether, "the books still promise the whole junior pot");

        vm.expectEmit(true, true, true, true, address(bridge));
        emit BacBridge.EscapeCollected(1, alice, 10e18, 0);
        vm.prank(alice);
        (uint256 bacPaid, uint256 bnbPaid) = bridge.escapeCollect(1, alice);
        assertEq(bacPaid, 10e18, "the BAC that is here is paid");
        assertEq(bnbPaid, 0, "the missing BNB is skipped, not reverted on");
        assertEq(bac.balanceOf(alice), 10e18);
        (bac_, bnb_) = bridge.escapeClaimable(1);
        assertEq(bac_, 0);
        assertEq(bnb_, 10 ether, "the BNB leg keeps its whole debt");
        (uint256 bnbShort,) = bridge.shortfall();
        assertEq(bnbShort, 10 ether);

        vm.prank(alice);
        vm.expectRevert(unicode"Bridge short of funds / 桥内资金不足");
        bridge.escapeCollect(1, alice);

        vm.deal(address(bridge), 10 ether); // force-sent back
        vm.prank(alice);
        (bacPaid, bnbPaid) = bridge.escapeCollect(1, alice);
        assertEq(bacPaid, 0);
        assertEq(bnbPaid, 10 ether);
        assertEq(bac.balanceOf(address(bridge)), 1000e18, "the deposits never moved");
    }

    /// The mirror case: a BAC hole (here 1 wei of the junior BAC) skips the BAC leg — which still
    /// never dips into the deposits — and the BNB that is here is paid.
    function test_EscapeBacHoleNeverStrandsTheBnbNorDipsIntoDeposits() public {
        _haltNow();
        vm.prank(owner);
        bridge.emergencyWithdrawToken(address(bac), treasury, 1e18); // part of the junior BAC
        vm.prank(alice);
        (uint256 bacPaid, uint256 bnbPaid) = bridge.escapeCollect(1, alice);
        assertEq(bacPaid, 0, "9e18 of 10e18 is here, but the leg is paid whole or not at all");
        assertEq(bnbPaid, 10 ether);
        assertEq(bac.balanceOf(address(bridge)), 1009e18, "nothing left the deposits");
        (uint256 bac_, uint256 bnb_) = bridge.escapeClaimable(1);
        assertEq(bac_, 10e18);
        assertEq(bnb_, 0);

        vm.prank(treasury);
        bac.transfer(address(bridge), 1e18);
        vm.prank(alice);
        (bacPaid, bnbPaid) = bridge.escapeCollect(1, alice);
        assertEq(bacPaid, 10e18);
        assertEq(bac.balanceOf(address(bridge)), 1000e18);
    }

    /// Both assets gone: a clean refusal, and no debt moves.
    function test_EscapeWithBothAssetsGoneRefusesAndMovesNoDebt() public {
        _haltNow();
        vm.startPrank(owner);
        bridge.emergencyWithdrawBnb(payable(treasury), 0);
        bridge.emergencyWithdrawToken(address(bac), treasury, 10e18);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(unicode"Bridge short of funds / 桥内资金不足");
        bridge.escapeCollect(1, alice);
        assertEq(bridge.escapeDebtBac(1), 0);
        assertEq(bridge.escapeDebtBnb(1), 0);
    }

    function test_ClaimOwedAfterHaltFailsWhenTheBacIsGone() public {
        _postSingle(_curEpoch(), _leaf(1, 1, alice, 100e18), 3);
        _claim(_curEpoch(), 1, 1, alice, 100e18); // owed = 1 BAC
        vm.warp(vm.getBlockTimestamp() + 20 days); // matured
        _haltNow();
        vm.prank(owner);
        bridge.emergencyWithdrawToken(address(bac), treasury, 10e18);

        vm.prank(alice);
        vm.expectRevert(unicode"Bridge short of BAC / 桥内 BAC 不足");
        bridge.claimOwedAfterHalt(alice);

        vm.prank(treasury);
        bac.transfer(address(bridge), 1e18);
        vm.prank(alice);
        assertEq(bridge.claimOwedAfterHalt(alice), 1e18);
    }

    /// If the owner cut into the deposits themselves, the burn fails on its transfer too.
    function test_BurnLockedFailsIfTheOwnerTookTheDeposits() public {
        vm.prank(owner);
        bridge.emergencyWithdrawToken(address(bac), treasury, 0);
        vm.expectRevert(unicode"Token transfer failed / 代币转出失败");
        bridge.burnLocked();
    }

    /// Everything that does not move money keeps working on the unwritten books.
    function test_BookKeepingPathsKeepWorkingAfterATotalWithdrawal() public {
        vm.startPrank(owner);
        bridge.emergencyWithdrawBnb(payable(treasury), 0);
        bridge.emergencyWithdrawToken(address(bac), treasury, 0);
        vm.stopPrank();

        _lock(bob, 2, 50e18); // entry still works: a new deposit is real BAC
        _postSingle(_curEpoch(), _leaf(1, 1, alice, 100e18), 3);
        assertGt(_claim(_curEpoch(), 1, 1, alice, 100e18), 0, "claimExit locks a rate off the book");
        _warpEpochs(1);
        _settleNext(3);
        assertEq(bridge.sweepUntracked(), 0);
        assertEq(bridge.sweepUntrackedBac(), 0);
        vm.prank(alice);
        vm.expectRevert(unicode"Bridge short of BAC / 桥内 BAC 不足");
        bridge.collect(alice);
        (uint256 bnbShort, uint256 bacShort) = bridge.shortfall();
        assertEq(bnbShort, 10 ether);
        assertEq(bacShort, 1010e18, "bob's new deposit is on the books and in the balance");
    }

    function testFuzz_ShortfallIsExact(uint256 bnbOut, uint256 bacOut) public {
        bnbOut = bound(bnbOut, 0, 10 ether);
        bacOut = bound(bacOut, 0, 1010e18);
        vm.startPrank(owner);
        if (bnbOut > 0) bridge.emergencyWithdrawBnb(payable(treasury), bnbOut);
        if (bacOut > 0) bridge.emergencyWithdrawToken(address(bac), treasury, bacOut);
        vm.stopPrank();
        (uint256 bnbShort, uint256 bacShort) = bridge.shortfall();
        assertEq(bnbShort, bnbOut);
        assertEq(bacShort, bacOut);
        assertEq(bridge.emergencyBnbWithdrawn(), bnbOut);
        assertEq(bridge.emergencyBacWithdrawn(), bacOut);
        assertEq(address(bridge).balance + bridge.emergencyBnbWithdrawn(), bridge.bnbBalance());
        assertEq(bac.balanceOf(address(bridge)) + bridge.emergencyBacWithdrawn(), bridge.bacAccounted());
    }

    function test_NoShortfallWithoutAWithdrawal() public view {
        (uint256 bnbShort, uint256 bacShort) = bridge.shortfall();
        assertEq(bnbShort, 0);
        assertEq(bacShort, 0);
    }
}

// ============================================================================
//                 AGENT CONTROLLER + DEPOSIT RECORDS  (decision #31)
// ============================================================================

contract BacBridgeControllerTest is BacBridgeTestBase {
    function _haltNow() internal {
        vm.prank(watchdog);
        bridge.armEscape();
        vm.warp(vm.getBlockTimestamp() + bridge.ESCAPE_ARM_DELAY());
        bridge.checkHalt();
    }

    function test_FirstLockSetsTheControllerAndRecordsTheDeposit() public {
        bac.mint(alice, 5e18);
        vm.startPrank(alice);
        bac.approve(address(bridge), 5e18);
        vm.expectEmit(true, true, true, true, address(bridge));
        emit BacBridge.AgentControllerSet(1, address(0), alice);
        bridge.lock(1, 5e18);
        vm.stopPrank();

        assertEq(bridge.agentController(1), alice);
        (address from, uint64 at, uint256 agentId, uint256 amount) = bridge.deposits(0);
        assertEq(from, alice);
        assertEq(uint256(at), T0);
        assertEq(agentId, 1);
        assertEq(amount, 5e18);
        assertEq(bridge.depositId(), 1);
    }

    string internal constant NOT_CONTROLLER =
        unicode"Another address controls this agent id, see setAgentController / 该身份已由其他地址控制，见 setAgentController";

    /// @dev Approves and tries to lock, expecting the controller refusal; the allowance is reset
    ///      afterwards, as `lock`'s NatSpec asks every caller to do.
    function _lockRefused(address who, uint256 agentId, uint256 amount) internal {
        bac.mint(who, amount);
        vm.startPrank(who);
        bac.approve(address(bridge), amount);
        vm.expectRevert(bytes(NOT_CONTROLLER));
        bridge.lock(agentId, amount);
        bac.approve(address(bridge), 0);
        vm.stopPrank();
    }

    /// Review finding (2026-09-23): once an id has entered, only its controller may lock more
    /// under it. A second wallet that passes the gate for the same identity (here its
    /// signature-proven `agentWallet`) is refused until the controller hands the claim over.
    function test_OnlyTheControllerMayAddToAnEnteredId() public {
        address hot = makeAddr("aliceHot");
        identity.setAgentWallet(1, hot);
        _lock(alice, 1, 5e18);
        assertTrue(bridge.holdsIdentity(hot, 1), "the gate alone would let the wallet in");
        _lockRefused(hot, 1, 7e18);
        assertEq(bac.balanceOf(hot), 7e18, "a refused deposit never leaves the wallet");
        assertEq(bridge.credited(1), 5e18);

        vm.prank(alice);
        bridge.setAgentController(1, hot);
        vm.recordLogs();
        _lock(hot, 1, 7e18);
        bytes32 sig = keccak256("AgentControllerSet(uint256,address,address)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics.length == 0 || logs[i].topics[0] != sig, "a lock re-set the controller");
        }
        assertEq(bridge.agentController(1), hot);
        (address from,, uint256 agentId, uint256 amount) = bridge.deposits(1);
        assertEq(from, hot);
        assertEq(agentId, 1);
        assertEq(amount, 7e18);
        assertEq(bridge.credited(1), 12e18, "both deposits sit behind the one claim, now the wallet's");
        _lockRefused(alice, 1, 1e18); // and the owner is now the one who must ask
    }

    /// Review finding: an `agentWallet` that locks 1 wei first can no longer capture its owner's
    /// escape share — the owner's deposit is refused instead of silently joining the claim.
    function test_AgentWalletDustFirstCannotCaptureTheOwnersDeposit() public {
        address hot = makeAddr("aliceHot");
        identity.setAgentWallet(1, hot);
        _lock(hot, 1, 1);
        assertEq(bridge.agentController(1), hot);
        _lockRefused(alice, 1, 1000e18);
        assertEq(bac.balanceOf(alice), 1000e18);
        assertEq(bridge.credited(1), 1);
    }

    function test_SetAgentControllerOnlyByTheCurrentController() public {
        _lock(alice, 1, 5e18);

        vm.prank(bob);
        vm.expectRevert(unicode"Only the agent controller / 仅限该 agent 的控制地址");
        bridge.setAgentController(1, bob);

        vm.prank(stranger); // an id that never entered has no controller at all
        vm.expectRevert(unicode"Only the agent controller / 仅限该 agent 的控制地址");
        bridge.setAgentController(3, stranger);

        vm.prank(alice);
        vm.expectRevert(unicode"Zero controller / 控制地址为零");
        bridge.setAgentController(1, address(0));

        vm.expectEmit(true, true, true, true, address(bridge));
        emit BacBridge.AgentControllerSet(1, alice, carol);
        vm.prank(alice);
        bridge.setAgentController(1, carol);
        assertEq(bridge.agentController(1), carol);

        vm.prank(alice);
        vm.expectRevert(unicode"Only the agent controller / 仅限该 agent 的控制地址");
        bridge.setAgentController(1, alice);

        // the NFT holder has no say by virtue of holding it: the registry is never asked
        assertEq(bridge.identityOwner(1), alice);
        vm.prank(carol);
        bridge.setAgentController(1, alice);
        assertEq(bridge.agentController(1), alice);
    }

    /// Requirement 4: an identity transferred AFTER entry does not move the escape claim — the old
    /// controller can still escape its own deposit — and the new holder cannot add to that claim.
    function test_IdentityTransferAfterEntryDoesNotMoveTheEscapeClaim() public {
        _lock(alice, 1, 600e18);
        vm.prank(alice);
        identity.transfer(1, bob);
        assertTrue(bridge.holdsIdentity(bob, 1), "bob holds the NFT now, so the gate alone lets him in");
        _lockRefused(bob, 1, 400e18);
        assertEq(bridge.agentController(1), alice);
        _seedBuyback(10e18);
        _haltNow();

        vm.prank(bob);
        vm.expectRevert(unicode"Only the agent controller / 仅限该 agent 的控制地址");
        bridge.escapeCollect(1, bob);

        vm.prank(alice);
        (uint256 bacPaid,) = bridge.escapeCollect(1, alice);
        assertApproxEqAbs(bacPaid, 10e18, 1e3, "alice's own deposit is the whole weight of identity 1");
    }

    /// Review finding (2026-09-23), the exact scenario: alice enters with 1 wei, sells the
    /// identity to bob, bob deposits 1000 BAC. Before the fix bob's deposit joined alice's claim
    /// and a halt paid bob's whole junior share to alice. Now bob's deposit is refused until alice
    /// hands the claim over, and after the hand-over the escape pays bob, not alice.
    function test_SellerWithDustCannotCaptureTheBuyersDeposit() public {
        _lock(alice, 1, 1);
        vm.prank(alice);
        identity.transfer(1, bob);
        _lockRefused(bob, 1, 1000e18);
        _lock(carol, 3, 1000e18);
        assertEq(bridge.credited(1), 1, "nothing of bob's reached alice's claim");

        vm.prank(alice);
        bridge.setAgentController(1, bob);
        _lock(bob, 1, 1000e18);
        _seedBuyback(100e18);
        vm.deal(address(this), 10 ether);
        bridge.acceptRelease{value: 10 ether}();
        _haltNow();

        vm.prank(alice);
        vm.expectRevert(unicode"Only the agent controller / 仅限该 agent 的控制地址");
        bridge.escapeCollect(1, alice);
        vm.prank(bob);
        (uint256 bacPaid, uint256 bnbPaid) = bridge.escapeCollect(1, bob);
        assertApproxEqAbs(bacPaid, 50e18, 1e6, "bob's half of the junior BAC");
        assertApproxEqAbs(bnbPaid, 5 ether, 1e6, "bob's half of the junior BNB");
    }

    function test_HandedOverClaimEscapesToTheNewController() public {
        _lock(alice, 1, 100e18);
        _seedBuyback(10e18);
        vm.prank(alice);
        bridge.setAgentController(1, bob);
        _haltNow();

        vm.prank(alice);
        vm.expectRevert(unicode"Only the agent controller / 仅限该 agent 的控制地址");
        bridge.escapeCollect(1, alice);
        vm.prank(bob);
        (uint256 bacPaid,) = bridge.escapeCollect(1, carol); // and it may pay anywhere
        assertEq(bacPaid, 10e18);
        assertEq(bac.balanceOf(carol), 10e18);
    }
}

// ============================================================================
//                      description()  (decisions #29a / #31a)
// ============================================================================

contract BacBridgeDescriptionTest is BacBridgeTestBase {
    function _contains(string memory hay, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(hay);
        bytes memory n = bytes(needle);
        if (n.length > h.length) return false;
        for (uint256 i = 0; i + n.length <= h.length; i++) {
            bool hit = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return true;
        }
        return false;
    }

    function test_NoticesAreTheDecidedSentencesWordForWord() public view {
        assertEq(
            bridge.OWNER_POWER_NOTICE(),
            unicode"项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。"
        );
        assertTrue(
            _contains(
                bridge.IDENTITY_LIMIT_NOTICE(), unicode"我们要求持有 agent 身份，我们不能证明它是 AI"
            )
        );
    }

    function test_DescriptionCarriesBothNoticesVerbatim() public view {
        string memory d = bridge.description();
        assertTrue(_contains(d, bridge.OWNER_POWER_NOTICE()), "decision #29a missing");
        assertTrue(
            _contains(
                d,
                unicode"项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。"
            )
        );
        assertTrue(_contains(d, bridge.IDENTITY_LIMIT_NOTICE()), "decision #31a missing");
        assertTrue(_contains(d, unicode"我们要求持有 agent 身份，我们不能证明它是 AI"));
        // a bilingual summary, honest about cost and trust
        assertTrue(_contains(d, unicode"不承诺任何金额"));
        assertTrue(_contains(d, unicode"4%"));
        assertTrue(_contains(d, unicode"中心化"));
        assertTrue(_contains(d, "withdraw all funds at any time"));
        assertTrue(_contains(d, "does not prove the holder is an AI"));
        // review finding (2026-09-23): the upgrade power reaches standing allowances, not only the pool
        assertTrue(_contains(d, unicode"不要给桥留授权额度"), "allowance warning (zh) missing");
        assertTrue(_contains(d, "can spend any allowance left on the bridge"), "allowance warning (en) missing");
        assertEq(impl.description(), d, "pure: the implementation says the same");
    }

    /// Decision #29a / HANDOFF §6: statements that are now false must appear nowhere on chain.
    function test_DescriptionMakesNoWithdrawnPromise() public view {
        string memory d = bridge.description();
        string[8] memory banned = [
            unicode"永久锁死",
            unicode"不可升级",
            unicode"动不了",
            unicode"没有任何路径",
            unicode"挑战",
            unicode"24 小时",
            "permanently locked",
            "non-upgradeable"
        ];
        for (uint256 i = 0; i < banned.length; i++) {
            assertFalse(_contains(d, banned[i]), banned[i]);
        }
    }
}

// ============================================================================
//                               BacNodeFund
// ============================================================================

contract BacNodeFundTest is Test {
    BacNodeFund internal fund;
    MockBAC internal bac;
    address internal owner = makeAddr("nodeFundOwner");
    address internal stranger = makeAddr("stranger");
    address internal payoutTo = makeAddr("projectWallet");

    function setUp() public {
        bac = new MockBAC();
        fund = new BacNodeFund(address(bac), owner);
        vm.deal(address(this), 100 ether);
    }

    function test_AcceptReleaseTracksLifetime() public {
        fund.acceptRelease{value: 3 ether}();
        fund.acceptRelease{value: 1 ether}();
        assertEq(fund.balance(), 4 ether);
        assertEq(fund.lifetimeReceived(), 4 ether);
        assertEq(fund.lifetimeWithdrawn(), 0);
    }

    function test_OwnerWithdrawsPartialAndAll() public {
        fund.acceptRelease{value: 5 ether}();
        vm.prank(owner);
        fund.withdraw(payoutTo, 2 ether);
        assertEq(payoutTo.balance, 2 ether);
        assertEq(fund.balance(), 3 ether);

        vm.prank(owner);
        fund.withdraw(payoutTo, 0); // 0 == everything
        assertEq(payoutTo.balance, 5 ether);
        assertEq(fund.balance(), 0);
        // N1
        assertEq(fund.lifetimeReceived(), fund.lifetimeWithdrawn() + fund.balance());
    }

    function test_OnlyOwnerCanWithdraw() public {
        fund.acceptRelease{value: 1 ether}();
        vm.prank(stranger);
        vm.expectRevert(unicode"Only owner / 仅限 owner");
        fund.withdraw(stranger, 1 ether);

        vm.prank(owner);
        vm.expectRevert(unicode"Amount exceeds balance / 金额超过余额");
        fund.withdraw(payoutTo, 2 ether);

        BacNodeFund empty = new BacNodeFund(address(bac), owner);
        vm.prank(owner);
        vm.expectRevert(unicode"Nothing to withdraw / 没有可提取的金额");
        empty.withdraw(payoutTo, 0);

        vm.prank(owner);
        vm.expectRevert(unicode"Zero recipient / 收款地址为零");
        fund.withdraw(address(0), 1);
    }

    function test_TwoStepOwnershipTransfer() public {
        address next = makeAddr("newOwner");
        vm.prank(stranger);
        vm.expectRevert(unicode"Only owner / 仅限 owner");
        fund.transferOwnership(next);

        vm.prank(owner);
        fund.transferOwnership(next);
        assertEq(fund.owner(), owner, "owner does not change until accepted");
        assertEq(fund.pendingOwner(), next);

        vm.prank(stranger);
        vm.expectRevert(unicode"Only pending owner / 仅限待定 owner");
        fund.acceptOwnership();

        vm.prank(next);
        fund.acceptOwnership();
        assertEq(fund.owner(), next);
        assertEq(fund.pendingOwner(), address(0));

        fund.acceptRelease{value: 1 ether}();
        vm.prank(next);
        fund.withdraw(payoutTo, 0);
        assertEq(payoutTo.balance, 1 ether);
    }

    function test_NoPlainReceiveAndNoBridgePath() public {
        (bool ok,) = address(fund).call{value: 1 ether}("");
        assertFalse(ok, "node fund must have no receive()");
        // N2: there is no function that takes a bridge address or moves BAC
        (ok,) = address(fund).call(abi.encodeWithSignature("rescueToken(address,uint256)", address(bac), 1));
        assertFalse(ok);
        (ok,) = address(fund).call(abi.encodeWithSignature("sweep(address)", address(bac)));
        assertFalse(ok);
    }

    function testFuzz_LifetimeIdentityHolds(uint96 inA, uint96 inB, uint96 out) public {
        vm.deal(address(this), uint256(inA) + uint256(inB));
        fund.acceptRelease{value: inA}();
        fund.acceptRelease{value: inB}();
        uint256 bal = fund.balance();
        uint256 amount = bal == 0 ? 0 : uint256(out) % (bal + 1);
        if (amount > 0) {
            vm.prank(owner);
            fund.withdraw(payoutTo, amount);
        }
        assertEq(fund.lifetimeReceived(), fund.lifetimeWithdrawn() + fund.balance(), "N1");
    }
}
