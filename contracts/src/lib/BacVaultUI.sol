// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Strings} from "@openzeppelin/utils/Strings.sol";

import {ApproveAction, FieldDescriptor, VaultMethodSchema, VaultUISchema} from "../flap/IVaultSchemasV1.sol";
import {IBacNodeFund} from "../interfaces/IBacNodeFund.sol";

/// @title BacVaultUI
/// @notice External linked library holding the long, deploy-frozen strings of
///         `BacTreasuryVault`: the runtime-rendered `description()` (docs/01-CONTRACT-SPEC.md §2.5)
///         and the static `vaultUISchema()` (§2.4). Kept out of the vault so the
///         implementation stays far below the 24,576-byte runtime limit.
/// @dev Deployed by CREATE2 with salt 0 from 0x4e59b44847b379578588920cA78FbF26c0B4956C:
///      its bytecode differs from the fly / rat libraries, so it cannot collide with
///      an address those projects already used.
library BacVaultUI {
    /// @notice Renders the vault status banner flap.sh polls (and VaultPortal mirrors).
    /// @param token The BAC tax token (may have no code yet very early in a launch).
    /// @param v Packed state, in this exact order:
    ///          [0] accountedQuote, [1] unsplit, [2] lifetimeToBridge, [3] lifetimeToNodeFund,
    ///          [4] stuckBridge,    [5] stuckNodeFund, [6] BRIDGE_BPS, [7] address(this).balance.
    /// @param owner The vault owner (no power to move any funds).
    /// @param bridge The BacBridge holding the bridge pool.
    /// @param nodeFund The BacNodeFund holding the official node fund.
    function describe(address token, uint256[8] memory v, address owner, address bridge, address nodeFund)
        external
        view
        returns (string memory)
    {
        return string.concat(_status(token, v), " | ", _pools(v), " | ", _rules(owner, bridge, nodeFund, v[6]));
    }

    /// @notice The on-chain UI schema: 8 input-less views plus the two permissionless
    ///         write methods flap.sh renders as bare Submit buttons. Zero approvals.
    function vaultUISchema() external pure returns (VaultUISchema memory schema) {
        schema.vaultType = "BacTreasuryVault";
        schema.description =
            unicode"Treasury of BNB Agent Chain. Every BNB that arrives (trading tax after Flap's protocol fee, donations, forfeited agent deposits) is split 50/50 into the bridge pool and the official node fund. Anyone can press Settle to push the two halves out; nobody is paid to do it, so the vault holds the unsplit remainder between settles. The two buttons below are the only write methods and neither of them takes an address: they cannot send BNB anywhere except the two contracts fixed at deployment. There is no human-facing interface to the layer itself. / BNB Agent Chain 的国库。到账的每一笔 BNB（扣除 Flap 协议费后的交易税、捐赠、被没收的 agent 押金）按 50/50 分成桥池和官方节点基金。任何人都可以按 Settle 把两半推走；没有人因此拿到报酬，所以两次 settle 之间金库里留着尚未分账的零头。下面两个按钮是仅有的写方法，且都不接受任何地址参数：它们只能把钱推给部署时就写死的那两个合约。二层本身没有给人用的界面。";
        schema.methods = new VaultMethodSchema[](10);

        _view(
            schema.methods[0],
            "taxToken",
            unicode"The BAC token this vault serves. / 本金库服务的 BAC 代币地址。",
            _one("taxToken", "address", unicode"BAC token address / BAC 代币地址", 0)
        );
        _view(
            schema.methods[1],
            "bridge",
            unicode"Bridge pool contract (non-upgradeable). / 桥池合约（不可升级）。",
            _one("bridge", "address", unicode"BacBridge address / BacBridge 地址", 0)
        );
        _view(
            schema.methods[2],
            "nodeFund",
            unicode"Official node fund contract (non-upgradeable). / 官方节点基金合约（不可升级）。",
            _one("nodeFund", "address", unicode"BacNodeFund address / BacNodeFund 地址", 0)
        );
        _view(
            schema.methods[3],
            "owner",
            unicode"Vault owner, with no power to move any funds; the node fund withdrawer is BacNodeFund.owner(), a different address. / 金库 owner，没有任何动用资金的权力；节点基金的提取人请读 BacNodeFund.owner()，那是另一个地址。",
            _one("owner", "address", unicode"Vault owner / 金库 owner", 0)
        );
        _view(
            schema.methods[4],
            "accountedQuote",
            unicode"Recognized BNB not yet pushed out. / 已确认但尚未推走的 BNB。",
            _one("accountedQuote", "uint256", unicode"Recognized BNB / 已记账的 BNB", 18)
        );
        _view(
            schema.methods[5],
            "lifetimeToBridge",
            unicode"Lifetime BNB pushed to the bridge pool. / 累计推给桥池的 BNB。",
            _one("lifetimeToBridge", "uint256", unicode"Lifetime to bridge pool / 累计推给桥池", 18)
        );
        _view(
            schema.methods[6],
            "lifetimeToNodeFund",
            unicode"Lifetime BNB pushed to the node fund. / 累计推给节点基金的 BNB。",
            _one("lifetimeToNodeFund", "uint256", unicode"Lifetime to node fund / 累计推给节点基金", 18)
        );

        FieldDescriptor[] memory sol = new FieldDescriptor[](3);
        sol[0] = FieldDescriptor("balance", "uint256", unicode"Vault BNB balance / 金库 BNB 余额", 18);
        sol[1] = FieldDescriptor("accounted", "uint256", unicode"Recognized BNB / 已记账的 BNB", 18);
        sol[2] = FieldDescriptor("buckets", "uint256", unicode"Sum of the buckets / 各桶之和", 18);
        _view(
            schema.methods[7],
            "solvency",
            unicode"Balance, accounted and bucket sum; the three must agree. / 余额、已记账、桶之和，三者必须自洽。",
            sol
        );

        _write(
            schema.methods[8],
            "settle",
            unicode"Push the unsplit revenue out 50/50 to the bridge pool and the node fund. Permissionless, no parameters, the caller is paid nothing. / 把未分账的收入按 50/50 推给桥池与节点基金。无许可，无参数，谁调都一样，调用者不拿一分钱。"
        );
        _write(
            schema.methods[9],
            "retryPush",
            unicode"Retry amounts whose earlier push failed (stuckBridge / stuckNodeFund). Permissionless, no parameters. / 重试之前推送失败的金额（stuckBridge / stuckNodeFund）。无许可，无参数。"
        );
    }

    /* ------------------------------------------------------------------ */
    /*                          schema helpers                            */
    /* ------------------------------------------------------------------ */

    function _one(string memory name, string memory fieldType, string memory description, uint8 decimals)
        private
        pure
        returns (FieldDescriptor[] memory out)
    {
        out = new FieldDescriptor[](1);
        out[0] = FieldDescriptor(name, fieldType, description, decimals);
    }

    function _view(
        VaultMethodSchema memory m,
        string memory name,
        string memory description,
        FieldDescriptor[] memory outputs
    ) private pure {
        m.name = name;
        m.description = description;
        m.inputs = new FieldDescriptor[](0);
        m.outputs = outputs;
        m.approvals = new ApproveAction[](0);
    }

    function _write(VaultMethodSchema memory m, string memory name, string memory description) private pure {
        m.name = name;
        m.description = description;
        m.inputs = new FieldDescriptor[](0);
        m.outputs = new FieldDescriptor[](0);
        m.approvals = new ApproveAction[](0);
        m.isWriteMethod = true;
    }

    /* ------------------------------------------------------------------ */
    /*                        description() sections                      */
    /* ------------------------------------------------------------------ */

    function _status(address token, uint256[8] memory v) private view returns (string memory) {
        string memory sym = unicode"(unreadable / 读取失败)";
        if (token.code.length != 0) {
            try IERC20Symbol(token).symbol() returns (string memory s) {
                if (bytes(s).length != 0) sym = s;
            } catch {}
        }
        return string.concat(
            "BNB Agent Chain treasury vault for ",
            sym,
            ": balance ",
            _fmtBNB(v[7]),
            " BNB, recognized ",
            _fmtBNB(v[0]),
            " BNB, awaiting settle ",
            _fmtBNB(v[1]),
            unicode" BNB. / BNB Agent Chain 国库金库（",
            sym,
            unicode"）：余额 ",
            _fmtBNB(v[7]),
            unicode" BNB，已记账 ",
            _fmtBNB(v[0]),
            unicode" BNB，待分账 ",
            _fmtBNB(v[1]),
            unicode" BNB。"
        );
    }

    function _pools(uint256[8] memory v) private pure returns (string memory) {
        return string.concat(
            "Pushed so far: ",
            _fmtBNB(v[2]),
            " BNB to the bridge pool, ",
            _fmtBNB(v[3]),
            " BNB to the node fund; push failed and awaiting retryPush: ",
            _fmtBNB(v[4]),
            " / ",
            _fmtBNB(v[5]),
            " BNB; split ",
            _fmtPct(v[6]),
            "% / ",
            _fmtPct(10000 - v[6]),
            unicode"%. / 已推出：桥池 ",
            _fmtBNB(v[2]),
            unicode" BNB，节点基金 ",
            _fmtBNB(v[3]),
            unicode" BNB；推送失败待重试：",
            _fmtBNB(v[4]),
            " / ",
            _fmtBNB(v[5]),
            unicode" BNB；分账比例 ",
            _fmtPct(v[6]),
            "% / ",
            _fmtPct(10000 - v[6]),
            unicode"%。"
        );
    }

    /// @dev Deploy-frozen. Must stay semantically identical to
    ///      `BacVaultFactory.vaultDataSchema().description` and to the first line of the
    ///      website footer (decision #10). The node fund withdrawer is read from the live
    ///      `BacNodeFund.owner()` and NEVER falls back to this vault's owner.
    function _rules(address owner, address bridge, address nodeFund, uint256 bridgeBps)
        private
        view
        returns (string memory)
    {
        address nfOwner;
        if (nodeFund.code.length != 0) {
            try IBacNodeFund(nodeFund).owner() returns (address o) {
                nfOwner = o;
            } catch {}
        }
        string memory nfOwnerStr =
            nfOwner == address(0) ? unicode"(unreadable / 读取失败)" : Strings.toHexString(nfOwner);
        string memory nodeBps = _fmtPct(10000 - bridgeBps);

        return string.concat(
            "Income split after Flap's 10% protocol fee (and the same split applies to donations, forced balances and forfeited agent deposits): ",
            _fmtPct(bridgeBps),
            "% bridge pool (BacBridge `",
            Strings.toHexString(bridge),
            "`, agent exits only) / ",
            nodeBps,
            "% official node fund (BacNodeFund `",
            Strings.toHexString(nodeFund),
            "`, withdrawable by that contract's owner `",
            nfOwnerStr,
            unicode"` — a separate, transferable address, not this vault's owner `",
            Strings.toHexString(owner),
            "`, which has no power over any funds). Anyone can call settle() to push the two halves out; nobody is paid to do it. The vault has no owner withdrawal, no emergency withdrawal and no rescue function. Upgrades only by the Flap Guardian. The ",
            nodeBps,
            "% node fund bucket is far above the ~3.0% Flap rule 001-h suggests for a 2% tax; it funds the servers, the signer node, the relayer and the validator reward pool. Exits are a pro-rata share of the bridge pool with per-epoch and per-address caps, and a single address can take at most 10% of one epoch's release. No promised return. / ",
            _rulesCN(owner, bridge, nodeFund, nfOwnerStr, _fmtPct(bridgeBps), nodeBps)
        );
    }

    function _rulesCN(
        address owner,
        address bridge,
        address nodeFund,
        string memory nfOwnerStr,
        string memory bridgePct,
        string memory nodePct
    ) private pure returns (string memory) {
        return string.concat(
            unicode"扣除 Flap 10% 协议费后的分账（捐赠、被强推的余额、被没收的 agent 押金同样按这个比例分）：",
            bridgePct,
            unicode"% 桥池（BacBridge `",
            Strings.toHexString(bridge),
            unicode"`，只用于 agent 退出）/ ",
            nodePct,
            unicode"% 官方节点基金（BacNodeFund `",
            Strings.toHexString(nodeFund),
            unicode"`，由该合约的 owner `",
            nfOwnerStr,
            unicode"` 提取 —— 这是一个独立的、可转让的地址，不是本金库的 owner `",
            Strings.toHexString(owner),
            unicode"`，后者对任何资金都没有权力）。任何人都可以调用 settle() 把两半推走，没有人因此拿到报酬。金库没有 owner 提款、没有紧急提款、也没有任何救援函数。仅 Flap Guardian 可升级。节点基金这 ",
            nodePct,
            unicode"% 的桶远高于 Flap 规则 001-h 对 2% 税率建议的约 3.0%，它用于支付服务器、出块签名节点、中继和验证者奖励池。退出按桥池份额兑付，有每纪元与单地址上限，单个地址在一个纪元里最多拿走该纪元释放额的 10%。不承诺任何收益。"
        );
    }

    /* ------------------------------------------------------------------ */
    /*                           formatting                               */
    /* ------------------------------------------------------------------ */

    /// @dev `wei` → decimal BNB with exactly 4 decimals, e.g. 1500000000000000 → "0.0015".
    function _fmtBNB(uint256 weiAmount) private pure returns (string memory) {
        uint256 whole = weiAmount / 1e18;
        uint256 frac = (weiAmount % 1e18) / 1e14; // 4 decimals
        bytes memory f = bytes(Strings.toString(frac));
        bytes memory pad = new bytes(4 - f.length);
        for (uint256 i; i < pad.length; ++i) {
            pad[i] = "0";
        }
        return string.concat(Strings.toString(whole), ".", string(pad), string(f));
    }

    /// @dev basis points → percent, e.g. 5000 → "50", 1234 → "12.34".
    function _fmtPct(uint256 bps) private pure returns (string memory) {
        uint256 whole = bps / 100;
        uint256 frac = bps % 100;
        if (frac == 0) return Strings.toString(whole);
        bytes memory f = bytes(Strings.toString(frac));
        string memory pad = f.length == 1 ? "0" : "";
        return string.concat(Strings.toString(whole), ".", pad, string(f));
    }
}

/// @dev Local, deliberately tiny ERC20 view: the vault must never pull a full ERC20
///      interface (and must never call the tax token outside a code-length guard).
interface IERC20Symbol {
    function symbol() external view returns (string memory);
}
