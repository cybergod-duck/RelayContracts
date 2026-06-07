// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IUniswapV2Pair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// @title BaseRelayV3 — Sovereign Swap Relay
/// @notice Pure V2 constant-product routing. 0.01% fee to immutable treasury.
contract BaseRelayV3 is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    address public immutable TREASURY;
    uint256 public constant RELAY_FEE_BPS = 1;
    uint256 public constant BPS_DENOMINATOR = 10000;

    error InsufficientOutput();
    error InvalidPool();
    error TransferFailed();

    event Swapped(address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 fee);

    constructor(address _treasury) Ownable(msg.sender) {
        require(_treasury != address(0), "Invalid treasury");
        TREASURY = _treasury;
    }

    /// @notice Pure constant-product output: amountOut = (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = (reserveIn * 1000) + amountInWithFee;
        return numerator / denominator;
    }

    /// @notice Execute a single-hop V2 swap with real reserves
    function _tryV2Swap(address pool, uint256 amountIn, bool zeroForOne) internal returns (uint256 amountOut) {
        (uint112 r0, uint112 r1,) = IUniswapV2Pair(pool).getReserves();
        require(r0 > 0 && r1 > 0, "Pool has no liquidity");

        (uint256 reserveIn, uint256 reserveOut) = zeroForOne
            ? (uint256(r0), uint256(r1))
            : (uint256(r1), uint256(r0));

        amountOut = getAmountOut(amountIn, reserveIn, reserveOut);
        require(amountOut > 0, "Zero output");

        (uint256 a0, uint256 a1) = zeroForOne
            ? (uint256(0), amountOut)
            : (amountOut, uint256(0));

        IUniswapV2Pair(pool).swap(a0, a1, address(this), "");
    }

    /// @notice Main swap entry point — wallet calls this
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address[] calldata pools,
        uint256 deadline
    )
        external
        nonReentrant
        returns (uint256 amountOut, uint256 fee)
    {
        require(block.timestamp <= deadline, "Deadline expired");
        require(amountIn > 0, "Zero amount");
        require(pools.length > 0, "No pools");
        require(tokenIn != tokenOut, "Same token");

        // Pull tokens from user
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // Deduct protocol fee upfront
        fee = (amountIn * RELAY_FEE_BPS) / BPS_DENOMINATOR;
        uint256 swapAmount = amountIn - fee;
        if (fee > 0) IERC20(tokenIn).safeTransfer(TREASURY, fee);

        // Determine token ordering for first pool
        (address t0, address t1) = _getPoolTokens(pools[0]);
        bool zeroForOne = (tokenIn == t0);
        require(tokenIn == t0 || tokenIn == t1, "Token not in pool");

        // Send tokens to pool
        IERC20(tokenIn).safeTransfer(pools[0], swapAmount);

        // Execute V2 swap through first pool
        amountOut = _tryV2Swap(pools[0], swapAmount, zeroForOne);

        require(amountOut >= minOut, "Insufficient output");

        // Send output to user
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);

        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut, fee);
    }

    /// @notice Read pool token addresses
    function _getPoolTokens(address pool) internal view returns (address t0, address t1) {
        (bool ok, bytes memory data) = pool.staticcall(abi.encodeWithSignature("token0()"));
        require(ok && data.length == 32, "Cannot read pool");
        t0 = abi.decode(data, (address));
        (ok, data) = pool.staticcall(abi.encodeWithSignature("token1()"));
        require(ok && data.length == 32, "Cannot read pool");
        t1 = abi.decode(data, (address));
    }

    /// @notice Returns this contract's ETH balance (for capture scripts / interface compatibility)
    function getContractBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
