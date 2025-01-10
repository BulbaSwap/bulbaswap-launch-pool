import { ethers } from "hardhat";
import { LaunchPoolFactory } from "../typechain-types";

async function main() {
  console.log("Starting deployment of LaunchPoolFactory...");

  // Get deployment account
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error(
      "No deployment account found. Please check if PRIVATE_KEY is correctly set in .env file"
    );
  }
  console.log("Deploying with account:", await deployer.getAddress());

  // Get current network gas price
  console.log("\nFetching network gas price...");
  const feeData = await ethers.provider.getFeeData();
  console.log("Current gas price:", {
    maxFeePerGas: feeData.maxFeePerGas?.toString(),
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString(),
    gasPrice: feeData.gasPrice?.toString(),
  });

  // Deploy LaunchPoolFactory
  const LaunchPoolFactory = await ethers.getContractFactory(
    "LaunchPoolFactory",
    deployer
  );

  console.log("\nDeploying contract...");
  const factory = await LaunchPoolFactory.deploy({
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
  });
  const deploymentTransaction = factory.deploymentTransaction();

  if (deploymentTransaction) {
    console.log("\n=== Transaction Info ===");
    console.log("Transaction hash:", deploymentTransaction.hash);
    console.log("From:", deploymentTransaction.from);
    console.log("Nonce:", deploymentTransaction.nonce);
    console.log("Gas price:", deploymentTransaction.gasPrice?.toString());
    console.log("Gas limit:", deploymentTransaction.gasLimit.toString());

    console.log("\nWaiting for confirmation...");
    const receipt = await deploymentTransaction.wait(5);
    if (receipt) {
      console.log("Transaction confirmed, block number:", receipt.blockNumber);
    }
  }

  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("\nLaunchPoolFactory deployed to:", factoryAddress);

  // Print verification info
  console.log("\n=== Contract Verification ===");
  console.log(
    "npx hardhat verify --network",
    process.env.HARDHAT_NETWORK,
    factoryAddress
  );

  // Save deployment info
  console.log("\n=== Deployment Info ===");
  console.log({
    network: process.env.HARDHAT_NETWORK,
    factory: factoryAddress,
    deployer: await deployer.getAddress(),
  });
}

// Execute deployment script
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
