/**
 * Fix My Treasury - Simple script to fix your treasury issue
 * 
 * This script deploys the UltimateControl contract and captures your funds
 * You only need to provide your correct treasury address
 * 
 * Usage:
 *   npx hardhat run scripts/fix-my-treasury.ts --network baseSepolia
 */
import { ethers } from "ethers";

async function main() {
  const hre = require("hardhat");
  
  const [deployer] = await hre.ethers.getSigners();
  console.log("Fixing your treasury with:", deployer.address);
  console.log("Balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");

  // Get addresses from environment or use the known-good values for your case
  const oldRelayAddress = process.env.OLD_RELAY_ADDRESS || "0x0382f917af966354D79485D7A4e8322b3A6f4f15"; // current live BaseRelayV3 (the one behind the old proxy)
  const CORRECT_TREASURY = "0xA951A66b5800567035EEbcbBbf50A5B438761f97";
  const correctTreasuryAddress = process.env.CORRECT_TREASURY_ADDRESS || CORRECT_TREASURY;

  console.log("Old relay address:", oldRelayAddress);
  console.log("Correct treasury address:", correctTreasuryAddress);

  // Deploy UltimateControl
  console.log("\n🚀 Deploying UltimateControl to fix your treasury...");
  const UltimateControl = await hre.ethers.getContractFactory("UltimateControl");
  const control = await UltimateControl.deploy(oldRelayAddress, correctTreasuryAddress);
  await control.waitForDeployment();
  const controlAddress = await control.getAddress();
  console.log("✅ UltimateControl deployed to:", controlAddress);

  // Capture existing funds
  console.log("\n🔥 Capturing existing funds from old relay...");
  const captureTx = await control.captureAllFunds();
  await captureTx.wait();
  console.log("✅ Funds captured! Check your wallet.");

  console.log("\n🎉 ULTIMATECONTROL DEPLOYED - FEES NOW ROUTED TO YOUR WALLET (for callers using this address)!");
  console.log("=========================================");
  console.log("NEW SWAP ENTRY POINT (use this instead of old relay/proxy):");
  console.log(controlAddress);
  console.log("Correct Treasury inside it:", correctTreasuryAddress);
  console.log("=========================================");
  console.log("\nNext steps:");
  console.log("1. Update cold-storage-wallet/main.js (NETWORKS.base) or your bots to use the new controlAddress for swaps.");
  console.log("2. If keeping the BotCompatibilityProxy interface, deploy a fresh proxy that points its RELAY to this UltimateControl address.");
  console.log("3. Old fees that already went to the immutable wrong treasury on the original BaseRelayV3 are generally unrecoverable.");
  console.log("4. Re-run captureAllFunds() periodically or when you suspect dust in the old relay contract.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});