import { ethers, upgrades } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Upgrading contracts with the account:", deployer.address);

  // Get current gas price
  const feeData = await ethers.provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas! * 2n; // 2x maxFeePerGas
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas! * 2n; // 2x maxPriorityFeePerGas

  console.log(
    `Using maxFeePerGas: ${ethers.formatUnits(maxFeePerGas, "gwei")} gwei`
  );
  console.log(
    `Using maxPriorityFeePerGas: ${ethers.formatUnits(
      maxPriorityFeePerGas,
      "gwei"
    )} gwei`
  );

  // Proxy address of the factory contract (replace with actual deployed address)
  const proxyAddress = "PROXY_ADDRESS";

  // First deploy LaunchPoolV2 implementation
  const LaunchPoolV2 = await ethers.getContractFactory("LaunchPoolV2");
  console.log("Deploying LaunchPoolV2 implementation...");
  const launchPoolV2Impl = await LaunchPoolV2.deploy({
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  await launchPoolV2Impl.waitForDeployment();
  console.log(
    "LaunchPoolV2 implementation deployed to:",
    await launchPoolV2Impl.getAddress()
  );

  // Upgrade to V2
  const LaunchPoolFactoryV2 = await ethers.getContractFactory(
    "LaunchPoolFactoryV2"
  );
  console.log("Upgrading to LaunchPoolFactoryV2...");
  const upgradedV2 = await upgrades.upgradeProxy(
    proxyAddress,
    LaunchPoolFactoryV2,
    {
      timeout: 0,
      pollingInterval: 5000,
      txOverrides: {
        maxFeePerGas,
        maxPriorityFeePerGas,
      },
    }
  );
  await upgradedV2.waitForDeployment();
  console.log(
    "LaunchPoolFactoryV2 upgraded at:",
    await upgradedV2.getAddress()
  );

  // Initialize V2 with LaunchPoolV2 implementation
  console.log("Initializing V2...");
  await upgradedV2.initialize(await launchPoolV2Impl.getAddress(), {
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  console.log("V2 initialized");

  // Upgrade to V3
  const LaunchPoolFactoryV3 = await ethers.getContractFactory(
    "LaunchPoolFactoryV3"
  );
  console.log("Upgrading to LaunchPoolFactoryV3...");
  const upgradedV3 = await upgrades.upgradeProxy(
    await upgradedV2.getAddress(),
    LaunchPoolFactoryV3,
    {
      timeout: 0,
      pollingInterval: 5000,
      txOverrides: {
        maxFeePerGas,
        maxPriorityFeePerGas,
      },
    }
  );
  await upgradedV3.waitForDeployment();
  console.log(
    "LaunchPoolFactoryV3 upgraded at:",
    await upgradedV3.getAddress()
  );

  // Initialize V3
  console.log("Initializing V3...");
  await upgradedV3.initializeV3({
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  console.log("V3 initialized");

  // Get final implementation address
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(
    await upgradedV3.getAddress()
  );
  console.log("Final implementation address:", implementationAddress);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
