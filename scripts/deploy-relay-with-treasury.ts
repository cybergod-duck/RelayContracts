/**
 * BaseRelayV3 Deployment Script with Correct Treasury
 * 
 * Usage:
 *   npx hardhat run scripts/deploy-relay-with-treasury.ts --network baseSepolia
 *   npx hardhat run scripts/deploy-relay-with-treasury.ts --network baseMainnet
 */
// NOTE: Relay contracts are now in ../contracts/ relative to this script (consolidated into cold-storage-wallet).
// To deploy: from workspace root: npx hardhat run cold-storage-wallet/scripts/deploy-relay-with-treasury.ts --network baseMainnet
// Hardhat sources default to root/contracts; the relay .sol have been moved here for Antigravity work. You may need to adjust paths.sources or run compilation targeting this location.
import { ethers } from "ethers";

async function main() {
  // Get the Hardhat Runtime Environment
  const hre = require("hardhat");
  
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  console.log("Balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");

  // Get treasury address from environment or default to YOUR CORRECT TREASURY
  // This must be set correctly at deploy - it is IMMUTABLE in BaseRelayV3
  const CORRECT_TREASURY = "0xA951A66b5800567035EEbcbBbf50A5B438761f97";
  console.log("   - relay: the new BaseRelayV3");
  console.log("   - proxy: the new BotCompatibilityProxy");
  console.log("3. Rebuild the cold-storage-wallet Electron app (npm run build or whatever your package uses) and redistribute.");
  console.log("4. If you have external bots/scripts calling the OLD proxy 0x5193Cd26B642De929068a950d79B6a03EDc7A37A, update them to call the NEW proxy.");
  console.log("5. Verify on Basescan: call TREASURY() on the new relay - must return 0xA951A66b5800567035EEbcbBbf50A5B438761f97");
  console.log("6. Test a small swap through the new proxy from the cold wallet Relay tab.");
  console.log("\nOld fees already sent to the wrong immutable treasury (previously 0x330293E325E7163faaa0602e8f8e6Bc258101445) are likely unrecoverable unless you control that EOA keys.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});