// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title BotCompatibilityProxy
 * @notice Standard-interface wrapper around BaseRelay for bot discoverability
 * @dev Exposes Uniswap V2-compatible function signatures, public quotes, and standard events.
 *      Wraps: BaseRelayV4
 *
 *      FUNCTION SELECTORS (4byte):
 *      - swapExactTokensForTokens: 0x38ed1739
 *      - getAmountsOut:           0xd06ca61f
 *      - WETH:                    0xad5c4648
 *      - factory:                 0xc45a0155
 *      - relayAddress:            0xed39b1e8
 */

interface IBaseRelay {
    function swap(address,address,uint256,uint256,address[] calldata,uint256) external returns (uint256,uint256);
    function RELAY_FEE_BPS() external view returns (uint256);
    function TREASURY() external view returns (address);
}

interface IUniswapV2Pair {
    function getReserves() external view returns (uint112,uint112,uint32);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IERC20 {
    function approve(address,uint256) external returns (bool);
    function transfer(address,uint256) external returns (bool);
}

contract BotCompatibilityProxy is Ownable {
    IBaseRelay public RELAY;
    address public immutable WETH;
    address public immutable FACTORY;

    event Swap(address indexed sender, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address to);
    event RelayUpdated(address indexed oldRelay, address indexed newRelay);

    error InsufficientOutput();
    error Expired();
    error InvalidPath();

    constructor(address _relay, address _weth, address _factory) Ownable(msg.sender) {
        require(_relay != address(0), "Zero relay");
        RELAY = IBaseRelay(_relay);
        WETH = _weth;
        FACTORY = _factory;
    }

    /// @notice Update the underlying BaseRelay contract address
    function setRelay(address newRelay) external onlyOwner {
        require(newRelay != address(0), "Zero relay");
        address oldRelay = address(RELAY);
        RELAY = IBaseRelay(newRelay);
        emit RelayUpdated(oldRelay, newRelay);
    }

    /// @notice Standard swapExactTokensForTokens — Uniswap V2 compatible (selector 0x38ed1739)
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(block.timestamp <= deadline, "Expired");
        require(path.length >= 3, "Invalid path");
        address tokenIn = path[0];
        address tokenOut = path[path.length - 1];

        uint256 pc = path.length / 2;
        address[] memory pools = new address[](pc);
        for (uint256 i = 0; i < pc; i++) pools[i] = path[i * 2 + 1];

        IERC20(tokenIn).approve(address(RELAY), amountIn);
        (uint256 amountOut,) = RELAY.swap(tokenIn, tokenOut, amountIn, amountOutMin, pools, deadline);
        require(amountOut >= amountOutMin, "Insufficient output");
        IERC20(tokenOut).transfer(to, amountOut);

        emit Swap(msg.sender, tokenIn, tokenOut, amountIn, amountOut, to);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
    }

    /// @notice Standard getAmountsOut — Uniswap V2 compatible (selector 0xd06ca61f)
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        require(path.length >= 3 && path.length % 2 == 1, "Invalid path");
        uint256 pc = path.length / 2;
        address[] memory pools = new address[](pc);
        for (uint256 i = 0; i < pc; i++) pools[i] = path[i * 2 + 1];

        uint256 cur = amountIn;
        address curTok = path[0];
        for (uint256 i = 0; i < pc; i++) {
            (uint112 r0, uint112 r1,) = IUniswapV2Pair(pools[i]).getReserves();
            bool zfo = curTok == IUniswapV2Pair(pools[i]).token0();
            (uint256 rIn, uint256 rOut) = zfo ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
            require(rIn > 0 && rOut > 0, "No liq");
            uint256 aif = cur * 997;
            cur = (aif * rOut) / (rIn * 1000 + aif);
            curTok = path[(i + 1) * 2];
        }
        uint256 fee = (amountIn * RELAY.RELAY_FEE_BPS()) / 10000;
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = cur - fee;
    }

    /// @notice Simulate swap — returns expectedOut, fee, priceImpactBps
    function simulateSwap(address tokenIn, address tokenOut, uint256 amountIn, address[] calldata pools) external view returns (uint256 expectedOut, uint256 fee, uint256 priceImpactBps) {
        IUniswapV2Pair pool = IUniswapV2Pair(pools[0]);
        (uint112 r0, uint112 r1,) = pool.getReserves();
        bool zfo = tokenIn == pool.token0();
        (uint256 rIn, uint256 rOut) = zfo ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 aif = amountIn * 997;
        expectedOut = (aif * rOut) / (rIn * 1000 + aif);
        fee = (amountIn * RELAY.RELAY_FEE_BPS()) / 10000;
        priceImpactBps = (amountIn * 10000) / rIn;
    }

    function relayAddress() external view returns (address) { return address(RELAY); }
    function weth() external view returns (address) { return WETH; }
    function factory() external view returns (address) { return FACTORY; }
    function relayFeeBps() external view returns (uint256) { return RELAY.RELAY_FEE_BPS(); }
    function treasury() external view returns (address) { return RELAY.TREASURY(); }
    receive() external payable {}
}
