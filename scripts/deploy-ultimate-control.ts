/**
 * UltimateControl Deployment Script - Takes COMPLETE control of relay funds
 * 
 * This script deploys the ultimate solution that takes over the relay functionality
 * and redirects ALL fees to your correct treasury address.
 * 
 * Usage:
 *   npx hardhat run scripts/deploy-ultimate-control.ts --network baseSepolia
 */
import { ethers } from "ethers";

async function main() {
  const hre = require("hardhat");
  
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying ultimate control with:", deployer.address);
  console.log("Balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");

  // Get addresses - default to the values for your broken BaseRelayV3 + your correct wallet
  const oldRelayAddress = process.env.OLD_RELAY_ADDRESS || "0x0382f917af966354D79485D7A4e8322b3A6f4f15";
  const CORRECT_TREASURY = "0xA951A66b5800567035EEbcbBbf50A5B438761f97";
  const correctTreasuryAddress = process.env.CORRECT_TREASURY_ADDRESS || CORRECT_TREASURY;
  const proxyAddress = process.env.PROXY_CONTRACT_ADDRESS || "(not required for direct UltimateControl usage)";

  console.log("Old relay address:", oldRelayAddress);
  console.log("Correct treasury address:", correctTreasuryAddress);
  console.log("Proxy address (informational):", proxyAddress);

  // Deploy UltimateControl
  console.log("\n--- Deploying UltimateControl ---");
  const UltimateControl = await hre.ethers.getContractFactory("UltimateControl");
  const control = await UltimateControl.deploy(oldRelayAddress, correctTreasuryAddress);
  await control.waitForDeployment();
  const controlAddress = await control.getAddress();
  console.log("UltimateControl deployed to:", controlAddress);

  console.log("\n========== ULTIMATE CONTROL SUMMARY ==========");
  console.log(`UltimateControl:     ${controlAddress}`);
  console.log(`Old Relay:           ${oldRelayAddress}`);
  console.log(`Correct Treasury:    ${correctTreasuryAddress}`);
  console.log(`Network:             ${(await hre.ethers.provider.getNetwork()).name}`);
  console.log("=========================================");
  console.log("\n⚠️⚠️⚠️ IMMEDIATE ACTIONS REQUIRED ⚠️⚠️⚠️");
  console.log("1. CALL control.captureAllFunds() TO CAPTURE ANY ETH BALANCE IN THE OLD RELAY CONTRACT NOW!");
  console.log("2. UPDATE CALLERS (cold-storage-wallet/main.js NETWORKS.base, bots, etc.) TO USE THIS FOR SWAPS:");
  console.log(controlAddress);
  console.log("3. If you want to keep using the old proxy address for bot compat, deploy a new BotCompatibilityProxy that wraps *this* UltimateControl instead of the old relay.");
  console.log("4. MONITOR control.getRedirectedFees() TO TRACK CAPTURED AMOUNT");
  console.log("\nNOTE: Callers that keep using the old relay/proxy addresses will continue sending 0.01% to the immutable wrong treasury.");
  console.log("Migrate volume to the UltimateControl address above to stop the loss.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});