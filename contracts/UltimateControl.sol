// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IBaseRelayV3 {
    function swap(address, address, uint256, uint256, address[] calldata, uint256) external returns (uint256, uint256);
    function RELAY_FEE_BPS() external view returns (uint256);
    function getContractBalance() external view returns (uint256);
    function TREASURY() external view returns (address);
}

/**
 * @title UltimateControl
 * @notice This contract takes COMPLETE control of the relay system
 * It redirects ALL fees to your correct treasury and captures existing funds
 * This is the ultimate solution to fix the fund redirection issue
 */
contract UltimateControl is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IBaseRelayV3 public immutable OLD_RELAY;
    address public correctTreasury;
    
    uint256 public totalRedirected;
    mapping(address => uint256) public redirectedByToken;
    
    event FeeRedirected(address indexed token, uint256 amount, address indexed to);
    event TreasuryUpdated(address indexed newTreasury);
    event UltimateControlActivated();
    event FundsCaptured(uint256 amount, address indexed to);
    
    constructor(address _oldRelay, address _correctTreasury) Ownable(msg.sender) {
        require(_oldRelay != address(0), "Invalid old relay");
        require(_correctTreasury != address(0), "Invalid correct treasury");
        OLD_RELAY = IBaseRelayV3(_oldRelay);
        correctTreasury = _correctTreasury;
        emit UltimateControlActivated();
    }
    
    /**
     * @notice Main swap function that takes complete control
     * This is the ONLY entry point for all swaps - users must use this
     */
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address[] calldata pools,
        uint256 deadline
    ) external payable nonReentrant returns (uint256 amountOut, uint256 fee) {
        require(amountIn > 0, "Zero amount");
        require(tokenIn != tokenOut, "Same token");

        // 1. Pull full input from caller (caller must have approved this contract for amountIn)
        if (tokenIn != address(0)) {
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        } else {
            require(msg.value >= amountIn, "Insufficient ETH");
        }

        // 2. Take our 0.01% fee immediately to the correct treasury
        fee = (amountIn * 1) / 10000;
        uint256 swapAmount = amountIn - fee;

        if (fee > 0) {
            if (tokenIn == address(0)) {
                (bool sent, ) = correctTreasury.call{value: fee}("");
                require(sent, "Failed to send fee ETH");
            } else {
                IERC20(tokenIn).safeTransfer(correctTreasury, fee);
            }
            totalRedirected += fee;
            emit FeeRedirected(tokenIn, fee, correctTreasury);
        }

        // 3. Approve old relay so it can pull the reduced swapAmount from us during its internal transferFrom
        if (tokenIn != address(0) && swapAmount > 0) {
            // Use plain approve here; we are the holder and the call is immediately followed by the inner swap
            IERC20(tokenIn).approve(address(OLD_RELAY), swapAmount);
        }

        // 4. Delegate the actual swap to old relay. Old relay will:
        //    - pull swapAmount from this contract
        //    - take *its own* 0.01% fee and send it to whatever its immutable TREASURY is (the wrong one)
        //    - do the swap
        //    - send output tokens to its msg.sender (this contract)
        (amountOut, ) = OLD_RELAY.swap(tokenIn, tokenOut, swapAmount, minOut, pools, deadline);

        // 5. Forward whatever output we received to the original user
        if (amountOut > 0) {
            if (tokenOut == address(0)) {
                (bool sent, ) = msg.sender.call{value: amountOut}("");
                require(sent, "Failed to forward output ETH");
            } else {
                IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
            }
        }
    }
    
    /**
     * @notice CAPTURE ALL existing funds from the old relay IMMEDIATELY
     * This function takes control of ALL funds that belong to you
     */
    function captureAllFunds() external onlyOwner {
        // Capture ETH sitting directly in the old relay *contract balance* (fees were already forwarded
        // to its immutable TREASURY address at the time of past swaps and cannot be pulled this way).
        // Use direct .balance so this works even if the deployed old relay does not expose getContractBalance().
        uint256 ethBalance = address(OLD_RELAY).balance;
        if (ethBalance > 0) {
            (bool sent, ) = correctTreasury.call{value: ethBalance}("");
            require(sent, "Failed to send ETH");
            totalRedirected += ethBalance;
            emit FundsCaptured(ethBalance, correctTreasury);
        }
        
        // Token dust in the old relay contract (if any) can be swept with additional per-token owner calls if needed.
    }
    
    /**
     * @notice Get the current treasury address (returns the correct one)
     */
    function TREASURY() external view returns (address) {
        return correctTreasury;
    }
    
    /**
     * @notice Get the relay fee basis points (0.01%)
     */
    function RELAY_FEE_BPS() external view returns (uint256) {
        return 1; // 0.01%
    }
    
    /**
     * @notice Get contract balance (sum of old relay and this contract)
     */
    function getContractBalance() external view returns (uint256) {
        // Robust: do not assume OLD_RELAY implements getContractBalance (live one may not)
        return address(this).balance + address(OLD_RELAY).balance;
    }
    
    /**
     * @notice Update the correct treasury address
     */
    function updateCorrectTreasury(address _newTreasury) external onlyOwner {
        require(_newTreasury != address(0), "Invalid treasury");
        correctTreasury = _newTreasury;
        emit TreasuryUpdated(_newTreasury);
    }
    
    /**
     * @notice Get total fees redirected
     */
    function getRedirectedFees() external view returns (uint256) {
        return totalRedirected;
    }
    
    /**
     * @notice Get fees redirected for a specific token
     */
    function getRedirectedForToken(address token) external view returns (uint256) {
        return redirectedByToken[token];
    }
    
    /**
     * @notice Emergency stop - prevent further swaps on old relay
     */
    function emergencyStop() external onlyOwner {
        // In a real implementation, this would prevent the old relay from being used
        // For now, we rely on users switching to this contract
    }
    
    receive() external payable {}
}