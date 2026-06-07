/**
 * RelayTakeover Deployment Script - Takes complete control of relay funds
 * 
 * This script deploys a contract that takes over the relay functionality
 * and redirects ALL fees to your correct treasury address.
 * 
 * Usage:
 *   npx hardhat run scripts/deploy-relay-takeover.ts --network baseSepolia
 */
import { ethers } from "ethers";

async function main() {
  const hre = require("hardhat");
  
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying relay takeover with:", deployer.address);
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

  // Deploy RelayTakeover
  console.log("\n--- Deploying RelayTakeover ---");
  const RelayTakeover = await hre.ethers.getContractFactory("RelayTakeover");
  const takeover = await RelayTakeover.deploy(oldRelayAddress, correctTreasuryAddress);
  await takeover.waitForDeployment();
  const takeoverAddress = await takeover.getAddress();
  console.log("RelayTakeover deployed to:", takeoverAddress);

  console.log("\n========== RELAY TAKEOVER SUMMARY ==========");
  console.log(`RelayTakeover:       ${takeoverAddress}`);
  console.log(`Old Relay:           ${oldRelayAddress}`);
  console.log(`Correct Treasury:    ${correctTreasuryAddress}`);
  console.log(`Proxy:              ${proxyAddress}`);
  console.log(`Network:             ${(await hre.ethers.provider.getNetwork()).name}`);
  console.log("=========================================");
  console.log("\nIMPORTANT: The BotCompatibilityProxy is immutable and cannot be updated.");
  console.log("You must instruct users to use the new RelayTakeover address immediately.");
  console.log("\nUPDATE YOUR FRONTEND TO USE:");
  console.log(takeoverAddress);
  console.log("\nIMMEDIATE ACTIONS:");
  console.log("1. Call takeover.captureAllFunds() to redirect existing ETH funds");
  console.log("2. Notify ALL users to use the new address for future swaps");
  console.log("3. Monitor takeover.getRedirectedFees() to track captured amounts");
  console.log("4. The old relay will no longer be used for new swaps");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});