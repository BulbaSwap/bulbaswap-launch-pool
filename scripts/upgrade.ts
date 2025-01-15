import { ethers, upgrades } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Upgrading contracts with the account:", deployer.address);

  // Proxy address of the factory contract (replace with actual deployed address)
  const proxyAddress = "PROXY_ADDRESS";

  // Deploy new implementation contract
  const LaunchPoolFactory = await ethers.getContractFactory(
    "LaunchPoolFactoryUpgradeable"
  );
  console.log("Upgrading LaunchPoolFactory...");

  // Upgrade to new implementation
  const upgraded = await upgrades.upgradeProxy(proxyAddress, LaunchPoolFactory);
  await upgraded.waitForDeployment();

  console.log("LaunchPoolFactory upgraded at:", await upgraded.getAddress());

  // Get new implementation address
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(
    await upgraded.getAddress()
  );
  console.log("New implementation address:", implementationAddress);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
