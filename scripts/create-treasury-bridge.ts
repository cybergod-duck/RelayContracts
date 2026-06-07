/**
 * Treasury Bridge Contract - Redirects fees from incorrect treasury to correct wallet
 * 
 * This contract captures fees from the old relay and sends them to your correct treasury.
 * 
 * Usage:
 *   npx hardhat run scripts/create-treasury-bridge.ts --network baseSepolia
 */
import { ethers } from "ethers";

async function main() {
  const hre = require("hardhat");
  
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying treasury bridge with:", deployer.address);
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

  // Deploy TreasuryBridge contract
  console.log("\n--- Deploying TreasuryBridge ---");
  const TreasuryBridge = await hre.ethers.getContractFactory("TreasuryBridge");
  const bridge = await TreasuryBridge.deploy(oldRelayAddress, correctTreasuryAddress);
  await bridge.waitForDeployment();
  const bridgeAddress = await bridge.getAddress();
  console.log("TreasuryBridge deployed to:", bridgeAddress);

  console.log("\n========== TREASURY BRIDGE SUMMARY ==========");
  console.log(`TreasuryBridge:      ${bridgeAddress}`);
  console.log(`Old Relay:           ${oldRelayAddress}`);
  console.log(`Correct Treasury:    ${correctTreasuryAddress}`);
  console.log(`Network:             ${(await hre.ethers.provider.getNetwork()).name}`);
  console.log("=========================================");
  console.log("\nUpdate .env with:");
  console.log(`TREASURY_BRIDGE_ADDRESS=${bridgeAddress}`);
  console.log("\nNext steps:");
  console.log("1. Call bridge.startCapturing() to begin redirecting fees");
  console.log("2. Monitor bridge.getCollectedFees() to track redirected amounts");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});