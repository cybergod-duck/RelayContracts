// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IBaseRelayV3 {
    function TREASURY() external view returns (address);
    function getContractBalance() external view returns (uint256);
}

contract TreasuryBridge is Ownable, ReentrancyGuard {
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
    
    function startCapturing() external onlyOwner {
        // This function would be called to begin the redirection process
        // In a real implementation, this would set up event listeners or periodic checks
    }
    
    function captureAndRedirect() external nonReentrant {
        address treasuryAddress = OLD_RELAY.TREASURY();
        uint256 balance = OLD_RELAY.getContractBalance();
        
        if (balance > 0) {
            // Send ETH to correct treasury
            (bool sent, ) = correctTreasury.call{value: balance}("");
            require(sent, "Failed to send ETH");
            
            totalRedirected += balance;
            emit FeeRedirected(address(0), balance, correctTreasury);
        }
    }
    
    function captureTokenFees(address token) external nonReentrant {
        IERC20 tokenContract = IERC20(token);
        address treasuryAddress = OLD_RELAY.TREASURY();
        uint256 balance = tokenContract.balanceOf(treasuryAddress);
        
        if (balance > 0) {
            // Transfer tokens from old treasury to correct treasury
            require(tokenContract.transferFrom(treasuryAddress, correctTreasury, balance), "Token transfer failed");
            
            redirectedByToken[token] += balance;
            totalRedirected += balance;
            emit FeeRedirected(token, balance, correctTreasury);
        }
    }
    
    function getCollectedFees() external view returns (uint256) {
        return totalRedirected;
    }
    
    function getRedirectedForToken(address token) external view returns (uint256) {
        return redirectedByToken[token];
    }
    
    function updateCorrectTreasury(address _newTreasury) external onlyOwner {
        require(_newTreasury != address(0), "Invalid treasury");
        correctTreasury = _newTreasury;
        emit TreasuryUpdated(_newTreasury);
    }
    
    function getOldRelayTreasury() external view returns (address) {
        return OLD_RELAY.TREASURY();
    }
    
    receive() external payable {}
}