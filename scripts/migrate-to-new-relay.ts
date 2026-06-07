/**
 * Migration Script to New Relay Contract
 * 
 * Usage:
 *   npx hardhat run scripts/migrate-to-new-relay.ts --network baseSepolia
 */
import { ethers } from "ethers";

async function main() {
  const hre = require("hardhat");
  
  const [deployer] = await hre.ethers.getSigners();
  console.log("Running migration with:", deployer.address);

  // Get addresses from environment
  const oldProxyAddress = process.env.OLD_PROXY_ADDRESS;
  const newProxyAddress = process.env.NEW_PROXY_ADDRESS;
  
  if (!oldProxyAddress || !newProxyAddress) {
    console.error("Set OLD_PROXY_ADDRESS and NEW_PROXY_ADDRESS in .env");
    process.exit(1);
  }

  console.log("Migrating from:", oldProxyAddress);
  console.log("Migrating to:", newProxyAddress);

  // Get contract instances
  const BotCompatibilityProxy = await hre.ethers.getContractFactory("BotCompatibilityProxy");
  const oldProxy = BotCompatibilityProxy.attach(oldProxyAddress);
  const newProxy = BotCompatibilityProxy.attach(newProxyAddress);

  // Get relay addresses
  const oldRelayAddress = await oldProxy.relayAddress();
  const newRelayAddress = await newProxy.relayAddress();
  
  console.log("Old relay:", oldRelayAddress);
  console.log("New relay:", newRelayAddress);

  // Check treasury addresses
  const oldRelay = await hre.ethers.getContractAt("BaseRelayV3", oldRelayAddress);
  const newRelay = await hre.ethers.getContractAt("BaseRelayV3", newRelayAddress);
  
  console.log("Old treasury:", await oldRelay.TREASURY());
  console.log("New treasury:", await newRelay.TREASURY());

  console.log("\nMigration Summary:");
  console.log("✅ Old proxy:", oldProxyAddress);
  console.log("✅ New proxy:", newProxyAddress);
  console.log("✅ Old relay:", oldRelayAddress);
  console.log("✅ New relay:", newRelayAddress);
  console.log("✅ Old treasury:", await oldRelay.TREASURY());
  console.log("✅ New treasury:", await newRelay.TREASURY());

  console.log("\n🎉 Migration ready. Update your frontend to use the new proxy address:");
  console.log(newProxyAddress);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});