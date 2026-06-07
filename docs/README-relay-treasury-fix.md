# Relay Treasury Fix: Funds Not Returning to Treasury

## Problem
Based on your transaction screenshot, I can see that funds are being sent to `0x330293E325E7163faaa0602e8f8e6Bc258101445` but you're not seeing returns in your treasury. This indicates that the BaseRelayV3 contract was deployed with an incorrect treasury address.

## Root Cause
The BaseRelayV3 contract has an `immutable TREASURY` address that's set during deployment. The contract is working correctly, but it's sending fees to the wrong address because the treasury address was set incorrectly.

## Solution
You need to deploy a new BaseRelayV3 contract with your correct treasury address and update the BotCompatibilityProxy to point to it.

## Steps to Fix

### 1. Set Your Treasury Address
First, set your correct treasury address in your environment:
```bash
export TREASURY_ADDRESS=0xYOUR_CORRECT_TREASURY_ADDRESS
```

### 2. Deploy New Relay Contract
Deploy the new relay contract with the correct treasury address:
```bash
npx hardhat run scripts/deploy-relay-with-treasury.ts --network baseSepolia
```

### 3. Update Frontend
Update your frontend to use the new proxy contract address that will be output in the deployment summary.

### 4. (Optional) Migrate Users
If you have users on the old contract, you can run the migration script:
```bash
export OLD_PROXY_ADDRESS=0xOLD_PROXY_ADDRESS
export NEW_PROXY_ADDRESS=0xNEW_PROXY_ADDRESS
npx hardhat run scripts/migrate-to-new-relay.ts --network baseSepolia
```

## Verification
After deployment, verify that:
1. The new relay contract has your correct treasury address
2. The proxy contract points to the new relay
3. Test a swap to ensure fees go to your correct treasury

## Important Notes
- The old contract will continue to send fees to the incorrect address
- Users need to be migrated to the new contract
- The treasury address is immutable, so you cannot change it after deployment

## Contact Support
If you need help with the deployment or have questions, contact the development team with the transaction details and deployment output.