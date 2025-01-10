import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { LaunchPool, LaunchPoolFactory, MockToken } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("LaunchPoolFactory", function () {
  async function deployFixture() {
    const [owner, admin, user] = await ethers.getSigners();

    // Deploy factory contract
    const LaunchPoolFactory = await ethers.getContractFactory(
      "LaunchPoolFactory"
    );
    const factory = await LaunchPoolFactory.deploy();
    await factory.waitForDeployment();

    // Deploy token contracts
    const MockToken = await ethers.getContractFactory("MockToken");
    const rewardToken = await MockToken.deploy();
    await rewardToken.waitForDeployment();

    const testToken = await MockToken.deploy();
    await testToken.waitForDeployment();

    return { factory, rewardToken, testToken, owner, admin, user };
  }

  describe("Deployment", function () {
    it("Should deploy factory successfully", async function () {
      const { factory, owner } = await loadFixture(deployFixture);
      expect(await factory.owner()).to.equal(owner.address);
    });
  });

  describe("Project and Pool Creation", function () {
    let factory: LaunchPoolFactory;
    let rewardToken: MockToken;
    let testToken: MockToken;
    let owner: HardhatEthersSigner;
    let admin: HardhatEthersSigner;
    let user: HardhatEthersSigner;

    beforeEach(async function () {
      ({ factory, rewardToken, testToken, owner, admin, user } =
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

      const initialPool = {
        stakedToken: testToken,
        poolRewardAmount: ethers.parseEther("360"), // 0.1 tokens per second * 3600 seconds
        poolLimitPerUser: ethers.parseEther("100"),
        minStakeAmount: ethers.parseEther("10"),
        admin: admin.address,
      };

      await expect(
        factory.createProject(
          rewardToken,
          ethers.parseEther("1000"),
          startTime,
          endTime,
          metadata,
          initialPool
        )
      )
        .to.emit(factory, "NewProject")
        .to.emit(factory, "NewLaunchPool")
        .to.emit(factory, "ProjectStatusUpdated")
        .withArgs(0, 0); // STAGING status

      const projectId = (await factory.nextProjectId()) - 1n;
      const pools = await factory.getProjectPools(projectId);
      expect(pools.length).to.equal(1);
      expect(await factory.getProjectStatus(projectId)).to.equal("STAGING");
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

      const emptyPool = {
        stakedToken: ethers.ZeroAddress,
        poolRewardAmount: 0,
        poolLimitPerUser: 0,
        minStakeAmount: 0,
        admin: ethers.ZeroAddress,
      };

      await expect(
        factory.createProject(
          rewardToken,
          ethers.parseEther("1000"),
          startTime,
          endTime,
          metadata,
          emptyPool
        )
      ).to.emit(factory, "NewProject");

      const projectId = (await factory.nextProjectId()) - 1n;
      const pools = await factory.getProjectPools(projectId);
      expect(pools.length).to.equal(0);
      expect(await factory.getProjectStatus(projectId)).to.equal("STAGING");
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

      const emptyPool = {
        stakedToken: ethers.ZeroAddress,
        poolRewardAmount: 0n,
        poolLimitPerUser: 0n,
        minStakeAmount: 0n,
        admin: ethers.ZeroAddress,
      };

      await factory.createProject(
        rewardToken,
        ethers.parseEther("1000"),
        startTime,
        endTime,
        metadata,
        emptyPool
      );

      const projectId = (await factory.nextProjectId()) - 1n;

      await expect(
        factory.addPoolToProject(
          projectId,
          testToken,
          ethers.parseEther("360"), // Total reward amount
          ethers.parseEther("100"),
          ethers.parseEther("10"),
          admin.address
        )
      ).to.emit(factory, "NewLaunchPool");

      // Verify pool was created with correct reward amount
      const pools = await factory.getProjectPools(projectId);
      expect(pools.length).to.equal(1);

      const LaunchPool = await ethers.getContractFactory("LaunchPool");
      const launchPool = LaunchPool.attach(pools[0]) as LaunchPool;

      // Calculate expected reward per second using the new helper function
      const expectedRewardPerSecond = await factory.calculateRewardPerSecond(
        ethers.parseEther("360"),
        startTime,
        endTime
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

      const emptyPool = {
        stakedToken: ethers.ZeroAddress,
        poolRewardAmount: 0n,
        poolLimitPerUser: 0n,
        minStakeAmount: 0n,
        admin: ethers.ZeroAddress,
      };

      await expect(
        factory
          .connect(user)
          .createProject(
            rewardToken,
            ethers.parseEther("1000"),
            startTime,
            endTime,
            metadata,
            emptyPool
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

      const initialPool = {
        stakedToken: rewardToken, // Same as reward token
        poolRewardAmount: ethers.parseEther("360"),
        poolLimitPerUser: ethers.parseEther("100"),
        minStakeAmount: ethers.parseEther("10"),
        admin: admin.address,
      };

      await expect(
        factory.createProject(
          rewardToken,
          ethers.parseEther("1000"),
          startTime,
          endTime,
          metadata,
          initialPool
        )
      ).to.be.revertedWith("Tokens must be different");
    });
  });

  describe("Project Management", function () {
    let factory: LaunchPoolFactory;
    let rewardToken: MockToken;
    let testToken: MockToken;
    let projectId: bigint;
    let owner: HardhatEthersSigner;
    let admin: HardhatEthersSigner;
    let user: HardhatEthersSigner;

    beforeEach(async function () {
      ({ factory, rewardToken, testToken, owner, admin, user } =
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

      const initialPool = {
        stakedToken: testToken,
        poolRewardAmount: ethers.parseEther("360"), // 0.1 tokens per second * 3600 seconds
        poolLimitPerUser: ethers.parseEther("100"),
        minStakeAmount: ethers.parseEther("10"),
        admin: admin.address,
      };

      await factory.createProject(
        rewardToken,
        ethers.parseEther("1000"),
        startTime,
        endTime,
        metadata,
        initialPool
      );

      projectId = (await factory.nextProjectId()) - 1n;
    });

    it("Should manage project status correctly", async function () {
      // Initial state should be STAGING
      expect(await factory.getProjectStatus(projectId)).to.equal("STAGING");

      // Fund the pool
      const pools = await factory.getProjectPools(projectId);
      const poolAddress = pools[0];
      await rewardToken.mint(owner.address, ethers.parseEther("360"));
      await rewardToken
        .connect(owner)
        .approve(await factory.getAddress(), ethers.parseEther("360"));
      await factory.fundPool(projectId, poolAddress, ethers.parseEther("360"));

      // After funding, should be READY
      expect(await factory.getProjectStatus(projectId)).to.equal("READY");

      // Should be able to pause from READY
      await factory.updateProjectStatus(projectId, 3); // PAUSED
      expect(await factory.getProjectStatus(projectId)).to.equal("PAUSED");

      // Should be able to delist from READY
      await factory.updateProjectStatus(projectId, 0); // Back to STAGING
      await factory.updateProjectStatus(projectId, 2); // DELISTED
      expect(await factory.getProjectStatus(projectId)).to.equal("DELISTED");
    });

    it("Should not allow invalid status transitions", async function () {
      // Cannot move to READY without funding
      await expect(
        factory.updateProjectStatus(projectId, 1)
      ).to.be.revertedWith("Not all pools funded");

      // Cannot pause from STAGING
      await expect(
        factory.updateProjectStatus(projectId, 3)
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

      await factory.updateProjectMetadata(projectId, newMetadata);
      const project = await factory.projects(projectId);
      expect(project.metadata.projectName).to.equal(newMetadata.projectName);
      expect(project.metadata.website).to.equal(newMetadata.website);
      expect(project.metadata.logo).to.equal(newMetadata.logo);
      expect(project.metadata.discord).to.equal(newMetadata.discord);
      expect(project.metadata.twitter).to.equal(newMetadata.twitter);
      expect(project.metadata.telegram).to.equal(newMetadata.telegram);
      expect(project.metadata.tokenInfo).to.equal(newMetadata.tokenInfo);
    });
  });

  describe("LaunchPool Integration", function () {
    let factory: LaunchPoolFactory;
    let rewardToken: MockToken;
    let testToken: MockToken;
    let launchPool: LaunchPool;
    let projectId: bigint;
    let owner: HardhatEthersSigner;
    let admin: HardhatEthersSigner;
    let user: HardhatEthersSigner;
    let startTime: number;
    let endTime: number;

    async function createProjectWithPoolFixture() {
      const { factory, rewardToken, testToken, owner, admin, user } =
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
        admin: admin.address,
      };

      await factory.createProject(
        rewardToken,
        ethers.parseEther("1000"),
        startTime,
        endTime,
        metadata,
        initialPool
      );

      const projectId = (await factory.nextProjectId()) - 1n;
      const pools = await factory.getProjectPools(projectId);
      const LaunchPool = await ethers.getContractFactory("LaunchPool");
      const launchPool = LaunchPool.attach(pools[0]) as LaunchPool;

      // Fund the pool
      await rewardToken.mint(owner.address, ethers.parseEther("360"));
      await rewardToken
        .connect(owner)
        .approve(await factory.getAddress(), ethers.parseEther("360"));
      await factory.fundPool(projectId, pools[0], ethers.parseEther("360"));

      return {
        factory,
        rewardToken,
        testToken,
        launchPool,
        projectId,
        owner,
        admin,
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
        admin,
        user,
        startTime,
        endTime,
      } = await loadFixture(createProjectWithPoolFixture));
    });

    it("Should initialize LaunchPool correctly", async function () {
      expect(await launchPool.isInitialized()).to.be.true;
      expect(await launchPool.owner()).to.equal(admin.address);
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
      await factory.updateProjectStatus(projectId, 3); // PAUSED

      // Try to stake while paused
      await expect(
        launchPool.connect(user).deposit(ethers.parseEther("10"))
      ).to.be.revertedWith("Pool not active");

      // Move back to READY
      await factory.updateProjectStatus(projectId, 0); // STAGING
      await factory.updateProjectStatus(projectId, 1); // READY

      // Should be able to stake again
      await expect(
        launchPool.connect(user).deposit(ethers.parseEther("10"))
      ).to.emit(launchPool, "Deposit");
    });
  });
});
