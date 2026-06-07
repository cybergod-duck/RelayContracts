// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title UniswapV3Relay — Sovereign Swap Router for Uniswap V3
/// @notice Routes trades through Uniswap V3 pools. Takes a 0.01% routing fee sent directly to the treasury wallet.
contract UniswapV3Relay is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    address public TREASURY;
    address public immutable swapRouter;

    uint256 public constant RELAY_FEE_BPS = 1;
    uint256 public constant BPS_DENOMINATOR = 10000;

    event Swapped(address indexed user, address tokenIn, address tokenOut, uint24 feeTier, uint256 amountIn, uint256 amountOut, uint256 fee);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    constructor(address _treasury, address _swapRouter) Ownable(msg.sender) {
        require(_treasury != address(0), "Invalid treasury");
        require(_swapRouter != address(0), "Invalid swap router");
        TREASURY = _treasury;
        swapRouter = _swapRouter;
        emit TreasuryUpdated(address(0), _treasury);
    }

    /// @notice Update the fee collection treasury address
    function updateTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "Invalid treasury");
        address oldTreasury = TREASURY;
        TREASURY = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    /// @notice Withdraw any native ETH residing in the contract directly to the treasury
    function withdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH to withdraw");
        (bool success, ) = TREASURY.call{value: balance}("");
        require(success, "ETH transfer failed");
    }

    /// @notice Withdraw any ERC20 tokens trapped in the contract to the treasury
    function withdrawToken(address token) external onlyOwner {
        require(token != address(0), "Invalid token");
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "No token to withdraw");
        IERC20(token).safeTransfer(TREASURY, balance);
    }

    /// @notice Swap tokenIn for tokenOut on Uniswap V3, taking a 0.01% fee for the treasury
    function swap(
        address tokenIn,
        address tokenOut,
        uint24 feeTier,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline
    ) external nonReentrant returns (uint256 amountOut, uint256 fee) {
        require(block.timestamp <= deadline, "Deadline expired");
        require(amountIn > 0, "Zero amount");
        require(tokenIn != tokenOut, "Same token");

        // Pull tokens from user
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // Deduct protocol fee (0.01% / 1 bps)
        fee = (amountIn * RELAY_FEE_BPS) / BPS_DENOMINATOR;
        uint256 swapAmount = amountIn - fee;

        if (fee > 0) {
            IERC20(tokenIn).safeTransfer(TREASURY, fee);
        }

        // Approve SwapRouter (USDT compatible: clear then set)
        IERC20(tokenIn).approve(swapRouter, 0);
        IERC20(tokenIn).approve(swapRouter, swapAmount);

        // Execute Uniswap V3 Swap
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: feeTier,
            recipient: msg.sender,
            deadline: deadline,
            amountIn: swapAmount,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0
        });

        amountOut = ISwapRouter(swapRouter).exactInputSingle(params);

        emit Swapped(msg.sender, tokenIn, tokenOut, feeTier, amountIn, amountOut, fee);
    }
}
