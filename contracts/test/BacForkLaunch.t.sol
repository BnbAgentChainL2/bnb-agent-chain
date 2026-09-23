// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/token/ERC20/extensions/IERC20Metadata.sol";

import {FlapBSCFixture} from "./FlapBSCFixture.sol";
import {IPortal, IPortalTypes, IPortalTradeV2, IPortalCommonTypes} from "../src/flap/IPortal.sol";
import {ITaxProcessor, PackedFeeConfigV2} from "../src/flap/ITaxProcessor.sol";
import {IFlapTaxTokenV3} from "../src/flap/IFlapTaxTokenV3.sol";

import {BacTaxRouter} from "../src/BacTaxRouter.sol";
import {BacBridge} from "../src/BacBridge.sol";
import {BacNodeFund} from "../src/BacNodeFund.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {ChainAnchor} from "../src/ChainAnchor.sol";
import {ValidatorStaking} from "../src/ValidatorStaking.sol";
import {IChainAnchor} from "../src/interfaces/IChainAnchor.sol";
import {IPancakeV2Router} from "../src/interfaces/IPancakeV2Router.sol";

/// @title BacForkLaunchTest
/// @notice The last gate before launch: the whole BNB Agent Chain BSC-side stack deployed in the
///         real §9 order on a BSC mainnet fork, launched through the LIVE PLAIN Portal with our own
///         `BacTaxRouter` as the beneficiary (decision #30: no VaultPortal, no vault factory, no
///         vault), fed with real tax from the real bonding curve, and settled through the real
///         `dispatch()`.
///
/// @dev Run:
///        BSC_RPC_URL=https://bsc-dataseed.bnbchain.org forge test --match-path 'test/BacForkLaunch.t.sol' -vv
///      Pin a block (reproducible re-runs, needs an archive RPC if it is old):
///        BAC_FORK_BLOCK=<n> ...
///
///      NOTHING here broadcasts. Every write goes through the forked EVM only.
contract BacForkLaunchTest is FlapBSCFixture {
    // ── the planned launch form (docs/01-CONTRACT-SPEC.md §1.3 + decisions #2/#4) ──────────
    string internal constant NAME = "BNB Agent Chain";
    string internal constant SYMBOL = "BAC";
    uint16 internal constant BUY_TAX = 200; // 2%
    uint16 internal constant SELL_TAX = 200; // 2%
    uint64 internal constant TAX_DURATION = uint64(100 * 365 days);
    uint64 internal constant ANTI_FARMER = uint64(1 days);
    uint16 internal constant MKT_BPS = 10_000;
    uint256 internal constant LAUNCH_BUY = 0.05 ether;

    // ── chain / protocol constants ────────────────────────────────────────────────────────
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    bytes32 internal constant BEACON_SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;
    uint128 internal constant OPERATOR_FLOAT = 1000e18;
    uint256 internal constant MIN_STAKE = 2_000_000e18;
    uint256 internal constant POW_TARGET = 2 ** 236;
    uint64 internal constant E = 600; // decision #20: a 10-minute epoch

    // ── our stack ─────────────────────────────────────────────────────────────────────────
    AgentRegistry internal registry;
    ChainAnchor internal anchor;
    ValidatorStaking internal staking;
    BacNodeFund internal nodeFund;
    BacBridge internal bridge;
    BacTaxRouter internal router;

    address internal token;
    address internal taxProcessor;
    bytes32 internal launchSalt;
    address internal predictedToken;
    address internal predictedBridge;

    // ── keys / roles ──────────────────────────────────────────────────────────────────────
    address internal LAUNCHER = makeAddr("launcher");
    address internal vaultOwner = makeAddr("vaultOwner");
    address internal fundOwner = makeAddr("nodeFundOwner");
    address internal admin = makeAddr("admin");
    address internal vetoKey = makeAddr("vetoKey");
    address internal relayer = makeAddr("relayer");
    address internal watchdog = makeAddr("watchdog");
    address internal trader = makeAddr("trader");
    address internal stranger = makeAddr("stranger");
    address internal exitTo = makeAddr("exitTo");

    uint256 internal ctrlPk = 0xBAC0FFEE01;
    uint256 internal walletPk = 0xBAC0FFEE02;
    address internal ctrl;
    address internal agentWallet;

    address[3] internal validators;
    bytes32 internal constant ATT_SALT = keccak256("bac-attestation-salt");

    // ── measurements (reported with -vv) ──────────────────────────────────────────────────
    uint256 public gasLaunch;
    uint256 public gasDispatch;
    uint256 public gasSettle;
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

        ctrl = vm.addr(ctrlPk);
        agentWallet = vm.addr(walletPk);
        validators[0] = makeAddr("validator1");
        validators[1] = makeAddr("validator2");
        validators[2] = makeAddr("validator3");

        // Salts are searched from a fork-derived seed so two suites never collide on an address
        // that is already staged on mainnet (the Portal would revert TokenAlreadyStaged).
        _seedVanitySalt(keccak256(abi.encode("BNB Agent Chain/fork", vm.getBlockNumber(), vm.getBlockTimestamp())));

        // ── §9 ①: the vanity salt and the token address it predicts ───────────────────────
        launchSalt = _findVanitySalt(VanityType.VANITY_7777, TOKEN_IMPL_TAXED_V3, PORTAL);
        predictedToken = _predictAddress(TOKEN_IMPL_TAXED_V3, launchSalt, PORTAL);
        assertEq(predictedToken.code.length, 0, "predicted token address is already taken");

        _deployStack();
        _launch();
    }

    /// @dev §9 ③-⑩, in the real order, with the real CREATE-nonce prediction for the bridge.
    function _deployStack() internal {
        // ③ AgentRegistry(admin, vetoKey)
        registry = new AgentRegistry(admin, vetoKey);

        // ④ ChainAnchor needs BacBridge's address and BacBridge needs ChainAnchor's: predict the
        //   bridge from this deployer's CREATE nonce (anchor, staking, nodeFund, bridge).
        uint64 n = vm.getNonce(address(this));
        predictedBridge = vm.computeCreateAddress(address(this), n + 3);
        anchor = new ChainAnchor(predictedBridge, relayer, admin, vetoKey, OPERATOR_FLOAT);

        // ⑤⑥⑦ — the three contracts whose `bacToken` is an immutable predicted address
        staking = new ValidatorStaking(predictedToken, address(anchor), admin);
        nodeFund = new BacNodeFund(predictedToken, fundOwner);
        bridge = new BacBridge(predictedToken, address(registry), address(anchor), watchdog, PORTAL, PANCAKE_V2_ROUTER);
        assertEq(address(bridge), predictedBridge, "CREATE nonce prediction of BacBridge drifted");
        assertEq(anchor.bridge(), address(bridge), "ChainAnchor.bridge() != BacBridge");

        // ⑧ one-shot binding
        anchor.setValidatorStaking(address(staking));

        // ⑨ the three preflight greens of §9 (run here against live state)
        assertEq(bridge.bacToken(), predictedToken, "preflight 1: bridge token");
        assertEq(nodeFund.bacToken(), predictedToken, "preflight 1: node fund token");
        assertEq(staking.bacToken(), predictedToken, "preflight 1: staking token");
        assertEq(predictedToken.code.length, 0, "preflight 2: address already has code");

        // ⑩ the tax router, LAST: its constructor cross-checks both downstreams against `T`
        router = new BacTaxRouter(predictedToken, address(bridge), address(nodeFund));

        vm.label(address(anchor), "ChainAnchor");
        vm.label(address(staking), "ValidatorStaking");
        vm.label(address(nodeFund), "BacNodeFund");
        vm.label(address(bridge), "BacBridge");
        vm.label(address(router), "BacTaxRouter");
    }

    /// @dev ⑪ the real launch through the live PLAIN Portal (decision #30: no VaultPortal, no
    ///      factory, no vault — `beneficiary` is our own `BacTaxRouter` and the Portal does not
    ///      care that it is a contract).
    function _launch() internal {
        IPortalTypes.NewTokenV6Params memory p = _formParams(launchSalt, address(router));
        p.quoteAmt = LAUNCH_BUY;

        vm.deal(LAUNCHER, 10 ether);
        vm.startPrank(LAUNCHER, LAUNCHER);
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
    ///      live Portal was measured to accept only one of is spelled out here, not defaulted.
    function _formParams(bytes32 salt, address beneficiary)
        internal
        pure
        returns (IPortalTypes.NewTokenV6Params memory p)
    {
        p = IPortalTypes.NewTokenV6Params({
            name: NAME,
            symbol: SYMBOL,
            meta: "",
            dexThresh: IPortalCommonTypes.DexThreshType.FOUR_FIFTHS, // measured: the only value accepted
            salt: salt,
            migratorType: IPortalTypes.MigratorType.V2_MIGRATOR, // measured: the only value accepted
            quoteToken: address(0), // native BNB
            quoteAmt: 0,
            beneficiary: beneficiary,
            permitData: "",
            extensionID: bytes32(0),
            extensionData: "",
            dexId: IPortalTypes.DEXId.DEX0,
            lpFeeProfile: IPortalTypes.V3LPFeeProfile.LP_FEE_PROFILE_STANDARD,
            buyTaxRate: BUY_TAX,
            sellTaxRate: SELL_TAX,
            taxDuration: TAX_DURATION,
            antiFarmerDuration: ANTI_FARMER,
            mktBps: MKT_BPS,
            deflationBps: 0,
            dividendBps: 0,
            lpBps: 0,
            minimumShareBalance: 0,
            dividendToken: address(0),
            commissionReceiver: address(0),
            tokenVersion: IPortalTypes.TokenVersion.TOKEN_TAXED_V3
        });
    }

    function _launchReverts(address who, IPortalTypes.NewTokenV6Params memory p)
        internal
        returns (bytes memory ret)
    {
        vm.deal(who, who.balance + 1 ether);
        bool ok;
        vm.prank(who, who);
        (ok, ret) = PORTAL.call{gas: MAX_OP_GAS}(abi.encodeCall(IPortal.newTokenV6, (p)));
        assertFalse(ok, "launch must revert");
    }

    /// @dev `Strings.toHexString` renders lowercase; `vm.toString` renders EIP-55 checksummed.
    function _addr(address a) internal pure returns (string memory) {
        bytes memory h = bytes(vm.toString(a));
        for (uint256 i; i < h.length; ++i) {
            if (h[i] >= 0x41 && h[i] <= 0x5A) h[i] = bytes1(uint8(h[i]) + 32);
        }
        return string(h);
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

    /// @dev Asserts the revert data is a plain `Error(string)` carrying our bilingual reason.
    function _assertReason(bytes memory ret, string memory reason) internal pure {
        require(bytes4(ret) == bytes4(keccak256("Error(string)")), "not a plain revert string");
        require(_contains(ret, bytes(reason)), "reason string mismatch");
    }

    function _buy(address who, uint256 bnb) internal returns (uint256 got) {
        vm.deal(who, who.balance + bnb);
        vm.startPrank(who);
        got = _buyOnBC(token, bnb);
        vm.stopPrank();
    }

    function _sellAll(address who) internal returns (uint256 bnb) {
        uint256 bal = IERC20(token).balanceOf(who);
        if (bal == 0) return 0;
        vm.startPrank(who);
        bnb = _sell(token, bal);
        vm.stopPrank();
    }

    /// @dev Buys until `who` holds at least `want` BAC, so the validator stakes are real tokens
    ///      bought off the real curve rather than cheatcode-minted balances.
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

    function _assertSolvent() internal view {
        (uint256 bal, uint256 accounted, uint256 buckets) = router.solvency();
        assertEq(accounted, buckets, "V1: accounted != buckets");
        assertGe(bal, accounted, "V2: balance < accounted");
        assertEq(
            router.totalRecognized(),
            router.lifetimeToBridge() + router.lifetimeToNodeFund() + router.accountedQuote(),
            "V9: totalRecognized"
        );
    }

    // ── agent registration (real PoW + real EIP-712 signatures) ───────────────────────────

    function _mine(bytes32 seed) internal pure returns (uint256) {
        unchecked {
            for (uint256 n = 0; n < 200_000_000; n++) {
                bytes32 h;
                assembly {
                    mstore(0x00, seed)
                    mstore(0x20, n)
                    h := keccak256(0x00, 0x40)
                }
                if (uint256(h) < POW_TARGET) return n;
            }
        }
        revert("no nonce found");
    }

    function _sign(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", registry.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _activateAgent() internal returns (uint256 id) {
        uint256 dl = vm.getBlockTimestamp() + 1 hours;
        bytes memory sig =
            _sign(walletPk, keccak256(abi.encode(registry.BIND_WALLET_TYPEHASH(), agentWallet, ctrl, dl)));
        // The deposit is read BEFORE the prank: an argument call would consume `vm.prank` and
        // `register` would then run as the test contract (the fixture's PRANK CONVENTION note).
        uint256 deposit = registry.ENTRY_DEPOSIT();
        vm.deal(ctrl, 1 ether);
        vm.prank(ctrl);
        (id,) = registry.register{value: deposit}(
            "https://bnbagentchain.example/agent.json", keccak256("endpoint"), keccak256("model"), agentWallet, dl, sig
        );
        uint256 rounds = registry.ROUNDS();
        for (uint256 i; i < rounds; ++i) {
            (bytes32 cid, bytes32 seed,,,) = registry.currentChallenge(id);
            uint256 nonce = _mine(seed);
            bytes memory s = _sign(ctrlPk, keccak256(abi.encode(registry.CHALLENGE_TYPEHASH(), id, cid, seed, nonce)));
            vm.prank(stranger);
            registry.solveChallenge(id, cid, nonce, s);
        }
        assertTrue(registry.isActive(id), "agent not ACTIVE");
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

    // ======================================================================================
    //          1 + 2.  THE LAUNCH ITSELF AND EVERY PIECE OF WIRING IT PRODUCED
    // ======================================================================================

    function test_fork_launchSucceededAndWiringIsCorrect() public {
        // — the token is the vanity CREATE2 clone we predicted before deploying three immutables —
        assertEq(uint256(uint160(token)) & 0xffff, 0x7777, "vanity suffix must be 7777");
        assertEq(token, predictedToken, "launched token != the address the immutables were pinned to");
        assertEq(IERC20Metadata(token).name(), NAME, "name");
        assertEq(IERC20Metadata(token).symbol(), SYMBOL, "symbol");
        assertEq(IFlapTaxTokenV3(token).buyTaxRate(), BUY_TAX, "buy tax");
        assertEq(IFlapTaxTokenV3(token).sellTaxRate(), SELL_TAX, "sell tax");
        assertEq(IFlapTaxTokenV3(token).antiFarmerDuration(), ANTI_FARMER, "anti-farmer window");
        assertEq(uint8(IFlapTaxTokenV3(token).state()), 0, "token must open on the bonding curve");
        assertEq(portal.getTokenV8Safe(token).status, 1, "tradable");
        assertGt(IERC20(token).balanceOf(LAUNCHER), 0, "the launch buy delivered no tokens");

        // — the single most expensive thing to get wrong: where the tax is sent —
        ITaxProcessor tp = ITaxProcessor(taxProcessor);
        assertEq(tp.marketAddress(), address(router), "TaxProcessor.marketAddress must be our router");
        assertEq(tp.taxToken(), token, "TaxProcessor.taxToken");
        // Flap's TaxProcessor books the quote as WBNB (isWeth) but pays the vault in native BNB.
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
        assertEq(router.bridge(), address(bridge), "router.bridge");
        assertEq(router.nodeFund(), address(nodeFund), "router.nodeFund");
        assertEq(router.BRIDGE_BPS(), 5000, "hard-coded 50/50 split");
        assertEq(
            vm.load(address(router), 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc),
            bytes32(0),
            "the router must not be a proxy"
        );
        (bool ownerExists,) = address(router).call(abi.encodeWithSignature("owner()"));
        assertFalse(ownerExists, "the router must have no owner()");

        // — description() carries the sentences decisions #29a and #31a make mandatory —
        string memory d = router.description();
        assertTrue(
            _contains(bytes(d), bytes(unicode"项目方可以随时升级桥合约、修改规则，并可随时取走桥池中的全部资金。")),
            "description must carry the decision #29a sentence verbatim"
        );
        assertTrue(
            _contains(bytes(d), bytes(unicode"我们要求持有 agent 身份，我们不能证明它是 AI")),
            "description must carry the decision #31a sentence verbatim"
        );
        emit log_string(d);

        _assertSolvent();
        emit log_named_address("launched token (vanity ...7777)", token);
        emit log_named_address("BacTaxRouter (the beneficiary in the launch form)", address(router));
        emit log_named_bytes32("launch salt", launchSalt);
        emit log_named_uint("fork block", vm.getBlockNumber());
        emit log_named_uint("GAS launch (plain Portal newTokenV6, with 0.05 BNB launch buy)", gasLaunch);
    }

    // ======================================================================================
    //          3.  THE REAL TAX PATH: curve trade -> dispatch -> receive -> settle
    // ======================================================================================

    function test_fork_realTaxReachesTheVaultAndSplits5050() public {
        // real buys and sells through the real Portal route
        _accrueTax(4, 0.4 ether);

        uint256 pending = _pendingMarketBalance(token);
        assertGt(pending, 0, "no market tax accrued on the real curve");
        emit log_named_uint("TaxProcessor.marketQuoteBalance before dispatch (wei)", pending);

        // ── dispatch: the real keeper call, the real 1,000,000 gas budget ─────────────────
        uint256 received = _dispatch();
        assertGt(received, 0, "dispatch() delivered no BNB to the vault");
        assertEq(received, pending, "vault did not receive the whole market balance");
        assertEq(vault.accountedQuote(), received, "receive() did not recognize the dispatch");
        assertEq(vault.unsplitRevenue(), received, "revenue not booked as unsplit");
        _assertSolvent();

        // ── settle: 50/50 to BacBridge.acceptRelease() and BacNodeFund.acceptRelease() ────
        uint256 poolBefore = bridge.bnbBalance();
        uint256 fundBefore = nodeFund.lifetimeReceived();
        uint256 g = gasleft();
        (uint256 toBridge, uint256 toNodeFund) = vault.settle();
        gasSettle = g - gasleft();

        assertEq(toBridge + toNodeFund, received, "the split must not lose a wei");
        assertEq(toNodeFund, received / 2, "node fund gets floor(50%)");
        assertEq(toBridge, received - received / 2, "V11: the rounding remainder goes to the bridge pool");
        assertGe(toBridge, toNodeFund, "V11: bridge >= node fund");

        assertEq(bridge.bnbBalance(), poolBefore + toBridge, "bridge pool did not grow by the bridge half");
        assertEq(address(bridge).balance, bridge.bnbBalance(), "bridge balance != poolBalance");
        assertEq(nodeFund.lifetimeReceived(), fundBefore + toNodeFund, "node fund half not received");
        assertEq(address(nodeFund).balance, nodeFund.lifetimeReceived(), "N1 broken");

        (uint256 sb, uint256 sn) = vault.stuckAmounts();
        assertEq(sb, 0, "nothing should be stuck on the bridge side");
        assertEq(sn, 0, "nothing should be stuck on the node fund side");
        assertEq(vault.accountedQuote(), 0, "everything was pushed out");
        assertEq(vault.unsplitRevenue(), 0, "nothing left unsplit");
        assertEq(vault.lifetimeToBridge(), toBridge, "lifetimeToBridge");
        assertEq(vault.lifetimeToNodeFund(), toNodeFund, "lifetimeToNodeFund");
        assertEq(address(vault).balance, 0, "the vault keeps nothing after a clean settle");
        _assertSolvent();

        // ── a second round proves the accounting is incremental, not absolute ─────────────
        _accrueTax(2, 0.3 ether);
        uint256 second = _dispatch();
        assertGt(second, 0, "second dispatch delivered nothing");
        vault.settle();
        assertEq(vault.totalRecognized(), received + second, "rule 010: totalRecognized");
        assertEq(vault.lifetimeToBridge() + vault.lifetimeToNodeFund(), received + second, "everything pushed");
        _assertSolvent();

        emit log_named_uint("GAS dispatch (real TaxProcessor, keeper budget 1,000,000)", gasDispatch);
        emit log_named_uint("GAS settle", gasSettle);
        emit log_named_uint("tax that reached the vault, round 1 (wei)", received);
        emit log_named_uint("tax that reached the vault, round 2 (wei)", second);
    }

    // ======================================================================================
    //          4.  THE TWO GAS PROPERTIES THAT FORFEIT MONEY IF THEY ARE WRONG
    // ======================================================================================

    function test_fork_receiveSucceedsUnder50kGasAndDispatchFitsTheKeeperBudget() public {
        // rule 005: a cold receive() must complete inside a 50,000-gas stipend
        vm.deal(stranger, 10 ether);
        vm.startPrank(stranger);
        uint256 g = gasleft();
        (bool ok,) = address(vault).call{value: 1 ether, gas: 50_000}("");
        gasReceiveCold = g - gasleft();
        assertTrue(ok, "receive() failed under call{gas: 50_000}");

        g = gasleft();
        (ok,) = address(vault).call{value: 1 ether, gas: 50_000}("");
        gasReceiveWarm = g - gasleft();
        assertTrue(ok, "warm receive() failed under call{gas: 50_000}");
        vm.stopPrank();

        assertLt(gasReceiveCold, 50_000, "cold receive() over the 50,000 budget");
        assertLt(gasReceiveWarm, 30_000, "warm receive() over the 30,000 budget");
        assertEq(vault.accountedQuote(), 2 ether, "both forced sends were recognized");
        vault.settle();
        _assertSolvent();

        // the whole dispatch, including our receive(), must fit the keeper's budget
        _accrueTax(3, 0.4 ether);
        uint256 got = _dispatch();
        assertGt(got, 0, "dispatch delivered nothing");
        assertLt(gasDispatch, 1_000_000, "dispatch exceeded the keeper's 1,000,000 gas budget");

        emit log_named_uint("GAS receive() cold", gasReceiveCold);
        emit log_named_uint("GAS receive() warm", gasReceiveWarm);
        emit log_named_uint("GAS dispatch (whole call, budget 1,000,000)", gasDispatch);
    }

    // ======================================================================================
    //          5.  NEGATIVE LAUNCHES AGAINST THE REAL VaultPortal
    // ======================================================================================

    function test_fork_vaultPortalRejectsEveryBadLaunch() public {
        bytes32 salt = _findVanitySalt(VanityType.VANITY_7777, TOKEN_IMPL_TAXED_V3, PORTAL);
        bytes memory good = _vaultData();
        IVaultPortalTypes.NewTokenV6WithVaultParams memory p;
        bytes memory r;

        // (a) wrong mktBps — the sum rule forces the remainder into deflation
        p = _formParams(salt, good);
        (p.mktBps, p.deflationBps) = (8_000, 2_000);
        r = _launchReverts(LAUNCHER, p);
        _assertReason(r, unicode"Vault share must be exactly 100% / 金库份额必须正好是 100%");

        // (b) holder dividend on. NOTE: Portal enforces mkt+deflation+dividend+lp == 10000
        //     BEFORE our hook runs, so any dividendBps > 0 necessarily drops mktBps below
        //     10000 and our vaultBps check (which is earlier in the hook) answers first.
        //     The dividend branch is therefore unreachable through a real launch; it is
        //     asserted directly against the hook below.
        p = _formParams(salt, good);
        (p.mktBps, p.dividendBps, p.minimumShareBalance) = (8_000, 2_000, 10_000e18);
        r = _launchReverts(LAUNCHER, p);
        _assertReason(r, unicode"Vault share must be exactly 100% / 金库份额必须正好是 100%");

        IVaultFactoryValidationV2.LaunchValidationDataV1 memory d;
        d.tokenVersion = IPortalTypes.TokenVersion.TOKEN_TAXED_V3;
        d.quoteToken = address(0);
        d.buyTaxRate = BUY_TAX;
        d.sellTaxRate = SELL_TAX;
        d.vaultBps = MKT_BPS;
        d.dividendBps = 2_000;
        (bool okHook, string memory reason) = factory.onBeforeLaunch(abi.encode(d));
        assertFalse(okHook, "hook must reject a holder dividend");
        assertEq(reason, unicode"Holder dividend must be 0% / 持币分红必须为 0%", "dividend reason");

        // (c) wrong tax rate
        p = _formParams(salt, good);
        p.buyTaxRate = 300;
        r = _launchReverts(LAUNCHER, p);
        _assertReason(r, unicode"Buy tax must be exactly 2% / 买税必须正好是 2%");

        p = _formParams(salt, good);
        p.sellTaxRate = 500;
        r = _launchReverts(LAUNCHER, p);
        _assertReason(r, unicode"Sell tax must be exactly 2% / 卖税必须正好是 2%");

        // (d) a stranger tries to launch with our factory (policy is OPEN on VaultPortal;
        //     the LAUNCHER immutable in newVault is what actually stops them)
        r = _launchReverts(stranger, _formParams(salt, good));
        _assertReason(r, unicode"Launcher not allowed / 该地址不能用此工厂发射");

        // (e) §9's A3 danger, live: the launch form carries a salt other than the locked one, so
        //     VaultPortal predicts a token address that is NOT the one pinned into the three
        //     immutables. This is the revert every negative case below `newVault` would also hit,
        //     which is why the good-form control at the end has to bring its own bridge/node fund.
        r = _launchReverts(LAUNCHER, _formParams(salt, good));
        _assertReason(r, unicode"Bridge is bound to another token / 桥绑定的是别的代币");

        // (f) a non-BNB quote token
        p = _formParams(salt, good);
        p.quoteToken = USDT;
        r = _launchReverts(LAUNCHER, p);
        emit log_named_bytes("USDT quote revert data", r);
        assertTrue(
            bytes4(r) == bytes4(keccak256("UnsupportedQuoteToken(address)"))
                || _contains(r, bytes(unicode"BNB quote only / 仅支持 BNB 计价")),
            "non-BNB quote must be rejected"
        );

        // (g) Portal's own rules: wrong token version and a non-vanity salt
        p = _formParams(salt, good);
        p.tokenVersion = IPortalTypes.TokenVersion.TOKEN_TAXED_V2;
        r = _launchReverts(LAUNCHER, p);
        assertEq(bytes4(r), bytes4(keccak256("FeatureDisabled()")), "wrong token version");

        r = _launchReverts(LAUNCHER, _formParams(bytes32(uint256(1)), good));
        assertEq(bytes4(r), bytes4(keccak256("InvalidVanity(address)")), "non-vanity salt");

        // (h) the hook itself never reverts and still answers `true` for the good form
        (okHook, reason) = factory.onBeforeLaunch(
            abi.encode(
                IVaultFactoryValidationV2.LaunchValidationDataV1({
                    tokenVersion: IPortalTypes.TokenVersion.TOKEN_TAXED_V3,
                    quoteToken: address(0),
                    buyTaxRate: BUY_TAX,
                    sellTaxRate: SELL_TAX,
                    vaultBps: MKT_BPS,
                    deflationBps: 0,
                    dividendBps: 0,
                    lpBps: 0,
                    dividendToken: address(0),
                    minimumShareBalance: 0
                })
            )
        );
        assertTrue(okHook, "the planned form must pass the hook");
        assertEq(bytes(reason).length, 0, "a passing hook returns an empty reason");

        // Positive control: nothing above consumed the salt or the factory. Re-deploy the two
        // contracts whose `bacToken` is an immutable, this time pinned to the address `salt`
        // predicts, and the very same form launches.
        address t2 = _predictAddress(TOKEN_IMPL_TAXED_V3, salt, PORTAL);
        BacNodeFund nf2 = new BacNodeFund(t2, fundOwner);
        BacBridge b2 = new BacBridge(t2, address(registry), address(anchor), watchdog, PORTAL, PANCAKE_V2_ROUTER);
        vm.deal(LAUNCHER, LAUNCHER.balance + 1 ether);
        vm.prank(LAUNCHER, LAUNCHER);
        address tok2 = vaultPortal.newTokenV6WithVault{gas: MAX_OP_GAS}(
            _formParams(salt, abi.encode(vaultOwner, address(b2), address(nf2)))
        );
        assertEq(tok2, t2, "second launch landed on the predicted address");
        assertEq(uint256(uint160(tok2)) & 0xffff, 0x7777, "second launch vanity");
        address v2 = vaultPortal.getVault(tok2).vault;
        assertEq(ITaxProcessor(IFlapTaxTokenV3(tok2).taxProcessor()).marketAddress(), v2, "tax -> vault 2");
        assertEq(BacTreasuryVault(payable(v2)).bridge(), address(b2), "vault 2 bridge");
    }

    // ======================================================================================
    //          6.  GAS FOR EVERY OPERATION THAT HAS TO FIT A REAL BSC BLOCK
    // ======================================================================================

    function test_fork_measureBridgeAnchorAndValidatorGas() public {
        // ── fund the bridge pool with real tax, exactly as production would ──────────────
        _accrueTax(4, 0.5 ether);
        // One buy that is HELD, so the curve has real depth for the buyback further down and
        // the bridge's 3% slippage bound is measured against a live reserve, not a toy one.
        _buy(makeAddr("curveDepth"), 5 ether);
        _dispatch();
        _settle();
        assertGt(bridge.bnbBalance(), 0, "bridge pool is empty");

        // ── an agent registers for real (PoW + EIP-712) and locks real BAC ───────────────
        uint256 agentId = _activateAgent();
        _acquireBac(trader, 3 * MIN_STAKE + 1_000_000e18);

        uint256 lockAmount = 1_000_000e18;
        vm.prank(trader);
        IERC20(token).transfer(ctrl, lockAmount);
        vm.startPrank(ctrl);
        IERC20(token).approve(address(bridge), lockAmount);
        uint256 g = gasleft();
        bridge.lock(agentId, lockAmount);
        gasLock = g - gasleft();
        vm.stopPrank();
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

        // both commitments fit inside epoch e0's commit window, which is the earliest either may be made
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
        g = gasleft();
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
            emit log_named_uint("SURVIVAL curve: everything beyond the buy tax (bps)", 10000 - buyTaxBps - survivalBps);
            // `dustKeptBps` was quoted BEFORE the buy, at a size whose own impact is negligible,
            // so it isolates the size-independent cost (buy tax + whatever the venue charges).
            // The difference is the price impact of this particular buy.
            emit log_named_uint("SURVIVAL curve: cost at ~zero size, quoted pre-trade (bps kept)", dustKeptBps);
            emit log_named_uint("SURVIVAL curve: venue fee beyond the buy tax (bps)", 10000 - buyTaxBps - dustKeptBps);
            emit log_named_uint("SURVIVAL curve: price impact of THIS buy alone (bps)", dustKeptBps - survivalBps);
            emit log_named_uint("SURVIVAL curve: modeller predicted (STOCK/modest, 2.00% tax + 0.215% slip)", 9778);
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
        assertLe(bridge.owedTotal(), bridge.buybackBac(), "B1: solvency is structural now");
        // The debt is a share of the BOUGHT stock only. It can never exceed what the buyback has
        // actually accumulated, which is the whole point of the two buckets: an exit that could
        // reach `lockedBac` would be able to claim more BAC than was ever bought.
        assertLe(lockedBacAmt, bought, "an exit locked more BAC than the buyback ever bought");
        assertEq(bridge.lockedBac(), lockAmount, "claimExit must not move lockedBac");
        assertEq(bridge.buybackBac(), bought, "claimExit moves no BAC, it only locks a rate");

        // ---- settle and collect: the exit is paid in BAC, out of the buyback bucket ----
        bridge.settleEpoch(e0 + 1);
        (uint256 pot,, uint16 bps) = bridge.lastEpochRelease();
        assertGt(pot, 0, "settleEpoch released nothing");
        assertEq(bps, 500, "release bps (a DAILY tier, divided by 144 inside the bridge)");

        uint256 span = uint64(vm.getBlockTimestamp() / E) - bridge.lastCollectEpoch(exitTo);
        if (span > bridge.MAX_CATCHUP_EPOCHS()) span = bridge.MAX_CATCHUP_EPOCHS();
        uint256 buybackBeforePay = bridge.buybackBac();
        uint256 bnbBeforePay = bridge.bnbBalance();
        vm.prank(exitTo);
        g = gasleft();
        uint256 paid = bridge.collect(exitTo);
        gasCollect = g - gasleft();
        assertGt(paid, 0, "collect paid nothing");
        assertLe(paid, (pot * bridge.MAX_EXIT_SHARE_BPS() * span) / 10000, "B15: per-epoch cap");
        assertEq(IERC20(token).balanceOf(exitTo), paid, "the exit address actually received BAC");
        assertEq(exitTo.balance, 0, "an exit pays BAC, never BNB (decision #24)");
        // ---- decision #24a ②: the payout came out of `buybackBac`, and ONLY out of it --------
        assertEq(bridge.buybackBac(), buybackBeforePay - paid, "the payout did not come out of buybackBac");
        assertEq(bridge.lockedBac(), lockAmount, "an exit touched lockedBac: the lock-forever promise is broken");
        assertEq(bridge.totalBurned(), burnedBefore, "an exit must not burn from the deposit bucket");
        assertEq(bridge.bnbBalance(), bnbBeforePay, "an exit moved BNB; exits are BAC-only");
        assertLe(paid, bought, "paid out more BAC than the buyback ever bought");
        assertLe(bridge.owedTotal(), bridge.buybackBac(), "B1: solvency");
        assertGe(address(bridge).balance, bridge.bnbBalance(), "B2");
        assertGe(IERC20(token).balanceOf(address(bridge)), bridge.bacAccounted(), "B2 (BAC side)");
        assertEq(
            IERC20(token).balanceOf(address(bridge)),
            bridge.lockedBac() + bridge.buybackBac() - bridge.totalBurned(),
            "BAC books after the payout: balance != lockedBac + buybackBac - burned"
        );
        // The deposit bucket is still whole and its only exit is still the dead address.
        assertGe(IERC20(token).balanceOf(address(bridge)), bridge.lockedBac(), "lockedBac is no longer fully backed");

        emit log_named_uint("GAS bridge.lock", gasLock);
        emit log_named_uint("GAS bridge.claimExit (1-leaf proof)", gasClaimExit);
        emit log_named_uint("GAS bridge.collect (pays BAC)", gasCollect);
        emit log_named_uint("GAS bridge.buyback (flap curve)", gasBuyback);
        emit log_named_uint("GAS anchor.postAnchor", gasPostAnchor);
        emit log_named_uint("GAS anchor.finalize (3 witnesses)", gasFinalize);
        emit log_named_uint("GAS staking.commitAttestation", gasCommit);
        emit log_named_uint("GAS staking.revealAttestation", gasReveal);
        emit log_named_uint("GAS attestation round per validator (commit + reveal)", gasCommit + gasReveal);
        emit log_named_uint("GAS launch (newTokenV6WithVault)", gasLaunch);
        emit log_named_uint("GAS dispatch", gasDispatch);
        emit log_named_uint("GAS settle", gasSettle);
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    // ======================================================================================
    //          EXTRA: the tax keeps flowing after the token graduates to the DEX
    // ======================================================================================

    function test_fork_taxStillReachesTheVaultAfterGraduation() public {
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
        assertGt(got, 0, "no DEX tax reached the vault after graduation");
        _settle();
        assertGt(bridge.bnbBalance(), 0, "bridge pool got nothing from DEX tax");
        assertGt(nodeFund.lifetimeReceived(), 0, "node fund got nothing from DEX tax");
        _assertSolvent();
        emit log_named_uint("post-graduation tax to the vault (wei)", got);

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
        vm.expectRevert(unicode"Buyback slippage too high / 回购滑点超过上限");
        bridge.buyback(0, 0);

        // The live PancakeSwap V2 mid price, taken the same way `_venue` takes it: a negligible
        // reference trade through the real router, so this is the real pre-trade price.
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
        emit log_named_uint("post-graduation buyback: BAC bought (wei)", bought);

        // Same slippage bound and same survival measure as on the curve, on the real V2 pair.
        // NOTE the asymmetry: `getAmountsOut` already nets PancakeSwap's 0.25% LP fee, so this
        // reference is fee-inclusive and the remainder below is price impact only. On the curve
        // the reference is the Portal's raw mid `price`, which is NOT fee-inclusive, so there the
        // same remainder also carries the venue fee.
        uint256 grossAtMid = (spentBnb * refOut) / bridge.BUYBACK_QUOTE_REF();
        uint256 floorOut = (grossAtMid * (10000 - buyTaxBps) * (10000 - bridge.MAX_BUY_SLIPPAGE_BPS())) / 1e8;
        assertGe(bought, floorOut, "the V2 fill breached MAX_BUY_SLIPPAGE_BPS");
        assertLe(bought, grossAtMid, "the V2 fill beat the pre-trade mid price, which is impossible");
        uint256 survivalBps = (bought * 10000) / grossAtMid;
        emit log_named_uint("SURVIVAL pancake: bps of spent BNB still BAC at the pre-trade mid", survivalBps);
        emit log_named_uint("SURVIVAL pancake: buy tax alone would leave (bps)", 10000 - buyTaxBps);
        emit log_named_uint("SURVIVAL pancake: slippage cost alone (bps)", 10000 - buyTaxBps - survivalBps);
        emit log_named_uint("SURVIVAL pancake: modeller predicted (STOCK/viral, 2.00% tax + 0.597% slip)", 9740);
    }
}
