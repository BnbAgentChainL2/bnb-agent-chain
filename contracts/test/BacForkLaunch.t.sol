// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC1967Proxy} from "@openzeppelin/proxy/ERC1967/ERC1967Proxy.sol";

import {FlapBSCFixture} from "./FlapBSCFixture.sol";
import {
    IPortal, IPortalTypes, IPortalTradeV2, IPortalCommonTypes, IPortalLauncher
} from "../src/flap/IPortal.sol";
import {ITaxProcessor, PackedFeeConfigV2} from "../src/flap/ITaxProcessor.sol";
import {IFlapTaxTokenV3} from "../src/flap/IFlapTaxTokenV3.sol";

import {BacTaxRouter} from "../src/BacTaxRouter.sol";
import {BacBridge} from "../src/BacBridge.sol";
import {BacNodeFund} from "../src/BacNodeFund.sol";
import {ChainAnchor} from "../src/ChainAnchor.sol";
import {ValidatorStaking} from "../src/ValidatorStaking.sol";
import {IChainAnchor} from "../src/interfaces/IChainAnchor.sol";
import {IPancakeV2Router} from "../src/interfaces/IPancakeV2Router.sol";

/// @title BacForkLaunchTest
/// @notice The last gate before launch: the whole BNB Agent Chain BSC-side stack deployed in the
///         real §9 order on a BSC mainnet fork, launched through the LIVE PLAIN Portal's
///         `newTokenV6` with our own `BacTaxRouter` as the beneficiary (decision #30: no
///         VaultPortal, no vault factory, no vault, no AgentRegistry), fed with real tax from the
///         real bonding curve, settled through the real `dispatch()`, and entered by an agent that
///         holds a REAL identity minted on the live ERC-8004 registry (decision #31).
///
///         `BacBridge` is deployed exactly the way production deploys it: an OpenZeppelin
///         `ERC1967Proxy` over a `BacBridge` implementation, initialised in the proxy's own
///         constructor. The owner powers of decision #29 — upgrade and emergency withdrawal — are
///         exercised against live chain state, and so is the sentence that has to disclose them:
///         「项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。」
///
///         THE SALT. When the live Portal still shows our ...7777 salt locked to the deployment
///         wallet and the token address is still empty (decision #35), the suite launches with
///         THAT salt, from THAT wallet (a prank — no key is read), and asserts the token lands on
///         `0xA97452d175679B2bF5F25a9a382D22aff39b7777`. Once BAC really exists it falls back to a
///         freshly mined ...7777 salt so the suite keeps running.
///
/// @dev Run:
///        BSC_RPC_URL=https://bsc-dataseed.bnbchain.org forge test --match-path 'test/BacForkLaunch.t.sol' -vv
///      Pin a block (reproducible re-runs, needs an archive RPC if it is old):
///        BAC_FORK_BLOCK=<n> ...
///
///      NOTHING here broadcasts. Every write goes through the forked EVM only.
contract BacForkLaunchTest is FlapBSCFixture {
    // ── the planned launch form (docs/research/12-erc8004-and-portal.md §2.3) ─────────────
    string internal constant NAME = "BNB Agent Chain";
    string internal constant SYMBOL = "BAC";
    uint16 internal constant BUY_TAX = 200; // 2%
    uint16 internal constant SELL_TAX = 200; // 2%
    uint64 internal constant TAX_DURATION = uint64(100 * 365 days);
    uint64 internal constant ANTI_FARMER = uint64(1 days);
    uint16 internal constant MKT_BPS = 10_000;
    uint256 internal constant LAUNCH_BUY = 0.05 ether;

    // ── decision #35: what is already on mainnet ──────────────────────────────────────────
    bytes32 internal constant LOCKED_SALT = 0xef6c0eb73e1df199c6585180a2ff54ce08a4be94de3c68d5de52ead1680b2af7;
    address internal constant DEPLOYER = 0x934a6678120b85652D2CC818C69774ea17012844;
    address internal constant BAC_TOKEN = 0xA97452d175679B2bF5F25a9a382D22aff39b7777;

    // ── decisions #29a / #31a, verbatim ───────────────────────────────────────────────────
    string internal constant NOTICE_29A = unicode"项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。";
    string internal constant NOTICE_31A = unicode"我们要求持有 agent 身份，我们不能证明它是 AI";

    // ── chain / protocol constants ────────────────────────────────────────────────────────
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    uint128 internal constant OPERATOR_FLOAT = 1000e18;
    uint256 internal constant MIN_STAKE = 2_000_000e18;
    uint64 internal constant E = 600; // decision #20: a 10-minute epoch

    // ── our stack ─────────────────────────────────────────────────────────────────────────
    ChainAnchor internal anchor;
    ValidatorStaking internal staking;
    BacNodeFund internal nodeFund;
    BacBridge internal bridgeImpl;
    BacBridge internal bridge; // the ERC1967 proxy
    BacTaxRouter internal router;

    address internal token;
    address internal taxProcessor;
    bytes32 internal launchSalt;
    address internal predictedToken;
    address internal predictedBridge;
    bool internal usingLockedSalt;

    // ── keys / roles ──────────────────────────────────────────────────────────────────────
    address internal launcher;
    /// @dev Decision #33: the bridge owner is the deployment wallet. An address, never a key.
    address internal bridgeOwner = DEPLOYER;
    address internal ownerSink = makeAddr("ownerSink");
    address internal fundOwner = makeAddr("nodeFundOwner");
    address internal admin = makeAddr("admin");
    address internal vetoKey = makeAddr("vetoKey");
    address internal relayer = makeAddr("relayer");
    address internal watchdog = makeAddr("watchdog");
    address internal trader = makeAddr("trader");
    address internal stranger = makeAddr("stranger");
    address internal exitTo = makeAddr("exitTo");
    address internal ctrl = makeAddr("agentHolder");
    address internal buyer = makeAddr("identityBuyer");

    address[3] internal validators;
    bytes32 internal constant ATT_SALT = keccak256("bac-attestation-salt");

    // ── measurements (reported with -vv) ──────────────────────────────────────────────────
    uint256 public gasLaunch;
    uint256 public gasDeployImpl;
    uint256 public gasDeployProxy;
    uint256 public gasDispatch;
    uint256 public gasSettle;
    uint256 public gasRegister;
    uint256 public gasLock;
    uint256 public gasClaimExit;
    uint256 public gasCollect;
    uint256 public gasBuyback;
    uint256 public gasPostAnchor;
    uint256 public gasCommit;
    uint256 public gasReveal;
    uint256 public gasFinalize;
    uint256 public gasReceiveCold;
    uint256 public gasReceiveWarm;

    // ======================================================================================
    //                                       SET UP
    // ======================================================================================

    function setUp() public {
        // via-IR caches block.* inside a single function, so the chain id comes from a cheatcode.
        if (vm.getChainId() != 56) {
            string memory url = vm.envOr("BSC_RPC_URL", string("https://bsc-dataseed.bnbchain.org"));
            uint256 pin = vm.envOr("BAC_FORK_BLOCK", uint256(0));
            if (pin == 0) {
                vm.createSelectFork(url);
            } else {
                vm.createSelectFork(url, pin);
            }
        }
        require(vm.getChainId() == 56, "BSC mainnet fork required");

        portal = IPortal(PORTAL);
        _labelDeployedAddresses();

        validators[0] = makeAddr("validator1");
        validators[1] = makeAddr("validator2");
        validators[2] = makeAddr("validator3");

        // ── §9 ①: the vanity salt and the token address it predicts ───────────────────────
        IPortalTypes.SaltLockEntry memory lk = portal.getSaltLock(LOCKED_SALT);
        if (lk.locker == DEPLOYER && lk.tokenVersion == 6 && BAC_TOKEN.code.length == 0) {
            usingLockedSalt = true;
            launchSalt = LOCKED_SALT;
            launcher = DEPLOYER;
        } else {
            // BAC already exists (or the lock is gone): mine a fresh ...7777 salt from a
            // fork-derived seed, so the suite never lands on an address already staged on mainnet.
            _seedVanitySalt(keccak256(abi.encode("BNB Agent Chain/fork", vm.getBlockNumber(), vm.getBlockTimestamp())));
            launchSalt = _findVanitySalt(VanityType.VANITY_7777, TOKEN_IMPL_TAXED_V3, PORTAL);
            launcher = makeAddr("launcher");
        }
        predictedToken = _predictAddress(TOKEN_IMPL_TAXED_V3, launchSalt, PORTAL);
        if (usingLockedSalt) assertEq(predictedToken, BAC_TOKEN, "the locked salt no longer predicts T");
        assertEq(predictedToken.code.length, 0, "predicted token address is already taken");

        _deployStack();
        _launch();
    }

    /// @dev §9 ④-⑩, in the real order, with the real CREATE-nonce prediction for the bridge
    ///      PROXY. The implementation's constructor deploys `BacBridgeExtension` with the
    ///      implementation's own nonce, so it costs this deployer exactly one nonce.
    function _deployStack() internal {
        // ④ ChainAnchor needs the bridge PROXY's address and the proxy needs the anchor's:
        //   anchor (n), staking (n+1), nodeFund (n+2), implementation (n+3), proxy (n+4).
        uint64 n = vm.getNonce(address(this));
        predictedBridge = vm.computeCreateAddress(address(this), n + 4);
        anchor = new ChainAnchor(predictedBridge, relayer, admin, vetoKey, OPERATOR_FLOAT);

        // ⑤⑥ the two contracts whose `bacToken` is an immutable predicted address
        staking = new ValidatorStaking(predictedToken, address(anchor), admin);
        nodeFund = new BacNodeFund(predictedToken, fundOwner);

        // ⑦ BacBridge: implementation, then ERC1967Proxy + initialize in the same transaction
        uint256 g = gasleft();
        bridgeImpl = new BacBridge();
        gasDeployImpl = g - gasleft();
        g = gasleft();
        bridge = BacBridge(
            address(
                new ERC1967Proxy(
                    address(bridgeImpl),
                    abi.encodeCall(
                        BacBridge.initialize,
                        (
                            bridgeOwner,
                            predictedToken,
                            ERC8004_IDENTITY,
                            address(anchor),
                            watchdog,
                            PORTAL,
                            PANCAKE_V2_ROUTER
                        )
                    )
                )
            )
        );
        gasDeployProxy = g - gasleft();
        assertEq(address(bridge), predictedBridge, "CREATE nonce prediction of the BacBridge proxy drifted");
        assertEq(anchor.bridge(), address(bridge), "ChainAnchor.bridge() != the BacBridge proxy");

        // ⑧ one-shot binding
        anchor.setValidatorStaking(address(staking));

        // ⑨ the preflight greens of §9 (run here against live state)
        assertEq(bridge.bacToken(), predictedToken, "preflight 1: bridge token");
        assertEq(nodeFund.bacToken(), predictedToken, "preflight 1: node fund token");
        assertEq(staking.bacToken(), predictedToken, "preflight 1: staking token");
        assertEq(predictedToken.code.length, 0, "preflight 2: address already has code");
        assertEq(bridge.identityRegistry(), ERC8004_IDENTITY, "preflight 3: the ERC-8004 registry");
        assertTrue(bridge.identityOwner(1) != address(0), "preflight 3: the registry resolves agent #1");

        // ⑩ the tax router, LAST: its constructor cross-checks both downstreams against `T`
        router = new BacTaxRouter(predictedToken, address(bridge), address(nodeFund));

        vm.label(address(anchor), "ChainAnchor");
        vm.label(address(staking), "ValidatorStaking");
        vm.label(address(nodeFund), "BacNodeFund");
        vm.label(address(bridgeImpl), "BacBridge:impl");
        vm.label(bridgeImpl.EXTENSION(), "BacBridge:extension");
        vm.label(address(bridge), "BacBridge:proxy");
        vm.label(address(router), "BacTaxRouter");
    }

    /// @dev ⑪ the real launch through the live PLAIN Portal (decision #30: no VaultPortal, no
    ///      factory, no vault — `beneficiary` is our own `BacTaxRouter` and the Portal does not
    ///      care that it is a contract).
    function _launch() internal {
        IPortalTypes.NewTokenV6Params memory p = _formParams(launchSalt, address(router));
        p.quoteAmt = LAUNCH_BUY;

        if (usingLockedSalt) {
            // The lock is real protection: the same form from any other wallet is refused.
            bytes memory r = _launchReverts(stranger, p);
            assertEq(
                r,
                abi.encodeWithSignature("FlapSaltLockedByAnotherUser(bytes32,address)", LOCKED_SALT, DEPLOYER),
                "a stranger must not be able to launch on our locked salt"
            );
        }

        vm.deal(launcher, launcher.balance + 10 ether);
        vm.startPrank(launcher, launcher);
        uint256 g = gasleft();
        token = portal.newTokenV6{value: p.quoteAmt, gas: MAX_OP_GAS}(p);
        gasLaunch = g - gasleft();
        vm.stopPrank();

        taxProcessor = IFlapTaxTokenV3(token).taxProcessor();
        vm.label(token, SYMBOL);
        vm.label(taxProcessor, "TaxProcessor");
    }

    // ======================================================================================
    //                                      HELPERS
    // ======================================================================================

    /// @dev The planned launch form, as a plain-Portal `NewTokenV6Params`. Every value that the
    ///      live Portal was measured to accept only one of is spelled out by the fixture builder.
    function _formParams(bytes32 salt, address beneficiary)
        internal
        pure
        returns (IPortalTypes.NewTokenV6Params memory p)
    {
        p = _buildV3TaxTokenParams(NAME, SYMBOL, salt, beneficiary);
        p.buyTaxRate = BUY_TAX;
        p.sellTaxRate = SELL_TAX;
        p.taxDuration = TAX_DURATION;
        p.antiFarmerDuration = ANTI_FARMER;
        p.mktBps = MKT_BPS;
    }

    function _launchReverts(address who, IPortalTypes.NewTokenV6Params memory p) internal returns (bytes memory ret) {
        vm.deal(who, who.balance + 1 ether);
        bool ok;
        vm.prank(who, who);
        (ok, ret) = PORTAL.call{value: p.quoteAmt, gas: MAX_OP_GAS}(abi.encodeCall(IPortalLauncher.newTokenV6, (p)));
        assertFalse(ok, "launch must revert");
    }

    function _launchOk(address who, IPortalTypes.NewTokenV6Params memory p) internal returns (address t) {
        vm.deal(who, who.balance + 1 ether);
        vm.startPrank(who, who);
        t = portal.newTokenV6{value: p.quoteAmt, gas: MAX_OP_GAS}(p);
        vm.stopPrank();
    }

    function _contains(bytes memory hay, bytes memory needle) internal pure returns (bool) {
        if (needle.length == 0 || hay.length < needle.length) return false;
        for (uint256 i; i <= hay.length - needle.length; ++i) {
            bool hit = true;
            for (uint256 j; j < needle.length; ++j) {
                if (hay[i + j] != needle[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return true;
        }
        return false;
    }

    function _buy(address who, uint256 bnb) internal returns (uint256 got) {
        vm.deal(who, who.balance + bnb);
        vm.startPrank(who);
        got = _buyOnBC(token, bnb);
        vm.stopPrank();
    }

    /// @dev Buys until `who` holds at least `want` BAC, so every stake and every deposit is real
    ///      tokens bought off the real curve rather than cheatcode-minted balances.
    function _acquireBac(address who, uint256 want) internal {
        for (uint256 i; i < 40 && IERC20(token).balanceOf(who) < want; ++i) {
            _buy(who, 0.5 ether);
        }
        assertGe(IERC20(token).balanceOf(who), want, "could not buy enough BAC off the curve");
    }

    /// @dev Real tax accrual: buy and sell through the real Portal route, both sides taxed.
    function _accrueTax(uint256 rounds, uint256 bnbEach) internal {
        for (uint256 i; i < rounds; ++i) {
            address t = makeAddr(string.concat("taxTrader", vm.toString(i)));
            uint256 got = _buy(t, bnbEach);
            vm.startPrank(t);
            _sell(token, got);
            vm.stopPrank();
        }
    }

    /// @dev The real keeper call: `ITaxProcessor.dispatch{gas: 1_000_000}()`.
    function _dispatch() internal returns (uint256 received) {
        uint256 before = address(router).balance;
        uint256 g = gasleft();
        ITaxProcessor(taxProcessor).dispatch{gas: 1_000_000}();
        uint256 used = g - gasleft();
        if (used > gasDispatch) gasDispatch = used;
        received = address(router).balance - before;
    }

    /// @dev `settle()` with the gas it cost recorded.
    function _settle() internal returns (uint256 toBridge, uint256 toNodeFund) {
        uint256 g = gasleft();
        (toBridge, toNodeFund) = router.settle();
        uint256 used = g - gasleft();
        if (used > gasSettle) gasSettle = used;
    }

    /// @dev Real tax all the way into the bridge pool: curve trades -> dispatch -> settle.
    function _fundBridgeWithRealTax(uint256 rounds, uint256 bnbEach) internal returns (uint256 toBridge) {
        _accrueTax(rounds, bnbEach);
        assertGt(_dispatch(), 0, "dispatch delivered nothing");
        (toBridge,) = _settle();
        assertGt(toBridge, 0, "nothing reached the bridge pool");
    }

    /// @dev Router V1/V2/V9 plus the bridge's two physical-backing checks.
    function _assertSolvent() internal view {
        (uint256 bal, uint256 accounted, uint256 buckets) = router.solvency();
        assertEq(accounted, buckets, "router V1: accounted != buckets");
        assertGe(bal, accounted, "router V2: balance < accounted");
        assertEq(
            router.totalRecognized(),
            router.lifetimeToBridge() + router.lifetimeToNodeFund() + router.accountedQuote(),
            "router V9: totalRecognized"
        );
        assertGe(address(bridge).balance, bridge.bnbBalance(), "bridge B2: BNB balance < book");
        if (token.code.length > 0) {
            assertGe(IERC20(token).balanceOf(address(bridge)), bridge.bacAccounted(), "bridge B2: BAC balance < book");
            (uint256 bnbShort, uint256 bacShort) = bridge.shortfall();
            assertEq(bnbShort, 0, "no BNB shortfall without an owner withdrawal");
            assertEq(bacShort, 0, "no BAC shortfall without an owner withdrawal");
        }
    }

    /// @dev Mints a real ERC-8004 identity for `who` on the live registry and locks `amount` of
    ///      real BAC with it. Returns the agent id.
    function _enter(address who, uint256 amount) internal returns (uint256 agentId) {
        uint256 g = gasleft();
        agentId = _registerAgent(who, "https://bnbagentchain.example/agent.json");
        gasRegister = g - gasleft();
        assertEq(_identityOwner(agentId), who, "the live registry did not mint the identity to its caller");

        if (IERC20(token).balanceOf(who) < amount) {
            _acquireBac(trader, amount);
            vm.prank(trader);
            IERC20(token).transfer(who, amount);
        }
        vm.startPrank(who);
        IERC20(token).approve(address(bridge), amount);
        g = gasleft();
        bridge.lock(agentId, amount);
        gasLock = g - gasleft();
        vm.stopPrank();
    }

    function _exitLeaf(uint256 exitId, uint256 agentId, address to, uint256 credits) internal view returns (bytes32) {
        return keccak256(
            abi.encode(bridge.EXIT_TYPEHASH(), exitId, agentId, to, credits, bridge.LAYER_CHAIN_ID(), address(bridge))
        );
    }

    function _anchorOf(bytes32 exitRoot, uint64 l2Block, uint128 credited, uint128 exitCredits, uint32 exitCount)
        internal
        pure
        returns (IChainAnchor.Anchor memory a)
    {
        a.exitRoot = exitRoot;
        a.l2BlockHash = keccak256(abi.encode("l2BlockHash", l2Block));
        a.l2Block = l2Block;
        a.creditedInEpoch = credited;
        a.exitCreditsInEpoch = exitCredits;
        a.feeBurnedInEpoch = 0;
        a.circulating = OPERATOR_FLOAT;
        a.exitCount = exitCount;
    }

    function _commitmentFor(uint64 epoch, IChainAnchor.Anchor memory a, address who) internal pure returns (bytes32) {
        return keccak256(abi.encode(epoch, a.exitRoot, a.l2BlockHash, a.l2Block, ATT_SALT, who));
    }

    function _implOf(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, IMPL_SLOT))));
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    // ======================================================================================
    //          1 + 2.  THE LAUNCH ITSELF AND EVERY PIECE OF WIRING IT PRODUCED
    // ======================================================================================

    function test_fork_launchSucceededAndWiringIsCorrect() public {
        _assertPortalVersion();

        // — the token is the vanity CREATE2 clone we predicted before pinning three immutables —
        assertEq(uint256(uint160(token)) & 0xffff, 0x7777, "vanity suffix must be 7777");
        assertEq(token, predictedToken, "launched token != the address the immutables were pinned to");
        if (usingLockedSalt) {
            assertEq(token, BAC_TOKEN, "decision #35: the locked salt must launch BAC at T");
            emit log("launched with the REAL locked salt of decision #35, from the deployment wallet");
        } else {
            emit log("BAC already exists on mainnet: launched with a freshly mined ...7777 salt instead");
        }
        assertEq(IERC20Metadata(token).name(), NAME, "name");
        assertEq(IERC20Metadata(token).symbol(), SYMBOL, "symbol");
        assertEq(IFlapTaxTokenV3(token).buyTaxRate(), BUY_TAX, "buy tax");
        assertEq(IFlapTaxTokenV3(token).sellTaxRate(), SELL_TAX, "sell tax");
        assertEq(IFlapTaxTokenV3(token).antiFarmerDuration(), ANTI_FARMER, "anti-farmer window");
        assertEq(uint8(IFlapTaxTokenV3(token).state()), 0, "token must open on the bonding curve");
        assertEq(portal.getTokenV8Safe(token).status, 1, "tradable");
        assertGt(IERC20(token).balanceOf(launcher), 0, "the launch buy delivered no tokens");

        // — the single most expensive thing to get wrong: where the tax is sent —
        ITaxProcessor tp = ITaxProcessor(taxProcessor);
        assertEq(tp.marketAddress(), address(router), "TaxProcessor.marketAddress must be our router");
        assertEq(tp.taxToken(), token, "TaxProcessor.taxToken");
        // Flap's TaxProcessor books the quote as WBNB (isWeth) but pays the router in native BNB.
        assertEq(tp.getQuoteToken(), WBNB, "TaxProcessor quote token is WBNB on BSC");
        assertEq(tp.commissionReceiver(), address(0), "no commission receiver");
        PackedFeeConfigV2 memory c = tp.feeConfigV2();
        assertEq(c.marketBps, MKT_BPS, "mktBps must be 10000");
        assertEq(c.dividendBps, 0, "dividendBps must be 0");
        assertEq(c.deflationBps, 0, "deflationBps must be 0");
        assertEq(c.lpBps, 0, "lpBps must be 0");
        assertEq(c.commissionBps, 0, "commissionBps must be 0");
        assertTrue(c.isWeth, "isWeth is true on BSC (the router still receives native BNB)");
        emit log_named_uint("live Flap protocol feeRate (bps of the tax)", c.feeRate);
        assertEq(c.feeRate, 1000, "measured: Flap takes 10% of the tax before our share is computed");

        // — the router's own wiring. It is not a proxy and it is not upgradeable: the address in
        //   the launch form is the final one, and nobody but Flap's own admin can change it. —
        assertEq(router.bacToken(), token, "router.bacToken must be the launched token");
        assertEq(router.bridge(), address(bridge), "router.bridge must be the bridge PROXY");
        assertEq(router.nodeFund(), address(nodeFund), "router.nodeFund");
        assertEq(router.BRIDGE_BPS(), 5000, "hard-coded 50/50 split");
        assertEq(vm.load(address(router), IMPL_SLOT), bytes32(0), "the router must not be a proxy");
        (bool ownerExists,) = address(router).call(abi.encodeWithSignature("owner()"));
        assertFalse(ownerExists, "the router must have no owner()");

        // — the bridge is an ERC1967 proxy over the implementation, initialised exactly once —
        assertEq(_implOf(address(bridge)), address(bridgeImpl), "EIP-1967 implementation slot");
        assertEq(bridge.owner(), bridgeOwner, "decision #33: the owner is the deployment wallet");
        assertEq(bridge.pendingOwner(), address(0), "no pending owner");
        assertEq(bridge.bacToken(), token, "bridge.bacToken");
        assertEq(bridge.identityRegistry(), ERC8004_IDENTITY, "bridge.identityRegistry is the live ERC-8004 registry");
        assertEq(bridge.anchor(), address(anchor), "bridge.anchor");
        assertEq(bridge.watchdog(), watchdog, "bridge.watchdog");
        assertEq(bridge.portal(), PORTAL, "bridge.portal");
        assertEq(bridge.router(), PANCAKE_V2_ROUTER, "bridge.router");
        assertEq(bridge.EXTENSION(), bridgeImpl.EXTENSION(), "the proxy runs the implementation's extension");
        assertGt(bridge.EXTENSION().code.length, 0, "extension deployed");
        assertEq(bridgeImpl.bacToken(), address(0), "the bare implementation holds no state");
        assertEq(bridgeImpl.owner(), address(0), "the bare implementation has no owner");
        vm.expectRevert(bytes("Initializable: contract is already initialized"));
        bridge.initialize(stranger, token, ERC8004_IDENTITY, address(anchor), watchdog, PORTAL, PANCAKE_V2_ROUTER);
        vm.expectRevert(bytes("Initializable: contract is already initialized"));
        bridgeImpl.initialize(stranger, token, ERC8004_IDENTITY, address(anchor), watchdog, PORTAL, PANCAKE_V2_ROUTER);
        vm.prank(bridgeOwner);
        vm.expectRevert(bytes(unicode"Renounce disabled / 已禁用放弃所有权"));
        bridge.renounceOwnership();
        assertGt(address(bridgeImpl).code.length, 0, "implementation code");
        assertLe(address(bridgeImpl).code.length, 24_576, "EIP-170: implementation");
        assertLe(bridge.EXTENSION().code.length, 24_576, "EIP-170: extension");

        // — description() carries the sentences decisions #29a and #31a make mandatory —
        assertEq(bridge.OWNER_POWER_NOTICE(), NOTICE_29A, "OWNER_POWER_NOTICE must be #29a verbatim");
        string memory d = bridge.description();
        assertTrue(_contains(bytes(d), bytes(NOTICE_29A)), "bridge description must carry #29a verbatim");
        assertTrue(_contains(bytes(d), bytes(NOTICE_31A)), "bridge description must carry #31a verbatim");
        emit log_string(d);
        assertTrue(
            _contains(bytes(d), bytes(unicode"不要给桥留授权额度")),
            "bridge description must warn about standing allowances"
        );
        // Decision #32: the immutable, ownerless router freezes no text; #29a lives on the bridge.
        (bool hasDesc,) = address(router).staticcall(abi.encodeWithSignature("description()"));
        assertFalse(hasDesc, "decision #32: BacTaxRouter must not carry a description()");

        _assertSolvent();
        emit log_named_address("launched token (vanity ...7777)", token);
        emit log_named_address("BacTaxRouter (the beneficiary in the launch form)", address(router));
        emit log_named_address("BacBridge proxy", address(bridge));
        emit log_named_address("BacBridge implementation", address(bridgeImpl));
        emit log_named_address("BacBridgeExtension", bridge.EXTENSION());
        emit log_named_bytes32("launch salt", launchSalt);
        emit log_named_uint("fork block", vm.getBlockNumber());
        emit log_named_uint("GAS launch (plain Portal newTokenV6, with 0.05 BNB launch buy)", gasLaunch);
        emit log_named_uint("GAS deploy BacBridge implementation (+ extension)", gasDeployImpl);
        emit log_named_uint("GAS deploy ERC1967Proxy + initialize", gasDeployProxy);
        emit log_named_uint("SIZE BacBridge implementation (bytes)", address(bridgeImpl).code.length);
        emit log_named_uint("SIZE BacBridgeExtension (bytes)", bridge.EXTENSION().code.length);
    }

    // ======================================================================================
    //          3.  THE REAL TAX PATH: curve trade -> dispatch -> receive -> settle
    // ======================================================================================

    function test_fork_realTaxReachesTheRouterAndSplits5050() public {
        // real buys and sells through the real Portal route
        _accrueTax(4, 0.4 ether);

        ITaxProcessor tp = ITaxProcessor(taxProcessor);
        uint256 pending = _pendingMarketBalance(token);
        uint256 feePending = tp.feeQuoteBalance();
        assertGt(pending, 0, "no market tax accrued on the real curve");
        emit log_named_uint("TaxProcessor.marketQuoteBalance before dispatch (wei)", pending);
        emit log_named_uint("TaxProcessor.feeQuoteBalance before dispatch (wei)", feePending);
        // The protocol fee, measured from the live books rather than read from the config: of all
        // the quote the curve's tax produced, the share that is ours.
        if (feePending > 0) {
            uint256 oursBps = (pending * 10000) / (pending + feePending);
            emit log_named_uint("MEASURED share of the tax that is ours (bps)", oursBps);
            assertApproxEqAbs(oursBps, 9000, 1, "measured: 90% of the tax is ours, 10% is Flap's fee");
        }

        // ── dispatch: the real keeper call, the real 1,000,000 gas budget ─────────────────
        uint256 received = _dispatch();
        assertGt(received, 0, "dispatch() delivered no BNB to the router");
        assertEq(received, pending, "router did not receive the whole market balance");
        assertEq(router.accountedQuote(), received, "receive() did not recognize the dispatch");
        assertEq(router.unsplitRevenue(), received, "revenue not booked as unsplit");
        _assertSolvent();

        // ── settle: 50/50 to the BacBridge PROXY's acceptRelease() and BacNodeFund's ─────
        uint256 poolBefore = bridge.bnbBalance();
        uint256 fundBefore = nodeFund.lifetimeReceived();
        (uint256 toBridge, uint256 toNodeFund) = _settle();

        assertEq(toBridge + toNodeFund, received, "the split must not lose a wei");
        assertEq(toNodeFund, received / 2, "node fund gets floor(50%)");
        assertEq(toBridge, received - received / 2, "the rounding remainder goes to the bridge pool");

        assertEq(bridge.bnbBalance(), poolBefore + toBridge, "bridge pool did not grow by the bridge half");
        assertEq(address(bridge).balance, bridge.bnbBalance(), "bridge balance != its book");
        assertEq(nodeFund.lifetimeReceived(), fundBefore + toNodeFund, "node fund half not received");
        assertEq(address(nodeFund).balance, nodeFund.lifetimeReceived(), "N1 broken");

        (uint256 sb, uint256 sn) = router.stuckAmounts();
        assertEq(sb, 0, "nothing may be stuck on the bridge side (the proxy fits PUSH_GAS)");
        assertEq(sn, 0, "nothing may be stuck on the node fund side");
        assertEq(router.accountedQuote(), 0, "everything was pushed out");
        assertEq(router.unsplitRevenue(), 0, "nothing left unsplit");
        assertEq(router.lifetimeToBridge(), toBridge, "lifetimeToBridge");
        assertEq(router.lifetimeToNodeFund(), toNodeFund, "lifetimeToNodeFund");
        assertEq(address(router).balance, 0, "the router keeps nothing after a clean settle");
        _assertSolvent();

        // ── a second round proves the accounting is incremental, not absolute ─────────────
        _accrueTax(2, 0.3 ether);
        uint256 second = _dispatch();
        assertGt(second, 0, "second dispatch delivered nothing");
        _settle();
        assertEq(router.totalRecognized(), received + second, "rule 010: totalRecognized");
        assertEq(router.lifetimeToBridge() + router.lifetimeToNodeFund(), received + second, "everything pushed");
        _assertSolvent();

        emit log_named_uint("GAS dispatch (real TaxProcessor, keeper budget 1,000,000)", gasDispatch);
        emit log_named_uint("GAS router.settle (two pushes, one through the bridge proxy)", gasSettle);
        emit log_named_uint("tax that reached the router, round 1 (wei)", received);
        emit log_named_uint("tax that reached the router, round 2 (wei)", second);
    }

    // ======================================================================================
    //          4.  THE GAS PROPERTIES THAT FORFEIT MONEY IF THEY ARE WRONG
    // ======================================================================================

    function test_fork_receiveSucceedsUnder50kGasAndDispatchFitsTheKeeperBudget() public {
        // The TaxProcessor pays us with call{gas: 50_000}: a cold receive() must complete in it.
        vm.deal(stranger, 10 ether);
        vm.startPrank(stranger);
        uint256 g = gasleft();
        (bool ok,) = address(router).call{value: 1 ether, gas: 50_000}("");
        gasReceiveCold = g - gasleft();
        assertTrue(ok, "receive() failed under call{gas: 50_000}");

        g = gasleft();
        (ok,) = address(router).call{value: 1 ether, gas: 50_000}("");
        gasReceiveWarm = g - gasleft();
        assertTrue(ok, "warm receive() failed under call{gas: 50_000}");
        vm.stopPrank();

        assertLt(gasReceiveCold, 50_000, "cold receive() over the 50,000 budget");
        assertLt(gasReceiveWarm, 30_000, "warm receive() over the 30,000 budget");
        assertEq(router.accountedQuote(), 2 ether, "both sends were recognized");
        _settle();
        _assertSolvent();

        // The router pushes the bridge half with call{gas: PUSH_GAS}. Since decision #29 that goes
        // through the ERC1967 proxy: a cold acceptRelease() must still fit.
        vm.deal(stranger, 10 ether);
        BacBridge fresh = BacBridge(
            address(
                new ERC1967Proxy(
                    address(bridgeImpl),
                    abi.encodeCall(
                        BacBridge.initialize,
                        (bridgeOwner, token, ERC8004_IDENTITY, address(anchor), watchdog, PORTAL, PANCAKE_V2_ROUTER)
                    )
                )
            )
        );
        vm.prank(stranger);
        g = gasleft();
        fresh.acceptRelease{value: 1 ether, gas: router.PUSH_GAS()}();
        uint256 gasAcceptCold = g - gasleft();
        assertEq(fresh.bnbBalance(), 1 ether, "a cold acceptRelease through the proxy must book its value");

        // the whole dispatch, including our receive(), must fit the keeper's budget
        _accrueTax(3, 0.4 ether);
        uint256 got = _dispatch();
        assertGt(got, 0, "dispatch delivered nothing");
        assertLt(gasDispatch, 1_000_000, "dispatch exceeded the keeper's 1,000,000 gas budget");

        emit log_named_uint("GAS router receive() cold (budget 50,000)", gasReceiveCold);
        emit log_named_uint("GAS router receive() warm", gasReceiveWarm);
        emit log_named_uint("GAS bridge.acceptRelease cold, through the proxy (budget PUSH_GAS)", gasAcceptCold);
        emit log_named_uint("GAS dispatch (whole call, budget 1,000,000)", gasDispatch);
    }

    // ======================================================================================
    //          5.  WHAT THE PLAIN PORTAL CHECKS, AND WHAT IT DOES NOT (research 12 §4.1)
    // ======================================================================================

    /// @notice Without a factory hook, the Portal's own rules are the only thing between a typo in
    ///         the form and a wrong token on chain forever. This pins, against the live Portal,
    ///         which mistakes it refuses and which it happily launches.
    function test_fork_plainPortalGuardsAndGaps() public {
        _seedVanitySalt(keccak256(abi.encode("negative", vm.getBlockNumber())));
        bytes32 salt = _findVanitySalt(VanityType.VANITY_7777, TOKEN_IMPL_TAXED_V3, PORTAL);
        IPortalTypes.NewTokenV6Params memory p;
        bytes memory r;

        // ── what the Portal REFUSES ────────────────────────────────────────────────────────
        // (a) a salt whose token address does not end in 7777
        p = _formParams(bytes32(uint256(1)), address(router));
        r = _launchReverts(stranger, p);
        assertEq(bytes4(r), bytes4(keccak256("VanityAddressRequirementNotMet(address)")), "non-vanity salt");

        // (b) a token version other than TOKEN_TAXED_V3
        p = _formParams(salt, address(router));
        p.tokenVersion = IPortalTypes.TokenVersion.TOKEN_TAXED_V2;
        r = _launchReverts(stranger, p);
        assertEq(bytes4(r), bytes4(keccak256("FeatureDisabled()")), "wrong token version");

        // (c) any supply threshold other than FOUR_FIFTHS (the docs' TWO_THIRDS example included)
        p = _formParams(salt, address(router));
        p.dexThresh = IPortalCommonTypes.DexThreshType.TWO_THIRDS;
        r = _launchReverts(stranger, p);
        assertEq(bytes4(r), bytes4(keccak256("InvalidDexThresholdType(uint8)")), "wrong dexThresh");

        // (d) a beneficiary of address(0) — refused by the TaxProcessor's initializer. NOTE: this
        //     corrects research 12 §2.4, whose eth_call stopped at the vanity check and so never
        //     reached the TaxProcessor; a real launch with a zero beneficiary does NOT go through.
        p = _formParams(salt, address(0));
        r = _launchReverts(stranger, p);
        assertTrue(_contains(r, bytes("TaxProcessor: zero wallet1 address")), "zero beneficiary");

        // (e) a non-BNB quote token
        p = _formParams(salt, address(router));
        p.quoteToken = USDT;
        r = _launchReverts(stranger, p);
        emit log_named_bytes("USDT quote revert data", r);

        // (f) the same form through newTokenV7 (one MARKETING_OR_VAULT slot = our router). The
        //     live v5.24.0 Portal refuses a TOKEN_TAXED_V3 launch there outright, so newTokenV6 is
        //     not a preference, it is the only function that launches BAC.
        IPortalTypes.NewTokenV7Params memory p7 = _buildV3TaxTokenParamsV7(NAME, SYMBOL, salt, address(router));
        p7.buyTaxRate = BUY_TAX;
        p7.sellTaxRate = SELL_TAX;
        vm.prank(stranger, stranger);
        (bool ok7, bytes memory r7) =
            PORTAL.call{gas: MAX_OP_GAS}(abi.encodeWithSelector(IPortalLauncher.newTokenV7.selector, p7));
        assertFalse(ok7, "newTokenV7 must not launch a TOKEN_TAXED_V3");
        assertEq(r7, abi.encodeWithSignature("NewTokenV7RuleViolation(uint8)", uint8(4)), "V7 rule 4");

        // ── what the Portal ACCEPTS without a word (the cost of decision #30) ────────────────
        // (g) a wrong beneficiary AND a wrong tax rate: the Portal launches it, and the tax of that
        //     token belongs to whoever was typed in, for its whole life. Nothing we own can stop
        //     it — the only defence is checking the form by eye before pressing Launch.
        p = _formParams(salt, stranger);
        p.buyTaxRate = 300;
        p.mktBps = 5_000;
        p.deflationBps = 5_000;
        address wrong = _launchOk(stranger, p);
        assertEq(uint256(uint160(wrong)) & 0xffff, 0x7777, "the wrong launch still got a vanity address");
        assertEq(ITaxProcessor(IFlapTaxTokenV3(wrong).taxProcessor()).marketAddress(), stranger, "tax -> stranger");
        assertEq(IFlapTaxTokenV3(wrong).buyTaxRate(), 300, "3% buy tax accepted");
        assertEq(ITaxProcessor(IFlapTaxTokenV3(wrong).taxProcessor()).feeConfigV2().deflationBps, 5_000, "split");
        emit log_named_address("a WRONG form launched anyway (beneficiary = stranger, 3% tax)", wrong);
    }

    // ======================================================================================
    //          6.  ENTRY THROUGH THE LIVE ERC-8004 REGISTRY (decision #31)
    // ======================================================================================

    function test_fork_agentEntersWithARealErc8004Identity() public {
        (bool okName, bytes memory nm) = ERC8004_IDENTITY.staticcall(abi.encodeWithSignature("name()"));
        assertTrue(okName, "registry name()");
        assertEq(abi.decode(nm, (string)), "AgentIdentity", "the live registry");

        uint256 amount = 1_000_000e18;
        _acquireBac(trader, 3 * amount);
        vm.startPrank(trader);
        IERC20(token).transfer(ctrl, amount);
        IERC20(token).transfer(stranger, amount);
        IERC20(token).transfer(buyer, amount);
        vm.stopPrank();

        // ── a real, fresh identity, minted by the holder itself on the live registry ────────
        uint256 g = gasleft();
        uint256 agentId = _registerAgent(ctrl, "https://bnbagentchain.example/agent.json");
        gasRegister = g - gasleft();
        assertGt(agentId, 356_000, "a real sequential id on the live registry");
        assertEq(_identityOwner(agentId), ctrl, "ownerOf(new id)");
        assertTrue(bridge.holdsIdentity(ctrl, agentId), "holdsIdentity(holder)");
        assertFalse(bridge.holdsIdentity(stranger, agentId), "holdsIdentity(stranger)");
        assertEq(bridge.identityOwner(agentId + 1_000_000), address(0), "an unminted id resolves to zero");

        // ── the gate: no identity, somebody else's identity, an unminted id, id 0 ───────────
        vm.startPrank(stranger);
        IERC20(token).approve(address(bridge), amount);
        vm.expectRevert(bytes(unicode"Not the ERC-8004 identity holder / 不是该 ERC-8004 身份的持有人"));
        bridge.lock(agentId, amount);
        vm.expectRevert(bytes(unicode"Not the ERC-8004 identity holder / 不是该 ERC-8004 身份的持有人"));
        bridge.lock(agentId + 1_000_000, amount);
        vm.expectRevert(bytes(unicode"Zero agent id / agent 身份编号为零"));
        bridge.lock(0, amount);
        vm.stopPrank();

        // ── the holder enters ────────────────────────────────────────────────────────────────
        vm.startPrank(ctrl);
        IERC20(token).approve(address(bridge), amount);
        g = gasleft();
        uint256 depId = bridge.lock(agentId, amount);
        gasLock = g - gasleft();
        vm.stopPrank();

        assertEq(depId, 0, "first deposit id");
        (address from, uint64 at, uint256 recAgent, uint256 recAmount) = bridge.deposits(depId);
        assertEq(from, ctrl, "deposit.from");
        assertEq(uint256(at), vm.getBlockTimestamp(), "deposit.at");
        assertEq(recAgent, agentId, "deposit.agentId");
        assertEq(recAmount, amount, "deposit.amount (measured by balance difference)");
        assertEq(bridge.agentController(agentId), ctrl, "first entry sets the agent controller");
        assertEq(bridge.lockedBac(), amount, "deposit bucket");
        assertEq(bridge.totalCreditsIssued(), amount, "credits issued 1:1");
        assertEq(bridge.credited(agentId), amount, "credited per agent");
        assertEq(IERC20(token).balanceOf(address(bridge)), amount, "BAC held by the proxy");

        // ── the identity is a transferable ERC-721: the gate follows it, the claim does not ──
        vm.prank(ctrl);
        (bool okT,) = ERC8004_IDENTITY.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", ctrl, buyer, agentId)
        );
        assertTrue(okT, "identity transfer on the live registry");
        assertEq(_identityOwner(agentId), buyer, "the buyer now holds the identity");

        vm.startPrank(ctrl);
        IERC20(token).approve(address(bridge), 1e18);
        vm.expectRevert(bytes(unicode"Not the ERC-8004 identity holder / 不是该 ERC-8004 身份的持有人"));
        bridge.lock(agentId, 1e18);
        vm.stopPrank();

        // The buyer passes the gate but may not add to the seller's escape claim (review finding
        // 2026-09-23: a seller who entered with dust would otherwise collect the buyer's deposit
        // after a halt). Refused until the controller hands the claim over.
        vm.startPrank(buyer);
        IERC20(token).approve(address(bridge), amount);
        vm.expectRevert(
            bytes(
                unicode"Another address controls this agent id, see setAgentController / 该身份已由其他地址控制，见 setAgentController"
            )
        );
        bridge.lock(agentId, amount);
        IERC20(token).approve(address(bridge), 0); // never leave a standing allowance on the proxy
        vm.stopPrank();
        assertEq(bridge.credited(agentId), amount, "nothing of the buyer's joined the seller's claim");

        vm.prank(buyer);
        vm.expectRevert(bytes(unicode"Only the agent controller / 仅限该 agent 的控制地址"));
        bridge.setAgentController(agentId, buyer);
        vm.prank(ctrl);
        bridge.setAgentController(agentId, buyer);
        assertEq(bridge.agentController(agentId), buyer, "the controller handed the claim on");

        vm.startPrank(buyer);
        IERC20(token).approve(address(bridge), amount);
        g = gasleft();
        bridge.lock(agentId, amount);
        uint256 gasLockRepeat = g - gasleft();
        vm.stopPrank();
        assertEq(bridge.agentController(agentId), buyer, "a lock never moves the controller");
        assertEq(bridge.credited(agentId), 2 * amount, "both deposits count against the same identity");
        _assertSolvent();

        emit log_named_uint("GAS ERC-8004 register(string) on the live registry", gasRegister);
        emit log_named_uint("GAS bridge.lock (first entry, cold, live ERC-8004 gate)", gasLock);
        emit log_named_uint("GAS bridge.lock (repeat entry, same id, new holder)", gasLockRepeat);
    }

    // ======================================================================================
    //          7.  THE WHOLE ROUND TRIP, AND GAS FOR EVERYTHING THAT HAS TO FIT A BSC BLOCK
    // ======================================================================================

    function test_fork_roundTripThroughAnchorAndMeasureGas() public {
        // ── fund the bridge pool with real tax, exactly as production would ──────────────
        _accrueTax(4, 0.5 ether);
        // One buy that is HELD, so the curve has real depth for the buyback further down and
        // the bridge's 3% slippage bound is measured against a live reserve, not a toy one.
        _buy(makeAddr("curveDepth"), 5 ether);
        _dispatch();
        _settle();
        assertGt(bridge.bnbBalance(), 0, "bridge pool is empty");

        // ── an agent enters with a real ERC-8004 identity and real BAC ───────────────────
        _acquireBac(trader, 3 * MIN_STAKE + 1_000_000e18);
        uint256 lockAmount = 1_000_000e18;
        uint256 agentId = _enter(ctrl, lockAmount);
        assertEq(bridge.totalCreditsIssued(), lockAmount, "credits issued 1:1");
        assertEq(IERC20(token).balanceOf(address(bridge)), lockAmount, "B6: locked BAC held");

        // ── three validators stake real BAC and register nodes ──────────────────────────
        for (uint256 i; i < 3; ++i) {
            vm.prank(trader);
            IERC20(token).transfer(validators[i], MIN_STAKE);
            vm.startPrank(validators[i]);
            IERC20(token).approve(address(staking), MIN_STAKE);
            staking.stake(MIN_STAKE);
            staking.registerNode(keccak256(abi.encode("node", i)), "enode://abc@1.2.3.4:30303", validators[i]);
            vm.stopPrank();
        }
        assertEq(staking.totalStaked(), 3 * MIN_STAKE, "total staked");

        // ── epoch e0: commit, post, reveal, finalize ────────────────────────────────────
        uint64 e0 = anchor.firstEpoch();
        assertEq(bridge.lastSettledEpoch(), e0, "the settle cursor starts at the deploy epoch");

        uint256 exitId = 1;
        uint256 credits = lockAmount / 2;
        bytes32 leaf = _exitLeaf(exitId, agentId, exitTo, credits);
        IChainAnchor.Anchor memory a0 = _anchorOf(leaf, 1_000, uint128(lockAmount), uint128(credits), 1);
        IChainAnchor.Anchor memory a1 = _anchorOf(bytes32(0), 2_000, 0, 0, 0);

        // COMMIT_WINDOW is 0: a commitment for epoch N must be filed before N ends, which is
        // also the earliest instant postAnchor accepts. Nothing has warped yet, so we are still
        // inside e0 and both commitments are legal right here, with no warp at all.
        for (uint256 i; i < 3; ++i) {
            vm.startPrank(validators[i]);
            uint256 gc = gasleft();
            staking.commitAttestation(e0, _commitmentFor(e0, a0, validators[i]));
            if (i == 0) gasCommit = gc - gasleft();
            staking.commitAttestation(e0 + 1, _commitmentFor(e0 + 1, a1, validators[i]));
            vm.stopPrank();
        }

        vm.warp((uint256(e0) + 1) * E);
        vm.prank(relayer);
        uint256 g = gasleft();
        anchor.postAnchor(e0, a0);
        gasPostAnchor = g - gasleft();
        assertEq(uint8(anchor.getAnchor(e0).state), uint8(IChainAnchor.State.POSTED), "e0 posted");

        // reveals land inside the 120-second anchor wait
        for (uint256 i; i < 3; ++i) {
            vm.startPrank(validators[i]);
            uint256 gr = gasleft();
            staking.revealAttestation(e0, a0.exitRoot, a0.l2BlockHash, a0.l2Block, ATT_SALT);
            if (i == 0) gasReveal = gr - gasleft();
            vm.stopPrank();
        }
        (uint256 agreeW,, uint32 agreeC,) = staking.attestationResult(e0, a0.exitRoot, a0.l2BlockHash, a0.l2Block);
        assertEq(agreeC, 3, "three agreeing witnesses");
        assertEq(agreeW, 3 * MIN_STAKE, "agreeing weight");

        vm.warp(uint256(anchor.getAnchor(e0).postedAt) + anchor.ANCHOR_WAIT());
        g = gasleft();
        anchor.finalize(e0);
        gasFinalize = g - gasleft();
        assertEq(uint8(anchor.getAnchor(e0).state), uint8(IChainAnchor.State.FINAL), "e0 final");
        assertEq(anchor.releaseBpsFor(e0), 500, "quorum of 3 -> 5% release");

        // ---- epoch e0+1: post, reveal, finalize --------------------------------------
        vm.warp(_max(vm.getBlockTimestamp() + 1, (uint256(e0) + 2) * E));
        vm.prank(relayer);
        anchor.postAnchor(e0 + 1, a1);
        for (uint256 i; i < 3; ++i) {
            vm.prank(validators[i]);
            staking.revealAttestation(e0 + 1, a1.exitRoot, a1.l2BlockHash, a1.l2Block, ATT_SALT);
        }
        vm.warp(uint256(anchor.getAnchor(e0 + 1).postedAt) + anchor.ANCHOR_WAIT());
        anchor.finalize(e0 + 1);
        assertEq(uint8(anchor.getAnchor(e0 + 1).state), uint8(IChainAnchor.State.FINAL), "e0+1 final");

        // ---- the buyback, on the live flap curve, with real tax BNB (decision #24) ----
        //      A day of accrual is 20% of the BNB bucket; the fill has to clear the bridge's own
        //      3% slippage floor, which is computed from the Portal's live price.
        vm.warp(vm.getBlockTimestamp() + uint256(bridge.EPOCHS_PER_DAY()) * E);
        IPortalTypes.TokenStateV8Safe memory st = portal.getTokenV8Safe(token);
        assertEq(uint256(st.status), 1, "BAC must still be on the curve here");
        // The pre-trade mid price and the token's own buy tax, read off the live Portal. Both are
        // what the bridge itself reads inside `_venue`, so the floor recomputed here is the
        // contract's real floor and not a test-local invention.
        uint256 priceBefore = st.price; // quote (BNB) per BAC, 18 decimals
        uint256 buyTaxBps = st.buyTaxRate;
        assertEq(buyTaxBps, BUY_TAX, "live buy tax is not the 2% we launched with");

        // Quoted BEFORE the buy, at a size small enough that its own price impact is negligible:
        // this separates the venue's fixed cost from the impact of the bridge's own order.
        uint256 dustKeptBps;
        {
            uint256 dust = 1e12; // 0.000001 BNB
            uint256 dustOut = portal.quoteExactInput(IPortalTradeV2.QuoteExactInputParams(address(0), token, dust));
            dustKeptBps = (dustOut * priceBefore * 10000) / (1e18 * dust);
        }

        uint256 bnbBefore = bridge.bnbBalance();
        uint256 lockedBefore = bridge.lockedBac();
        uint256 burnedBefore = bridge.totalBurned();
        g = gasleft();
        uint256 bought = bridge.buyback(0, 0);
        gasBuyback = g - gasleft();
        uint256 spentBnb = bnbBefore - bridge.bnbBalance();
        assertGt(bought, 0, "the buyback bought no BAC on the live curve");
        assertGt(spentBnb, 0, "the buyback spent no BNB");
        assertLe(spentBnb, bridge.MAX_BUYBACK_BNB(), "single-call spend cap breached");
        assertEq(bridge.buybackBac(), bought, "bought BAC must land in the payout bucket");
        assertEq(bridge.lockedBac(), lockedBefore, "a buyback must never touch the deposit bucket");
        assertEq(bridge.lockedBac(), lockAmount, "lockedBac drifted from what was deposited");
        assertEq(bridge.totalBurned(), burnedBefore, "a buyback burns nothing");
        assertEq(bridge.buybackBnbSpent(), spentBnb, "buybackBnbSpent != the BNB that left the book");
        assertEq(bridge.buybackBacBought(), bought, "buybackBacBought != the BAC that arrived");
        assertEq(
            IERC20(token).balanceOf(address(bridge)),
            bridge.lockedBac() + bridge.buybackBac() - bridge.totalBurned(),
            "BAC books: balance != lockedBac + buybackBac - burned"
        );
        {
            // ---- the slippage bound, recomputed from the live pre-trade price ---------------
            uint256 grossAtMid = (spentBnb * 1e18) / priceBefore; // no tax, no slippage
            uint256 floorOut = (grossAtMid * (10000 - buyTaxBps) * (10000 - bridge.MAX_BUY_SLIPPAGE_BPS())) / 1e8;
            assertGe(bought, floorOut, "the fill breached MAX_BUY_SLIPPAGE_BPS");
            assertLe(bought, grossAtMid, "the fill beat the pre-trade mid price, which is impossible");

            // ---- how much of the spent BNB survives as BAC (decision #24b's honest cost) ----
            //      Valued at the PRE-TRADE mid price, so the number is `1 - buyTax - slippage`.
            uint256 survivalBps = (bought * priceBefore * 10000) / (1e18 * spentBnb);
            uint256 floorBps = ((10000 - buyTaxBps) * (10000 - bridge.MAX_BUY_SLIPPAGE_BPS())) / 10000;
            emit log_named_uint("buyback: BNB spent (wei)", spentBnb);
            emit log_named_uint("buyback: BAC bought (wei)", bought);
            emit log_named_uint("buyback: pre-trade mid price (wei BNB per BAC)", priceBefore);
            emit log_named_uint("SURVIVAL curve: bps of spent BNB still BAC at the pre-trade mid", survivalBps);
            emit log_named_uint("SURVIVAL curve: buy tax alone would leave (bps)", 10000 - buyTaxBps);
            emit log_named_uint("SURVIVAL curve: cost at ~zero size, quoted pre-trade (bps kept)", dustKeptBps);
            emit log_named_uint("SURVIVAL curve: contract's own worst-case floor (bps)", floorBps);
            assertGe(survivalBps, floorBps, "survival below the contract's own floor");
            assertLe(survivalBps, 10000 - buyTaxBps, "survival above the no-slippage ceiling");
        }

        // ---- claimExit against the real FINAL anchor (single-leaf tree: empty proof) ---
        bytes32[] memory proof = new bytes32[](0);
        g = gasleft();
        uint256 lockedBacAmt = bridge.claimExit(e0, exitId, agentId, exitTo, credits, proof);
        gasClaimExit = g - gasleft();
        assertGt(lockedBacAmt, 0, "claimExit locked nothing");
        assertEq(bridge.owedTotal(), lockedBacAmt, "owedTotal");
        assertTrue(bridge.exitClaimed(exitId), "exit marked claimed");
        assertLe(bridge.owedTotal(), bridge.buybackBac(), "B1: solvency is structural");
        assertLe(lockedBacAmt, bought, "an exit locked more BAC than the buyback ever bought");
        assertEq(bridge.lockedBac(), lockAmount, "claimExit must not move lockedBac");
        assertEq(bridge.buybackBac(), bought, "claimExit moves no BAC, it only locks a rate");
        assertEq(bridge.exitedCredits(agentId), credits, "exit attributed to the ERC-8004 identity");

        // ---- settle and collect: the exit is paid in BAC, out of the buyback bucket ----
        bridge.settleEpoch(e0 + 1);
        (uint256 pot,, uint16 bps) = bridge.lastEpochRelease();
        assertGt(pot, 0, "settleEpoch released nothing");
        assertEq(bps, 500, "release bps (a DAILY tier, divided by 144 inside the bridge)");

        uint256 span = uint64(vm.getBlockTimestamp() / E) - bridge.lastCollectEpoch(exitTo);
        if (span > bridge.MAX_CATCHUP_EPOCHS()) span = bridge.MAX_CATCHUP_EPOCHS();
        uint256 buybackBeforePay = bridge.buybackBac();
        uint256 bnbBeforePay = bridge.bnbBalance();
        // B15: 10% of what the settled daily rate releases from the whole bucket, per epoch
        uint256 cap = (buybackBeforePay * bps * bridge.MAX_EXIT_SHARE_BPS() * span) / (1e8 * 144);
        vm.prank(exitTo);
        g = gasleft();
        uint256 paid = bridge.collect(exitTo);
        gasCollect = g - gasleft();
        assertGt(paid, 0, "collect paid nothing");
        assertLe(paid, cap, "B15: per-epoch cap");
        assertLe(paid, pot, "collect paid more than was released");
        assertEq(IERC20(token).balanceOf(exitTo), paid, "the exit address actually received BAC");
        assertEq(exitTo.balance, 0, "an exit pays BAC, never BNB (decision #24)");
        assertEq(bridge.buybackBac(), buybackBeforePay - paid, "the payout did not come out of buybackBac");
        assertEq(bridge.lockedBac(), lockAmount, "an exit touched lockedBac");
        assertEq(bridge.totalBurned(), burnedBefore, "an exit must not burn from the deposit bucket");
        assertEq(bridge.bnbBalance(), bnbBeforePay, "an exit moved BNB; exits are BAC-only");
        assertLe(paid, bought, "paid out more BAC than the buyback ever bought");
        assertLe(bridge.owedTotal(), bridge.buybackBac(), "B1: solvency");
        assertEq(
            IERC20(token).balanceOf(address(bridge)),
            bridge.lockedBac() + bridge.buybackBac() - bridge.totalBurned(),
            "BAC books after the payout: balance != lockedBac + buybackBac - burned"
        );
        _assertSolvent();

        emit log_named_uint("GAS ERC-8004 register(string)", gasRegister);
        emit log_named_uint("GAS bridge.lock (live ERC-8004 gate, through the proxy)", gasLock);
        emit log_named_uint("GAS bridge.claimExit (1-leaf proof)", gasClaimExit);
        emit log_named_uint("GAS bridge.collect (pays BAC)", gasCollect);
        emit log_named_uint("GAS bridge.buyback (flap curve)", gasBuyback);
        emit log_named_uint("GAS anchor.postAnchor", gasPostAnchor);
        emit log_named_uint("GAS anchor.finalize (3 witnesses)", gasFinalize);
        emit log_named_uint("GAS staking.commitAttestation", gasCommit);
        emit log_named_uint("GAS staking.revealAttestation", gasReveal);
        emit log_named_uint("GAS launch (plain Portal newTokenV6)", gasLaunch);
        emit log_named_uint("GAS dispatch", gasDispatch);
        emit log_named_uint("GAS router.settle", gasSettle);
    }

    // ======================================================================================
    //          8.  OWNER POWER #1: UPGRADE, ON LIVE STATE, LOGGED (decisions #29 / #29c)
    // ======================================================================================

    function test_fork_ownerUpgradeKeepsTheBooksAndIsLogged() public {
        // real state to carry across the upgrade: tax BNB in the pool, a real ERC-8004 deposit
        _fundBridgeWithRealTax(3, 0.4 ether);
        uint256 agentId = _enter(ctrl, 1_000_000e18);

        address oldImpl = _implOf(address(bridge));
        address oldExt = bridge.EXTENSION();
        uint256 bnbBook = bridge.bnbBalance();
        uint256 lockedBook = bridge.lockedBac();
        uint256 buybackBook = bridge.buybackBac();
        uint256 owedBook = bridge.owedTotal();
        uint256 issued = bridge.totalCreditsIssued();
        uint64 settled = bridge.lastSettledEpoch();
        uint256 bnbHeld = address(bridge).balance;
        uint256 bacHeld = IERC20(token).balanceOf(address(bridge));

        BacBridge newImpl = new BacBridge();

        // — nobody but the owner, and never onto something that is not UUPS —
        vm.prank(stranger);
        vm.expectRevert(bytes(unicode"Only owner / 仅限 owner"));
        bridge.upgradeTo(address(newImpl));
        vm.prank(watchdog);
        vm.expectRevert(bytes(unicode"Only owner / 仅限 owner"));
        bridge.upgradeTo(address(newImpl));
        vm.prank(bridgeOwner);
        vm.expectRevert(bytes("ERC1967Upgrade: new implementation is not UUPS"));
        bridge.upgradeTo(oldExt);

        // — the owner upgrades: BridgeUpgraded carries the old implementation and the books —
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.expectEmit(true, true, true, true, address(bridge));
        emit BacBridge.BridgeUpgraded(
            address(newImpl),
            oldImpl,
            bridgeOwner,
            1,
            uint64(vm.getBlockTimestamp()),
            bnbBook,
            lockedBook - bridge.totalBurned(),
            buybackBook,
            owedBook
        );
        vm.prank(bridgeOwner);
        uint256 g = gasleft();
        bridge.upgradeTo(address(newImpl));
        uint256 gasUpgrade = g - gasleft();

        assertEq(_implOf(address(bridge)), address(newImpl), "implementation slot moved");
        assertEq(bridge.EXTENSION(), newImpl.EXTENSION(), "the extension moved with the implementation");
        assertTrue(bridge.EXTENSION() != oldExt, "a new extension");
        assertEq(uint256(bridge.upgradeCount()), 1, "upgradeCount");
        assertEq(uint256(bridge.lastUpgradeAt()), vm.getBlockTimestamp(), "lastUpgradeAt");

        // — nothing moved: every book, every wiring slot, every balance —
        assertEq(bridge.bnbBalance(), bnbBook, "bnbBalance");
        assertEq(bridge.lockedBac(), lockedBook, "lockedBac");
        assertEq(bridge.buybackBac(), buybackBook, "buybackBac");
        assertEq(bridge.owedTotal(), owedBook, "owedTotal");
        assertEq(bridge.totalCreditsIssued(), issued, "totalCreditsIssued");
        assertEq(bridge.lastSettledEpoch(), settled, "lastSettledEpoch");
        assertEq(bridge.agentController(agentId), ctrl, "agentController");
        (address from,, uint256 recAgent,) = bridge.deposits(0);
        assertEq(from, ctrl, "deposits[0].from");
        assertEq(recAgent, agentId, "deposits[0].agentId");
        assertEq(bridge.owner(), bridgeOwner, "owner");
        assertEq(bridge.bacToken(), token, "bacToken");
        assertEq(bridge.identityRegistry(), ERC8004_IDENTITY, "identityRegistry");
        assertEq(address(bridge).balance, bnbHeld, "BNB held");
        assertEq(IERC20(token).balanceOf(address(bridge)), bacHeld, "BAC held");
        vm.expectRevert(bytes("Initializable: contract is already initialized"));
        bridge.initialize(stranger, token, ERC8004_IDENTITY, address(anchor), watchdog, PORTAL, PANCAKE_V2_ROUTER);

        // — and it still works: new tax reaches it through the router, a new agent enters —
        uint256 more = _fundBridgeWithRealTax(2, 0.3 ether);
        assertEq(bridge.bnbBalance(), bnbBook + more, "tax after the upgrade");
        (uint256 sb,) = router.stuckAmounts();
        assertEq(sb, 0, "the upgraded bridge still fits the router's PUSH_GAS");
        uint256 id2 = _enter(buyer, 500_000e18);
        assertEq(bridge.agentController(id2), buyer, "entry after the upgrade");
        assertTrue(_contains(bytes(bridge.description()), bytes(NOTICE_29A)), "#29a survives the upgrade");
        _assertSolvent();

        emit log_named_uint("GAS bridge.upgradeTo (owner, live state)", gasUpgrade);
    }

    // ======================================================================================
    //          9.  OWNER POWER #2: EMERGENCY WITHDRAWAL, ON LIVE STATE, LOGGED
    // ======================================================================================

    function test_fork_ownerEmergencyWithdrawIsLoggedAndShowsAsShortfall() public {
        _fundBridgeWithRealTax(4, 2 ether);
        uint256 lockAmount = 1_000_000e18;
        _enter(ctrl, lockAmount);

        uint256 bnbBook = bridge.bnbBalance();
        uint256 bnbHeld = address(bridge).balance;
        assertEq(bnbHeld, bnbBook, "no untracked BNB before");

        // — only the owner; the extension itself refuses direct calls —
        vm.prank(stranger);
        vm.expectRevert(bytes(unicode"Only owner / 仅限 owner"));
        bridge.emergencyWithdrawBnb(payable(stranger), 0);
        vm.prank(watchdog);
        vm.expectRevert(bytes(unicode"Only owner / 仅限 owner"));
        bridge.emergencyWithdrawToken(token, watchdog, 0);
        BacBridge ext = BacBridge(bridge.EXTENSION()); // read first: an argument call would eat the prank
        vm.prank(bridgeOwner);
        vm.expectRevert(bytes(unicode"Call the bridge, not the extension / 请调用桥合约，而非扩展合约"));
        ext.emergencyWithdrawBnb(payable(ownerSink), 0);

        // — the owner takes the whole BNB pool (amount 0 = everything) —
        vm.expectEmit(true, true, true, true, address(bridge));
        emit BacBridge.EmergencyWithdraw(
            bridgeOwner, ownerSink, address(0), bnbHeld, 0, bnbBook, bnbHeld, 1, uint64(vm.getBlockTimestamp())
        );
        vm.prank(bridgeOwner);
        uint256 g = gasleft();
        bridge.emergencyWithdrawBnb(payable(ownerSink), 0);
        uint256 gasWithdrawBnb = g - gasleft();

        assertEq(ownerSink.balance, bnbHeld, "the owner's recipient got the whole pool");
        assertEq(address(bridge).balance, 0, "the pool is empty");
        assertEq(bridge.bnbBalance(), bnbBook, "#29: the book is NOT written down");
        (uint256 bnbShort, uint256 bacShort) = bridge.shortfall();
        assertEq(bnbShort, bnbBook, "shortfall() shows the whole hole");
        assertEq(bacShort, 0, "no BAC missing yet");
        assertEq(bridge.emergencyBnbWithdrawn(), bnbHeld, "lifetime counter");
        assertEq(uint256(bridge.emergencyCount()), 1, "emergencyCount");

        // — then every BAC in the bridge, the agents' deposits included —
        uint256 bacHeld = IERC20(token).balanceOf(address(bridge));
        uint256 bacBook = bridge.bacAccounted();
        assertEq(bacHeld, lockAmount, "only the deposit is held");
        vm.expectEmit(true, true, true, true, address(bridge));
        emit BacBridge.EmergencyWithdraw(
            bridgeOwner, ownerSink, token, bacHeld, 0, bacBook, bacHeld, 2, uint64(vm.getBlockTimestamp())
        );
        vm.prank(bridgeOwner);
        g = gasleft();
        bridge.emergencyWithdrawToken(token, ownerSink, 0);
        uint256 gasWithdrawBac = g - gasleft();

        assertEq(IERC20(token).balanceOf(ownerSink), bacHeld, "the deposits left the bridge");
        assertEq(bridge.lockedBac(), lockAmount, "#29: lockedBac is NOT written down");
        (bnbShort, bacShort) = bridge.shortfall();
        assertEq(bacShort, bacBook, "shortfall() shows the missing BAC");
        assertEq(bridge.emergencyBacWithdrawn(), bacHeld, "BAC lifetime counter");

        // — with the deposits gone, the one non-owner path out of lockedBac fails cleanly —
        vm.expectRevert(bytes(unicode"Token transfer failed / 代币转出失败"));
        bridge.burnLocked();

        // — the money path keeps flowing into the hole: tax still arrives, nothing gets stuck —
        uint256 more = _fundBridgeWithRealTax(2, 0.4 ether);
        assertEq(address(bridge).balance, more, "new tax is physically here");
        assertEq(bridge.bnbBalance(), bnbBook + more, "and booked on top of the old book");
        (bnbShort,) = bridge.shortfall();
        assertEq(bnbShort, bnbBook, "the hole is exactly what was withdrawn");

        // — a buyback spends only BNB that is physically present: a day's budget on the BOOK is
        //   larger than what is here, so it spends exactly what is here and not a wei more —
        vm.warp(vm.getBlockTimestamp() + uint256(bridge.EPOCHS_PER_DAY()) * E);
        (uint256 budget,,,) = bridge.buybackState();
        uint256 physBefore = address(bridge).balance;
        uint256 bookBefore = bridge.bnbBalance();
        assertGt(budget, physBefore, "setup: the book's budget must exceed what is physically here");
        assertGe(physBefore, bridge.MIN_BUYBACK_BNB(), "setup: enough BNB here to buy at all");
        uint256 boughtAfterWithdraw = bridge.buyback(0, 0);
        assertGt(boughtAfterWithdraw, 0, "the buyback bought with what was physically here");
        assertEq(address(bridge).balance, 0, "it spent exactly the physical balance");
        assertEq(bookBefore - bridge.bnbBalance(), physBefore, "and booked exactly that spend");
        (bnbShort,) = bridge.shortfall();
        assertEq(bnbShort, bnbBook, "the hole neither grew nor shrank");

        // — returning the BAC by plain transfer closes the BAC hole —
        vm.prank(ownerSink);
        IERC20(token).transfer(address(bridge), bacHeld);
        (, bacShort) = bridge.shortfall();
        assertEq(bacShort, 0, "BAC refilled");

        emit log_named_uint("GAS bridge.emergencyWithdrawBnb (whole pool)", gasWithdrawBnb);
        emit log_named_uint("GAS bridge.emergencyWithdrawToken (BAC, whole balance)", gasWithdrawBac);
    }

    // ======================================================================================
    //          10.  THE TAX KEEPS FLOWING AFTER THE TOKEN GRADUATES TO THE DEX
    // ======================================================================================

    function test_fork_taxStillReachesTheRouterAfterGraduation() public {
        // Venue BEFORE graduation, read from live chain state: 1 = the flap bonding curve.
        assertEq(uint256(portal.getTokenV8Safe(token).status), 1, "BAC should start on the curve");
        (,,, uint8 venue0) = bridge.buybackState();
        assertEq(uint256(venue0), 1, "a curve-stage BAC must route to the flap curve");

        uint256 i;
        for (i = 0; i < 40 && portal.getTokenV8Safe(token).status == 1; ++i) {
            _buy(makeAddr(string.concat("whale", vm.toString(i))), 5 ether);
        }
        if (portal.getTokenV8Safe(token).status != 4) {
            emit log_named_uint(
                "token did NOT graduate within 40 x 5 BNB buys; status", portal.getTokenV8Safe(token).status
            );
            return;
        }
        emit log_named_uint("BNB spent to graduate the curve (whole BNB)", i * 5);
        assertEq(uint8(IFlapTaxTokenV3(token).state()), 2, "anti-farmer window after migration");

        address seller = makeAddr("whale0");
        uint256 bal = IERC20(token).balanceOf(seller);
        assertGt(bal, 0, "seller holds nothing");
        vm.startPrank(seller);
        _sell(token, bal / 2);
        vm.stopPrank();

        uint256 got = _dispatch();
        assertGt(got, 0, "no DEX tax reached the router after graduation");
        _settle();
        assertGt(bridge.bnbBalance(), 0, "bridge pool got nothing from DEX tax");
        assertGt(nodeFund.lifetimeReceived(), 0, "node fund got nothing from DEX tax");
        _assertSolvent();
        emit log_named_uint("post-graduation tax to the router (wei)", got);

        // decision #24: the buyback has to change venue by itself. Nothing is stored and nobody
        // flips a flag - `getTokenV8Safe(BAC).status` went from 1 (curve) to 4 (DEX) and the
        // bridge routes to PancakeSwap V2 from this block on.
        vm.deal(address(this), address(this).balance + 3 ether);
        bridge.acceptRelease{value: 2 ether}();
        vm.warp(vm.getBlockTimestamp() + uint256(bridge.EPOCHS_PER_DAY()) * E);
        (,,, uint8 venue) = bridge.buybackState();
        assertEq(uint256(venue), 2, "a graduated BAC must route to PancakeSwap V2");

        // The fresh pair is thin, so a full MAX_BUYBACK_BNB buy breaches the 3% slippage bound
        // and the call reverts. That is the guard working: the keeper has to split.
        vm.expectRevert(bytes(unicode"Buyback slippage too high / 回购滑点超过上限"));
        bridge.buyback(0, 0);

        // The live PancakeSwap V2 mid price, taken the same way `_venue` takes it.
        address[] memory path = new address[](2);
        path[0] = WBNB;
        path[1] = token;
        uint256 refOut = IPancakeV2Router(PANCAKE_V2_ROUTER).getAmountsOut(bridge.BUYBACK_QUOTE_REF(), path)[1];
        uint256 buyTaxBps = portal.getTokenV8Safe(token).buyTaxRate;

        uint256 bnbBefore2 = bridge.bnbBalance();
        uint256 g = gasleft();
        uint256 bought = bridge.buyback(0, 0.05 ether);
        uint256 gasPcsBuyback = g - gasleft();
        uint256 spentBnb = bnbBefore2 - bridge.bnbBalance();
        emit log_named_uint("GAS bridge.buyback (PancakeSwap V2)", gasPcsBuyback);
        assertGt(bought, 0, "the buyback bought no BAC on the live PancakeSwap pair");
        assertEq(spentBnb, 0.05 ether, "maxSpend was not honoured");
        assertEq(bridge.buybackBac(), bought, "bought BAC must land in the payout bucket");
        assertEq(bridge.lockedBac(), 0, "a buyback must never touch the deposit bucket");
        assertEq(
            IERC20(token).balanceOf(address(bridge)),
            bridge.lockedBac() + bridge.buybackBac() - bridge.totalBurned(),
            "BAC books: balance != lockedBac + buybackBac - burned"
        );

        uint256 grossAtMid = (spentBnb * refOut) / bridge.BUYBACK_QUOTE_REF();
        uint256 floorOut = (grossAtMid * (10000 - buyTaxBps) * (10000 - bridge.MAX_BUY_SLIPPAGE_BPS())) / 1e8;
        assertGe(bought, floorOut, "the V2 fill breached MAX_BUY_SLIPPAGE_BPS");
        assertLe(bought, grossAtMid, "the V2 fill beat the pre-trade mid price, which is impossible");
        emit log_named_uint("SURVIVAL pancake: bps of spent BNB still BAC at the pre-trade mid", (bought * 10000) / grossAtMid);
    }
}
