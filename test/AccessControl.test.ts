import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
  LaunchPool,
  LaunchPoolFactoryUpgradeable,
  MockToken,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Access Control", function () {
  async function deployFixture() {
    const [owner, projectOwner, user1] = await ethers.getSigners();

    // Deploy LaunchPool implementation first
    const LaunchPoolFactory = await ethers.getContractFactory("LaunchPool");
    const launchPoolImpl = await LaunchPoolFactory.deploy();
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

    // Deploy tokens
    const MockToken = await ethers.getContractFactory("MockToken");
    const rewardToken = await MockToken.deploy();
    await rewardToken.waitForDeployment();

    const testToken = await MockToken.deploy();
    await testToken.waitForDeployment();

    // Set up timestamps
    const now = await time.latest();
    const startTime = now + 100;
    const endTime = startTime + 3600;

    // Create project with initial pool through factory
    const metadata = {
      projectName: "Test Project",
      website: "https://test.com",
      logo: "https://test.com/logo.png",
      discord: "https://discord.gg/test",
      twitter: "https://twitter.com/test",
      telegram: "https://t.me/test",
      tokenInfo: "Test Token Info",
    };

    const initialPools = [
      {
        stakedToken: testToken,
        poolRewardAmount: ethers.parseEther("360"),
        poolLimitPerUser: ethers.parseEther("100"),
        minStakeAmount: ethers.parseEther("10"),
      },
    ];

    await factory.createProject(
      rewardToken,
      ethers.parseEther("360"),
      startTime,
      endTime,
      metadata,
      initialPools,
      projectOwner.address
    );

    const projectId = (await factory.nextProjectId()) - 1n;
    const poolInfos = await factory.getProjectPools(projectId);
    const LaunchPoolContract = await ethers.getContractFactory("LaunchPool");
    const launchPool = LaunchPoolContract.attach(
      poolInfos[0].poolAddress
    ) as LaunchPool;

    // Mint and fund reward tokens
    await rewardToken.mint(projectOwner.address, ethers.parseEther("360"));
    await rewardToken
      .connect(projectOwner)
      .approve(await factory.getAddress(), ethers.parseEther("360"));
    await factory
      .connect(projectOwner)
      .fundPool(projectId, poolInfos[0].poolAddress, ethers.parseEther("360"));

    return {
      factory,
      rewardToken,
      testToken,
      launchPool,
      projectId,
      owner,
      projectOwner,
      user1,
      startTime,
      endTime,
    };
  }

  describe("LaunchPoolFactory Access Control", function () {
    let factory: LaunchPoolFactoryUpgradeable;
    let rewardToken: MockToken;
    let testToken: MockToken;
    let owner: HardhatEthersSigner;
    let projectOwner: HardhatEthersSigner;
    let user1: HardhatEthersSigner;

    beforeEach(async function () {
      ({ factory, rewardToken, testToken, owner, projectOwner, user1 } =
        await loadFixture(deployFixture));
    });

    it("Should not allow non-owner to create project", async function () {
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

      const emptyPools = [] as {
        stakedToken: MockToken;
        poolRewardAmount: bigint;
        poolLimitPerUser: bigint;
        minStakeAmount: bigint;
      }[];

      await expect(
        factory
          .connect(user1)
          .createProject(
            rewardToken,
            ethers.parseEther("360"),
            startTime,
            endTime,
            metadata,
            emptyPools,
            projectOwner.address
          )
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("Should allow owner to create project and project owner to add pool", async function () {
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

      const emptyPools = [] as {
        stakedToken: MockToken;
        poolRewardAmount: bigint;
        poolLimitPerUser: bigint;
        minStakeAmount: bigint;
      }[];

      await expect(
        factory.createProject(
          rewardToken,
          ethers.parseEther("360"),
          startTime,
          endTime,
          metadata,
          emptyPools,
          projectOwner.address
        )
      ).to.emit(factory, "NewProject");

      const projectId = (await factory.nextProjectId()) - 1n;

      await expect(
        factory.connect(projectOwner).addPoolToProject(
          projectId,
          testToken,
          ethers.parseEther("360"), // 0.1 tokens per second * 3600 seconds
          ethers.parseEther("100"),
          ethers.parseEther("10")
        )
      ).to.emit(factory, "NewLaunchPool");
    });

    it("Should only allow project owner to update project metadata", async function () {
      const projectId = (await factory.nextProjectId()) - 1n;

      const newMetadata = {
        projectName: "Updated Project",
        website: "https://updated.com",
        logo: "https://updated.com/logo.png",
        discord: "https://discord.gg/updated",
        twitter: "https://twitter.com/updated",
        telegram: "https://t.me/updated",
        tokenInfo: "Updated Token Info",
      };

      await expect(
        factory.connect(user1).updateProjectMetadata(projectId, newMetadata)
      ).to.be.revertedWith("Only project owner");

      await expect(
        factory
          .connect(projectOwner)
          .updateProjectMetadata(projectId, newMetadata)
      ).to.emit(factory, "PoolMetadataUpdated");
    });

    it("Should allow project ownership transfer", async function () {
      const projectId = (await factory.nextProjectId()) - 1n;

      await expect(
        factory
          .connect(user1)
          .transferProjectOwnership(projectId, user1.address)
      ).to.be.revertedWith("Only project owner");

      await expect(
        factory
          .connect(projectOwner)
          .transferProjectOwnership(projectId, user1.address)
      )
        .to.emit(factory, "ProjectOwnershipTransferred")
        .withArgs(projectId, projectOwner.address, user1.address);

      // After transfer, old owner should not be able to update metadata
      const newMetadata = {
        projectName: "Updated Project",
        website: "https://updated.com",
        logo: "https://updated.com/logo.png",
        discord: "https://discord.gg/updated",
        twitter: "https://twitter.com/updated",
        telegram: "https://t.me/updated",
        tokenInfo: "Updated Token Info",
      };

      await expect(
        factory
          .connect(projectOwner)
          .updateProjectMetadata(projectId, newMetadata)
      ).to.be.revertedWith("Only project owner");

      // New owner should be able to update metadata
      await expect(
        factory.connect(user1).updateProjectMetadata(projectId, newMetadata)
      ).to.emit(factory, "PoolMetadataUpdated");
    });
  });

  describe("LaunchPool Access Control", function () {
    let factory: LaunchPoolFactoryUpgradeable;
    let launchPool: LaunchPool;
    let projectId: bigint;
    let projectOwner: HardhatEthersSigner;
    let user1: HardhatEthersSigner;

    beforeEach(async function () {
      ({ factory, launchPool, projectId, projectOwner, user1 } =
        await loadFixture(deployFixture));
    });

    it("Should only allow project owner to update minimum stake amount", async function () {
      // Non-owner should not be able to update
      await expect(
        launchPool.connect(user1).updateMinStakeAmount(ethers.parseEther("20"))
      ).to.be.revertedWith("Not project owner");

      // Project owner should be able to set zero minimum stake
      await expect(launchPool.connect(projectOwner).updateMinStakeAmount(0))
        .to.emit(launchPool, "NewMinStakeAmount")
        .withArgs(0);

      // Project owner should be able to update to positive value
      await expect(
        launchPool
          .connect(projectOwner)
          .updateMinStakeAmount(ethers.parseEther("20"))
      )
        .to.emit(launchPool, "NewMinStakeAmount")
        .withArgs(ethers.parseEther("20"));
    });

    it("Should only allow project owner to update pool limit", async function () {
      // Non-owner should not be able to update
      await expect(
        launchPool
          .connect(user1)
          .updatePoolLimitPerUser(true, ethers.parseEther("200"))
      ).to.be.revertedWith("Not project owner");

      // Cannot set zero pool limit when enabling limit
      await expect(
        launchPool.connect(projectOwner).updatePoolLimitPerUser(true, 0)
      ).to.be.revertedWith("Pool limit must be positive");

      // Project owner should be able to update with positive limit
      await expect(
        launchPool
          .connect(projectOwner)
          .updatePoolLimitPerUser(true, ethers.parseEther("200"))
      )
        .to.emit(launchPool, "NewPoolLimit")
        .withArgs(ethers.parseEther("200"));

      // Project owner should be able to disable limit
      await expect(
        launchPool.connect(projectOwner).updatePoolLimitPerUser(false, 0)
      )
        .to.emit(launchPool, "NewPoolLimit")
        .withArgs(0);
    });

    it("Should only allow project owner to stop project", async function () {
      await expect(
        factory.connect(user1).endProject(projectId)
      ).to.be.revertedWith("Not project owner");

      await expect(factory.connect(projectOwner).endProject(projectId)).to.emit(
        factory,
        "ProjectStatusUpdated"
      );
    });

    it("Should only allow project owner to recover wrong tokens", async function () {
      // Deploy a new token to test recovery
      const MockToken = await ethers.getContractFactory("MockToken");
      const wrongToken = await MockToken.deploy();
      await wrongToken.waitForDeployment();
      await wrongToken.mint(
        await launchPool.getAddress(),
        ethers.parseEther("100")
      );

      // Non-owner should not be able to recover
      await expect(
        launchPool
          .connect(user1)
          .recoverWrongTokens(
            await wrongToken.getAddress(),
            ethers.parseEther("100")
          )
      ).to.be.revertedWith("Not project owner");

      // Cannot recover zero amount
      await expect(
        launchPool
          .connect(projectOwner)
          .recoverWrongTokens(await wrongToken.getAddress(), 0)
      ).to.be.revertedWith("Amount must be positive");

      // Cannot recover more than balance
      await expect(
        launchPool
          .connect(projectOwner)
          .recoverWrongTokens(
            await wrongToken.getAddress(),
            ethers.parseEther("200")
          )
      ).to.be.revertedWith("Insufficient balance");

      // Project owner should be able to recover wrong tokens
      await expect(
        launchPool
          .connect(projectOwner)
          .recoverWrongTokens(
            await wrongToken.getAddress(),
            ethers.parseEther("100")
          )
      ).to.emit(launchPool, "AdminTokenRecovery");
    });

    it("Should only allow project owner to perform emergency reward withdrawal", async function () {
      await factory.connect(projectOwner).updateProjectStatus(projectId, 3); // PAUSED

      await expect(
        launchPool
          .connect(user1)
          .emergencyRewardWithdraw(ethers.parseEther("100"))
      ).to.be.revertedWith("Not project owner");

      await expect(
        launchPool
          .connect(projectOwner)
          .emergencyRewardWithdraw(ethers.parseEther("100"))
      ).not.to.be.reverted;
    });

    it("Should respect project ownership transfer for pool management", async function () {
      // Transfer project ownership to user1
      await factory
        .connect(projectOwner)
        .transferProjectOwnership(projectId, user1.address);

      // Old owner should not be able to update parameters
      await expect(
        launchPool
          .connect(projectOwner)
          .updateMinStakeAmount(ethers.parseEther("20"))
      ).to.be.revertedWith("Not project owner");

      // New owner should be able to update parameters
      await expect(
        launchPool.connect(user1).updateMinStakeAmount(ethers.parseEther("20"))
      ).to.not.be.reverted;
    });
  });
});
