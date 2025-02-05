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

      // Should be able to delist from READY
      await factory.connect(projectOwner).updateProjectStatus(projectId, 0); // Back to STAGING
      await factory.connect(projectOwner).updateProjectStatus(projectId, 2); // DELISTED
      expect(await factory.getProjectStatus(projectId)).to.equal("DELISTED");
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

    it("Should transfer project ownership", async function () {
      // Transfer ownership to user
      await expect(
        factory
          .connect(projectOwner)
          .transferProjectOwnership(projectId, user.address)
      )
        .to.emit(factory, "ProjectOwnershipTransferred")
        .withArgs(projectId, projectOwner.address, user.address);

      expect(await factory.getProjectOwner(projectId)).to.equal(user.address);

      // Old owner should not be able to update metadata
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
        factory.connect(user).updateProjectMetadata(projectId, newMetadata)
      ).to.not.be.reverted;
    });

    it("Should not allow non-owner to transfer project ownership", async function () {
      await expect(
        factory.connect(user).transferProjectOwnership(projectId, user.address)
      ).to.be.revertedWith("Only project owner");
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

      // Move back to STAGING
      await factory.connect(projectOwner).updateProjectStatus(projectId, 0); // STAGING

      // Wait for status update to be mined
      await ethers.provider.send("evm_mine", []);

      // Re-fund the pool since we're back in STAGING
      await rewardToken.mint(projectOwner.address, ethers.parseEther("360"));
      await rewardToken
        .connect(projectOwner)
        .approve(await factory.getAddress(), ethers.parseEther("360"));
      await factory
        .connect(projectOwner)
        .fundPool(
          projectId,
          await launchPool.getAddress(),
          ethers.parseEther("360")
        );

      // Pool should automatically move to READY after funding

      // Should be able to stake again
      await expect(
        launchPool.connect(user).deposit(ethers.parseEther("10"))
      ).to.emit(launchPool, "Deposit");
    });

    it("Should respect project ownership for admin functions", async function () {
      // Only project owner should be able to stop project
      await expect(
        factory.connect(user).stopProject(projectId)
      ).to.be.revertedWith("Not project owner");

      await expect(
        factory.connect(projectOwner).stopProject(projectId)
      ).to.emit(factory, "ProjectStatusUpdated");

      // Only project owner should be able to update pool limit
      await expect(
        launchPool
          .connect(user)
          .updatePoolLimitPerUser(true, ethers.parseEther("200"))
      ).to.be.revertedWith("Not project owner");

      // Transfer project ownership
      await factory
        .connect(projectOwner)
        .transferProjectOwnership(projectId, user.address);

      // New owner should be able to update pool limit
      await expect(
        launchPool
          .connect(user)
          .updatePoolLimitPerUser(true, ethers.parseEther("200"))
      ).to.not.be.reverted;
    });
  });
});
