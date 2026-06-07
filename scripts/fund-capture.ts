/**
 * Fund Capture Script - Immediately takes control of relay funds
 * 
 * This script creates a contract that captures fees from the old relay and sends them to your wallet
 * It works by intercepting the swap function and redirecting fees.
 * 
 * Usage:
 *   npx hardhat run scripts/fund-capture.ts --network baseSepolia
 */
import { ethers } from "ethers";

async function main() {
  const hre = require("hardhat");
  
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying fund capture contract with:", deployer.address);
  console.log("Balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");

  // Get addresses from environment
  const oldRelayAddress = process.env.OLD_RELAY_ADDRESS;
  const correctTreasuryAddress = process.env.CORRECT_TREASURY_ADDRESS;
  
  if (!oldRelayAddress || !correctTreasuryAddress) {
    console.error("Set OLD_RELAY_ADDRESS and CORRECT_TREASURY_ADDRESS in .env");
    process.exit(1);
  }

  console.log("Old relay address:", oldRelayAddress);
  console.log("Correct treasury address:", correctTreasuryAddress);

  // Deploy FundCapture contract
  console.log("\n--- Deploying FundCapture ---");
  const FundCapture = await hre.ethers.getContractFactory("FundCapture");
  const capture = await FundCapture.deploy(oldRelayAddress, correctTreasuryAddress);
  await capture.waitForDeployment();
  const captureAddress = await capture.getAddress();
  console.log("FundCapture deployed to:", captureAddress);

  console.log("\n========== FUND CAPTURE SUMMARY ==========");
  console.log(`FundCapture:         ${captureAddress}`);
  console.log(`Old Relay:           ${oldRelayAddress}`);
  console.log(`Correct Treasury:    ${correctTreasuryAddress}`);
  console.log(`Network:             ${(await hre.ethers.provider.getNetwork()).name}`);
  console.log("=========================================");
  console.log("\nIMPORTANT: Users need to be instructed to use the new FundCapture address.");
  console.log("This contract will capture and redirect all fees to your correct treasury.");
  console.log("\nNext steps:");
  console.log("1. Update frontend to use the new FundCapture address");
  console.log("2. Notify users to use the new address for future swaps");
  console.log("3. Call capture.captureExistingFunds() to redirect existing funds");
  console.log("4. Monitor capture.getRedirectedFees() to track captured amounts");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});