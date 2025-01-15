import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { Contract } from "ethers";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
  LaunchPoolFactoryUpgradeable,
  MockToken,
  LaunchPoolFactoryV2,
  LaunchPoolFactoryV3,
  LaunchPool,
} from "../typechain-types";

describe("LaunchPoolFactoryUpgradeable", function () {
  async function deployFixture() {
    const [owner, projectOwner, user] = await ethers.getSigners();

    // Deploy mock tokens
    const MockToken = await ethers.getContractFactory("MockToken");
    const rewardToken = await MockToken.deploy();
    await rewardToken.waitForDeployment();

    const testToken = await MockToken.deploy();
    await testToken.waitForDeployment();

    // Deploy factory with UUPS proxy
    const Factory = await ethers.getContractFactory(
      "LaunchPoolFactoryUpgradeable"
    );
    const factory = (await upgrades.deployProxy(Factory, [], {
      initializer: "initialize",
      kind: "uups",
    })) as LaunchPoolFactoryUpgradeable;

    const proxyAddress = await factory.getAddress();

    return {
      factory,
      rewardToken,
      testToken,
      owner,
      projectOwner,
      user,
      proxyAddress,
    };
  }

  describe("Initialization", function () {
    it("Should set the right owner", async function () {
      const { factory, owner } = await loadFixture(deployFixture);
      expect(await factory.owner()).to.equal(owner.address);
    });

    it("Should initialize with version 1", async function () {
      const { factory } = await loadFixture(deployFixture);
      expect(await factory.CURRENT_VERSION()).to.equal(1);
    });
  });

  describe("Project and Pool Creation", function () {
    it("Should create new project with initial pool", async function () {
      const { factory, rewardToken, testToken, owner, projectOwner } =
        await loadFixture(deployFixture);

      const now = await time.latest();
      const startTime = now + 100;
      const endTime = startTime + 3600;

      const metadata = {
        projectName: "Test Project",
        website: "https://test.com",
        logo: "https://test.com/logo.png",
        discord: "https://discord.gg/test",
        twitter: "https://twitter.com/test",
        telegram: "https://t.me/test",
        tokenInfo: "Test Token Info",
      };

      const initialPool = {
        stakedToken: testToken,
        poolRewardAmount: ethers.parseEther("360"),
        poolLimitPerUser: ethers.parseEther("100"),
        minStakeAmount: ethers.parseEther("10"),
      };

      await expect(
        factory.createProject(
          rewardToken,
          ethers.parseEther("360"),
          startTime,
          endTime,
          metadata,
          initialPool,
          projectOwner.address
        )
      )
        .to.emit(factory, "NewProject")
        .to.emit(factory, "NewLaunchPool")
        .to.emit(factory, "ProjectStatusUpdated")
        .withArgs(0, 0); // STAGING status

      const projectId = (await factory.nextProjectId()) - 1n;
      const poolInfos = await factory.getProjectPools(projectId);
      expect(poolInfos.length).to.equal(1);
      expect(poolInfos[0].stakedToken).to.equal(await testToken.getAddress());
      expect(poolInfos[0].rewardToken).to.equal(await rewardToken.getAddress());
      expect(poolInfos[0].poolLimitPerUser).to.equal(ethers.parseEther("100"));
      expect(poolInfos[0].minStakeAmount).to.equal(ethers.parseEther("10"));
      expect(await factory.getProjectStatus(projectId)).to.equal("STAGING");
      expect(await factory.getProjectOwner(projectId)).to.equal(
        projectOwner.address
      );
    });
  });

  describe("Upgrade", function () {
    it("Should allow owner to upgrade", async function () {
      const { factory, proxyAddress } = await loadFixture(deployFixture);
      const Factory = await ethers.getContractFactory(
        "LaunchPoolFactoryUpgradeable"
      );
      const upgraded = await upgrades.upgradeProxy(proxyAddress, Factory);
      expect(await upgraded.getAddress()).to.equal(proxyAddress);
    });

    it("Should prevent non-owner from upgrading", async function () {
      const { user, proxyAddress } = await loadFixture(deployFixture);
      const Factory = await ethers.getContractFactory(
        "LaunchPoolFactoryUpgradeable",
        user
      );
      await expect(
        upgrades.upgradeProxy(proxyAddress, Factory)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("Should successfully upgrade to V2, maintain old state, and support V2 pools", async function () {
      const { factory, rewardToken, testToken, owner, proxyAddress } =
        await loadFixture(deployFixture);

      // Create a project before upgrade
      const block = await ethers.provider.getBlock("latest");
      if (!block) throw new Error("Failed to get latest block");
      const currentTime = block.timestamp;
      const startTime = currentTime + 3600;
      const endTime = startTime + 86400;

      await factory.createProject(
        rewardToken,
        ethers.parseEther("1000"),
        startTime,
        endTime,
        {
          projectName: "Test Project",
          website: "https://test.com",
          logo: "logo.png",
          discord: "discord.gg/test",
          twitter: "twitter.com/test",
          telegram: "t.me/test",
          tokenInfo: "Test token info",
        },
        {
          stakedToken: testToken,
          poolRewardAmount: ethers.parseEther("100"),
          poolLimitPerUser: ethers.parseEther("10"),
          minStakeAmount: ethers.parseEther("1"),
        },
        owner.address
      );

      const projectIdBefore = await factory.nextProjectId();

      // Deploy V2 implementation
      const FactoryV2 = await ethers.getContractFactory("LaunchPoolFactoryV2");
      const upgradedFactory = (await upgrades.upgradeProxy(
        proxyAddress,
        FactoryV2
      )) as LaunchPoolFactoryV2;
      await upgradedFactory.waitForDeployment();

      // Call initialize after upgrade to trigger V2 initialization
      await upgradedFactory.initialize();

      // Verify proxy address remains the same
      expect(await upgradedFactory.getAddress()).to.equal(proxyAddress);

      // Verify old state is preserved
      expect(await upgradedFactory.nextProjectId()).to.equal(projectIdBefore);
      expect(await upgradedFactory.owner()).to.equal(owner.address);

      // Test V2 functionality - project limits
      await upgradedFactory.setMaxProjectsPerOwner(2);
      expect(await upgradedFactory.maxProjectsPerOwner()).to.equal(2);

      // Enable V2 pools
      await upgradedFactory.setUseV2Pools(true);
      expect(await upgradedFactory.useV2Pools()).to.be.true;

      // Create another project with V2 pool (should succeed as under limit)
      await upgradedFactory.createProject(
        rewardToken,
        ethers.parseEther("1000"),
        startTime,
        endTime,
        {
          projectName: "Test Project 2",
          website: "https://test2.com",
          logo: "logo2.png",
          discord: "discord.gg/test2",
          twitter: "twitter.com/test2",
          telegram: "t.me/test2",
          tokenInfo: "Test token info 2",
        },
        {
          stakedToken: testToken,
          poolRewardAmount: ethers.parseEther("100"),
          poolLimitPerUser: ethers.parseEther("10"),
          minStakeAmount: ethers.parseEther("1"),
        },
        owner.address
      );

      // Get the pool address and verify it's a V2 pool
      const projectId = (await upgradedFactory.nextProjectId()) - 1n;
      const poolInfos = await upgradedFactory.getProjectPools(projectId);
      const LaunchPoolV2 = await ethers.getContractFactory("LaunchPoolV2");
      const v2Pool = LaunchPoolV2.attach(
        poolInfos[0].poolAddress
      ) as Contract & {
        getParticipationStats(): Promise<[bigint, bigint]>;
      };

      // Verify V2 specific features
      const [current, maximum] = await v2Pool.getParticipationStats();
      expect(current).to.equal(0);
      expect(maximum).to.equal(100); // Default max participants

      // Try to create one more project (should fail as reached limit)
      await expect(
        upgradedFactory.createProject(
          rewardToken,
          ethers.parseEther("1000"),
          startTime,
          endTime,
          {
            projectName: "Test Project 3",
            website: "https://test3.com",
            logo: "logo3.png",
            discord: "discord.gg/test3",
            twitter: "twitter.com/test3",
            telegram: "t.me/test3",
            tokenInfo: "Test token info 3",
          },
          {
            stakedToken: testToken,
            poolRewardAmount: ethers.parseEther("100"),
            poolLimitPerUser: ethers.parseEther("10"),
            minStakeAmount: ethers.parseEther("1"),
          },
          owner.address
        )
      ).to.be.revertedWith("Too many projects");
    });
  });

  describe("Pool Version Management", function () {
    async function createPoolFixture() {
      const { factory, rewardToken, testToken, owner } = await loadFixture(
        deployFixture
      );

      const block = await ethers.provider.getBlock("latest");
      if (!block) throw new Error("Failed to get latest block");
      const startTime = block.timestamp + 3600;
      const endTime = startTime + 86400;

      const tx = await factory.createProject(
        rewardToken,
        ethers.parseEther("1000"),
        startTime,
        endTime,
        {
          projectName: "Test Project",
          website: "https://test.com",
          logo: "logo.png",
          discord: "discord.gg/test",
          twitter: "twitter.com/test",
          telegram: "t.me/test",
          tokenInfo: "Test token info",
        },
        {
          stakedToken: testToken,
          poolRewardAmount: ethers.parseEther("100"),
          poolLimitPerUser: ethers.parseEther("10"),
          minStakeAmount: ethers.parseEther("1"),
        },
        owner.address
      );

      const receipt = await tx.wait();
      if (!receipt) throw new Error("No receipt");

      const event = receipt.logs.find((log: any) => {
        const decoded = factory.interface.parseLog(log);
        return decoded?.name === "NewLaunchPool";
      });

      if (!event) throw new Error("Event not found");
      const decoded = factory.interface.parseLog(event);
      if (!decoded) throw new Error("Failed to decode event");
      const poolAddress = decoded.args[1];

      return { factory, poolAddress };
    }

    it("Should track pool version", async function () {
      const { factory, poolAddress } = await loadFixture(createPoolFixture);
      expect(await factory.getPoolVersion(poolAddress)).to.equal(1);
    });

    it("Should verify pool is from factory", async function () {
      const { factory, poolAddress } = await loadFixture(createPoolFixture);
      expect(await factory.isPoolFromFactory(poolAddress)).to.be.true;
    });

    it("Should reject non-existent pool version query", async function () {
      const { factory } = await loadFixture(createPoolFixture);
      await expect(
        factory.getPoolVersion(ethers.ZeroAddress)
      ).to.be.revertedWith("Pool not found");
    });
  });

  describe("State Preservation", function () {
    it("Should preserve state after upgrade", async function () {
      const { factory, rewardToken, testToken, owner, proxyAddress } =
        await loadFixture(deployFixture);

      // Create a project before upgrade
      const block = await ethers.provider.getBlock("latest");
      if (!block) throw new Error("Failed to get latest block");
      const startTime = block.timestamp + 3600;
      const endTime = startTime + 86400;

      await factory.createProject(
        rewardToken,
        ethers.parseEther("1000"),
        startTime,
        endTime,
        {
          projectName: "Test Project",
          website: "https://test.com",
          logo: "logo.png",
          discord: "discord.gg/test",
          twitter: "twitter.com/test",
          telegram: "t.me/test",
          tokenInfo: "Test token info",
        },
        {
          stakedToken: testToken,
          poolRewardAmount: ethers.parseEther("100"),
          poolLimitPerUser: ethers.parseEther("10"),
          minStakeAmount: ethers.parseEther("1"),
        },
        owner.address
      );

      const projectIdBefore = await factory.nextProjectId();

      // Upgrade contract
      const Factory = await ethers.getContractFactory(
        "LaunchPoolFactoryUpgradeable"
      );
      const upgraded = await upgrades.upgradeProxy(proxyAddress, Factory);

      // Verify state is preserved
      expect(await upgraded.nextProjectId()).to.equal(projectIdBefore);
      expect(await upgraded.owner()).to.equal(owner.address);
    });
  });

  describe("Multiple Upgrades", function () {
    it("Should maintain LaunchPool ownership after upgrade", async function () {
      const {
        factory,
        rewardToken,
        testToken,
        owner,
        projectOwner,
        user,
        proxyAddress,
      } = await loadFixture(deployFixture);

      // Create project with pool in V1
      const now = await time.latest();
      const startTime = now + 100;
      const endTime = startTime + 3600;

      const metadata = {
        projectName: "Test Project",
        website: "https://test.com",
        logo: "logo.png",
        discord: "discord.gg/test",
        twitter: "twitter.com/test",
        telegram: "t.me/test",
        tokenInfo: "Test token info",
      };

      const initialPool = {
        stakedToken: testToken,
        poolRewardAmount: ethers.parseEther("100"),
        poolLimitPerUser: ethers.parseEther("10"),
        minStakeAmount: ethers.parseEther("1"),
      };

      const totalReward = ethers.parseEther("100");
      await factory.createProject(
        rewardToken,
        totalReward,
        startTime,
        endTime,
        metadata,
        {
          ...initialPool,
          poolRewardAmount: totalReward, // Make pool reward match total reward
        },
        projectOwner.address
      );

      const projectId = (await factory.nextProjectId()) - 1n;
      const poolInfos = await factory.getProjectPools(projectId);
      const LaunchPool = await ethers.getContractFactory("LaunchPool");
      const launchPool = LaunchPool.attach(
        poolInfos[0].poolAddress
      ) as LaunchPool;

      // Upgrade to V2
      const FactoryV2 = await ethers.getContractFactory("LaunchPoolFactoryV2");
      const upgradedFactory = (await upgrades.upgradeProxy(
        proxyAddress,
        FactoryV2
      )) as LaunchPoolFactoryV2;
      await upgradedFactory.waitForDeployment();
      await upgradedFactory.initialize();

      // Fund the pool first
      await rewardToken.mint(projectOwner.address, totalReward);
      await rewardToken
        .connect(projectOwner)
        .approve(await upgradedFactory.getAddress(), ethers.parseEther("100"));
      await upgradedFactory
        .connect(projectOwner)
        .fundPool(
          projectId,
          poolInfos[0].poolAddress,
          ethers.parseEther("100")
        );

      // Transfer project ownership after funding
      await upgradedFactory
        .connect(projectOwner)
        .transferProjectOwnership(projectId, user.address);

      // Status should be READY after funding
      expect(await upgradedFactory.getProjectStatus(projectId)).to.equal(
        "READY"
      );

      // Test actions in READY state
      await expect(
        launchPool.connect(user).updateMinStakeAmount(ethers.parseEther("2"))
      ).to.not.be.reverted;

      await expect(
        launchPool
          .connect(user)
          .updatePoolLimitPerUser(true, ethers.parseEther("20"))
      ).to.not.be.reverted;

      // Test actions in ACTIVE state (status changes to ACTIVE after startTime)
      await time.increaseTo(startTime);
      expect(await upgradedFactory.getProjectStatus(projectId)).to.equal(
        "ACTIVE"
      );
      await expect(launchPool.connect(user).stopReward()).to.not.be.reverted;

      // Test actions in PAUSED state
      await upgradedFactory.connect(user).updateProjectStatus(projectId, 3); // ACTIVE -> PAUSED

      await expect(
        launchPool
          .connect(user)
          .emergencyRewardWithdraw(ethers.parseEther("100"))
      ).to.not.be.reverted;

      // Verify old owner cannot perform admin actions
      await expect(
        launchPool
          .connect(projectOwner)
          .updateMinStakeAmount(ethers.parseEther("2"))
      ).to.be.revertedWith("Not project owner");

      await expect(
        launchPool
          .connect(projectOwner)
          .updatePoolLimitPerUser(true, ethers.parseEther("20"))
      ).to.be.revertedWith("Not project owner");

      await expect(
        launchPool.connect(projectOwner).stopReward()
      ).to.be.revertedWith("Not project owner");

      await expect(
        launchPool
          .connect(projectOwner)
          .emergencyRewardWithdraw(ethers.parseEther("100"))
      ).to.be.revertedWith("Not project owner");
    });

    it("Should successfully upgrade from V2 to V3", async function () {
      const { factory, rewardToken, testToken, owner, proxyAddress } =
        await loadFixture(deployFixture);

      // First upgrade to V2
      const FactoryV2 = await ethers.getContractFactory("LaunchPoolFactoryV2");
      const upgradedToV2 = (await upgrades.upgradeProxy(
        proxyAddress,
        FactoryV2
      )) as LaunchPoolFactoryV2;
      await upgradedToV2.waitForDeployment();
      await upgradedToV2.initialize();

      // Set V2 specific parameter
      await upgradedToV2.setMaxProjectsPerOwner(2);

      // Then upgrade to V3
      const FactoryV3 = await ethers.getContractFactory("LaunchPoolFactoryV3");
      const upgradedToV3 = (await upgrades.upgradeProxy(
        proxyAddress,
        FactoryV3
      )) as LaunchPoolFactoryV3;
      await upgradedToV3.waitForDeployment();
      await upgradedToV3.initialize();

      // Verify V2 state is preserved
      expect(await upgradedToV3.maxProjectsPerOwner()).to.equal(2);

      // Test V3 functionality
      const now = await time.latest();
      const startTime = now + 100;
      const endTime = startTime + 3600;

      const metadata = {
        projectName: "Test Project",
        website: "https://test.com",
        logo: "logo.png",
        discord: "discord.gg/test",
        twitter: "twitter.com/test",
        telegram: "t.me/test",
        tokenInfo: "Test token info",
      };

      const initialPool = {
        stakedToken: testToken,
        poolRewardAmount: ethers.parseEther("100"),
        poolLimitPerUser: ethers.parseEther("10"),
        minStakeAmount: ethers.parseEther("1"),
      };

      // Create first project
      await upgradedToV3.createProject(
        rewardToken,
        ethers.parseEther("1000"),
        startTime,
        endTime,
        metadata,
        initialPool,
        owner.address
      );

      // Try to create second project with start time too soon
      await expect(
        upgradedToV3.createProject(
          rewardToken,
          ethers.parseEther("1000"),
          startTime,
          endTime,
          metadata,
          initialPool,
          owner.address
        )
      ).to.be.revertedWith("Must wait before creating new project");

      // Update min project interval
      await upgradedToV3.setMinProjectInterval(60); // 1 minute

      // Create second project with longer interval
      await upgradedToV3.createProject(
        rewardToken,
        ethers.parseEther("1000"),
        startTime + 3600, // 1 hour later
        endTime + 3600,
        metadata,
        initialPool,
        owner.address
      );
    });
  });
});
