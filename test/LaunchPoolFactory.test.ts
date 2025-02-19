import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
  LaunchPool,
  LaunchPoolFactoryUpgradeable,
  MockToken,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { LaunchPoolFactoryUpgradeable as LaunchPoolFactoryType } from "../typechain-types/contracts/LaunchPoolFactoryUpgradeable";

type InitialPoolParams = {
  stakedToken: MockToken;
  poolRewardAmount: bigint;
  poolLimitPerUser: bigint;
  minStakeAmount: bigint;
};

const emptyPools: InitialPoolParams[] = [];

describe("LaunchPoolFactoryUpgradeable (Business Logic)", function () {
  async function deployFixture() {
    const [owner, projectOwner, user] = await ethers.getSigners();

    // Deploy LaunchPool implementation first
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

    // Deploy token contracts
    const MockToken = await ethers.getContractFactory("MockToken");
    const rewardToken = await MockToken.deploy();
    await rewardToken.waitForDeployment();

    const testToken = await MockToken.deploy();
    await testToken.waitForDeployment();

    return { factory, rewardToken, testToken, owner, projectOwner, user };
  }

  describe("Deployment", function () {
    it("Should deploy factory successfully", async function () {
      const { factory, owner } = await loadFixture(deployFixture);
      expect(await factory.owner()).to.equal(owner.address);
    });
  });

  describe("Project and Pool Creation", function () {
    let factory: LaunchPoolFactoryUpgradeable;
    let rewardToken: MockToken;
    let testToken: MockToken;
    let owner: HardhatEthersSigner;
    let projectOwner: HardhatEthersSigner;
    let user: HardhatEthersSigner;

    beforeEach(async function () {
      ({ factory, rewardToken, testToken, owner, projectOwner, user } =
        await loadFixture(deployFixture));
    });

    it("Should create new project with initial pool", async function () {
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

      const initialPools: InitialPoolParams[] = [
        {
          stakedToken: testToken,
          poolRewardAmount: ethers.parseEther("360"), // 0.1 tokens per second * 3600 seconds
          poolLimitPerUser: ethers.parseEther("100"),
          minStakeAmount: ethers.parseEther("10"),
        },
      ];

      await expect(
        factory.createProject(
          rewardToken,
          ethers.parseEther("360"),
          startTime,
          endTime,
          metadata,
          initialPools,
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

    it("Should create project without initial pool", async function () {
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
      const poolInfos = await factory.getProjectPools(projectId);
      expect(poolInfos.length).to.equal(0);
      expect(await factory.getProjectStatus(projectId)).to.equal("STAGING");
      expect(await factory.getProjectOwner(projectId)).to.equal(
        projectOwner.address
      );
    });

    it("Should add pool to existing project", async function () {
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

      await factory.createProject(
        rewardToken,
        ethers.parseEther("360"),
        startTime,
        endTime,
        metadata,
        emptyPools,
        projectOwner.address
      );

      const projectId = (await factory.nextProjectId()) - 1n;

      await expect(
        factory.connect(projectOwner).addPoolToProject(
          projectId,
          testToken,
          ethers.parseEther("360"), // Total reward amount
          ethers.parseEther("100"),
          ethers.parseEther("10")
        )
      ).to.emit(factory, "NewLaunchPool");

      // Verify pool was created with correct reward amount
      const poolInfos = await factory.getProjectPools(projectId);
      expect(poolInfos.length).to.equal(1);

      const LaunchPool = await ethers.getContractFactory("LaunchPool");
      const launchPool = LaunchPool.attach(
        poolInfos[0].poolAddress
      ) as LaunchPool;

      // Calculate expected reward per second using the new helper function
      const expectedRewardPerSecond = await factory.calculateRewardPerSecond(
        projectId,
        ethers.parseEther("360")
      );

      expect(await launchPool.rewardPerSecond()).to.equal(
        expectedRewardPerSecond
      );
      expect(await factory.getProjectStatus(projectId)).to.equal("STAGING");
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

      await expect(
        factory
          .connect(user)
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

    it("Should validate pool creation parameters", async function () {
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

      const initialPools: InitialPoolParams[] = [
        {
          stakedToken: rewardToken, // Same as reward token
          poolRewardAmount: ethers.parseEther("360"),
          poolLimitPerUser: ethers.parseEther("100"),
          minStakeAmount: ethers.parseEther("10"),
        },
      ];

      await expect(
        factory.createProject(
          rewardToken,
          ethers.parseEther("360"),
          startTime,
          endTime,
          metadata,
          initialPools,
          projectOwner.address
        )
      ).to.be.revertedWith("Tokens must be different");
    });
  });

  describe("Project Management", function () {
    let factory: LaunchPoolFactoryUpgradeable;
    let rewardToken: MockToken;
    let testToken: MockToken;
    let projectId: bigint;
    let owner: HardhatEthersSigner;
    let projectOwner: HardhatEthersSigner;
    let user: HardhatEthersSigner;

    beforeEach(async function () {
      ({ factory, rewardToken, testToken, owner, projectOwner, user } =
        await loadFixture(deployFixture));

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

      const initialPools: InitialPoolParams[] = [
        {
          stakedToken: testToken,
          poolRewardAmount: ethers.parseEther("360"), // 0.1 tokens per second * 3600 seconds
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

      projectId = (await factory.nextProjectId()) - 1n;
    });

    it("Should manage project status correctly", async function () {
      // Initial state should be STAGING
      expect(await factory.getProjectStatus(projectId)).to.equal("STAGING");

      // Fund the pool
      const poolInfos = await factory.getProjectPools(projectId);
      const poolAddress = poolInfos[0].poolAddress;
      await rewardToken.mint(projectOwner.address, ethers.parseEther("360"));
      await rewardToken
        .connect(projectOwner)
        .approve(await factory.getAddress(), ethers.parseEther("360"));
      await factory
        .connect(projectOwner)
        .fundPool(projectId, poolAddress, ethers.parseEther("360"));

      // After funding, should be READY
      expect(await factory.getProjectStatus(projectId)).to.equal("READY");

      // Should be able to pause from READY
      await factory.connect(projectOwner).updateProjectStatus(projectId, 3); // PAUSED
      expect(await factory.getProjectStatus(projectId)).to.equal("PAUSED");

      // Should be able to resume from PAUSED
      await factory.connect(projectOwner).resumeProject(projectId); // Will go to READY since funds are sufficient
      expect(await factory.getProjectStatus(projectId)).to.equal("READY");

      // Should be able to delist from READY
      await factory.connect(projectOwner).updateProjectStatus(projectId, 2); // DELISTED
      expect(await factory.getProjectStatus(projectId)).to.equal("DELISTED");
    });

    it("Should only reset insufficient funded pools when moving from PAUSED to STAGING", async function () {
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

      // Create project without initial pools
      await factory.createProject(
        rewardToken,
        ethers.parseEther("360"),
        startTime,
        endTime,
        metadata,
        emptyPools,
        projectOwner.address
      );

      const projectId = (await factory.nextProjectId()) - 1n;

      // Add first pool with 300 tokens reward
      await factory.connect(projectOwner).addPoolToProject(
        projectId,
        testToken,
        ethers.parseEther("300"), // Main pool with 300 tokens
        ethers.parseEther("100"),
        ethers.parseEther("10")
      );

      // Add second pool with 60 tokens reward
      await factory.connect(projectOwner).addPoolToProject(
        projectId,
        testToken,
        ethers.parseEther("60"), // Small pool with 60 tokens
        ethers.parseEther("100"),
        ethers.parseEther("10")
      );

      const poolInfos = await factory.getProjectPools(projectId);
      expect(poolInfos.length).to.equal(2);

      // Fund both pools (300 + 60)
      await rewardToken.mint(projectOwner.address, ethers.parseEther("360")); // Total project reward
      await rewardToken
        .connect(projectOwner)
        .approve(await factory.getAddress(), ethers.parseEther("360"));

      // Fund first pool with 300 tokens
      await factory
        .connect(projectOwner)
        .fundPool(
          projectId,
          poolInfos[0].poolAddress,
          ethers.parseEther("300")
        );
      // Fund second pool with 60 tokens
      await factory
        .connect(projectOwner)
        .fundPool(projectId, poolInfos[1].poolAddress, ethers.parseEther("60"));

      // Move to READY state
      expect(await factory.getProjectStatus(projectId)).to.equal("READY");

      // Pause project
      await factory.connect(projectOwner).updateProjectStatus(projectId, 3); // PAUSED
      expect(await factory.getProjectStatus(projectId)).to.equal("PAUSED");

      // Remove funds from second pool only
      const LaunchPool = await ethers.getContractFactory("LaunchPool");
      const pool2 = LaunchPool.attach(poolInfos[1].poolAddress) as LaunchPool;
      await pool2
        .connect(projectOwner)
        .emergencyRewardWithdraw(ethers.parseEther("60"));

      // Resume project (should go to STAGING since pool2 has insufficient funds)
      await factory.connect(projectOwner).resumeProject(projectId);
      expect(await factory.getProjectStatus(projectId)).to.equal("STAGING");

      // Get project info to check pool funding status
      const project = await factory.getProject(projectId);

      // First pool should still be marked as funded
      const pool1Info = project.poolInfos[0];
      const pool2Info = project.poolInfos[1];

      // Verify pool statuses through their balances
      const pool1Balance = await rewardToken.balanceOf(
        poolInfos[0].poolAddress
      );
      const pool2Balance = await rewardToken.balanceOf(
        poolInfos[1].poolAddress
      );

      expect(pool1Balance).to.equal(ethers.parseEther("300")); // First pool should still have full balance
      expect(pool2Balance).to.equal(0n); // Second pool should have no balance
    });

    it("Should not allow invalid status transitions", async function () {
      // Cannot move to READY without funding
      await expect(
        factory.connect(projectOwner).updateProjectStatus(projectId, 1)
      ).to.be.revertedWith("Not all pools funded");

      // Cannot pause from STAGING
      await expect(
        factory.connect(projectOwner).updateProjectStatus(projectId, 3)
      ).to.be.revertedWith("Can only pause from READY state");
    });

    it("Should update project metadata", async function () {
      const newMetadata = {
        projectName: "Updated Project",
        website: "https://updated.com",
        logo: "https://updated.com/logo.png",
        discord: "https://discord.gg/updated",
        twitter: "https://twitter.com/updated",
        telegram: "https://t.me/updated",
        tokenInfo: "Updated Token Info",
      };

      await factory
        .connect(projectOwner)
        .updateProjectMetadata(projectId, newMetadata);
      const project = await factory.projects(projectId);
      expect(project.metadata.projectName).to.equal(newMetadata.projectName);
      expect(project.metadata.website).to.equal(newMetadata.website);
      expect(project.metadata.logo).to.equal(newMetadata.logo);
      expect(project.metadata.discord).to.equal(newMetadata.discord);
      expect(project.metadata.twitter).to.equal(newMetadata.twitter);
      expect(project.metadata.telegram).to.equal(newMetadata.telegram);
      expect(project.metadata.tokenInfo).to.equal(newMetadata.tokenInfo);
    });

    it("Should handle project ownership transfer correctly", async function () {
      // Request transfer ownership to user
      await expect(
        factory
          .connect(projectOwner)
          .transferProjectOwnershipRequest(projectId, user.address)
      )
        .to.emit(factory, "ProjectOwnershipTransferStarted")
        .withArgs(projectId, projectOwner.address, user.address);

      // Old owner should still be able to update metadata before transfer is accepted
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
      ).to.not.be.reverted;

      // Accept ownership transfer
      await expect(factory.connect(user).acceptProjectOwnership(projectId))
        .to.emit(factory, "ProjectOwnershipTransferred")
        .withArgs(projectId, projectOwner.address, user.address);

      expect(await factory.getProjectOwner(projectId)).to.equal(user.address);

      // Old owner should not be able to update metadata after transfer
      await expect(
        factory
          .connect(projectOwner)
          .updateProjectMetadata(projectId, newMetadata)
      ).to.be.revertedWith("Only project owner");

      // New owner should be able to update metadata
      await expect(
        factory.connect(user).updateProjectMetadata(projectId, newMetadata)
      ).to.not.be.reverted;
    });

    it("Should handle project ownership transfer cancellation", async function () {
      // Request transfer ownership to user
      await factory
        .connect(projectOwner)
        .transferProjectOwnershipRequest(projectId, user.address);

      // Cancel transfer
      await expect(
        factory.connect(projectOwner).cancelProjectOwnershipTransfer(projectId)
      )
        .to.emit(factory, "ProjectOwnershipTransferCanceled")
        .withArgs(projectId, projectOwner.address, user.address);

      // Original owner should still be able to update metadata
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
      ).to.not.be.reverted;

      // User should not be able to accept cancelled transfer
      await expect(
        factory.connect(user).acceptProjectOwnership(projectId)
      ).to.be.revertedWith("No pending transfer");
    });

    it("Should validate project ownership transfer parameters", async function () {
      // Cannot transfer to zero address
      await expect(
        factory
          .connect(projectOwner)
          .transferProjectOwnershipRequest(projectId, ethers.ZeroAddress)
      ).to.be.revertedWith("New owner is zero address");

      // Cannot transfer to current owner
      await expect(
        factory
          .connect(projectOwner)
          .transferProjectOwnershipRequest(projectId, projectOwner.address)
      ).to.be.revertedWith("New owner is current owner");

      // Non-owner cannot initiate transfer
      await expect(
        factory
          .connect(user)
          .transferProjectOwnershipRequest(projectId, user.address)
      ).to.be.revertedWith("Only project owner");

      // Cannot cancel when no transfer is pending
      await expect(
        factory.connect(projectOwner).cancelProjectOwnershipTransfer(projectId)
      ).to.be.revertedWith("No pending transfer");

      // Cannot accept when no transfer is pending
      await expect(
        factory.connect(user).acceptProjectOwnership(projectId)
      ).to.be.revertedWith("No pending transfer");
    });
  });

  describe("LaunchPool Integration", function () {
    let factory: LaunchPoolFactoryUpgradeable;
    let rewardToken: MockToken;
    let testToken: MockToken;
    let launchPool: LaunchPool;
    let projectId: bigint;
    let owner: HardhatEthersSigner;
    let projectOwner: HardhatEthersSigner;
    let user: HardhatEthersSigner;
    let startTime: number;
    let endTime: number;

    async function createProjectWithPoolFixture() {
      const { factory, rewardToken, testToken, owner, projectOwner, user } =
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

      const initialPools: InitialPoolParams[] = [
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
      const LaunchPool = await ethers.getContractFactory("LaunchPool");
      const launchPool = LaunchPool.attach(
        poolInfos[0].poolAddress
      ) as LaunchPool;

      // Fund the pool
      await rewardToken.mint(projectOwner.address, ethers.parseEther("360"));
      await rewardToken
        .connect(projectOwner)
        .approve(await factory.getAddress(), ethers.parseEther("360"));
      await factory
        .connect(projectOwner)
        .fundPool(
          projectId,
          poolInfos[0].poolAddress,
          ethers.parseEther("360")
        );

      return {
        factory,
        rewardToken,
        testToken,
        launchPool,
        projectId,
        owner,
        projectOwner,
        user,
        startTime,
        endTime,
      };
    }

    beforeEach(async function () {
      ({
        factory,
        rewardToken,
        testToken,
        launchPool,
        projectId,
        owner,
        projectOwner,
        user,
        startTime,
        endTime,
      } = await loadFixture(createProjectWithPoolFixture));
    });

    it("Should initialize LaunchPool correctly", async function () {
      expect(await launchPool.isInitialized()).to.be.true;
      expect(await launchPool.projectId()).to.equal(projectId);
      expect(await launchPool.rewardToken()).to.equal(
        await rewardToken.getAddress()
      );
      expect(await launchPool.stakedToken()).to.equal(
        await testToken.getAddress()
      );
    });

    it("Should respect project status", async function () {
      // Prepare for staking
      await testToken.mint(user.address, ethers.parseEther("100"));
      await testToken
        .connect(user)
        .approve(await launchPool.getAddress(), ethers.parseEther("100"));

      // Move to start time
      await time.increaseTo(startTime);

      // Should be able to stake in READY state
      await expect(
        launchPool.connect(user).deposit(ethers.parseEther("10"))
      ).to.emit(launchPool, "Deposit");

      // Pause project
      await factory.connect(projectOwner).updateProjectStatus(projectId, 3); // PAUSED

      // Try to stake while paused
      await expect(
        launchPool.connect(user).deposit(ethers.parseEther("10"))
      ).to.be.revertedWith("Pool must be active or ready");

      // Resume project (will go to READY since funds are sufficient)
      await factory.connect(projectOwner).resumeProject(projectId);

      // Wait for status update to be mined
      await ethers.provider.send("evm_mine", []);

      // Should be able to stake again
      await expect(
        launchPool.connect(user).deposit(ethers.parseEther("10"))
      ).to.emit(launchPool, "Deposit");
    });

    it("Should respect project ownership for admin functions", async function () {
      // Only project owner should be able to end project
      await expect(
        factory.connect(user).endProject(projectId)
      ).to.be.revertedWith("Not project owner");

      await expect(factory.connect(projectOwner).endProject(projectId)).to.emit(
        factory,
        "ProjectStatusUpdated"
      );

      // Only project owner should be able to update pool limit
      await expect(
        launchPool
          .connect(user)
          .updatePoolLimitPerUser(true, ethers.parseEther("200"))
      ).to.be.revertedWith("Not project owner");

      // Request transfer project ownership
      await factory
        .connect(projectOwner)
        .transferProjectOwnershipRequest(projectId, user.address);

      // Accept ownership transfer
      await factory.connect(user).acceptProjectOwnership(projectId);

      // New owner should be able to update pool limit
      await expect(
        launchPool
          .connect(user)
          .updatePoolLimitPerUser(true, ethers.parseEther("200"))
      ).to.not.be.reverted;
    });
  });
});
