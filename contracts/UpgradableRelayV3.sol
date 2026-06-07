// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IBaseRelayV3 {
    function swap(address, address, uint256, uint256, address[] calldata, uint256) external returns (uint256, uint256);
    function RELAY_FEE_BPS() external view returns (uint256);
    function TREASURY() external view returns (address);
    function getContractBalance() external view returns (uint256);
}

/**
 * @title UpgradableRelayV3
 * @notice This contract acts as a proxy that redirects fees to the correct treasury
 * while maintaining compatibility with the existing BaseRelayV3 interface
 */
contract UpgradableRelayV3 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IBaseRelayV3 public immutable OLD_RELAY;
    address public correctTreasury;
    
    uint256 public totalRedirected;
    mapping(address => uint256) public redirectedByToken;
    
    event FeeRedirected(address indexed token, uint256 amount, address indexed to);
    event TreasuryUpdated(address indexed newTreasury);
    
    constructor(address _oldRelay, address _correctTreasury) Ownable(msg.sender) {
        require(_oldRelay != address(0), "Invalid old relay");
        require(_correctTreasury != address(0), "Invalid correct treasury");
        OLD_RELAY = IBaseRelayV3(_oldRelay);
        correctTreasury = _correctTreasury;
    }
    
    /**
     * @notice Redirects the swap function to capture and redirect fees
     * This maintains the same interface as BaseRelayV3 but redirects fees
     */
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address[] calldata pools,
        uint256 deadline
    ) external nonReentrant returns (uint256 amountOut, uint256 fee) {
        // Call the old relay's swap function
        (amountOut, fee) = OLD_RELAY.swap(tokenIn, tokenOut, amountIn, minOut, pools, deadline);
        
        // Redirect the fee to the correct treasury
        if (fee > 0) {
            if (tokenIn == address(0)) { // ETH case
                (bool sent, ) = correctTreasury.call{value: fee}("");
                require(sent, "Failed to send ETH");
            } else {
                IERC20(tokenIn).safeTransferFrom(msg.sender, correctTreasury, fee);
            }
            
            totalRedirected += fee;
            emit FeeRedirected(tokenIn, fee, correctTreasury);
        }
    }
    
    /**
     * @notice Get the current treasury address (returns the correct one, not the old one)
     */
    function TREASURY() external view returns (address) {
        return correctTreasury;
    }
    
    /**
     * @notice Get the relay fee basis points (same as old relay)
     */
    function RELAY_FEE_BPS() external view returns (uint256) {
        return OLD_RELAY.RELAY_FEE_BPS();
    }
    
    /**
     * @notice Get contract balance (sum of old relay and this contract)
     */
    function getContractBalance() external view returns (uint256) {
        return address(this).balance + OLD_RELAY.getContractBalance();
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
    
    receive() external payable {}
}