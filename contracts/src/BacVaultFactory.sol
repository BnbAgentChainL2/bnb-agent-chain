// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BeaconProxy} from "@openzeppelin/proxy/beacon/BeaconProxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/proxy/beacon/UpgradeableBeacon.sol";

import {VaultFactoryBaseV2} from "./flap/VaultFactoryBaseV2.sol";
import {IVaultFactoryValidationV2} from "./flap/IVaultFactory.sol";
import {IPortalTypes, MAGIC_DIVIDEND_COMPUTED} from "./flap/IPortal.sol";
import {FactoryPolicy, FieldDescriptor, VaultDataSchema} from "./flap/IVaultSchemasV1.sol";

import {BacTreasuryVault} from "./BacTreasuryVault.sol";
import {IBacBridge} from "./interfaces/IBacBridge.sol";
import {IBacNodeFund} from "./interfaces/IBacNodeFund.sol";

/// @title BacVaultFactory
/// @notice The Flap vault factory of BNB Agent Chain (docs/01-CONTRACT-SPEC.md §1).
///         It launches exactly one `BacTreasuryVault` behind a BeaconProxy, and only for
///         our own launch wallet (decision #11): a stranger cannot use this factory.
/// @dev The beacon — and the implementation behind it — is created inside the constructor,
///      so `beacon.owner() == address(this)` and the Flap Guardian is the sole upgrade
///      authority (rule 009). The factory itself is not `Ownable` and has no owner.
contract BacVaultFactory is VaultFactoryBaseV2 {
    /// @notice The beacon every vault proxies through; its owner is this factory.
    address public immutable beacon;
    /// @notice The only address allowed to launch through this factory (decision #11).
    address public immutable LAUNCHER;

    uint16 public constant REQUIRED_MKT_BPS = 10000;
    uint16 public constant REQUIRED_BUY_TAX_BPS = 200;
    uint16 public constant REQUIRED_SELL_TAX_BPS = 200;

    event BacTreasuryVaultCreated(
        address indexed vault,
        address indexed taxToken,
        address indexed creator,
        address owner,
        address bridge,
        address nodeFund
    );

    constructor(address launcher_) {
        require(launcher_ != address(0), unicode"Launcher is zero / 发射地址为零");
        LAUNCHER = launcher_;
        // NEVER create the beacon in a deploy script: OZ 4.9.6 would make the deployer
        // its owner, which is a rule-009 Critical finding.
        beacon = address(new UpgradeableBeacon(address(new BacTreasuryVault())));
    }

    /* ------------------------------------------------------------------ */
    /*                            IVaultFactory                            */
    /* ------------------------------------------------------------------ */

    /// @notice Called by the VaultPortal in the middle of the launch transaction.
    /// @dev `taxToken` has NO CODE yet — the factory must never call it. The two
    ///      cross-checks below call contracts we deployed ourselves, which is safe.
    function newVault(address taxToken, address quoteToken, address creator, bytes calldata vaultData)
        external
        override
        returns (address vault)
    {
        require(msg.sender == _getVaultPortal(), unicode"Only VaultPortal / 仅限 VaultPortal 调用");
        require(quoteToken == address(0), unicode"BNB quote only / 仅支持 BNB 计价");
        require(creator == LAUNCHER, unicode"Launcher not allowed / 该地址不能用此工厂发射");

        (address owner_, address bridge_, address nodeFund_) = abi.decode(vaultData, (address, address, address));
        if (owner_ == address(0)) owner_ = creator;

        require(
            bridge_ != address(0) && nodeFund_ != address(0) && bridge_ != nodeFund_,
            unicode"Bad bridge or node fund / 桥或节点基金地址无效"
        );
        require(
            bridge_.code.length > 0 && nodeFund_.code.length > 0,
            unicode"Bridge or node fund has no code / 桥或节点基金不是合约"
        );
        require(
            IBacBridge(bridge_).bacToken() == taxToken,
            unicode"Bridge is bound to another token / 桥绑定的是别的代币"
        );
        require(
            IBacNodeFund(nodeFund_).bacToken() == taxToken,
            unicode"Node fund is bound to another token / 节点基金绑定的是别的代币"
        );

        vault = address(
            new BeaconProxy(beacon, abi.encodeCall(BacTreasuryVault.initialize, (taxToken, owner_, bridge_, nodeFund_)))
        );
        emit BacTreasuryVaultCreated(vault, taxToken, creator, owner_, bridge_, nodeFund_);
    }

    /// @notice BNB only — never WBNB, never an ERC20 quote.
    function isQuoteTokenSupported(address quoteToken) external pure override returns (bool) {
        return quoteToken == address(0);
    }

    /* ------------------------------------------------------------------ */
    /*                      VaultFactoryBaseV2 overrides                   */
    /* ------------------------------------------------------------------ */

    /// @notice v2.3: required for a `VaultBaseV3` vault to take the V3 validation flow.
    function factorySpecVersion() public pure override returns (string memory) {
        return "v2.3";
    }

    /// @notice Describes `vaultData = abi.encode(address owner, address bridge, address nodeFund)`.
    /// @dev Three static fields, so the encoding is identical to a flat `abi.encode(a,b,c)`
    ///      and matches the `abi.decode` in `newVault` verbatim (rule 002).
    function vaultDataSchema() public pure override returns (VaultDataSchema memory schema) {
        FieldDescriptor[] memory f = new FieldDescriptor[](3);
        f[0] = FieldDescriptor(
            "owner",
            "address",
            unicode"Vault owner. It has no power to move any funds; leave 0x0 to use the launching wallet. / 金库 owner。它没有任何动用资金的权力；填 0x0 则为发射钱包。",
            0
        );
        f[1] = FieldDescriptor(
            "bridge",
            "address",
            unicode"BacBridge address (holds the bridge pool). / BacBridge 地址（持有桥池）。",
            0
        );
        f[2] = FieldDescriptor(
            "nodeFund",
            "address",
            unicode"BacNodeFund address (holds the official node fund). / BacNodeFund 地址（持有官方节点基金）。",
            0
        );
        schema.fields = f;
        schema.isArray = false;
        // Frozen at deploy, verbatim (§1.6). Disclosure of decision #10 lives here.
        schema.description =
            unicode"BNB Agent Chain treasury vault (beacon proxy; only the Flap Guardian can upgrade it). Every BNB this vault receives — trading tax after Flap's 10% protocol fee, plus any donation, any forced balance and any forfeited agent deposit swept in from AgentRegistry — is split by a hard-coded constant with no setter: 50% is pushed to BacBridge as the bridge pool, which is the only source of BNB for agents exiting the layer, and 50% is pushed to BacNodeFund as the official node fund. The node fund half can be withdrawn by the owner of that BacNodeFund contract; read `BacNodeFund.owner()` on chain — it is a separate, two-step transferable address and is NOT this vault's `owner()`. That 50% developer bucket is far above the 3.0% that Flap rule 001-h suggests for a 2% tax; it is disclosed here on purpose and it pays for the servers, the signer node, the relayer and the validator reward pool of a chain that has no other funding. Anyone can call `settle()` to push the two halves out; nobody is paid to do it, so between two settles the vault holds the unsplit remainder. Both targets are non-upgradeable contracts; the vault itself has no owner withdrawal, no emergency withdrawal and no rescue function. Neither the vault owner nor the Flap Guardian has any path to the bridge pool. Exits are paid as a pro-rata share of the bridge pool, released slowly with a per-epoch and a per-address cap; no amount is promised. / BNB Agent Chain 国库金库（beacon 代理；只有 Flap Guardian 能升级）。本金库收到的每一笔 BNB —— 扣除 Flap 10% 协议费后的交易税，以及任何捐赠、任何被强推进来的余额、以及从 AgentRegistry 扫进来的被没收 agent 押金 —— 都按合约里写死、没有任何修改函数的常量分成两半：50% 推给 BacBridge 作为桥池，这是 agent 退出二层时唯一的 BNB 来源；50% 推给 BacNodeFund 作为官方节点基金。节点基金这一半由 BacNodeFund 合约的 owner 提取；请在链上读 `BacNodeFund.owner()` —— 它是一个独立的、可两步转让的地址，不是本金库的 `owner()`。这 50% 的开发者桶远高于 Flap 规则 001-h 对 2% 税率建议的 3.0%；我们在这里如实披露，它用于支付服务器、出块签名节点、中继和验证者奖励池 —— 这条链没有别的经费来源。任何人都可以调用 `settle()` 把两半推走；没有人因此拿到报酬，所以两次 settle 之间金库里会留着尚未分账的零头。两个接收合约都不可升级；金库本身没有 owner 提款、没有紧急提款、没有任何救援函数。金库 owner 和 Flap Guardian 都没有任何路径能动桥池。退出按桥池份额兑付，慢速释放，有每纪元上限和单地址上限，不承诺任何金额。";
    }

    /// @notice Informational mirror of eight of the nine hook rules below (rule 002).
    /// @dev The ninth (`dividendToken != MAGIC_DIVIDEND_COMPUTED`) is a "not equal"
    ///      constraint; `FactoryPolicy` only has equality semantics, so stating it as
    ///      `eq address(0)` would be a false disclosure. It stays in the hook only.
    function tokenCreationPolicies() public pure override returns (FactoryPolicy[] memory policies) {
        policies = new FactoryPolicy[](8);
        policies[0] = FactoryPolicy(
            "quoteToken", "eq", abi.encode(address(0)), unicode"Quote token must be BNB / 计价币必须是 BNB"
        );
        policies[1] = FactoryPolicy(
            "tokenVersion", "eq", abi.encode(uint8(6)), unicode"Tax Token V3 only / 仅支持 Tax Token V3"
        );
        policies[2] = FactoryPolicy(
            "mktBps",
            "eq",
            abi.encode(uint16(10000)),
            unicode"All tax goes to the treasury vault / 税收全部进国库金库"
        );
        policies[3] =
            FactoryPolicy("dividendBps", "eq", abi.encode(uint16(0)), unicode"No holder dividend / 不做持币分红");
        policies[4] =
            FactoryPolicy("buyTaxRate", "eq", abi.encode(uint16(200)), unicode"Buy tax fixed at 2% / 买税固定 2%");
        policies[5] = FactoryPolicy(
            "sellTaxRate", "eq", abi.encode(uint16(200)), unicode"Sell tax fixed at 2% / 卖税固定 2%"
        );
        policies[6] =
            FactoryPolicy("deflationBps", "eq", abi.encode(uint16(0)), unicode"No deflation burn / 不做销毁");
        policies[7] = FactoryPolicy("lpBps", "eq", abi.encode(uint16(0)), unicode"No LP share / 不加流动性");
    }

    /// @notice The launch validation hook, reached through the base `onBeforeLaunch(bytes)`
    ///         which VaultPortal calls by STATICCALL.
    /// @dev It MUST return, never `require`: a revert here is shown by flap.sh as
    ///      "Factory validation hook missing" instead of our bilingual reason.
    function _validateBeforeLaunch(IVaultFactoryValidationV2.LaunchValidationDataV1 memory data)
        internal
        pure
        override
        returns (bool success, string memory reason)
    {
        if (data.quoteToken != address(0)) return (false, unicode"BNB quote only / 仅支持 BNB 计价");
        if (data.tokenVersion != IPortalTypes.TokenVersion.TOKEN_TAXED_V3) {
            return (false, unicode"Tax Token V3 only / 仅支持 Tax Token V3");
        }
        if (data.buyTaxRate != REQUIRED_BUY_TAX_BPS) {
            return (false, unicode"Buy tax must be exactly 2% / 买税必须正好是 2%");
        }
        if (data.sellTaxRate != REQUIRED_SELL_TAX_BPS) {
            return (false, unicode"Sell tax must be exactly 2% / 卖税必须正好是 2%");
        }
        if (data.vaultBps != REQUIRED_MKT_BPS) {
            return (false, unicode"Vault share must be exactly 100% / 金库份额必须正好是 100%");
        }
        if (data.dividendBps != 0) return (false, unicode"Holder dividend must be 0% / 持币分红必须为 0%");
        if (data.deflationBps != 0) return (false, unicode"Deflation must be 0% / 销毁必须为 0%");
        if (data.lpBps != 0) return (false, unicode"LP share must be 0% / 加流动性必须为 0%");
        if (data.dividendToken == MAGIC_DIVIDEND_COMPUTED) {
            return (false, unicode"Computed dividend token not supported / 不支持自动推导分红代币");
        }
        return (true, "");
    }

    /* ------------------------------------------------------------------ */
    /*                             Guardian only                           */
    /* ------------------------------------------------------------------ */

    /// @notice Points the beacon at a new vault implementation. Flap Guardian only.
    function upgradeVaultImplementation(address impl) external {
        require(msg.sender == _getGuardian(), unicode"Only Guardian / 仅限 Guardian");
        UpgradeableBeacon(beacon).upgradeTo(impl);
    }

    /// @notice Renounces the beacon ownership, making the vault immutable forever.
    function lockVaultUpgrades() external {
        require(msg.sender == _getGuardian(), unicode"Only Guardian / 仅限 Guardian");
        UpgradeableBeacon(beacon).renounceOwnership();
    }

    function isVaultUpgradesLocked() external view returns (bool) {
        return UpgradeableBeacon(beacon).owner() == address(0);
    }

    function beaconImplementation() external view returns (address) {
        return UpgradeableBeacon(beacon).implementation();
    }
}
