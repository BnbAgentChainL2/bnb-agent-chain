// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/security/ReentrancyGuard.sol";
import {IChainAnchor} from "./interfaces/IChainAnchor.sol";

/// @title ValidatorStaking
/// @notice The humans: stake BAC, register a node, witness every epoch with a
///         commit-reveal, and claim BNB rewards out of a permissionlessly funded pot.
///
/// @dev Implements docs/01-CONTRACT-SPEC.md §7 including the revision record:
///        - #36: `WEIGHT_CAP` is deleted. `attestWeight = stakeOf(v).staked`, purely
///               linear, uncapped, counted once per address (S5).
///               `MAX_VALIDATOR_SHARE_BPS` constrains reward splitting ONLY and never
///               touches `attestationResult`.
///        - #37: `settleEpochRewards` is strictly sequential and reuses the bridge's
///               skip rules; every undistributable remainder stays in `rewardBalance`.
///        - #38: `requestUnstake` re-checks `staked - amount >= MIN_STAKE * nodesOf(who)`
///               (S4) and rewards are paid per validator ADDRESS, not per node.
///        - #34: `commitAttestation` looks at the clock only, never at the anchor state,
///               so the relayer cannot squeeze the commit window to zero.
///      There is no admin path that can move staked BAC and no token rescue function (S3).
contract ValidatorStaking is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // constants (§7, and 00-DESIGN-SPEC §3.5 / §11)
    // ---------------------------------------------------------------------

    /// @notice Minimum stake per node slot. `MIN_VALIDATOR_STAKE` is the name used by
    ///         00-DESIGN-SPEC, `MIN_STAKE` the one used by 01-CONTRACT-SPEC §7: same value.
    uint256 public constant MIN_VALIDATOR_STAKE = 2_000_000e18;
    uint256 public constant MIN_STAKE = MIN_VALIDATOR_STAKE;

    uint64 public constant UNSTAKE_COOLDOWN = 7 days;
    uint16 public constant MAX_NODES = 64;
    // WEIGHT_CAP is deleted (00 §11.1 M3 / revision 36): linear weight is split-neutral,
    // a cap makes splitting strictly profitable AND cheapens "force a DISPUTED" attacks.
    uint16 public constant MAX_VALIDATOR_SHARE_BPS = 2500; // reward split only, never witness weight
    uint16 public constant REWARD_RELEASE_BPS = 500;
    uint64 public constant REWARD_CLAIM_WINDOW = 30 days;
    uint8 public constant MAX_STRIKES = 3;
    uint64 public constant ADMIN_TIMELOCK = 48 hours;

    /// @dev Mirrors of `ChainAnchor`'s clock, verified against it in the constructor.
    uint64 public constant EPOCH = 86400;
    uint64 public constant COMMIT_WINDOW = 2 hours;
    uint64 public constant CHALLENGE_WINDOW = 24 hours;
    /// @dev Same grace as `BacBridge.SETTLE_GRACE`: an epoch that is neither FINAL nor
    ///      resolved can only be skipped after this long (revision 37 reuses the bridge rule).
    uint64 public constant SETTLE_GRACE = 7 days;

    uint256 private constant ACC_PRECISION = 1e27;
    uint16 private constant BPS = 10000;

    // ---------------------------------------------------------------------
    // storage
    // ---------------------------------------------------------------------

    address public immutable bacToken;
    address public immutable anchor;
    address public admin;

    uint256 public totalStaked;
    mapping(address => uint256) private _staked;
    mapping(address => uint256) private _pendingUnstake;
    mapping(address => uint64) private _unlockAt;

    struct Node {
        address validator;
        address payout;
        string enodeURI;
        bool active;
        uint32 strikes;
        uint32 listIndex; // index in _nodeList
        uint32 ownerIndex; // index in _validatorNodes[validator]
    }

    bytes32[] private _nodeList;
    mapping(bytes32 => Node) private _nodes;
    mapping(address => bytes32[]) private _validatorNodes;
    /// @notice Where this validator's rewards are sent (set by `registerNode`).
    mapping(address => address) public payoutOf;

    /// @notice Removed validators keep their principal and their witness weight; they
    ///         only lose reward eligibility (§7: "v1 does not slash").
    mapping(address => bool) public removed;
    mapping(address => uint64) public removalEta;

    mapping(uint64 => mapping(address => bytes32)) public commitmentOf;
    mapping(uint64 => mapping(address => bool)) public hasRevealed;

    struct Reveal {
        bytes32 exitRoot;
        bytes32 l2BlockHash;
        uint64 l2Block;
        uint256 weight; // snapshot of stakeOf(validator).staked at reveal time
    }

    mapping(uint64 => mapping(address => Reveal)) private _reveals;
    mapping(uint64 => address[]) private _revealers; // each address pushed at most once (S5)

    uint256 public rewardBalance;
    uint256 public lifetimeFunded;
    uint256 public lifetimePaid;
    uint64 public lastRewardEpoch;

    struct EpochReward {
        uint128 pot; // nominal pot = rewardBalance * REWARD_RELEASE_BPS / BPS
        uint128 escrowed; // what is actually reserved for claimants (<= pot)
        uint128 claimedTotal;
        uint256 weight; // sum of the agreeing addresses' stake
        uint256 rate; // pot * ACC_PRECISION / weight
        bytes32 exitRoot;
        bytes32 l2BlockHash;
        uint64 l2Block;
        uint64 settledAt;
        bool settled;
        bool swept;
    }

    mapping(uint64 => EpochReward) private _epochRewards;
    mapping(uint64 => mapping(address => bool)) public rewardClaimed;

    // ---------------------------------------------------------------------
    // events (§7, verbatim)
    // ---------------------------------------------------------------------

    event Staked(address indexed who, uint256 amount, uint256 total);
    event UnstakeRequested(address indexed who, uint256 amount, uint64 unlockAt);
    event Unstaked(address indexed who, address indexed to, uint256 amount);
    event NodeRegistered(bytes32 indexed nodeIdHash, address indexed validator, address payout, string enodeURI);
    event NodeRetired(bytes32 indexed nodeIdHash);
    event AttestationCommitted(uint64 indexed epoch, address indexed validator, bytes32 commitment);
    event AttestationRevealed(
        uint64 indexed epoch,
        address indexed validator,
        bytes32 exitRoot,
        bytes32 l2BlockHash,
        uint64 l2Block,
        bool agreeing,
        uint256 weight
    );
    event RewardsFunded(address indexed from, uint256 amount, uint256 balanceAfter);
    event RewardsSettled(uint64 indexed epoch, uint256 pot, uint256 weight, uint256 rate);
    event RewardClaimed(uint64 indexed epoch, address indexed validator, address indexed to, uint256 amount);
    event RewardExpired(uint64 indexed epoch, uint256 returned);
    event NodeStruck(bytes32 indexed nodeIdHash, uint32 strikes);
    event ValidatorRemovalQueued(address indexed v, bytes32 reasonHash, uint64 eta);
    event ValidatorRemovalCancelled(address indexed v, address indexed by);
    event ValidatorRemoved(address indexed v);

    // ---------------------------------------------------------------------
    // constructor
    // ---------------------------------------------------------------------

    constructor(address bacToken_, address anchor_, address admin_) {
        require(bacToken_ != address(0), unicode"Token is zero / 代币地址为零");
        require(anchor_ != address(0), unicode"Anchor is zero / 锚点地址为零");
        require(admin_ != address(0), unicode"Admin is zero / 管理员地址为零");

        bacToken = bacToken_;
        anchor = anchor_;
        admin = admin_;

        // the clock mirrors must match the anchor's, or the commit window would drift
        require(IChainAnchor(anchor_).EPOCH() == EPOCH, unicode"Epoch length mismatch / 纪元长度不一致");
        require(
            IChainAnchor(anchor_).COMMIT_WINDOW() == COMMIT_WINDOW,
            unicode"Commit window mismatch / 承诺窗口不一致"
        );
        require(
            IChainAnchor(anchor_).CHALLENGE_WINDOW() == CHALLENGE_WINDOW,
            unicode"Challenge window mismatch / 挑战窗口不一致"
        );

        // reward settlement starts at the same epoch the anchor chain starts at
        lastRewardEpoch = IChainAnchor(anchor_).firstEpoch() - 1;
    }

    // ---------------------------------------------------------------------
    // staking (no admin path can ever move this BAC - S3)
    // ---------------------------------------------------------------------

    /// @notice Stake BAC. Accounted by measured balance delta, never by the argument.
    function stake(uint256 amount) external nonReentrant {
        require(amount != 0, unicode"Zero amount / 金额为零");
        uint256 before = IERC20(bacToken).balanceOf(address(this));
        IERC20(bacToken).safeTransferFrom(msg.sender, address(this), amount);
        uint256 measured = IERC20(bacToken).balanceOf(address(this)) - before;
        require(measured != 0, unicode"Zero amount / 金额为零");

        _staked[msg.sender] += measured;
        totalStaked += measured;
        emit Staked(msg.sender, measured, _staked[msg.sender]);
    }

    /// @notice Start the 7-day cooldown on part of the stake.
    /// @dev S4: the same inequality `registerNode` enforces is re-checked here, otherwise
    ///      "stake 8M, register 4 nodes, unstake 6M" would never revert (revision 38).
    function requestUnstake(uint256 amount) external {
        require(amount != 0, unicode"Zero amount / 金额为零");
        uint256 staked_ = _staked[msg.sender];
        require(amount <= staked_, unicode"Amount too large / 金额过大");
        require(
            staked_ - amount >= MIN_STAKE * _validatorNodes[msg.sender].length,
            unicode"Retire a node first / 请先退掉一个节点"
        );

        _staked[msg.sender] = staked_ - amount;
        totalStaked -= amount;
        _pendingUnstake[msg.sender] += amount;
        _unlockAt[msg.sender] = uint64(block.timestamp) + UNSTAKE_COOLDOWN;
        emit UnstakeRequested(msg.sender, amount, _unlockAt[msg.sender]);
    }

    function withdrawUnstaked(address to) external nonReentrant returns (uint256) {
        require(to != address(0), unicode"Zero address / 地址为零");
        uint256 amount = _pendingUnstake[msg.sender];
        require(amount != 0, unicode"Nothing to withdraw / 没有可取回的金额");
        require(block.timestamp >= _unlockAt[msg.sender], unicode"Cooldown not elapsed / 冷却期未满");

        _pendingUnstake[msg.sender] = 0;
        _unlockAt[msg.sender] = 0;
        IERC20(bacToken).safeTransfer(to, amount);
        emit Unstaked(msg.sender, to, amount);
        return amount;
    }

    // ---------------------------------------------------------------------
    // nodes
    // ---------------------------------------------------------------------

    /// @dev Every nodeIdHash must be backed by its own full `MIN_STAKE` (judge-attack N7).
    function registerNode(bytes32 nodeIdHash, string calldata enodeURI, address payout) external {
        require(nodeIdHash != bytes32(0), unicode"Node id is zero / 节点 id 为零");
        require(_nodes[nodeIdHash].validator == address(0), unicode"Node already registered / 该节点已注册");
        require(_nodeList.length < MAX_NODES, unicode"Node slots are full / 节点槽位已满");
        require(bytes(enodeURI).length != 0, unicode"Empty enode URI / enode 地址为空");
        require(payout != address(0), unicode"Zero address / 地址为零");

        uint256 slots = _validatorNodes[msg.sender].length + 1;
        require(_staked[msg.sender] >= MIN_STAKE * slots, unicode"Stake below minimum / 质押低于门槛");

        _nodes[nodeIdHash] = Node({
            validator: msg.sender,
            payout: payout,
            enodeURI: enodeURI,
            active: true,
            strikes: 0,
            listIndex: uint32(_nodeList.length),
            ownerIndex: uint32(slots - 1)
        });
        _nodeList.push(nodeIdHash);
        _validatorNodes[msg.sender].push(nodeIdHash);
        payoutOf[msg.sender] = payout;

        emit NodeRegistered(nodeIdHash, msg.sender, payout, enodeURI);
    }

    function retireNode(bytes32 nodeIdHash) external {
        Node memory n = _nodes[nodeIdHash];
        require(n.validator == msg.sender, unicode"Not the node operator / 不是该节点的运营者");

        // swap-pop out of the global list
        uint256 last = _nodeList.length - 1;
        if (n.listIndex != last) {
            bytes32 moved = _nodeList[last];
            _nodeList[n.listIndex] = moved;
            _nodes[moved].listIndex = n.listIndex;
        }
        _nodeList.pop();

        // swap-pop out of the operator's list
        bytes32[] storage own = _validatorNodes[msg.sender];
        uint256 ownLast = own.length - 1;
        if (n.ownerIndex != ownLast) {
            bytes32 movedOwn = own[ownLast];
            own[n.ownerIndex] = movedOwn;
            _nodes[movedOwn].ownerIndex = n.ownerIndex;
        }
        own.pop();

        delete _nodes[nodeIdHash];
        emit NodeRetired(nodeIdHash);
    }

    // ---------------------------------------------------------------------
    // attestation (commit - reveal)
    // ---------------------------------------------------------------------

    /// @notice Commit to an epoch's triple before the relayer posts its anchor.
    /// @dev Time only. Never look at the anchor state here: that would hand the length
    ///      of the commit window to the relayer, which could squeeze it to one block
    ///      and make DISPUTED unreachable forever (attack-funds #7 / revision 34).
    function commitAttestation(uint64 epoch, bytes32 commitment) external {
        require(commitment != bytes32(0), unicode"Empty commitment / 承诺为空");
        require(_validatorNodes[msg.sender].length != 0, unicode"Register a node first / 请先注册节点");
        require(commitmentOf[epoch][msg.sender] == bytes32(0), unicode"Already committed / 本纪元已承诺");
        require(
            block.timestamp < (uint256(epoch) + 1) * EPOCH + COMMIT_WINDOW,
            unicode"Commit window closed / 承诺窗口已结束"
        );

        commitmentOf[epoch][msg.sender] = commitment;
        emit AttestationCommitted(epoch, msg.sender, commitment);
    }

    /// @notice Reveal inside the 24h challenge window of a POSTED anchor.
    /// @dev A reveal that does not match the commitment counts for NEITHER side and
    ///      adds a strike to every node of that validator (§7).
    function revealAttestation(uint64 epoch, bytes32 exitRoot, bytes32 l2BlockHash, uint64 l2Block, bytes32 salt)
        external
    {
        IChainAnchor.Anchor memory a = IChainAnchor(anchor).getAnchor(epoch);
        require(a.state == IChainAnchor.State.POSTED, unicode"Anchor not posted / 锚点不处于已提交状态");
        require(
            block.timestamp < uint256(a.postedAt) + CHALLENGE_WINDOW,
            unicode"Challenge window closed / 挑战窗口已结束"
        );

        bytes32 c = commitmentOf[epoch][msg.sender];
        require(c != bytes32(0), unicode"No commitment / 本纪元没有承诺");
        require(!hasRevealed[epoch][msg.sender], unicode"Already revealed / 本纪元已揭示");
        hasRevealed[epoch][msg.sender] = true;

        if (c != keccak256(abi.encode(epoch, exitRoot, l2BlockHash, l2Block, salt, msg.sender))) {
            _strike(msg.sender);
            return; // counted on neither side
        }

        uint256 weight = _staked[msg.sender]; // linear, uncapped, one snapshot per address
        require(weight != 0, unicode"Stake below minimum / 质押低于门槛");

        _reveals[epoch][msg.sender] =
            Reveal({exitRoot: exitRoot, l2BlockHash: l2BlockHash, l2Block: l2Block, weight: weight});
        _revealers[epoch].push(msg.sender);

        bool agreeing = (exitRoot == a.exitRoot && l2BlockHash == a.l2BlockHash && l2Block == a.l2Block);
        emit AttestationRevealed(epoch, msg.sender, exitRoot, l2BlockHash, l2Block, agreeing, weight);
    }

    /// @notice Weight of the reveals that match / contradict a triple.
    /// @dev Per ADDRESS and once per address (S5); no cap of any kind is applied here.
    function attestationResult(uint64 epoch, bytes32 exitRoot, bytes32 l2BlockHash, uint64 l2Block)
        external
        view
        returns (uint256 agreeingWeight, uint256 disputingWeight, uint32 agreeingCount, uint32 disputingCount)
    {
        address[] storage rs = _revealers[epoch];
        uint256 n = rs.length;
        for (uint256 i; i < n; ++i) {
            Reveal storage r = _reveals[epoch][rs[i]];
            if (r.exitRoot == exitRoot && r.l2BlockHash == l2BlockHash && r.l2Block == l2Block) {
                agreeingWeight += r.weight;
                unchecked {
                    ++agreeingCount;
                }
            } else {
                disputingWeight += r.weight;
                unchecked {
                    ++disputingCount;
                }
            }
        }
    }

    function _strike(address validator) private {
        bytes32[] storage own = _validatorNodes[validator];
        uint256 n = own.length;
        for (uint256 i; i < n; ++i) {
            Node storage nd = _nodes[own[i]];
            nd.strikes += 1;
            if (nd.strikes >= MAX_STRIKES) nd.active = false;
            emit NodeStruck(own[i], nd.strikes);
        }
    }

    // ---------------------------------------------------------------------
    // rewards
    // ---------------------------------------------------------------------

    /// @notice Permissionless: in v1 the operator funds this out of the node fund (00 §6.3).
    function fundRewards() external payable {
        require(msg.value != 0, unicode"Zero amount / 金额为零");
        rewardBalance += msg.value;
        lifetimeFunded += msg.value;
        emit RewardsFunded(msg.sender, msg.value, rewardBalance);
    }

    /// @notice Permissionless, strictly sequential, and it may skip a non-FINAL epoch
    ///         exactly the way `BacBridge.settleEpoch` does (revision 37).
    function settleEpochRewards(uint64 epoch) external {
        require(epoch == lastRewardEpoch + 1, unicode"Settle epochs in order / 纪元必须按序结算");
        EpochReward storage er = _epochRewards[epoch];

        IChainAnchor.Anchor memory a = IChainAnchor(anchor).getAnchor(epoch);
        if (a.state != IChainAnchor.State.FINAL) {
            if (a.state != IChainAnchor.State.VETOED && a.state != IChainAnchor.State.DISPUTED) {
                require(
                    block.timestamp >= (uint256(epoch) + 1) * EPOCH + SETTLE_GRACE,
                    unicode"Epoch not resolved yet / 该纪元尚未定案"
                );
            }
            er.settled = true;
            er.settledAt = uint64(block.timestamp);
            lastRewardEpoch = epoch;
            emit RewardsSettled(epoch, 0, 0, 0);
            return;
        }

        uint256 pot = rewardBalance * REWARD_RELEASE_BPS / BPS;
        address[] storage rs = _revealers[epoch];
        uint256 n = rs.length;

        uint256 weight;
        for (uint256 i; i < n; ++i) {
            address v = rs[i];
            if (removed[v]) continue;
            Reveal storage r = _reveals[epoch][v];
            if (r.exitRoot == a.exitRoot && r.l2BlockHash == a.l2BlockHash && r.l2Block == a.l2Block) {
                weight += r.weight;
            }
        }

        er.settled = true;
        er.settledAt = uint64(block.timestamp);
        er.exitRoot = a.exitRoot;
        er.l2BlockHash = a.l2BlockHash;
        er.l2Block = a.l2Block;
        lastRewardEpoch = epoch;

        if (pot == 0 || weight == 0) {
            // nothing to distribute: the whole pot stays in rewardBalance
            emit RewardsSettled(epoch, 0, weight, 0);
            return;
        }

        uint256 rate = pot * ACC_PRECISION / weight;
        uint256 cap = pot * MAX_VALIDATOR_SHARE_BPS / BPS;
        uint256 escrowed;
        for (uint256 i; i < n; ++i) {
            address v = rs[i];
            if (removed[v]) continue;
            Reveal storage r = _reveals[epoch][v];
            if (r.exitRoot != a.exitRoot || r.l2BlockHash != a.l2BlockHash || r.l2Block != a.l2Block) continue;
            uint256 amt = r.weight * rate / ACC_PRECISION;
            if (amt > cap) amt = cap;
            escrowed += amt;
        }

        er.pot = uint128(pot);
        er.weight = weight;
        er.rate = rate;
        er.escrowed = uint128(escrowed);
        // Only what can actually be distributed leaves rewardBalance; the remainder
        // (rounding dust + whatever the 25% cap shaved off) stays there (S2).
        rewardBalance -= escrowed;

        emit RewardsSettled(epoch, pot, weight, rate);
    }

    /// @notice Claim one epoch's reward for one validator ADDRESS. Anyone may call it;
    ///         the money always goes to that validator's payout address.
    function claimReward(uint64 epoch, address validator) external nonReentrant returns (uint256) {
        EpochReward storage er = _epochRewards[epoch];
        require(er.settled, unicode"Epoch not settled / 该纪元尚未结算"); // implies rewardOf > 0 checks below
        require(!er.swept, unicode"Reward expired / 奖励已过期");
        require(
            block.timestamp < uint256(er.settledAt) + REWARD_CLAIM_WINDOW, unicode"Reward expired / 奖励已过期"
        );

        uint256 amount = rewardOf(epoch, validator);
        require(amount != 0, unicode"Nothing to claim / 没有可领取的金额");

        rewardClaimed[epoch][validator] = true;
        er.claimedTotal += uint128(amount);
        lifetimePaid += amount;

        address to = payoutOf[validator];
        if (to == address(0)) to = validator;

        (bool ok,) = to.call{value: amount}("");
        require(ok, unicode"Reward transfer failed / 奖励转账失败");

        emit RewardClaimed(epoch, validator, to, amount);
        return amount;
    }

    /// @notice Permissionless: 30 days after settlement whatever was not claimed goes
    ///         back to `rewardBalance` (it is never burnt and never rolls into a pot).
    function sweepExpired(uint64 epoch) external returns (uint256) {
        EpochReward storage er = _epochRewards[epoch];
        require(er.settled, unicode"Epoch not settled / 该纪元尚未结算");
        require(!er.swept, unicode"Already swept / 已经清扫过");
        require(
            block.timestamp >= uint256(er.settledAt) + REWARD_CLAIM_WINDOW,
            unicode"Claim window still open / 领取窗口尚未结束"
        );

        er.swept = true;
        uint256 returned = uint256(er.escrowed) - uint256(er.claimedTotal);
        if (returned != 0) rewardBalance += returned;
        emit RewardExpired(epoch, returned);
        return returned;
    }

    // ---------------------------------------------------------------------
    // admin (48h timelock; it can only cancel reward eligibility, never touch stake)
    // ---------------------------------------------------------------------

    function proposeRemoveValidator(address v, bytes32 reasonHash) external {
        require(msg.sender == admin, unicode"Only admin / 仅限管理员");
        require(v != address(0), unicode"Zero address / 地址为零");
        removalEta[v] = uint64(block.timestamp) + ADMIN_TIMELOCK;
        emit ValidatorRemovalQueued(v, reasonHash, removalEta[v]);
    }

    function executeRemoveValidator(address v) external {
        require(msg.sender == admin, unicode"Only admin / 仅限管理员");
        uint64 eta = removalEta[v];
        require(eta != 0, unicode"No removal queued / 没有待执行的移除");
        require(block.timestamp >= eta, unicode"Timelock not elapsed / 时锁未到期");

        removalEta[v] = 0;
        removed[v] = true;

        bytes32[] storage own = _validatorNodes[v];
        uint256 n = own.length;
        for (uint256 i; i < n; ++i) {
            _nodes[own[i]].active = false;
        }
        emit ValidatorRemoved(v);
        // NOTE: the stake itself is untouched. The principal is still withdrawable
        // through the normal 7-day cooldown (v1 does not slash), and the witness
        // weight is untouched as well so that admin can never soften a dispute.
    }

    function cancelRemoveValidator(address v) external {
        require(
            msg.sender == admin || msg.sender == IChainAnchor(anchor).vetoKey(),
            unicode"Only admin or veto key / 仅限管理员或 veto 钥"
        );
        require(removalEta[v] != 0, unicode"No removal queued / 没有待执行的移除");
        removalEta[v] = 0;
        emit ValidatorRemovalCancelled(v, msg.sender);
    }

    // ---------------------------------------------------------------------
    // views
    // ---------------------------------------------------------------------

    function stakeOf(address who) external view returns (uint256 staked, uint256 pending, uint64 unlockAt) {
        return (_staked[who], _pendingUnstake[who], _unlockAt[who]);
    }

    function nodeCount() external view returns (uint256) {
        return _nodeList.length;
    }

    function nodeAt(uint256 i) external view returns (bytes32 nodeIdHash) {
        return _nodeList[i];
    }

    function nodeOf(bytes32 nodeIdHash)
        external
        view
        returns (address validator, address payout, string memory enodeURI, bool active, uint32 strikes)
    {
        Node storage n = _nodes[nodeIdHash];
        return (n.validator, n.payout, n.enodeURI, n.active && !removed[n.validator], n.strikes);
    }

    function nodesOf(address who) external view returns (uint256) {
        return _validatorNodes[who].length;
    }

    function epochReward(uint64 epoch) external view returns (uint256 pot, uint256 weight, uint256 rate, bool settled) {
        EpochReward storage er = _epochRewards[epoch];
        return (er.pot, er.weight, er.rate, er.settled);
    }

    /// @notice What `validator` can still claim for `epoch` (0 once claimed or expired).
    function rewardOf(uint64 epoch, address validator) public view returns (uint256) {
        EpochReward storage er = _epochRewards[epoch];
        if (!er.settled || er.swept || er.weight == 0) return 0;
        if (removed[validator] || rewardClaimed[epoch][validator]) return 0;

        Reveal storage r = _reveals[epoch][validator];
        if (r.weight == 0) return 0;
        if (r.exitRoot != er.exitRoot || r.l2BlockHash != er.l2BlockHash || r.l2Block != er.l2Block) return 0;

        uint256 amt = r.weight * er.rate / ACC_PRECISION;
        uint256 cap = uint256(er.pot) * MAX_VALIDATOR_SHARE_BPS / BPS;
        return amt > cap ? cap : amt;
    }

    function revealerCount(uint64 epoch) external view returns (uint256) {
        return _revealers[epoch].length;
    }

    function revealOf(uint64 epoch, address validator)
        external
        view
        returns (bytes32 exitRoot, bytes32 l2BlockHash, uint64 l2Block, uint256 weight)
    {
        Reveal storage r = _reveals[epoch][validator];
        return (r.exitRoot, r.l2BlockHash, r.l2Block, r.weight);
    }
}
