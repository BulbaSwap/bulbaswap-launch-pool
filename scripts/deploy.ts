import { ethers, upgrades, run } from "hardhat";

async function verifyContract(
  address: string,
  constructorArguments: any[] = [],
  contract?: string
) {
  console.log(`\n${"-".repeat(80)}`);
  console.log(
    `Verifying contract${contract ? ` ${contract}` : ""} at ${address}`
  );
  try {
    await run("verify:verify", {
      address,
      constructorArguments,
    });
    console.log("✅ Verification successful");
    console.log(
      `🔍 View on explorer: https://explorer-holesky.morphl2.io/address/${address}#code`
    );
  } catch (error: any) {
    if (error.message.includes("Already Verified")) {
      console.log("ℹ️  Contract is already verified");
      console.log(
        `🔍 View on explorer: https://explorer-holesky.morphl2.io/address/${address}#code`
      );
    } else {
      console.error("❌ Error verifying contract:", error);
    }
  }
}

async function main() {
  console.log("\n📝 Starting deployment process...\n");
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);

  // Get current gas price
  const feeData = await ethers.provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas! * 2n; // 2x maxFeePerGas
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas! * 2n; // 2x maxPriorityFeePerGas

  // Deploy LaunchPool implementation
  console.log("\n1️⃣  Deploying LaunchPool implementation...");
  console.log(
    `Using maxFeePerGas: ${ethers.formatUnits(maxFeePerGas, "gwei")} gwei`
  );
  console.log(
    `Using maxPriorityFeePerGas: ${ethers.formatUnits(
      maxPriorityFeePerGas,
      "gwei"
    )} gwei`
  );

  const LaunchPool = await ethers.getContractFactory("LaunchPool");
  const launchPoolImpl = await LaunchPool.deploy({
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  await launchPoolImpl.waitForDeployment();
  const launchPoolImplAddress = await launchPoolImpl.getAddress();
  console.log("LaunchPool implementation deployed to:", launchPoolImplAddress);

  // Wait for block confirmations
  console.log("\nWaiting for block confirmations...");
  await launchPoolImpl.deploymentTransaction()?.wait(5);

  // Deploy factory contract
  console.log("\n2️⃣  Deploying LaunchPoolFactory...");
  const LaunchPoolFactory = await ethers.getContractFactory(
    "LaunchPoolFactoryUpgradeable"
  );

  // Deploy using UUPS proxy pattern
  const factory = await upgrades.deployProxy(
    LaunchPoolFactory,
    [launchPoolImplAddress],
    {
      initializer: "initialize",
      kind: "uups",
      constructorArgs: [],
      timeout: 0,
      pollingInterval: 5000,
      useDeployedImplementation: false,
      txOverrides: {
        maxFeePerGas,
        maxPriorityFeePerGas,
      },
    }
  );

  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("LaunchPoolFactory proxy deployed to:", factoryAddress);

  // Get implementation contract address
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(
    factoryAddress
  );
  console.log(
    "LaunchPoolFactory implementation deployed to:",
    implementationAddress
  );

  // Wait for block confirmations
  console.log("\nWaiting for block confirmations...");
  await factory.deploymentTransaction()?.wait(5);

  // Verify contracts
  console.log("\n3️⃣  Starting contract verification...");

  // Verify LaunchPool implementation
  await verifyContract(launchPoolImplAddress, [], "LaunchPool Implementation");

  // Verify Factory implementation
  await verifyContract(
    implementationAddress,
    [],
    "LaunchPoolFactory Implementation"
  );

  // Verify Factory proxy
  console.log(`\n${"-".repeat(80)}`);
  console.log(`Verifying Factory Proxy at ${factoryAddress}`);
  try {
    // Verify proxy contract
    await run("verify:verify", {
      address: factoryAddress,
      constructorArguments: [],
    });
    console.log("✅ Proxy verification successful");
    console.log(
      `🔍 View on explorer: https://explorer-holesky.morphl2.io/address/${factoryAddress}#code`
    );
  } catch (error: any) {
    if (error.message.includes("Already Verified")) {
      console.log("ℹ️  Proxy is already verified");
      console.log(
        `🔍 View on explorer: https://explorer-holesky.morphl2.io/address/${factoryAddress}#code`
      );
    } else if (error.message.includes("Reason: Proxy implementation")) {
      // Proxy is verified but needs to be linked with implementation
      console.log("✅ Proxy verification successful");
      console.log(
        `🔍 View on explorer: https://explorer-holesky.morphl2.io/address/${factoryAddress}#code`
      );
    } else {
      console.error("❌ Error verifying proxy:", error);
    }
  }

  // Summary
  console.log("\n📋 Deployment Summary");
  console.log("=".repeat(80));
  console.log("Contract Addresses:");
  console.log("- LaunchPool Implementation:", launchPoolImplAddress);
  console.log("- Factory Proxy:", factoryAddress);
  console.log("- Factory Implementation:", implementationAddress);
  console.log("\nExplorer Links:");
  console.log(
    `- LaunchPool Implementation: https://explorer-holesky.morphl2.io/address/${launchPoolImplAddress}#code`
  );
  console.log(
    `- Factory Proxy: https://explorer-holesky.morphl2.io/address/${factoryAddress}#code`
  );
  console.log(
    `- Factory Implementation: https://explorer-holesky.morphl2.io/address/${implementationAddress}#code`
  );
  console.log("=".repeat(80));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
