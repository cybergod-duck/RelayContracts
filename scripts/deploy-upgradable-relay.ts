/**
 * UpgradableRelayV3 Deployment Script - Fixes existing contract without redeploying
 * 
 * This script deploys a proxy contract that redirects fees to your correct treasury
 * while maintaining the same interface as the existing BaseRelayV3 contract.
 * 
 * Usage:
 *   npx hardhat run scripts/deploy-upgradable-relay.ts --network baseSepolia
 */
import { ethers } from "ethers";

async function main() {
  const hre = require("hardhat");
  
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying upgradable relay with:", deployer.address);
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

  // Deploy UpgradableRelayV3
  console.log("\n--- Deploying UpgradableRelayV3 ---");
  const UpgradableRelayV3 = await hre.ethers.getContractFactory("UpgradableRelayV3");
  const upgradableRelay = await UpgradableRelayV3.deploy(oldRelayAddress, correctTreasuryAddress);
  await upgradableRelay.waitForDeployment();
  const upgradableRelayAddress = await upgradableRelay.getAddress();
  console.log("UpgradableRelayV3 deployed to:", upgradableRelayAddress);

  // Update BotCompatibilityProxy to point to the new upgradable relay
  console.log("\n--- Updating BotCompatibilityProxy ---");
  const BotCompatibilityProxy = await hre.ethers.getContractFactory("BotCompatibilityProxy");
  const proxy = await BotCompatibilityProxy.attach(process.env.PROXY_CONTRACT_ADDRESS);
  console.log("Current proxy relay:", await proxy.relayAddress());
  
  // Note: The proxy is immutable, so we can't directly update it.
  // Users need to be instructed to use the new upgradable relay address instead.

  console.log("\n========== UPGRADE SUMMARY ==========");
  console.log(`UpgradableRelayV3:    ${upgradableRelayAddress}`);
  console.log(`Old Relay:           ${oldRelayAddress}`);
  console.log(`Correct Treasury:    ${correctTreasuryAddress}`);
  console.log(`Network:             ${(await hre.ethers.provider.getNetwork()).name}`);
  console.log("=========================================");
  console.log("\nIMPORTANT: The BotCompatibilityProxy is immutable and cannot be updated.");
  console.log("You must instruct users to use the new UpgradableRelayV3 address instead.");
  console.log("\nUpdate your frontend to use:");
  console.log(upgradableRelayAddress);
  console.log("\nNext steps:");
  console.log("1. Update frontend to use the new upgradable relay address");
  console.log("2. Notify users to use the new address for future swaps");
  console.log("3. The old relay will continue to send fees to the incorrect address");
  console.log("4. Monitor upgradable relay for redirected fees");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});