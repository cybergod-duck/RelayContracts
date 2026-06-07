import { ethers } from "ethers";

async function main() {
  // Connect to Base Sepolia
  const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
  
  // The BaseRelayV3 contract address
  const relayAddress = "0x0382f917af966354D79485D7A4e8322b3A6f4f15";
  
  console.log("Checking BaseRelayV3 contract:", relayAddress);

  try {
    // Get contract balance
    const contractBalance = await provider.getBalance(relayAddress);
    console.log("\n💰 BASE RELAY V3 BALANCE:");
    console.log("ETH:", ethers.formatEther(contractBalance), "ETH");
    console.log("Wei:", contractBalance.toString());

    if (contractBalance > 0) {
      console.log("\n🔥 FUNDS FOUND IN RELAY CONTRACT!");
      console.log("================================");
      console.log("These are the fees that should be going to your treasury.");
      console.log("You need the private key for the relay contract to capture them.");
      console.log("Contact your development team for the relay contract private key.");
    } else {
      console.log("\n❌ No funds found in BaseRelayV3 contract.");
      console.log("The funds may have been sent to the wrong treasury address");
      console.log("or there was an error in the fee calculation.");
    }
  } catch (error) {
    console.error("Error checking relay contract:", error);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});