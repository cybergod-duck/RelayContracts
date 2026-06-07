/**
 * SWEEP LEGACY RELAY TREASURY (CommonJS version - ethers v5)
 *
 * Gives you CONTROL of the wallet that was created as the TREASURY for the bot
 * compatibility contract (BaseRelayV3 + BotCompatibilityProxy).
 *
 * ALL THE FUNDS your contract has made (0.01% fees on every swap) went to
 * 0x330293E325E7163faaa0602e8f8e6Bc258101445 because that was the immutable
 * TREASURY set at deployment.
 *
 * Run:
 *   set LEGACY_PRIVATE_KEY=0xYourLegacyPrivateKeyHere
 *   set TARGET_ADDRESS=0xA951A66b5800567035EEbcbBbf50A5B438761f97
 *   node scripts/sweep-legacy-relay-treasury.js
 *
 * (Use PowerShell $env: or export on other shells. Key is used only in memory.)
 */

const { ethers } = require("ethers");
require("dotenv").config();

const LEGACY = "0x330293E325E7163faaa0602e8f8e6Bc258101445";
const TARGET = process.env.TARGET_ADDRESS || "0xA951A66b5800567035EEbcbBbf50A5B438761f97";

const BASE_RPC = "https://mainnet.base.org";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const WETH_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)"
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)"
];

async function main() {
  const legacyPk = process.env.LEGACY_PRIVATE_KEY;
  if (!legacyPk || !legacyPk.startsWith("0x")) {
    console.error("Set LEGACY_PRIVATE_KEY environment variable to the private key of 0x330293...");
    console.error("Example (PowerShell):");
    console.error("  $env:LEGACY_PRIVATE_KEY='0x...'; node scripts/sweep-legacy-relay-treasury.js");
    process.exit(1);
  }

  const provider = new ethers.providers.JsonRpcProvider(BASE_RPC);
  const legacySigner = new ethers.Wallet(legacyPk, provider);

  console.log("=== LEGACY RELAY TREASURY SWEEP ===");
  console.log("Source (the one created with the bot compat contract):", LEGACY);
  console.log("Target (your correct wallet):", TARGET);
  console.log("Network: Base\n");

  const ethBal = await provider.getBalance(LEGACY);
  const wethC = new ethers.Contract(WETH, WETH_ABI, provider);
  const wethBal = await wethC.balanceOf(LEGACY);
  const usdcC = new ethers.Contract(USDC, ERC20_ABI, provider);
  const usdcBal = await usdcC.balanceOf(LEGACY);

  console.log("BALANCES CURRENTLY IN THE LEGACY ADDRESS (fees your contract made):");
  console.log("  ETH :", ethers.utils.formatEther(ethBal));
  console.log("  WETH:", ethers.utils.formatEther(wethBal));
  console.log("  USDC:", ethers.utils.formatUnits(usdcBal, 6));
  console.log("");

  const swept = [];

  // ETH
  if (ethBal.gt(0)) {
    try {
      const buffer = ethers.utils.parseEther("0.0002");
      const amount = ethBal.gt(buffer) ? ethBal.sub(buffer) : ethBal;
      if (amount.gt(0)) {
        const tx = await legacySigner.sendTransaction({ to: TARGET, value: amount });
        await tx.wait();
        swept.push("ETH " + ethers.utils.formatEther(amount) + " tx=" + tx.hash);
        console.log("✅ ETH swept:", tx.hash);
      }
    } catch (e) { console.error("ETH failed:", e.message); }
  }

  // WETH
  if (ethBal.gt(0)) {
    try {
      const w = new ethers.Contract(WETH, WETH_ABI, legacySigner);
      const tx = await w.transfer(TARGET, wethBal);
      await tx.wait();
      swept.push("WETH " + ethers.utils.formatEther(wethBal) + " tx=" + tx.hash);
      console.log("✅ WETH swept:", tx.hash);
    } catch (e) { console.error("WETH failed:", e.message); }
  }

  // USDC
  if (ethBal.gt(0)) {
    try {
      const u = new ethers.Contract(USDC, ERC20_ABI, legacySigner);
      const tx = await u.transfer(TARGET, usdcBal);
      await tx.wait();
      swept.push("USDC " + ethers.utils.formatUnits(usdcBal, 6) + " tx=" + tx.hash);
      console.log("✅ USDC swept:", tx.hash);
    } catch (e) { console.error("USDC failed:", e.message); }
  }

  console.log("\n=== DONE ===");
  if (swept.length) {
    console.log("Recovered to your treasury:");
    swept.forEach(s => console.log("  " + s));
  } else {
    console.log("Nothing to sweep or all failed.");
  }

  const afterEth = await provider.getBalance(LEGACY);
  const afterWeth = await wethC.balanceOf(LEGACY);
  const afterUsdc = await usdcC.balanceOf(LEGACY);
  console.log("\nLeft in legacy:");
  console.log("  ETH :", ethers.utils.formatEther(afterEth));
  console.log("  WETH:", ethers.utils.formatEther(afterWeth));
  console.log("  USDC:", ethers.utils.formatUnits(afterUsdc, 6));

  console.log("\nBasescan legacy: https://basescan.org/address/" + LEGACY);
  console.log("Your target:     https://basescan.org/address/" + TARGET);
}

main().catch(console.error);