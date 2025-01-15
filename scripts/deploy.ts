import { ethers, upgrades } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);

  // Deploy factory contract
  const LaunchPoolFactory = await ethers.getContractFactory(
    "LaunchPoolFactoryUpgradeable"
  );
  console.log("Deploying LaunchPoolFactory...");

  // Deploy using UUPS proxy pattern
  const factory = await upgrades.deployProxy(LaunchPoolFactory, [], {
    initializer: "initialize",
    kind: "uups",
  });

  await factory.waitForDeployment();
  console.log(
    "LaunchPoolFactory proxy deployed to:",
    await factory.getAddress()
  );

  // Get implementation contract address
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(
    await factory.getAddress()
  );
  console.log(
    "LaunchPoolFactory implementation deployed to:",
    implementationAddress
  );

  // Get proxy admin address
  const adminAddress = await upgrades.erc1967.getAdminAddress(
    await factory.getAddress()
  );
  console.log("LaunchPoolFactory proxy admin:", adminAddress);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
