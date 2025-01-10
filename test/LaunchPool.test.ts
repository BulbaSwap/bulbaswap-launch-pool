import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { LaunchPool, LaunchPoolFactory, MockToken } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("LaunchPool", function () {
  async function deployFixture() {
    const [owner, admin, user1, user2] = await ethers.getSigners();

    // Deploy factory contract
    const LaunchPoolFactory = await ethers.getContractFactory(
      "LaunchPoolFactory"
    );
    const factory = await LaunchPoolFactory.deploy();
    await factory.waitForDeployment();

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

    const initialPool = {
      stakedToken: testToken,
      poolRewardAmount: ethers.parseEther("360"), // 0.1 tokens per second * 3600 seconds
      poolLimitPerUser: ethers.parseEther("100"),
      minStakeAmount: ethers.parseEther("10"),
      admin: admin.address,
    };

    await factory.createProject(
      rewardToken,
      ethers.parseEther("360"),
      startTime,
      endTime,
      metadata,
      initialPool
    );

    const projectId = (await factory.nextProjectId()) - 1n;
    const poolInfos = await factory.getProjectPools(projectId);
    const LaunchPool = await ethers.getContractFactory("LaunchPool");
    const launchPool = LaunchPool.attach(
      poolInfos[0].poolAddress
    ) as LaunchPool;

    // Mint test tokens to users
    await testToken.mint(user1.address, ethers.parseEther("1000"));
    await testToken.mint(user2.address, ethers.parseEther("1000"));

    // Mint and fund reward tokens
    await rewardToken.mint(owner.address, ethers.parseEther("360"));
    await rewardToken
      .connect(owner)
      .approve(await factory.getAddress(), ethers.parseEther("360"));
    await factory.fundPool(
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
      admin,
      user1,
      user2,
      startTime,
      endTime,
    };
  }

  describe("Basic Functions", function () {
    let factory: LaunchPoolFactory;
    let launchPool: LaunchPool;
    let testToken: MockToken;
    let rewardToken: MockToken;
    let projectId: bigint;
    let admin: HardhatEthersSigner;
    let user1: HardhatEthersSigner;
    let user2: HardhatEthersSigner;
    let startTime: number;
    let endTime: number;

    beforeEach(async function () {
      ({
        factory,
        launchPool,
        testToken,
        rewardToken,
        projectId,
        admin,
        user1,
        user2,
        startTime,
        endTime,
      } = await loadFixture(deployFixture));

      // Approve LaunchPool to spend test tokens
      await testToken
        .connect(user1)
        .approve(await launchPool.getAddress(), ethers.parseEther("1000"));
      await testToken
        .connect(user2)
        .approve(await launchPool.getAddress(), ethers.parseEther("1000"));
    });

    it("Should initialize with correct parameters and project ID", async function () {
      expect(await launchPool.isInitialized()).to.be.true;
      expect(await launchPool.projectId()).to.equal(projectId);
      expect(await launchPool.owner()).to.equal(admin.address);
      expect(await launchPool.rewardToken()).to.equal(
        await rewardToken.getAddress()
      );
      expect(await launchPool.stakedToken()).to.equal(
        await testToken.getAddress()
      );
      expect(await launchPool.startTime()).to.equal(startTime);
      expect(await launchPool.endTime()).to.equal(endTime);
      expect(await launchPool.rewardPerSecond()).to.equal(
        ethers.parseEther("0.1")
      );
      expect(await launchPool.poolLimitPerUser()).to.equal(
        ethers.parseEther("100")
      );
      expect(await launchPool.hasUserLimit()).to.be.true;
      expect(await launchPool.minStakeAmount()).to.equal(
        ethers.parseEther("10")
      );
    });

    it("Should handle deposits and rewards correctly", async function () {
      // Move to start time
      await time.increaseTo(startTime);

      // User1 deposits
      await launchPool.connect(user1).deposit(ethers.parseEther("50"));
      await time.increase(900); // 15 minutes

      // User2 deposits
      await launchPool.connect(user2).deposit(ethers.parseEther("50"));
      await time.increase(900); // Another 15 minutes

      // Check rewards
      // User1: First 15 min full reward (90), second 15 min half reward (45)
      expect(await launchPool.pendingReward(user1.address)).to.be.closeTo(
        ethers.parseEther("135"),
        ethers.parseEther("0.1")
      );

      // User2: Only second 15 min half reward (45)
      expect(await launchPool.pendingReward(user2.address)).to.be.closeTo(
        ethers.parseEther("45"),
        ethers.parseEther("0.1")
      );
    });

    it("Should handle withdrawals correctly", async function () {
      await time.increaseTo(startTime);
      await launchPool.connect(user1).deposit(ethers.parseEther("50"));
      await time.increase(900);

      const beforeBalance = await testToken.balanceOf(user1.address);
      await launchPool.connect(user1).withdraw(ethers.parseEther("25"));

      expect(await testToken.balanceOf(user1.address)).to.equal(
        beforeBalance + ethers.parseEther("25")
      );

      // Rewards should be accumulated but not claimed
      expect(await launchPool.pendingReward(user1.address)).to.be.closeTo(
        ethers.parseEther("90"),
        ethers.parseEther("0.1")
      );
    });

    it("Should handle emergency withdrawal", async function () {
      await time.increaseTo(startTime);
      await launchPool.connect(user1).deposit(ethers.parseEther("50"));
      await time.increase(900);

      const beforeBalance = await testToken.balanceOf(user1.address);
      await launchPool.connect(user1).emergencyWithdraw();

      expect(await testToken.balanceOf(user1.address)).to.equal(
        beforeBalance + ethers.parseEther("50")
      );
      expect(await launchPool.pendingReward(user1.address)).to.equal(0);
    });
  });

  describe("Admin Functions", function () {
    let factory: LaunchPoolFactory;
    let launchPool: LaunchPool;
    let projectId: bigint;
    let admin: HardhatEthersSigner;
    let user1: HardhatEthersSigner;

    beforeEach(async function () {
      ({ factory, launchPool, projectId, admin, user1 } = await loadFixture(
        deployFixture
      ));
    });

    it("Should allow admin to update pool parameters in READY state", async function () {
      await launchPool
        .connect(admin)
        .updateMinStakeAmount(ethers.parseEther("20"));
      expect(await launchPool.minStakeAmount()).to.equal(
        ethers.parseEther("20")
      );

      await launchPool
        .connect(admin)
        .updatePoolLimitPerUser(true, ethers.parseEther("200"));
      expect(await launchPool.poolLimitPerUser()).to.equal(
        ethers.parseEther("200")
      );

      await launchPool
        .connect(admin)
        .updateRewardPerSecond(ethers.parseEther("0.2"));
      expect(await launchPool.rewardPerSecond()).to.equal(
        ethers.parseEther("0.2")
      );
    });

    it("Should not allow admin functions in wrong states", async function () {
      await time.increaseTo(await launchPool.startTime());

      await expect(
        launchPool.connect(admin).updateMinStakeAmount(ethers.parseEther("20"))
      ).to.be.revertedWith("Pool not in ready state");

      await factory.updateProjectStatus(projectId, 3); // PAUSED
      await expect(
        launchPool.connect(admin).updateMinStakeAmount(ethers.parseEther("20"))
      ).to.be.revertedWith("Pool not in ready state");
    });

    it("Should not allow non-admin to call admin functions", async function () {
      await expect(
        launchPool.connect(user1).updateMinStakeAmount(ethers.parseEther("20"))
      ).to.be.revertedWith("Ownable: caller is not the owner");

      await expect(
        launchPool
          .connect(user1)
          .updatePoolLimitPerUser(true, ethers.parseEther("200"))
      ).to.be.revertedWith("Ownable: caller is not the owner");

      await expect(
        launchPool
          .connect(user1)
          .updateRewardPerSecond(ethers.parseEther("0.2"))
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
  });

  describe("Reward Claiming", function () {
    let factory: LaunchPoolFactory;
    let launchPool: LaunchPool;
    let rewardToken: MockToken;
    let testToken: MockToken;
    let projectId: bigint;
    let user1: HardhatEthersSigner;
    let startTime: number;
    let endTime: number;

    beforeEach(async function () {
      ({
        factory,
        launchPool,
        rewardToken,
        testToken,
        projectId,
        user1,
        startTime,
        endTime,
      } = await loadFixture(deployFixture));
    });

    it("Should allow claiming rewards after pool ends", async function () {
      await testToken
        .connect(user1)
        .approve(await launchPool.getAddress(), ethers.parseEther("50"));

      await time.increaseTo(startTime);
      await launchPool.connect(user1).deposit(ethers.parseEther("50"));
      await time.increase(1800);
      await launchPool.connect(user1).deposit(0);
      await time.increaseTo(endTime + 1);

      const beforeReward = await rewardToken.balanceOf(user1.address);
      await launchPool.connect(user1).claimReward();
      const afterReward = await rewardToken.balanceOf(user1.address);

      // Verify rewards (60 minutes * 0.1 tokens/second = 360 tokens)
      // First 30 minutes: 1800 seconds * 0.1 = 180 tokens (stored in pendingRewards)
      // Second 30 minutes: 1800 seconds * 0.1 = 180 tokens (calculated through accTokenPerShare)
      // Total rewards: 360 tokens
      const expectedReward = ethers.parseEther("360");
      expect(afterReward - beforeReward).to.be.closeTo(
        expectedReward,
        ethers.parseEther("0.1")
      );
    });

    it("Should not allow claiming rewards before end or when paused", async function () {
      await testToken
        .connect(user1)
        .approve(await launchPool.getAddress(), ethers.parseEther("50"));

      await time.increaseTo(startTime);
      await launchPool.connect(user1).deposit(ethers.parseEther("50"));
      await time.increase(1800);

      await expect(launchPool.connect(user1).claimReward()).to.be.revertedWith(
        "Pool not ended"
      );

      await time.increaseTo(endTime + 1);
      await factory.updateProjectStatus(projectId, 3); // PAUSED

      await expect(launchPool.connect(user1).claimReward()).to.be.revertedWith(
        "Pool not ended"
      );
    });
  });
});
