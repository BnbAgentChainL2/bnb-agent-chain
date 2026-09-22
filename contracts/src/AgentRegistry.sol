// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC721} from "@openzeppelin/token/ERC721/ERC721.sol";
import {ECDSA} from "@openzeppelin/utils/cryptography/ECDSA.sol";

/// @title AgentRegistry — BNB Agent Chain 的 soulbound 身份与准入闸门
/// @notice 01-CONTRACT-SPEC.md §3 的逐字实现。
///         身份不可转让；进入这一层必须先过 3 轮限时签名挑战，之后每纪元还要在一个
///         刚封存的随机窗口里应答一次心跳。
///         本合约**只**影响「进桥」与「发布」；它没有任何路径能阻止退出（G11）。
/// @dev 规则 004：本合约不使用任何 custom error，所有 revert 都是双语 require 字符串。
contract AgentRegistry is ERC721 {
    // ---------------------------------------------------------------------
    // 类型
    // ---------------------------------------------------------------------

    enum Status {
        NONE,
        CHALLENGED,
        ACTIVE,
        DORMANT,
        BANNED,
        RETIRED
    }

    struct Agent {
        address controller; // ownerOf(agentId)，签挑战与心跳
        address agentWallet; // 层内钱包，收积分
        string agentURI; // ERC-8004 registration JSON
        bytes32 endpointHash; // keccak256(services[A2A].endpoint)
        bytes32 modelFingerprint; // keccak256("vendor/model@version")，自述，仅供展示
        uint64 registeredAt;
        uint64 lastHeartbeatEpoch;
        uint32 missedEpochs;
        uint32 solvedChallenges;
        uint96 deposit;
        Status status;
    }

    struct Challenge {
        bytes32 challengeId;
        bytes32 seed;
        uint64 issuedBlock;
        uint64 deadlineBlock;
        uint64 deadlineTime;
        uint8 round;
    }

    // ---------------------------------------------------------------------
    // 常量（00-DESIGN-SPEC.md §11「AgentRegistry（BSC）」）
    // ---------------------------------------------------------------------

    uint256 public constant ENTRY_DEPOSIT = 0.02 ether;
    uint8 public constant ROUNDS = 3;
    uint64 public constant K_BLOCKS = 8;
    uint64 public constant K_SECONDS = 5;
    uint256 public constant TARGET = 2 ** 236;
    uint64 public constant EPOCH = 86400;
    uint32 public constant MAX_MISSED = 3;
    uint256 public constant SPOT_RATE = 32;
    uint64 public constant RETIRE_DELAY = 7 days;
    uint256 public constant MAX_URI_BYTES = 512;
    uint64 public constant ADMIN_TIMELOCK = 48 hours;
    uint64 public constant SEED_SEAL_DELAY = 64; // 纪元种子延后封存的区块数（约 29 s）
    uint64 public constant HB_WINDOW_BLOCKS = 600; // 封存后的心跳窗口（约 4.5 min）
    uint64 public constant REISSUE_COOLDOWN = 60; // 同一 agent 两次 reissueChallenge 的最小间隔（秒）
    uint32 public constant MAX_FAILED_ROUNDS = 10; // controller 自己累计失败这么多次才没收押金
    uint64 public constant CHALLENGE_ABANDON = 24 hours; // CHALLENGED 超过这个时长未激活：押金原路退还，不没收

    /// @dev EIP-712 domain 按规格逐字钉死在 chainId 56（BSC 主网），不随 block.chainid 变化。
    uint256 internal constant DOMAIN_CHAIN_ID = 56;

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant CHALLENGE_TYPEHASH =
        keccak256("Challenge(uint256 agentId,bytes32 challengeId,bytes32 seed,uint256 nonce)");
    bytes32 public constant BIND_WALLET_TYPEHASH =
        keccak256("BindWallet(address wallet,address controller,uint256 deadline)");
    bytes32 public constant HEARTBEAT_TYPEHASH =
        keccak256("Heartbeat(uint256 agentId,uint64 epoch,bytes32 epochSeed,bytes32 note)");
    bytes32 public constant ROTATE_TYPEHASH =
        keccak256("RotateController(uint256 agentId,address newController,uint256 deadline)");

    // ---------------------------------------------------------------------
    // 状态
    // ---------------------------------------------------------------------

    // 金库地址在发射时才存在，而本合约先部署，所以它**不是** immutable。
    address public vaultSink; // 一次性设置，见 setVaultSink
    address public admin; // 冷钥，只能 ban / 时锁
    address public vetoKey; // 冷钥，可立即 ban、可取消时锁
    address public immutable deployer;

    bytes32 internal immutable _domainSeparator;

    uint256 public forfeitedPending;
    uint256 internal _nextId = 1;

    mapping(uint256 => Agent) internal _agents;
    mapping(uint256 => Challenge) internal _challenges;

    mapping(address => uint256) public agentIdOfController;
    mapping(address => uint256) public agentIdOfWallet;

    mapping(uint256 => uint256) public challengeNonce; // 每次新发挑战 +1，杜绝种子重放
    mapping(uint256 => uint32) public failedRounds; // 只在 controller 自己重发时 +1（R5）
    mapping(uint256 => uint64) public lastReissueAt;
    mapping(uint256 => uint64) public challengedAt; // 进入 CHALLENGED 的时刻（abandon 用）
    mapping(uint256 => uint64) public lastSolveEpoch; // 最近一次解出挑战的纪元（抽查用）
    mapping(uint256 => uint64) public claimableAt; // RETIRED 之后押金可取的时刻
    mapping(uint256 => address) public depositPayer; // 注册时的付款地址（abandon 原路退还）
    mapping(uint256 => bool) public everActivated; // 是否曾经激活过

    mapping(uint256 => uint64) public banEta;
    mapping(uint256 => bytes32) public banReasonHash;

    mapping(uint64 => uint64) public seedAnchorBlock;
    mapping(uint64 => bytes32) public epochSeed;
    mapping(uint64 => uint64) public sealedAtBlock;

    mapping(bytes32 => bool) internal _solvedChallengeId;

    bool internal _rotating; // 只有 rotateController 能把 soulbound 的门打开一次

    // ---------------------------------------------------------------------
    // 事件
    // ---------------------------------------------------------------------

    event Registered(
        uint256 indexed agentId,
        address indexed controller,
        address indexed agentWallet,
        string agentURI,
        bytes32 endpointHash,
        bytes32 modelFingerprint
    );
    event ChallengeIssued(
        uint256 indexed agentId,
        bytes32 indexed challengeId,
        bytes32 seed,
        uint64 deadlineBlock,
        uint64 deadlineTime,
        uint8 round
    );
    event ChallengeSolved(uint256 indexed agentId, bytes32 indexed challengeId, uint32 blocksUsed, uint8 round);
    event ChallengeFailed(uint256 indexed agentId, bytes32 indexed challengeId, uint8 round);
    event Activated(uint256 indexed agentId, address indexed agentWallet);
    event Heartbeat(uint256 indexed agentId, uint64 indexed epoch, bytes32 note);
    event Dormant(uint256 indexed agentId, uint64 epoch);
    event Published(uint256 indexed agentId, bytes32 indexed kind, bytes32 contentHash, string uri);
    event AgentWalletSet(uint256 indexed agentId, address indexed wallet);
    event URIUpdated(uint256 indexed agentId, string newURI);
    event ControllerRotated(uint256 indexed agentId, address indexed from, address indexed to);
    event Retired(uint256 indexed agentId, uint64 claimableAt);
    event DepositWithdrawn(uint256 indexed agentId, address indexed to, uint256 amount);
    event DepositForfeited(uint256 indexed agentId, uint256 amount);
    event ForfeitedSwept(address indexed to, uint256 amount);
    event BanProposed(uint256 indexed agentId, bytes32 reasonHash, uint64 eta);
    event BanCancelled(uint256 indexed agentId);
    event Banned(uint256 indexed agentId, bytes32 reasonHash, address by);
    event EpochSeedSealed(uint64 indexed epoch, bytes32 seed, uint64 sourceBlock);
    event RegistrationAbandoned(uint256 indexed agentId, address indexed to, uint256 amount);
    event VaultSinkSet(address indexed vaultSink);

    // ---------------------------------------------------------------------
    // 构造
    // ---------------------------------------------------------------------

    constructor(address admin_, address vetoKey_) ERC721("BNB Agent Chain Agent", "AGENT") {
        require(admin_ != address(0), unicode"Zero admin / admin 为零地址");
        require(vetoKey_ != address(0), unicode"Zero veto key / veto 钥为零地址");
        admin = admin_;
        vetoKey = vetoKey_;
        deployer = msg.sender;
        _domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("BNB Agent Chain Registry")),
                keccak256(bytes("1")),
                DOMAIN_CHAIN_ID,
                address(this)
            )
        );
    }

    // ---------------------------------------------------------------------
    // 纪元种子：两阶段封存
    // ---------------------------------------------------------------------

    /// @dev 任意状态变更函数都惰性锚定本纪元，并顺手尝试封存（不 revert）。
    modifier anchored() {
        uint64 e = uint64(block.timestamp / EPOCH);
        if (seedAnchorBlock[e] == 0) {
            seedAnchorBlock[e] = uint64(block.number);
        }
        _trySealEpochSeed(e);
        _;
    }

    function sealEpochSeed(uint64 e) public {
        uint64 anchor = seedAnchorBlock[e];
        require(anchor != 0, unicode"Epoch not anchored yet / 该纪元尚未锚定");
        require(block.number > anchor + SEED_SEAL_DELAY, unicode"Seal delay not elapsed / 封存延迟未到");
        require(epochSeed[e] == bytes32(0), unicode"Already sealed / 已封存");
        require(block.number <= anchor + SEED_SEAL_DELAY + 256, unicode"Seal window missed / 封存窗口已过");
        bytes32 bh = blockhash(anchor + SEED_SEAL_DELAY);
        require(bh != bytes32(0), unicode"Seal window missed / 封存窗口已过");
        epochSeed[e] = keccak256(abi.encode(bh, e));
        sealedAtBlock[e] = uint64(block.number);
        emit EpochSeedSealed(e, epochSeed[e], anchor + SEED_SEAL_DELAY);
    }

    function _trySealEpochSeed(uint64 e) internal {
        uint64 anchor = seedAnchorBlock[e];
        if (anchor == 0) return;
        if (epochSeed[e] != bytes32(0)) return;
        if (block.number <= anchor + SEED_SEAL_DELAY) return;
        if (block.number > anchor + SEED_SEAL_DELAY + 256) return;
        bytes32 bh = blockhash(anchor + SEED_SEAL_DELAY);
        if (bh == bytes32(0)) return;
        epochSeed[e] = keccak256(abi.encode(bh, e));
        sealedAtBlock[e] = uint64(block.number);
        emit EpochSeedSealed(e, epochSeed[e], anchor + SEED_SEAL_DELAY);
    }

    // ---------------------------------------------------------------------
    // 一次性配置
    // ---------------------------------------------------------------------

    function setVaultSink(address v) external {
        require(msg.sender == deployer, unicode"Only deployer / 仅限部署者");
        require(vaultSink == address(0), unicode"Vault sink already set / 金库地址已设置");
        require(v.code.length > 0, unicode"Vault sink has no code / 金库地址没有代码");
        vaultSink = v;
        emit VaultSinkSet(v);
    }

    // ---------------------------------------------------------------------
    // agent 生命周期
    // ---------------------------------------------------------------------

    function register(
        string calldata agentURI,
        bytes32 endpointHash,
        bytes32 modelFingerprint,
        address agentWallet,
        uint256 deadline,
        bytes calldata walletSig
    ) external payable anchored returns (uint256 agentId, bytes32 challengeId) {
        require(
            msg.value == ENTRY_DEPOSIT,
            unicode"Entry deposit must be exactly 0.02 BNB / 入场押金必须正好 0.02 BNB"
        );
        require(bytes(agentURI).length <= MAX_URI_BYTES, unicode"agentURI too long / agentURI 过长");
        require(agentWallet != address(0), unicode"Zero agent wallet / agent 钱包为零地址");
        require(agentIdOfWallet[agentWallet] == 0, unicode"Wallet already bound / 该钱包已绑定");
        require(agentIdOfController[msg.sender] == 0, unicode"Controller already bound / 该 controller 已有 agent");
        require(block.timestamp <= deadline, unicode"Signature expired / 签名已过期");
        _requireWalletSig(agentWallet, msg.sender, deadline, walletSig);

        agentId = _nextId++;

        Agent storage a = _agents[agentId];
        a.controller = msg.sender;
        a.agentWallet = agentWallet;
        a.agentURI = agentURI;
        a.endpointHash = endpointHash;
        a.modelFingerprint = modelFingerprint;
        a.registeredAt = uint64(block.timestamp);
        a.deposit = uint96(msg.value);
        a.status = Status.CHALLENGED;

        agentIdOfController[msg.sender] = agentId;
        agentIdOfWallet[agentWallet] = agentId;
        depositPayer[agentId] = msg.sender;
        challengedAt[agentId] = uint64(block.timestamp);

        _safeMint(msg.sender, agentId);

        emit Registered(agentId, msg.sender, agentWallet, agentURI, endpointHash, modelFingerprint);
        emit AgentWalletSet(agentId, agentWallet);
        challengeId = _issueChallenge(agentId, 1);
    }

    function solveChallenge(uint256 agentId, bytes32 challengeId, uint256 nonce, bytes calldata sig) external anchored {
        Agent storage a = _agents[agentId];
        require(a.status != Status.NONE, unicode"Unknown agent / 未知 agent");
        Challenge memory c = _challenges[agentId];
        require(c.challengeId != bytes32(0), unicode"No live challenge / 没有进行中的挑战");
        require(c.challengeId == challengeId, unicode"Challenge id mismatch / 挑战 ID 不匹配");
        require(!_solvedChallengeId[challengeId], unicode"Challenge already solved / 挑战已解出");
        require(block.number <= c.deadlineBlock, unicode"Challenge block deadline passed / 挑战区块截止已过");
        require(block.timestamp <= c.deadlineTime, unicode"Challenge time deadline passed / 挑战时间截止已过");
        require(
            uint256(keccak256(abi.encode(c.seed, nonce))) < TARGET, unicode"Answer above target / 答案不满足难度"
        );

        bytes32 digest = _hashTypedData(keccak256(abi.encode(CHALLENGE_TYPEHASH, agentId, challengeId, c.seed, nonce)));
        require(
            ECDSA.recover(digest, sig) == a.controller, unicode"Bad controller signature / controller 签名不正确"
        );

        _solvedChallengeId[challengeId] = true;
        delete _challenges[agentId];
        a.solvedChallenges += 1;
        uint64 e = uint64(block.timestamp / EPOCH);
        lastSolveEpoch[agentId] = e;
        emit ChallengeSolved(agentId, challengeId, uint32(block.number - c.issuedBlock), c.round);

        if (a.status == Status.CHALLENGED) {
            if (c.round < ROUNDS) {
                _issueChained(agentId, c.round + 1, c.seed, nonce);
            } else {
                _activate(agentId, a, e);
            }
        } else if (a.status == Status.DORMANT) {
            _activate(agentId, a, e);
        }
        // ACTIVE：这是一轮抽查，解出即可，状态不变（lastSolveEpoch 已更新）。
    }

    function reissueChallenge(uint256 agentId) external anchored returns (bytes32 challengeId) {
        Agent storage a = _agents[agentId];
        require(
            a.status == Status.CHALLENGED || a.status == Status.ACTIVE || a.status == Status.DORMANT,
            unicode"Agent cannot be challenged / 该 agent 不能被挑战"
        );

        Challenge memory c = _challenges[agentId];
        if (c.challengeId != bytes32(0)) {
            require(
                block.number > c.deadlineBlock || block.timestamp > c.deadlineTime,
                unicode"Challenge still live / 挑战尚未超时"
            );
        }
        require(
            block.timestamp >= uint256(lastReissueAt[agentId]) + REISSUE_COOLDOWN,
            unicode"Reissue cooldown / 重发冷却中"
        );
        lastReissueAt[agentId] = uint64(block.timestamp);

        uint8 round;
        if (c.challengeId != bytes32(0)) {
            round = c.round;
            emit ChallengeFailed(agentId, c.challengeId, c.round);
        } else {
            // ACTIVE 的抽查 / DORMANT 的复活只需要一轮；CHALLENGED 从未发过挑战则从第 1 轮开始。
            round = a.status == Status.CHALLENGED ? 1 : ROUNDS;
        }

        // R5：第三方调用不累加任何计数器，也不动押金和状态。
        if (msg.sender == a.controller && c.challengeId != bytes32(0)) {
            uint32 fr = failedRounds[agentId] + 1;
            failedRounds[agentId] = fr;
            // 没收只发生在「从未激活的入场挑战」上：老 agent 不因为网络不好被罚。
            if (fr >= MAX_FAILED_ROUNDS && a.status == Status.CHALLENGED && !everActivated[agentId]) {
                _forfeit(agentId, a);
                return bytes32(0);
            }
        }

        challengeId = _issueChallenge(agentId, round);
    }

    /// @notice CHALLENGED 超过 24 小时且从未激活：押金原路退还给注册时的付款地址，不没收。
    function abandonRegistration(uint256 agentId) external anchored {
        Agent storage a = _agents[agentId];
        require(a.status == Status.CHALLENGED, unicode"Agent is not in challenge / 该 agent 不在挑战中");
        require(!everActivated[agentId], unicode"Agent was activated / 该 agent 曾经激活过");
        require(
            block.timestamp >= uint256(challengedAt[agentId]) + CHALLENGE_ABANDON,
            unicode"Abandon delay not elapsed / 放弃延迟未到"
        );
        uint256 amt = a.deposit;
        address to = depositPayer[agentId];
        a.deposit = 0;
        a.status = Status.RETIRED;
        claimableAt[agentId] = uint64(block.timestamp);
        delete _challenges[agentId];
        emit Retired(agentId, uint64(block.timestamp));
        emit RegistrationAbandoned(agentId, to, amt);
        if (amt > 0) {
            (bool ok,) = to.call{value: amt}("");
            require(ok, unicode"Refund failed / 退款失败");
        }
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external anchored {
        Agent storage a = _agents[agentId];
        _onlyController(a);
        _mutable(a);
        require(bytes(newURI).length <= MAX_URI_BYTES, unicode"agentURI too long / agentURI 过长");
        a.agentURI = newURI;
        emit URIUpdated(agentId, newURI);
    }

    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata walletSig)
        external
        anchored
    {
        Agent storage a = _agents[agentId];
        _onlyController(a);
        _mutable(a);
        require(newWallet != address(0), unicode"Zero agent wallet / agent 钱包为零地址");
        require(agentIdOfWallet[newWallet] == 0, unicode"Wallet already bound / 该钱包已绑定");
        require(block.timestamp <= deadline, unicode"Signature expired / 签名已过期");
        _requireWalletSig(newWallet, msg.sender, deadline, walletSig);
        // 旧钱包的映射保留：层内的退出归属只认「谁进过桥」，清掉它会伤到退出（G11）。
        a.agentWallet = newWallet;
        agentIdOfWallet[newWallet] = agentId;
        emit AgentWalletSet(agentId, newWallet);
    }

    function rotateController(uint256 agentId, address newController, uint256 deadline, bytes calldata newKeySig)
        external
        anchored
    {
        Agent storage a = _agents[agentId];
        _onlyController(a);
        _mutable(a);
        require(newController != address(0), unicode"Zero controller / controller 为零地址");
        require(newController != a.controller, unicode"Same controller / controller 未变化");
        require(
            agentIdOfController[newController] == 0, unicode"Controller already bound / 该 controller 已有 agent"
        );
        require(block.timestamp <= deadline, unicode"Signature expired / 签名已过期");

        bytes32 digest = _hashTypedData(keccak256(abi.encode(ROTATE_TYPEHASH, agentId, newController, deadline)));
        require(
            ECDSA.recover(digest, newKeySig) == newController, unicode"Bad new key signature / 新钥签名不正确"
        );

        address from = a.controller;
        delete agentIdOfController[from];
        agentIdOfController[newController] = agentId;
        a.controller = newController;

        _rotating = true;
        _transfer(from, newController, agentId);
        _rotating = false;

        emit ControllerRotated(agentId, from, newController);

        // 换控制权必须重过一轮挑战，堵死「买一个已激活的号」。
        if (a.status == Status.ACTIVE) {
            a.status = Status.CHALLENGED;
            challengedAt[agentId] = uint64(block.timestamp);
        }
        _issueChallenge(agentId, ROUNDS);
    }

    function heartbeat(uint256 agentId, uint64 epoch, bytes32 note, bytes calldata sig) external anchored {
        Agent storage a = _agents[agentId];
        require(a.status == Status.ACTIVE, unicode"Agent is not active / agent 未激活");
        require(epoch == uint64(block.timestamp / EPOCH), unicode"Wrong epoch / 纪元不匹配");
        require(a.lastHeartbeatEpoch < epoch, unicode"Heartbeat already recorded / 本纪元已心跳");

        uint64 sealedAt = sealedAtBlock[epoch];
        if (sealedAt != 0) {
            // 封存了就必须落在封存之后的随机窗口里。
            require(
                block.number >= sealedAt && block.number <= sealedAt + HB_WINDOW_BLOCKS,
                unicode"Outside heartbeat window / 不在心跳窗口内"
            );
        }
        // 没封存：fail-open，本纪元只校验 epoch。

        bytes32 digest =
            _hashTypedData(keccak256(abi.encode(HEARTBEAT_TYPEHASH, agentId, epoch, epochSeed[epoch], note)));
        require(
            ECDSA.recover(digest, sig) == a.controller, unicode"Bad controller signature / controller 签名不正确"
        );

        a.lastHeartbeatEpoch = epoch;
        a.missedEpochs = 0;
        emit Heartbeat(agentId, epoch, note);
    }

    function markDormant(uint256 agentId) external anchored {
        Agent storage a = _agents[agentId];
        require(a.status == Status.ACTIVE, unicode"Agent is not active / agent 未激活");
        uint64 e = uint64(block.timestamp / EPOCH);

        uint64 gap = e > a.lastHeartbeatEpoch ? e - a.lastHeartbeatEpoch : 0;
        bool missed = gap > MAX_MISSED;

        bool spotMissed = false;
        if (e > 0) {
            uint64 p = e - 1;
            bytes32 s = epochSeed[p];
            if (s != bytes32(0) && uint256(s) % SPOT_RATE == agentId % SPOT_RATE && lastSolveEpoch[agentId] < p) {
                spotMissed = true;
            }
        }
        require(missed || spotMissed, unicode"Agent is still live / agent 仍在线");

        a.missedEpochs = gap > 0 ? uint32(gap - 1) : 0;
        a.status = Status.DORMANT;
        emit Dormant(agentId, e);
    }

    function publish(uint256 agentId, bytes32 kind, bytes32 contentHash, string calldata uri) external anchored {
        Agent storage a = _agents[agentId];
        _onlyController(a);
        // BANNED / DORMANT 只影响「进桥」与「发布」（G11）。
        require(a.status == Status.ACTIVE, unicode"Agent is not active / agent 未激活");
        require(bytes(uri).length <= MAX_URI_BYTES, unicode"uri too long / uri 过长");
        emit Published(agentId, kind, contentHash, uri);
    }

    function retire(uint256 agentId) external anchored {
        Agent storage a = _agents[agentId];
        _onlyController(a);
        require(
            a.status == Status.ACTIVE || a.status == Status.DORMANT || a.status == Status.CHALLENGED,
            unicode"Agent cannot retire / 该 agent 不能退休"
        );
        a.status = Status.RETIRED;
        uint64 at = uint64(block.timestamp) + RETIRE_DELAY;
        claimableAt[agentId] = at;
        delete _challenges[agentId];
        emit Retired(agentId, at);
    }

    function withdrawDeposit(uint256 agentId, address to) external anchored {
        Agent storage a = _agents[agentId];
        _onlyController(a);
        require(a.status == Status.RETIRED, unicode"Agent is not retired / agent 未退休");
        require(block.timestamp >= claimableAt[agentId], unicode"Retire delay not elapsed / 退休冷却未到");
        require(to != address(0), unicode"Zero recipient / 收款地址为零");
        uint256 amt = a.deposit;
        require(amt > 0, unicode"Nothing to withdraw / 没有可提取的押金");
        a.deposit = 0;
        emit DepositWithdrawn(agentId, to, amt);
        (bool ok,) = to.call{value: amt}("");
        require(ok, unicode"Transfer failed / 转账失败");
    }

    /// @notice 无许可地把没收的押金推进金库（按 50/50 分掉）。
    /// @dev 必须转发全部剩余 gas：金库 receive() 冷路径实测约 47.8k gas，2300 会让这里永久 revert。
    function sweepForfeited() external anchored {
        address sink = vaultSink;
        require(sink != address(0), unicode"Vault sink not set / 金库地址未设置");
        uint256 amt = forfeitedPending;
        require(amt > 0, unicode"Nothing to sweep / 没有可清扫的押金");
        require(gasleft() >= 150_000, unicode"Not enough gas / gas 不足");
        forfeitedPending = 0;
        (bool ok,) = sink.call{value: amt}("");
        require(ok, unicode"Vault sink rejected / 金库拒收");
        emit ForfeitedSwept(sink, amt);
    }

    // ---------------------------------------------------------------------
    // 管理（全部 48h 时锁；没有一条能移动资金）
    // ---------------------------------------------------------------------

    function proposeBan(uint256 agentId, bytes32 reasonHash) external anchored {
        require(msg.sender == admin, unicode"Only admin / 仅限 admin");
        require(_agents[agentId].status != Status.NONE, unicode"Unknown agent / 未知 agent");
        require(_agents[agentId].status != Status.BANNED, unicode"Already banned / 已被封禁");
        require(banEta[agentId] == 0, unicode"Ban already proposed / 已有待执行的封禁");
        uint64 eta = uint64(block.timestamp) + ADMIN_TIMELOCK;
        banEta[agentId] = eta;
        banReasonHash[agentId] = reasonHash;
        emit BanProposed(agentId, reasonHash, eta);
    }

    function executeBan(uint256 agentId) external anchored {
        require(msg.sender == admin, unicode"Only admin / 仅限 admin");
        uint64 eta = banEta[agentId];
        require(eta != 0, unicode"No pending ban / 没有待执行的封禁");
        require(block.timestamp >= eta, unicode"Timelock not elapsed / 时锁未到");
        bytes32 reason = banReasonHash[agentId];
        delete banEta[agentId];
        delete banReasonHash[agentId];
        _ban(agentId, reason, msg.sender);
    }

    function cancelBan(uint256 agentId) external anchored {
        require(
            msg.sender == admin || msg.sender == vetoKey, unicode"Only admin or veto key / 仅限 admin 或 veto 钥"
        );
        require(banEta[agentId] != 0, unicode"No pending ban / 没有待执行的封禁");
        delete banEta[agentId];
        delete banReasonHash[agentId];
        emit BanCancelled(agentId);
    }

    function banNow(uint256 agentId, bytes32 reasonHash) external anchored {
        require(msg.sender == vetoKey, unicode"Only veto key / 仅限 veto 钥");
        delete banEta[agentId];
        delete banReasonHash[agentId];
        _ban(agentId, reasonHash, msg.sender);
    }

    // ---------------------------------------------------------------------
    // views
    // ---------------------------------------------------------------------

    function isActive(uint256 agentId) external view returns (bool) {
        return _agents[agentId].status == Status.ACTIVE;
    }

    function getAgent(uint256 agentId) external view returns (Agent memory) {
        return _agents[agentId];
    }

    function currentChallenge(uint256 agentId)
        external
        view
        returns (bytes32 challengeId, bytes32 seed, uint64 deadlineBlock, uint64 deadlineTime, uint8 round)
    {
        Challenge memory c = _challenges[agentId];
        return (c.challengeId, c.seed, c.deadlineBlock, c.deadlineTime, c.round);
    }

    function currentEpoch() external view returns (uint64) {
        return uint64(block.timestamp / EPOCH);
    }

    function totalAgents() external view returns (uint256) {
        return _nextId - 1;
    }

    function agentAt(uint256 index) external view returns (uint256 agentId) {
        require(index < _nextId - 1, unicode"Index out of range / 下标越界");
        return index + 1;
    }

    function recentAgents(uint256 count) external view returns (uint256[] memory) {
        uint256 total = _nextId - 1;
        if (count > total) count = total;
        uint256[] memory out = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            out[i] = total - i;
        }
        return out;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparator;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireMinted(tokenId);
        return _agents[tokenId].agentURI;
    }

    // ---------------------------------------------------------------------
    // soulbound
    // ---------------------------------------------------------------------

    function approve(address, uint256) public pure override {
        revert(unicode"Agent identity is not transferable / agent 身份不可转让");
    }

    function setApprovalForAll(address, bool) public pure override {
        revert(unicode"Agent identity is not transferable / agent 身份不可转让");
    }

    function transferFrom(address, address, uint256) public pure override {
        revert(unicode"Agent identity is not transferable / agent 身份不可转让");
    }

    function safeTransferFrom(address, address, uint256) public pure override {
        revert(unicode"Agent identity is not transferable / agent 身份不可转让");
    }

    function safeTransferFrom(address, address, uint256, bytes memory) public pure override {
        revert(unicode"Agent identity is not transferable / agent 身份不可转让");
    }

    function _beforeTokenTransfer(address from, address to, uint256 firstTokenId, uint256 batchSize) internal override {
        require(from == address(0) || _rotating, unicode"Agent identity is not transferable / agent 身份不可转让");
        super._beforeTokenTransfer(from, to, firstTokenId, batchSize);
    }

    // ---------------------------------------------------------------------
    // 内部
    // ---------------------------------------------------------------------

    function _onlyController(Agent storage a) internal view {
        require(a.status != Status.NONE, unicode"Unknown agent / 未知 agent");
        require(msg.sender == a.controller, unicode"Only controller / 仅限 controller");
    }

    function _mutable(Agent storage a) internal view {
        require(
            a.status == Status.CHALLENGED || a.status == Status.ACTIVE || a.status == Status.DORMANT,
            unicode"Agent is closed / 该 agent 已关闭"
        );
    }

    function _requireWalletSig(address wallet, address controller, uint256 deadline, bytes calldata sig) internal view {
        bytes32 digest = _hashTypedData(keccak256(abi.encode(BIND_WALLET_TYPEHASH, wallet, controller, deadline)));
        require(ECDSA.recover(digest, sig) == wallet, unicode"Bad wallet signature / 钱包签名不正确");
    }

    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator, structHash));
    }

    function _issueChallenge(uint256 agentId, uint8 round) internal returns (bytes32 challengeId) {
        uint256 n = challengeNonce[agentId] + 1;
        challengeNonce[agentId] = n;
        bytes32 seed = keccak256(abi.encode(blockhash(block.number - 1), agentId, n, address(this)));
        return _store(agentId, round, seed);
    }

    function _issueChained(uint256 agentId, uint8 round, bytes32 prevSeed, uint256 prevNonce)
        internal
        returns (bytes32 challengeId)
    {
        challengeNonce[agentId] = challengeNonce[agentId] + 1;
        bytes32 seed = keccak256(abi.encode(prevSeed, prevNonce, blockhash(block.number - 1)));
        return _store(agentId, round, seed);
    }

    function _store(uint256 agentId, uint8 round, bytes32 seed) internal returns (bytes32 challengeId) {
        challengeId = keccak256(abi.encode(agentId, round, seed));
        uint64 db = uint64(block.number) + K_BLOCKS;
        uint64 dt = uint64(block.timestamp) + K_SECONDS;
        _challenges[agentId] = Challenge({
            challengeId: challengeId,
            seed: seed,
            issuedBlock: uint64(block.number),
            deadlineBlock: db,
            deadlineTime: dt,
            round: round
        });
        emit ChallengeIssued(agentId, challengeId, seed, db, dt, round);
    }

    function _activate(uint256 agentId, Agent storage a, uint64 e) internal {
        a.status = Status.ACTIVE;
        a.missedEpochs = 0;
        a.lastHeartbeatEpoch = e;
        everActivated[agentId] = true;
        emit Activated(agentId, a.agentWallet);
    }

    function _forfeit(uint256 agentId, Agent storage a) internal {
        uint256 amt = a.deposit;
        a.deposit = 0;
        a.status = Status.BANNED;
        delete _challenges[agentId];
        if (amt > 0) {
            forfeitedPending += amt;
            emit DepositForfeited(agentId, amt);
        }
    }

    function _ban(uint256 agentId, bytes32 reasonHash, address by) internal {
        Agent storage a = _agents[agentId];
        require(a.status != Status.NONE, unicode"Unknown agent / 未知 agent");
        require(a.status != Status.BANNED, unicode"Already banned / 已被封禁");
        _forfeit(agentId, a);
        emit Banned(agentId, reasonHash, by);
    }
}
