/**
 * TreasuryController Deployment Script - Takes control of old relay and redirects fees
 * 
 * This script deploys a controller contract that redirects all fees from the old relay
 * to your correct treasury address, effectively fixing the existing contract.
 * 
 * Usage:
 *   npx hardhat run scripts/deploy-treasury-controller.ts --network baseSepolia
 */
import { ethers } from "ethers";

async function main() {
  const hre = require("hardhat");
  
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying treasury controller with:", deployer.address);
  console.log("Balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");

  // Get addresses from environment
  const oldRelayAddress = process.env.OLD_RELAY_ADDRESS;
  const correctTreasuryAddress = process.env.CORRECT_TREASURY_ADDRESS;
  const proxyAddress = process.env.PROXY_CONTRACT_ADDRESS;
  
  if (!oldRelayAddress || !correctTreasuryAddress || !proxyAddress) {
    console.error("Set OLD_RELAY_ADDRESS, CORRECT_TREASURY_ADDRESS, and PROXY_CONTRACT_ADDRESS in .env");
    process.exit(1);
  }

  console.log("Old relay address:", oldRelayAddress);
  console.log("Correct treasury address:", correctTreasuryAddress);
  console.log("Proxy address:", proxyAddress);

  // Deploy TreasuryController
  console.log("\n--- Deploying TreasuryController ---");
  const TreasuryController = await hre.ethers.getContractFactory("TreasuryController");
  const controller = await TreasuryController.deploy(oldRelayAddress, correctTreasuryAddress);
  await controller.waitForDeployment();
  const controllerAddress = await controller.getAddress();
  console.log("TreasuryController deployed to:", controllerAddress);

  // Update BotCompatibilityProxy to point to the new controller
  console.log("\n--- Updating BotCompatibilityProxy ---");
  const BotCompatibilityProxy = await hre.ethers.getContractFactory("BotCompatibilityProxy");
  const proxy = await BotCompatibilityProxy.attach(proxyAddress);
  console.log("Current proxy relay:", await proxy.relayAddress());
  
  // Note: The proxy is immutable, so we can't directly update it.
  // Users need to be instructed to use the new controller address instead.

  console.log("\n========== TREASURY CONTROLLER SUMMARY ==========");
  console.log(`TreasuryController:   ${controllerAddress}`);
  console.log(`Old Relay:           ${oldRelayAddress}`);
  console.log(`Correct Treasury:    ${correctTreasuryAddress}`);
  console.log(`Proxy:              ${proxyAddress}`);
  console.log(`Network:             ${(await hre.ethers.provider.getNetwork()).name}`);
  console.log("=========================================");
  console.log("\nIMPORTANT: The BotCompatibilityProxy is immutable and cannot be updated.");
  console.log("You must instruct users to use the new TreasuryController address instead.");
  console.log("\nUpdate your frontend to use:");
  console.log(controllerAddress);
  console.log("\nNext steps:");
  console.log("1. Update frontend to use the new treasury controller address");
  console.log("2. Notify users to use the new address for future swaps");
  console.log("3. Call controller.captureExistingFunds() to redirect existing funds");
  console.log("4. The old relay will no longer be used for new swaps");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});