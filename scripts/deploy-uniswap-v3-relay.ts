import { ethers, network } from "hardhat";

// Uniswap V3 Swap Router addresses
const ROUTERS: Record<string, string> = {
    baseMainnet: "0x2626664c2603f293e11065a55d650b3f8099176f",
    polygonMainnet: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    baseSepolia: "0x3b29C19f2f459e4554a7E0f7B24f1e8A124CefF4", // Standard Uniswap V3 SwapRouter on Base Sepolia
    arbitrumMainnet: "0xE592427A0AEce92De3Edee1F18E0157C05861564", // Standard Uniswap V3 SwapRouter on Arbitrum
    optimismMainnet: "0xE592427A0AEce92De3Edee1F18E0157C05861564", // Standard Uniswap V3 SwapRouter on Optimism
    bscMainnet: "0xB3F8688113AE7563809Ba837dc12daC54a03ccCd",      // Standard Uniswap V3 SwapRouter on BSC
    lineaMainnet: "0x2626664c2603f293e11065a55d650b3f8099176f"     // Standard Uniswap V3 SwapRouter on Linea
};

async function main(): Promise<void> {
    const signers = await ethers.getSigners();
    if (signers.length === 0) {
        console.error("ERROR: No signers found. Make sure DEPLOYER_PRIVATE_KEY is set in your environment.");
        process.exit(1);
    }

    const deployer = signers[0];
    const netName = network.name;
    const routerAddress = ROUTERS[netName];

    if (!routerAddress) {
        console.error(`ERROR: No Uniswap V3 SwapRouter address configured for network: ${netName}`);
        console.error("Available networks: baseMainnet, baseSepolia, polygonMainnet, arbitrumMainnet, optimismMainnet, bscMainnet, lineaMainnet");
        process.exit(1);
    }

    const treasury = process.env.TREASURY_ADDRESS || "0xA951A66b5800567035EEbcbBbf50A5B438761f97";

    console.log("=========================================");
    console.log("Deploying UniswapV3Relay");
    console.log("=========================================");
    console.log("Network:  ", netName);
    console.log("Deployer: ", deployer.address);
    console.log("Treasury: ", treasury);
    console.log("V3 Router:", routerAddress);
    console.log("");

    const UniswapV3Relay = await ethers.getContractFactory("UniswapV3Relay");
    const relay = await UniswapV3Relay.deploy(treasury, routerAddress);
    await relay.waitForDeployment();

    const deployedAddress = await relay.getAddress();

    console.log("=========================================");
    console.log("✅ UniswapV3Relay deployed successfully!");
    console.log("Address:", deployedAddress);
    console.log("DEPLOYMENT_SUCCESS: relay=" + deployedAddress + " proxy=" + deployedAddress);
    console.log("=========================================");
    console.log(`\nTo verify on explorer:`);
    console.log(`npx hardhat verify --network ${netName} ${deployedAddress} "${treasury}" "${routerAddress}"`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
