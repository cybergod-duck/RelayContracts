// Simple CommonJS script to deploy UltimateControl + auto-capture
// Run with: npx hardhat run scripts/simple-fix-treasury.js --network baseSepolia
// (or baseMainnet). Make sure DEPLOYER_PRIVATE_KEY and RPC are in .env / hardhat.config.

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Fixing your treasury with:", deployer.address);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH");

  // Hardcoded to your correct treasury (as specified in the handoff)
  const correctTreasuryAddress = "0xA951A66b5800567035EEbcbBbf50A5B438761f97";
  const oldRelayAddress = "0x0382f917af966354D79485D7A4e8322b3A6f4f15"; // current live BaseRelayV3 behind the proxy

  console.log("Old relay address:", oldRelayAddress);
  console.log("Correct treasury address:", correctTreasuryAddress);

  // Deploy UltimateControl (the wrapper that will be the new callable "relay" address)
  console.log("\n🚀 Deploying UltimateControl to fix your treasury...");
  const UltimateControl = await hre.ethers.getContractFactory("UltimateControl");
  const control = await UltimateControl.deploy(oldRelayAddress, correctTreasuryAddress);
  await control.waitForDeployment();
  const controlAddress = await control.getAddress();
  console.log("✅ UltimateControl deployed to:", controlAddress);

  // Immediately capture whatever ETH balance is stuck in the old relay contract
  console.log("\n🔥 Capturing existing funds from old relay contract balance...");
  try {
    const captureTx = await control.captureAllFunds();
    await captureTx.wait();
    console.log("✅ captureAllFunds succeeded. Any contract-balance ETH should now be in your treasury.");
  } catch (e) {
    console.warn("captureAllFunds call failed or had no balance:", e.message || e);
  }

  console.log("\n🎉 TREASURY REDIRECT DEPLOYED!");
  console.log("=========================================");
  console.log("NEW ADDRESS TO USE FOR ALL FUTURE SWAPS / BOTS / WALLET:");
  console.log(controlAddress);
  console.log("=========================================");
  console.log("\nNext steps (per handoff):");
  console.log("1. Update your frontend / cold-storage-wallet / bots to call this address for swap()");
  console.log("2. (For cold wallet) you may also need to deploy a new BotCompatibilityProxy pointing its RELAY to this UltimateControl if you want to keep using the UniswapV2 compat methods.");
  console.log("3. Call captureAllFunds() again later if more dust accumulates in the old relay.");
  console.log("4. Verify on Basescan that TREASURY() on the new contract returns your 0xA951... address.");
  console.log("\nNOTE: Because the old BaseRelayV3 still has its immutable wrong treasury, any usage of the *old* addresses will continue to leak 0.01% there. Migration to this new address stops the loss for new volume.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});