import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
  LaunchPool,
  LaunchPoolV2,
  LaunchPoolFactoryUpgradeable,
  LaunchPoolFactoryV2,
  LaunchPoolFactoryV3,
  MockToken,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

type InitialPoolParams = {
  stakedToken: MockToken;
  poolRewardAmount: bigint;
  poolLimitPerUser: bigint;
  minStakeAmount: bigint;
};

describe("LaunchPoolFactoryUpgradeable (Upgrades)", function () {
  async function deployV1Fixture() {
    const [owner, projectOwner, user] = await ethers.getSigners();

    // Deploy LaunchPool implementation
    const LaunchPool = await ethers.getContractFactory("LaunchPool");
    const launchPoolImpl = await LaunchPool.deploy();
    await launchPoolImpl.waitForDeployment();

    // Deploy factory contract with UUPS proxy
    const Factory = await ethers.getContractFactory(
      "LaunchPoolFactoryUpgradeable"
    );
    const factory = (await upgrades.deployProxy(
      Factory,
      [await launchPoolImpl.getAddress()],
      {
        initializer: "initialize",
        kind: "uups",
      }
    )) as LaunchPoolFactoryUpgradeable;

    // Deploy token contracts for testing
    const MockToken = await ethers.getContractFactory("MockToken");
    const rewardToken = await MockToken.deploy();
    const testToken = await MockToken.deploy();

    return {
      factory,
      launchPoolImpl,
      rewardToken,
      testToken,
      owner,
      projectOwner,
      user,
    };
  }

  describe("V1 to V2 Upgrade", function () {
    it("Should upgrade to V2 and initialize correctly", async function () {
      const { factory, owner, projectOwner } = await loadFixture(
        deployV1Fixture
      );

      // Deploy LaunchPoolV2 implementation
      const LaunchPoolV2 = await ethers.getContractFactory("LaunchPoolV2");
      const launchPoolV2Impl = await LaunchPoolV2.deploy();
      await launchPoolV2Impl.waitForDeployment();

      // Upgrade to V2
      const FactoryV2 = await ethers.getContractFactory("LaunchPoolFactoryV2");
      const factoryV2 = (await upgrades.upgradeProxy(
        await factory.getAddress(),
        FactoryV2
      )) as LaunchPoolFactoryV2;

      // Initialize V2
      await factoryV2.initialize(await launchPoolV2Impl.getAddress());

      // Verify V2 state
      expect(await factoryV2.maxProjectsPerOwner()).to.equal(2);
      expect(await factoryV2.useV2Pools()).to.equal(false);
      expect(await factoryV2.launchPoolV2Implementation()).to.equal(
        await launchPoolV2Impl.getAddress()
      );
    });

    it("Should enforce project limit in V2", async function () {
      const { factory, rewardToken, testToken, owner, projectOwner } =
        await loadFixture(deployV1Fixture);

      // Deploy LaunchPoolV2 implementation
      const LaunchPoolV2 = await ethers.getContractFactory("LaunchPoolV2");
      const launchPoolV2Impl = await LaunchPoolV2.deploy();

      // Upgrade to V2
      const FactoryV2 = await ethers.getContractFactory("LaunchPoolFactoryV2");
      const factoryV2 = (await upgrades.upgradeProxy(
        await factory.getAddress(),
        FactoryV2
      )) as LaunchPoolFactoryV2;
      await factoryV2.initialize(await launchPoolV2Impl.getAddress());

      // Create first project
      const now = await time.latest();
      const metadata = {
        projectName: "Test",
        website: "test.com",
        logo: "test.com/logo.png",
        discord: "discord.gg/test",
        twitter: "twitter.com/test",
        telegram: "t.me/test",
        tokenInfo: "Test Token",
      };
      const emptyPools: InitialPoolParams[] = [];

      // Should allow creating up to maxProjectsPerOwner projects
      await factoryV2.createProject(
        rewardToken,
        1000n,
        now + 100,
        now + 3600,
        metadata,
        emptyPools,
        projectOwner.address
      );

      await factoryV2.createProject(
        rewardToken,
        1000n,
        now + 100,
        now + 3600,
        metadata,
        emptyPools,
        projectOwner.address
      );

      // Third project should fail
      await expect(
        factoryV2.createProject(
          rewardToken,
          1000n,
          now + 100,
          now + 3600,
          metadata,
          emptyPools,
          projectOwner.address
        )
      ).to.be.revertedWith("Too many projects");
    });
  });

  describe("V2 to V3 Upgrade", function () {
    async function deployV2Fixture() {
      const { factory, rewardToken, testToken, owner, projectOwner, user } =
        await loadFixture(deployV1Fixture);

      // Deploy LaunchPoolV2 implementation
      const LaunchPoolV2 = await ethers.getContractFactory("LaunchPoolV2");
      const launchPoolV2Impl = await LaunchPoolV2.deploy();

      // Upgrade to V2
      const FactoryV2 = await ethers.getContractFactory("LaunchPoolFactoryV2");
      const factoryV2 = (await upgrades.upgradeProxy(
        await factory.getAddress(),
        FactoryV2
      )) as LaunchPoolFactoryV2;
      await factoryV2.initialize(await launchPoolV2Impl.getAddress());

      return {
        factoryV2,
        launchPoolV2Impl,
        rewardToken,
        testToken,
        owner,
        projectOwner,
        user,
      };
    }

    it("Should upgrade to V3 and initialize correctly", async function () {
      const { factoryV2, owner } = await loadFixture(deployV2Fixture);

      // Upgrade to V3
      const FactoryV3 = await ethers.getContractFactory("LaunchPoolFactoryV3");
      const factoryV3 = (await upgrades.upgradeProxy(
        await factoryV2.getAddress(),
        FactoryV3
      )) as LaunchPoolFactoryV3;

      // Initialize V3
      await factoryV3.initializeV3();

      // Verify V3 state
      expect(await factoryV3.minProjectInterval()).to.equal(24 * 60 * 60); // 1 day
    });

    it("Should enforce project interval in V3", async function () {
      const { factoryV2, rewardToken, owner, projectOwner } = await loadFixture(
        deployV2Fixture
      );

      // Upgrade to V3
      const FactoryV3 = await ethers.getContractFactory("LaunchPoolFactoryV3");
      const factoryV3 = (await upgrades.upgradeProxy(
        await factoryV2.getAddress(),
        FactoryV3
      )) as LaunchPoolFactoryV3;
      await factoryV3.initializeV3();

      const now = await time.latest();
      const metadata = {
        projectName: "Test",
        website: "test.com",
        logo: "test.com/logo.png",
        discord: "discord.gg/test",
        twitter: "twitter.com/test",
        telegram: "t.me/test",
        tokenInfo: "Test Token",
      };
      const emptyPools: InitialPoolParams[] = [];

      // Create first project
      await factoryV3.createProject(
        rewardToken,
        1000n,
        now + 100,
        now + 3600,
        metadata,
        emptyPools,
        projectOwner.address
      );

      // Second project with start time less than minProjectInterval should fail
      await expect(
        factoryV3.createProject(
          rewardToken,
          1000n,
          now + 100,
          now + 3600,
          metadata,
          emptyPools,
          projectOwner.address
        )
      ).to.be.revertedWith("Must wait before creating new project");

      // Second project with start time after minProjectInterval should succeed
      await factoryV3.createProject(
        rewardToken,
        1000n,
        now + 24 * 60 * 60 + 100, // After minProjectInterval
        now + 24 * 60 * 60 + 3600,
        metadata,
        emptyPools,
        projectOwner.address
      );
    });
  });
});
