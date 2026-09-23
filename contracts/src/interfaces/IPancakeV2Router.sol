// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IPancakeV2Router
/// @notice The two PancakeSwap V2 router methods `BacBridge` needs after BAC graduates
///         (docs/research/01-flap-spec.md §5: a TAX token must use a V2 migrator, so the
///         graduated pool is always a Uniswap-V2-shaped pair).
///         `...SupportingFeeOnTransferTokens` is mandatory: BAC charges a buy tax, so the
///         amount that lands in the bridge is smaller than the amount the pair sends out and
///         the plain `swapExactETHForTokens` would revert on its own output check.
interface IPancakeV2Router {
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;
}
