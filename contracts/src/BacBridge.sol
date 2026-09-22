// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {MerkleProof} from "@openzeppelin/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/security/ReentrancyGuard.sol";
import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";
import {IChainAnchor} from "./interfaces/IChainAnchor.sol";

/// @title BacBridge
/// @notice BSC side of the BNB Agent Chain bridge (docs/01-CONTRACT-SPEC.md §4, M1 + M4).
///         BAC goes in and is locked forever (the only exit is the hard-coded dead address);
///         BNB comes out of the bridge pool, which is fed only by the vault's tax split.
///
///         Money model, in one paragraph: an exit locks its redemption rate at the moment it
///         is claimed (M1) — `lockedWei = credits * free / outstanding` — and that debt is then
///         paid down through a single MasterChef-style accumulator (M4). `settleEpoch` releases
///         a slice of the pool into `accPerOwed` / `reservedTotal`; `collect` harvests an
///         address's share of everything released *after* its debt was locked, capped at
///         `lastPot * 10%` per epoch. There is no per-epoch ledger, so no historical epoch can
///         ever be raided by a late exiter.
///
///         This contract has NO owner and NO admin. `watchdog` can only pause `collect` and arm
///         the escape hatch; the veto key is read live from `ChainAnchor`. No privileged role has
///         any path to move BNB or BAC.
contract BacBridge is ReentrancyGuard {
    // ------------------------------------------------------------------ immutables / constants

    address public immutable bacToken;
    address public immutable registry;
    address public immutable anchor;
    address public immutable watchdog;

    uint64 public constant EPOCH = 86400;
    uint64 public constant SETTLE_GRACE = 7 days;
    uint16 public constant MAX_EXIT_SHARE_BPS = 1000;
    uint16 public constant NO_ATTEST_WINDOW_BPS = 1500;
    uint64 public constant NO_ATTEST_WINDOW = 30;
    uint64 public constant PAUSE_LEN = 7 days;
    uint64 public constant MAX_PAUSE_TOTAL = 21 days;
    uint64 public constant OWED_MATURITY = 14 days;
    uint64 public constant ESCAPE_ARM_DELAY = 14 days;
    uint256 public constant LAYER_CHAIN_ID = 56777;
    uint256 public constant ACC_PRECISION = 1e27;
    bytes32 public constant EXIT_TYPEHASH = keccak256(
        "Exit(uint256 exitId,uint256 agentId,address to,uint256 credits,uint256 layerChainId,address bridge)"
    );

    /// @notice The one and only destination locked BAC can ever reach.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // ------------------------------------------------------------------ entry-side accounting

    uint256 public totalLocked;
    uint256 public totalCreditsIssued;
    uint256 public totalCreditsExited;
    uint256 public totalBurned;
    uint256 public depositId;

    mapping(uint256 => uint256) public credited;
    mapping(uint256 => uint256) public exitedCredits;
    uint256 public unattributedExited;

    // ------------------------------------------------------------------ exit-side accounting

    uint256 public poolBalance;
    uint256 public owedTotal;
    uint256 public reservedTotal;
    uint256 public accPerOwed;

    mapping(address => uint256) public owed;
    mapping(address => uint256) public unclaimed;
    mapping(address => uint256) public owedDebt;
    mapping(address => uint64) public lastClaimAt;
    mapping(address => uint64) public lastCollectEpoch;
    mapping(uint256 => bool) public exitClaimed;

    uint64 public lastSettledEpoch;
    uint64 public skippedEpochs;
    uint256 public lastPot;
    uint64 public lastPotSettledAt;
    uint16 public lastPotBps;

    uint256 public releasedInWindow;
    mapping(uint256 => uint128) private potRing;

    // ------------------------------------------------------------------ brake / halt / escape

    uint64 public pauseStartedAt;
    uint64 public pausedUntil;
    uint64 public pausedCumulative;

    bool private halted;
    uint8 public haltCause;
    uint64 public haltedAt;
    uint64 public escapeArmedAt;
    uint8 public armedCause;

    uint256 public escapeTotalWeight;
    uint256 public accPerWeight;
    uint256 public escapeDistributed;
    mapping(uint256 => uint256) public escapeDebt;

    // ------------------------------------------------------------------ events

    event Locked(
        uint256 indexed depositId,
        uint256 indexed agentId,
        address indexed from,
        address layerWallet,
        uint256 measured,
        uint256 credits,
        uint256 totalIssued
    );
    event ReleaseReceived(address indexed from, uint256 amount, uint256 poolAfter);
    event Untracked(uint256 amount, uint256 poolAfter);
    event ExitClaimed(
        uint64 indexed anchorEpoch,
        uint256 indexed exitId,
        uint256 indexed agentId,
        address to,
        uint256 credits,
        uint256 lockedWei,
        uint256 rateUsed,
        uint256 attributed
    );
    event EpochSettled(uint64 indexed epoch, uint256 pot, uint256 owedTotalAfter, uint16 releaseBps, bool skipped);
    event Collected(address indexed who, address indexed to, uint256 amount, uint256 owedLeft);
    event EscapeArmed(address indexed by, uint8 cause, uint64 effectiveAt);
    event EscapeArmCancelled(address indexed by);
    event Halted(uint8 cause);
    event OwedPaidAfterHalt(address indexed who, address indexed to, uint256 amount);
    event OwedDemoted(address indexed who, uint256 amount);
    event EscapeCollected(uint256 indexed agentId, address indexed to, uint256 amount);
    event Paused(address indexed by, uint64 until_, uint64 cumulative);
    event Unpaused(address indexed by, uint64 cumulative);
    event LockedBurned(uint256 amount);

    // ------------------------------------------------------------------ constructor

    /// @dev Four parameters exactly as deployment step ⑦ of §9 writes them. The settle cursor
    ///      starts at the deploy epoch: epoch numbers are `timestamp / 86400`, so without a
    ///      starting point the strictly-sequential `settleEpoch` would have to walk ~20,000
    ///      empty epochs. `ChainAnchor` is deployed minutes earlier (step ④), so its first epoch
    ///      is never below this one.
    constructor(address bacToken_, address registry_, address anchor_, address watchdog_) {
        require(bacToken_ != address(0), unicode"Zero BAC token / BAC 代币地址为零");
        require(registry_ != address(0), unicode"Zero registry / 注册表地址为零");
        require(anchor_ != address(0), unicode"Zero anchor / 锚点地址为零");
        require(watchdog_ != address(0), unicode"Zero watchdog / 看门狗地址为零");
        bacToken = bacToken_;
        registry = registry_;
        anchor = anchor_;
        watchdog = watchdog_;
        lastSettledEpoch = uint64(block.timestamp / EPOCH);
    }

    // ==================================================================
    //                               IN
    // ==================================================================

    /// @notice Lock BAC and mint 1:1 layer credits for `agentId`.
    /// @dev Measured by balance difference, so a fee-on-transfer BAC can never over-credit.
    function lock(uint256 agentId, uint256 amount) external nonReentrant returns (uint256 id) {
        require(!isHalted(), unicode"Bridge halted / 桥已停机");
        require(IAgentRegistry(registry).isActive(agentId), unicode"Agent is not active / agent 不是活跃状态");
        IAgentRegistry.Agent memory a = IAgentRegistry(registry).getAgent(agentId);
        require(
            msg.sender == a.controller || msg.sender == a.agentWallet,
            unicode"Not the agent controller / 不是该 agent 的控制者"
        );

        uint256 before = IERC20(bacToken).balanceOf(address(this));
        _pullBac(msg.sender, amount);
        uint256 measured = IERC20(bacToken).balanceOf(address(this)) - before;
        require(measured > 0, unicode"Zero amount / 金额为零");

        uint256 credits = measured;
        totalLocked += measured;
        totalCreditsIssued += credits;
        credited[agentId] += credits;

        id = depositId++;
        emit Locked(id, agentId, msg.sender, a.agentWallet, measured, credits, totalCreditsIssued);
    }

    /// @notice Permissionless: the vault pushes the bridge-pool half here; anyone may donate.
    function acceptRelease() external payable {
        _accept(msg.value);
        emit ReleaseReceived(msg.sender, msg.value, poolBalance);
    }

    /// @notice Permissionless: fold force-pushed (selfdestruct / coinbase) balance into the pool.
    function sweepUntracked() external returns (uint256 swept) {
        swept = address(this).balance - poolBalance;
        if (swept == 0) return 0;
        _accept(swept);
        emit Untracked(swept, poolBalance);
    }

    /// @dev The single accounting path for incoming BNB. `poolBalance` ALWAYS grows; once halted
    ///      the same wei is additionally handed to the junior accumulator, otherwise post-halt
    ///      revenue would have no legal claimant (or `escapeCollect` would underflow, §4.2).
    function _accept(uint256 amount) internal {
        poolBalance += amount;
        if (halted && escapeTotalWeight > 0) {
            accPerWeight += (amount * 1e18) / escapeTotalWeight;
        }
    }

    // ==================================================================
    //                          OUT (normal mode)
    // ==================================================================

    /// @notice Burn layer credits against a FINAL anchor and lock the redemption rate (M1).
    /// @dev No time window, no status check, not gated by `pause()` — this function moves zero wei.
    function claimExit(
        uint64 anchorEpoch,
        uint256 exitId,
        uint256 agentId,
        address to,
        uint256 credits,
        bytes32[] calldata proof
    ) external returns (uint256 lockedWei) {
        require(!isHalted(), unicode"Bridge halted / 桥已停机");
        IChainAnchor.Anchor memory an = IChainAnchor(anchor).getAnchor(anchorEpoch);
        require(an.state == IChainAnchor.State.FINAL, unicode"Anchor not final / 锚点尚未定案");
        require(!exitClaimed[exitId], unicode"Exit already claimed / 该退出已领取");

        bytes32 leaf = keccak256(abi.encode(EXIT_TYPEHASH, exitId, agentId, to, credits, LAYER_CHAIN_ID, address(this)));
        require(MerkleProof.verify(proof, an.exitRoot, leaf), unicode"Bad merkle proof / merkle 证明无效");

        uint256 outstanding = totalCreditsIssued - totalCreditsExited;
        require(outstanding >= credits, unicode"Credits exceed outstanding / 积分超过未退出总量");
        uint256 free = poolBalance - owedTotal;
        lockedWei = (credits * free) / outstanding;
        require(
            lockedWei > 0,
            unicode"Rate too low, exit not worth claiming / 当前兑付率过低，本次退出不值得领取"
        );

        _harvest(to);
        owed[to] += lockedWei;
        owedTotal += lockedWei;
        owedDebt[to] = (owed[to] * accPerOwed) / ACC_PRECISION;
        lastClaimAt[to] = uint64(block.timestamp);
        exitClaimed[exitId] = true;

        // Attribution is truncated at what this agent actually put in, so the escape weight
        // (`credited - exitedCredits`) can never underflow (attack-funds #4).
        uint256 room = credited[agentId] - exitedCredits[agentId];
        uint256 attr = credits < room ? credits : room;
        exitedCredits[agentId] += attr;
        unattributedExited += credits - attr;
        totalCreditsExited += credits;

        emit ExitClaimed(anchorEpoch, exitId, agentId, to, credits, lockedWei, (free * 1e18) / outstanding, attr);
    }

    /// @notice Permissionless, strictly sequential. Non-FINAL epochs advance the cursor with pot 0.
    function settleEpoch(uint64 epoch) external {
        require(!isHalted(), unicode"Bridge halted / 桥已停机");
        require(epoch == lastSettledEpoch + 1, unicode"Settle epochs in order / 纪元必须按序结算");

        IChainAnchor.Anchor memory an = IChainAnchor(anchor).getAnchor(epoch);
        IChainAnchor.State st = an.state;

        if (st == IChainAnchor.State.VETOED || st == IChainAnchor.State.DISPUTED) {
            lastSettledEpoch = epoch;
            skippedEpochs += 1;
            emit EpochSettled(epoch, 0, owedTotal, 0, true);
            return;
        }
        if (st != IChainAnchor.State.FINAL) {
            require(
                block.timestamp >= (uint256(epoch) + 1) * EPOCH + SETTLE_GRACE,
                unicode"Epoch not resolved yet / 该纪元尚未定案"
            );
            lastSettledEpoch = epoch;
            skippedEpochs += 1;
            emit EpochSettled(epoch, 0, owedTotal, 0, true);
            return;
        }

        uint16 bps = IChainAnchor(anchor).releaseBpsFor(epoch);
        if (owedTotal == 0) {
            reservedTotal = 0; // rounding dust can never ratchet (I2)
            lastSettledEpoch = epoch;
            emit EpochSettled(epoch, 0, 0, bps, false);
            return;
        }

        uint256 pot = ((poolBalance - reservedTotal) * bps) / 10000;
        uint256 headroom = owedTotal - reservedTotal;
        if (pot > headroom) pot = headroom;

        // Zero-witness ceiling: with nobody independently checking `exitRoot`, the loss from a
        // stolen relayer key must be a number written in the contract (attack-gate #14).
        uint256 windowOther = releasedInWindow - potRing[epoch % NO_ATTEST_WINDOW];
        if (an.agreeingCount == 0) {
            uint256 capLeft = (poolBalance * NO_ATTEST_WINDOW_BPS) / 10000;
            capLeft = capLeft > windowOther ? capLeft - windowOther : 0;
            if (pot > capLeft) pot = capLeft;
        }
        require(pot <= type(uint128).max, unicode"Pot too large / 释放额过大");
        releasedInWindow = windowOther + pot;
        potRing[epoch % NO_ATTEST_WINDOW] = uint128(pot);

        if (pot != 0) accPerOwed += (pot * ACC_PRECISION) / owedTotal;
        reservedTotal += pot;
        lastPot = pot;
        lastPotSettledAt = uint64(block.timestamp);
        lastPotBps = bps;
        lastSettledEpoch = epoch;
        emit EpochSettled(epoch, pot, owedTotal, bps, false);
    }

    /// @notice Permissionless, once per address per epoch, capped at `lastPot * 10%`.
    /// @dev Truncated wei stays in `unclaimed` forever; it is never forfeited.
    function collect(address to) external nonReentrant returns (uint256 paid) {
        require(to != address(0), unicode"Zero recipient / 收款地址为零");
        (bool paused,,) = isPaused();
        require(!paused, unicode"Bridge paused / 桥已暂停");
        require(!isHalted(), unicode"Bridge halted / 桥已停机");

        uint64 e = uint64(block.timestamp / EPOCH);
        require(lastCollectEpoch[msg.sender] < e, unicode"Already collected this epoch / 本纪元已领取");
        lastCollectEpoch[msg.sender] = e;

        _harvest(msg.sender);
        paid = unclaimed[msg.sender];
        uint256 cap = (lastPot * MAX_EXIT_SHARE_BPS) / 10000;
        if (paid > cap) paid = cap;
        if (paid > owed[msg.sender]) paid = owed[msg.sender];
        // Dust guard (not in §4.2, and it can only ever bite by a few wei): `unclaimed` is a
        // difference of two floors, so it can exceed one address's exact share of `reservedTotal`
        // by up to 1 wei per harvest. Without this clamp that dust would make `reservedTotal -=
        // paid` underflow and panic — i.e. permanently brick `collect` for the last claimant
        // instead of paying them. The clamped wei stays in `unclaimed`, exactly like cap dust.
        if (paid > reservedTotal) paid = reservedTotal;
        require(paid > 0, unicode"Nothing to collect / 没有可领取的金额");

        unclaimed[msg.sender] -= paid;
        owed[msg.sender] -= paid;
        owedDebt[msg.sender] = (owed[msg.sender] * accPerOwed) / ACC_PRECISION;
        owedTotal -= paid;
        reservedTotal -= paid;
        poolBalance -= paid;

        emit Collected(msg.sender, to, paid, owed[msg.sender]);
        _payout(to, paid);
    }

    /// @dev Credits everything released since this address's debt basis, then re-bases it.
    function _harvest(address who) internal {
        uint256 acc = accPerOwed;
        uint256 scaled = (owed[who] * acc) / ACC_PRECISION;
        uint256 debt = owedDebt[who];
        if (scaled > debt) unclaimed[who] += scaled - debt;
        owedDebt[who] = scaled;
    }

    // ==================================================================
    //                          OUT (escape mode)
    // ==================================================================

    /// @notice Watchdog-only manual arm (cause 4). Arming is never an immediate halt.
    function armEscape() external {
        require(msg.sender == watchdog, unicode"Only watchdog / 仅限看门狗");
        require(!halted, unicode"Already halted / 已停机");
        require(escapeArmedAt == 0, unicode"Already armed / 已武装");
        escapeArmedAt = uint64(block.timestamp);
        armedCause = 4;
        emit EscapeArmed(msg.sender, 4, uint64(block.timestamp) + ESCAPE_ARM_DELAY);
    }

    /// @notice Only `ChainAnchor.vetoKey()`, and only once the trigger itself is gone.
    function cancelEscapeArm() external {
        require(msg.sender == IChainAnchor(anchor).vetoKey(), unicode"Only veto key / 仅限 veto 钥");
        require(!halted, unicode"Already halted / 已停机");
        require(escapeArmedAt != 0, unicode"Nothing armed / 尚未武装");
        require(armedCause == 4 || _pendingCause() == 0, unicode"Condition still true / 触发条件仍然成立");
        escapeArmedAt = 0;
        armedCause = 0;
        emit EscapeArmCancelled(msg.sender);
    }

    /// @notice Permissionless: first arms, then (after `ESCAPE_ARM_DELAY`) halts for good.
    function checkHalt() external {
        require(!halted, unicode"Already halted / 已停机");
        uint8 c = _pendingCause();
        if (escapeArmedAt == 0) {
            require(c != 0, unicode"No halt condition / 不满足任何停机条件");
            escapeArmedAt = uint64(block.timestamp);
            armedCause = c;
            emit EscapeArmed(msg.sender, c, uint64(block.timestamp) + ESCAPE_ARM_DELAY);
            return;
        }
        require(
            block.timestamp >= escapeArmedAt + ESCAPE_ARM_DELAY, unicode"Arming delay not elapsed / 武装期未满"
        );
        require(armedCause == 4 || _pendingCause() != 0, unicode"Halt condition cleared / 停机条件已消失");
        _halt(armedCause);
    }

    /// @dev O(1), one-shot. Senior debt is carved out first; the rest becomes the junior pot.
    ///
    ///      The junior denominator is `Σ_id (credited[id] - exitedCredits[id])`, which is
    ///      `issued - exited + unattributedExited`. §4.2 writes `issued - exited`, but that is the
    ///      same number only while `unattributedExited == 0`: an agent that exits more credits
    ///      than it locked has its attribution truncated (revision #21), and each truncated wei
    ///      lands in `unattributedExited` — subtracted from the total but never from any weight.
    ///      Using the spec's literal figure makes the weights sum to MORE than the denominator,
    ///      so `escapeCollect` pays out more than the junior pot and `poolBalance` sinks below
    ///      `owedTotal` (B1 breaks, and `poolBalance -= paid` eventually underflows and bricks
    ///      the escape hatch for everyone). The invariant run finds this in seconds.
    function _halt(uint8 cause) internal {
        reservedTotal = 0;
        escapeTotalWeight = totalCreditsIssued - totalCreditsExited + unattributedExited;
        uint256 junior = poolBalance - owedTotal;
        accPerWeight = escapeTotalWeight == 0 ? 0 : (junior * 1e18) / escapeTotalWeight;
        halted = true;
        haltedAt = uint64(block.timestamp);
        haltCause = cause;
        emit Halted(cause);
    }

    /// @notice Senior claim after a halt: matured `owed` is paid in full.
    function claimOwedAfterHalt(address to) external nonReentrant returns (uint256 paid) {
        require(to != address(0), unicode"Zero recipient / 收款地址为零");
        require(halted, unicode"Bridge not halted / 桥尚未停机");
        require(
            lastClaimAt[msg.sender] + OWED_MATURITY <= haltedAt
                || (haltCause != 2 && haltCause != 3 && block.timestamp >= haltedAt + OWED_MATURITY),
            unicode"Owed not matured / 债权尚未成熟"
        );
        paid = owed[msg.sender];
        require(paid > 0, unicode"Nothing to collect / 没有可领取的金额");

        owed[msg.sender] = 0;
        unclaimed[msg.sender] = 0;
        owedDebt[msg.sender] = 0;
        owedTotal -= paid;
        poolBalance -= paid;

        emit OwedPaidAfterHalt(msg.sender, to, paid);
        _payout(to, paid);
    }

    /// @notice Permissionless: under cause 2/3 an immature `owed` is demoted to the junior pot.
    /// @dev cause 2/3 are the only "the root may be forged" signals; the fraud path can only ever
    ///      produce `owed` younger than `OWED_MATURITY` (attack-funds #3).
    function sweepImmatureOwed(address who) external {
        require(halted, unicode"Bridge not halted / 桥尚未停机");
        require(haltCause == 2 || haltCause == 3, unicode"Halt cause keeps priority / 该停机原因保留优先级");
        require(block.timestamp >= haltedAt + OWED_MATURITY, unicode"Owed not matured / 债权尚未成熟");
        require(lastClaimAt[who] + OWED_MATURITY > haltedAt, unicode"Owed already matured / 该债权已成熟");
        uint256 amount = owed[who];
        require(amount > 0, unicode"Nothing to demote / 没有可降级的债权");

        owed[who] = 0;
        unclaimed[who] = 0;
        owedDebt[who] = 0;
        owedTotal -= amount;
        if (escapeTotalWeight > 0) accPerWeight += (amount * 1e18) / escapeTotalWeight;
        emit OwedDemoted(who, amount);
    }

    /// @notice Junior claim after a halt: pro-rata on credits that never left the bridge.
    /// @dev Status is NOT checked (G11): a banned or dormant agent still gets out.
    function escapeCollect(uint256 agentId, address to) external nonReentrant returns (uint256 paid) {
        require(to != address(0), unicode"Zero recipient / 收款地址为零");
        require(halted, unicode"Bridge not halted / 桥尚未停机");
        IAgentRegistry.Agent memory a = IAgentRegistry(registry).getAgent(agentId);
        require(
            msg.sender == a.controller || msg.sender == a.agentWallet,
            unicode"Not the agent controller / 不是该 agent 的控制者"
        );

        uint256 weight = credited[agentId] - exitedCredits[agentId];
        paid = (weight * accPerWeight) / 1e18 - escapeDebt[agentId];
        require(paid > 0, unicode"Nothing to collect / 没有可领取的金额");

        escapeDebt[agentId] += paid;
        escapeDistributed += paid;
        poolBalance -= paid;

        emit EscapeCollected(agentId, to, paid);
        _payout(to, paid);
    }

    // ==================================================================
    //                              BRAKE
    // ==================================================================

    /// @notice Watchdog-only. Freezes `collect` ONLY — never `claimExit`, never the escape path.
    function pause() external {
        require(msg.sender == watchdog, unicode"Only watchdog / 仅限看门狗");
        pausedCumulative += _pauseUsed();
        pausedUntil = 0;
        require(pausedCumulative < MAX_PAUSE_TOTAL, unicode"Pause budget exhausted / 暂停额度已用尽");
        pauseStartedAt = uint64(block.timestamp);
        pausedUntil = uint64(block.timestamp) + PAUSE_LEN;
        emit Paused(msg.sender, pausedUntil, pausedCumulative);
    }

    /// @notice Watchdog-only. Settles the time actually spent paused into the cumulative budget.
    function unpause() external {
        require(msg.sender == watchdog, unicode"Only watchdog / 仅限看门狗");
        require(pausedUntil != 0, unicode"Not paused / 未处于暂停");
        pausedCumulative += _pauseUsed();
        pausedUntil = 0;
        pauseStartedAt = 0;
        emit Unpaused(msg.sender, pausedCumulative);
    }

    /// @dev Time of the current (or last, expired-but-unsettled) pause that is not yet counted.
    function _pauseUsed() internal view returns (uint64) {
        if (pausedUntil == 0) return 0;
        uint64 end = uint64(block.timestamp) < pausedUntil ? uint64(block.timestamp) : pausedUntil;
        return end > pauseStartedAt ? end - pauseStartedAt : 0;
    }

    // ==================================================================
    //                         ONE-WAY BAC BURN
    // ==================================================================

    /// @notice Permissionless. The one and only way BAC can leave this contract: to `DEAD`.
    function burnLocked() external nonReentrant returns (uint256 burned) {
        burned = IERC20(bacToken).balanceOf(address(this));
        require(burned > 0, unicode"Nothing to burn / 没有可销毁的 BAC");
        totalBurned += burned;
        _pushBac(DEAD, burned);
        emit LockedBurned(burned);
    }

    // ==================================================================
    //                              VIEWS
    // ==================================================================

    function creditsOutstanding() external view returns (uint256) {
        return totalCreditsIssued - totalCreditsExited;
    }

    /// @notice What `collect` would pay right now, cap already applied.
    function pendingCollect(address who) external view returns (uint256) {
        uint256 scaled = (owed[who] * accPerOwed) / ACC_PRECISION;
        uint256 debt = owedDebt[who];
        uint256 amount = unclaimed[who] + (scaled > debt ? scaled - debt : 0);
        uint256 cap = (lastPot * MAX_EXIT_SHARE_BPS) / 10000;
        if (amount > cap) amount = cap;
        if (amount > owed[who]) amount = owed[who];
        return amount;
    }

    /// @notice 1e18-fixed wei per credit. A view only — nothing is ever promised.
    function currentRate() external view returns (uint256 weiPerCredit) {
        uint256 outstanding = totalCreditsIssued - totalCreditsExited;
        if (outstanding == 0) return 0;
        return ((poolBalance - owedTotal) * 1e18) / outstanding;
    }

    function lastEpochRelease() external view returns (uint256 pot, uint64 settledAt, uint16 releaseBps) {
        return (lastPot, lastPotSettledAt, lastPotBps);
    }

    function isPaused() public view returns (bool, uint64 until_, uint64 cumulative) {
        return (pausedUntil > block.timestamp, pausedUntil, pausedCumulative + _pauseUsed());
    }

    function isHalted() public view returns (bool) {
        return halted;
    }

    function escapeState() external view returns (uint256 totalWeight, uint256 accPerWeight_, uint256 distributed) {
        return (escapeTotalWeight, accPerWeight, escapeDistributed);
    }

    function escapeClaimable(uint256 agentId) external view returns (uint256) {
        if (!halted) return 0;
        uint256 weight = credited[agentId] - exitedCredits[agentId];
        uint256 gross = (weight * accPerWeight) / 1e18;
        uint256 debt = escapeDebt[agentId];
        return gross > debt ? gross - debt : 0;
    }

    /// @notice 0 = no condition. 1/2/3 come from `ChainAnchor`, 5 from our own pause budget.
    ///         Cause 4 is the manual arm and never appears here.
    function pendingCause() external view returns (uint8) {
        return _pendingCause();
    }

    function _pendingCause() internal view returns (uint8) {
        uint8 r = IChainAnchor(anchor).haltReason();
        if (r != 0) return r;
        if (pausedCumulative + _pauseUsed() >= MAX_PAUSE_TOTAL) return 5;
        return 0;
    }

    // ==================================================================
    //                             INTERNALS
    // ==================================================================

    function _payout(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        require(ok, unicode"BNB transfer failed / BNB 转账失败");
    }

    function _pullBac(address from, uint256 amount) internal {
        (bool ok, bytes memory ret) =
            bacToken.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), unicode"BAC transferFrom failed / BAC 转入失败");
    }

    function _pushBac(address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = bacToken.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), unicode"BAC transfer failed / BAC 转出失败");
    }
}
