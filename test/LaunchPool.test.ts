import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
  LaunchPool,
  LaunchPoolFactoryUpgradeable,
  MockToken,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("LaunchPool", function () {
  async function deployFixture() {
    const [owner, projectOwner, user1, user2] = await ethers.getSigners();

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
    const LaunchPool = await ethers.getContractFactory("LaunchPool");
    const launchPool = LaunchPool.attach(
      poolInfos[0].poolAddress
    ) as LaunchPool;

    // Mint test tokens to users
    await testToken.mint(user1.address, ethers.parseEther("1000"));
    await testToken.mint(user2.address, ethers.parseEther("1000"));

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
      user2,
      startTime,
      endTime,
    };
  }

  describe("Basic Functions", function () {
    let factory: LaunchPoolFactoryUpgradeable;
    let launchPool: LaunchPool;
    let testToken: MockToken;
    let rewardToken: MockToken;
    let projectId: bigint;
    let projectOwner: HardhatEthersSigner;
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
        projectOwner,
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
      expect(await launchPool.rewardToken()).to.equal(
        await rewardToken.getAddress()
      );
      expect(await launchPool.stakedToken()).to.equal(
        await testToken.getAddress()
      );

      const [actualStartTime, actualEndTime] =
        await launchPool.getProjectTimes();
      expect(actualStartTime).to.equal(startTime);
      expect(actualEndTime).to.equal(endTime);

      const expectedRewardPerSecond = await factory.calculateRewardPerSecond(
        projectId,
        ethers.parseEther("360")
      );
      expect(await launchPool.rewardPerSecond()).to.equal(
        expectedRewardPerSecond
      );

      expect(await launchPool.poolLimitPerUser()).to.equal(
        ethers.parseEther("100")
      );
      expect(await launchPool.hasUserLimit()).to.be.true;
      expect(await launchPool.minStakeAmount()).to.equal(
        ethers.parseEther("10")
      );
    });

    it("Should calculate rewards correctly for deposits made in READY state", async function () {
      // User1 deposits in READY state (before start time)
      await launchPool.connect(user1).deposit(ethers.parseEther("50"));

      // Verify no rewards before start time
      expect(await launchPool.pendingReward(user1.address)).to.equal(0);

      // Move to start time
      await time.increaseTo(startTime);

      // Move 30 minutes into active period
      await time.increase(1800);

      // Calculate expected rewards:
      // 30 minutes = 1800 seconds
      // reward per second = 0.1 tokens (360 tokens / 3600 seconds)
      // total expected = 1800 * 0.1 = 180 tokens
      expect(await launchPool.pendingReward(user1.address)).to.be.closeTo(
        ethers.parseEther("180"),
        ethers.parseEther("0.1")
      );

      // User2 deposits at this point
      await launchPool.connect(user2).deposit(ethers.parseEther("50"));

      // Move another 30 minutes
      await time.increase(1800);

      // Check User1's rewards:
      // First 30 min: 180 tokens (full)
      // Second 30 min: 90 tokens (shared)
      // Total: 270 tokens
      expect(await launchPool.pendingReward(user1.address)).to.be.closeTo(
        ethers.parseEther("270"),
        ethers.parseEther("0.1")
      );

      // Check User2's rewards:
      // Only second 30 min: 90 tokens (shared)
      expect(await launchPool.pendingReward(user2.address)).to.be.closeTo(
        ethers.parseEther("90"),
        ethers.parseEther("0.1")
      );
    });

    it("Should allow deposits in READY state without accumulating rewards", async function () {
      // Project is already in READY state after deployment

      // User1 deposits in READY state
      await launchPool.connect(user1).deposit(ethers.parseEther("50"));

      // Check no rewards accumulated before start time
      expect(await launchPool.pendingReward(user1.address)).to.equal(0);

      // Move to start time and verify rewards start accumulating
      await time.increaseTo(startTime);
      await time.increase(900); // 15 minutes

      expect(await launchPool.pendingReward(user1.address)).to.be.closeTo(
        ethers.parseEther("90"),
        ethers.parseEther("0.1")
      );
    });

    it("Should allow withdrawals in READY state", async function () {
      // User1 deposits in READY state
      await launchPool.connect(user1).deposit(ethers.parseEther("50"));

      // Withdraw half amount in READY state
      const beforeBalance = await testToken.balanceOf(user1.address);
      await launchPool.connect(user1).withdraw(ethers.parseEther("25"));

      // Verify withdrawal amount
      expect(await testToken.balanceOf(user1.address)).to.equal(
        beforeBalance + ethers.parseEther("25")
      );

      // Verify no rewards accumulated in READY state
      expect(await launchPool.pendingReward(user1.address)).to.equal(0);
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

    it("Should handle emergency withdrawal in PAUSED state", async function () {
      await time.increaseTo(startTime);
      await launchPool.connect(user1).deposit(ethers.parseEther("50"));
      await time.increase(900);

      // Set project status to PAUSED
      await factory.connect(projectOwner).updateProjectStatus(projectId, 3); // PAUSED

      const beforeBalance = await testToken.balanceOf(user1.address);
      await launchPool.connect(user1).emergencyWithdraw();

      expect(await testToken.balanceOf(user1.address)).to.equal(
        beforeBalance + ethers.parseEther("50")
      );
      expect(await launchPool.pendingReward(user1.address)).to.equal(0);
    });
  });

  describe("Admin Functions", function () {
    let factory: LaunchPoolFactoryUpgradeable;
    let launchPool: LaunchPool;
    let projectId: bigint;
    let projectOwner: HardhatEthersSigner;
    let user1: HardhatEthersSigner;

    beforeEach(async function () {
      ({ factory, launchPool, projectId, projectOwner, user1 } =
        await loadFixture(deployFixture));
    });

    it("Should allow project owner to update pool parameters in READY state", async function () {
      await launchPool
        .connect(projectOwner)
        .updateMinStakeAmount(ethers.parseEther("20"));
      expect(await launchPool.minStakeAmount()).to.equal(
        ethers.parseEther("20")
      );

      await launchPool
        .connect(projectOwner)
        .updatePoolLimitPerUser(true, ethers.parseEther("200"));
      expect(await launchPool.poolLimitPerUser()).to.equal(
        ethers.parseEther("200")
      );
    });

    it("Should not allow non-project-owner to call admin functions", async function () {
      await expect(
        launchPool.connect(user1).updateMinStakeAmount(ethers.parseEther("20"))
      ).to.be.revertedWith("Not project owner");

      await expect(
        launchPool
          .connect(user1)
          .updatePoolLimitPerUser(true, ethers.parseEther("200"))
      ).to.be.revertedWith("Not project owner");
    });

    it("Should respect project ownership transfer", async function () {
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

  describe("Precision Test", function () {
    let factory: LaunchPoolFactoryUpgradeable;
    let launchPool: LaunchPool;
    let rewardToken: MockToken;
    let testToken: MockToken;
    let projectId: bigint;
    let projectOwner: HardhatEthersSigner;
    let user1: HardhatEthersSigner;
    let user2: HardhatEthersSigner;
    let startTime: number;
    let endTime: number;

    beforeEach(async function () {
      // Deploy LaunchPool implementation first
      const LaunchPoolFactory = await ethers.getContractFactory("LaunchPool");
      const launchPoolImpl = await LaunchPoolFactory.deploy();
      await launchPoolImpl.waitForDeployment();

      // Deploy factory contract with UUPS proxy
      const Factory = await ethers.getContractFactory(
        "LaunchPoolFactoryUpgradeable"
      );
      factory = (await upgrades.deployProxy(
        Factory,
        [await launchPoolImpl.getAddress()],
        {
          initializer: "initialize",
          kind: "uups",
        }
      )) as LaunchPoolFactoryUpgradeable;

      const [owner, _projectOwner, _user1, _user2] = await ethers.getSigners();
      projectOwner = _projectOwner;
      user1 = _user1;
      user2 = _user2;

      // Deploy tokens
      const MockToken = await ethers.getContractFactory("MockToken");
      rewardToken = await MockToken.deploy();
      await rewardToken.waitForDeployment();
      testToken = await MockToken.deploy();
      await testToken.waitForDeployment();

      // Set up timestamps for 600 seconds duration
      const now = await time.latest();
      startTime = now + 100;
      endTime = startTime + 600;

      // Create project with 1000 USDT reward
      const metadata = {
        projectName: "Precision Test Project",
        website: "https://test.com",
        logo: "https://test.com/logo.png",
        discord: "https://discord.gg/test",
        twitter: "https://twitter.com/test",
        telegram: "https://t.me/test",
        tokenInfo: "Precision Test Pool",
      };

      const initialPools = [
        {
          stakedToken: testToken,
          poolRewardAmount: ethers.parseEther("1000"),
          poolLimitPerUser: ethers.parseEther("10"),
          minStakeAmount: ethers.parseEther("0.1"),
        },
      ];

      await factory.createProject(
        rewardToken,
        ethers.parseEther("1000"),
        startTime,
        endTime,
        metadata,
        initialPools,
        projectOwner.address
      );

      projectId = (await factory.nextProjectId()) - 1n;
      const poolInfos = await factory.getProjectPools(projectId);
      const LaunchPool = await ethers.getContractFactory("LaunchPool");
      launchPool = LaunchPool.attach(poolInfos[0].poolAddress) as LaunchPool;

      // Fund pool with reward tokens
      await rewardToken.mint(projectOwner.address, ethers.parseEther("1000"));
      await rewardToken
        .connect(projectOwner)
        .approve(await factory.getAddress(), ethers.parseEther("1000"));
      await factory
        .connect(projectOwner)
        .fundPool(
          projectId,
          poolInfos[0].poolAddress,
          ethers.parseEther("1000")
        );

      // Mint test tokens to users
      await testToken.mint(user1.address, ethers.parseEther("1"));
      await testToken.mint(user2.address, ethers.parseEther("1"));

      // Approve LaunchPool to spend test tokens
      await testToken
        .connect(user1)
        .approve(await launchPool.getAddress(), ethers.parseEther("1"));
      await testToken
        .connect(user2)
        .approve(await launchPool.getAddress(), ethers.parseEther("1"));
    });

    it("Should handle rewards distribution with different stake ratios", async function () {
      const rewardPerSecond = await launchPool.rewardPerSecond();
      const precisionFactor = await launchPool.PRECISION_FACTOR();

      await time.increaseTo(startTime);

      // User1 deposits 0.1 ETH
      const user1Deposit = ethers.parseEther("0.1");
      await launchPool.connect(user1).deposit(user1Deposit);

      // User2 deposits 0.2 ETH
      const user2Deposit = ethers.parseEther("0.2");
      await launchPool.connect(user2).deposit(user2Deposit);

      // Move to end time
      await time.increaseTo(endTime + 1);

      // User2 claims
      const beforeUser2Balance = await rewardToken.balanceOf(user2.address);
      await launchPool.connect(user2).claimReward();
      const afterUser2Balance = await rewardToken.balanceOf(user2.address);
      const user2Reward = afterUser2Balance - beforeUser2Balance;

      // User1 claims
      const beforeUser1Balance = await rewardToken.balanceOf(user1.address);
      await launchPool.connect(user1).claimReward();
      const afterUser1Balance = await rewardToken.balanceOf(user1.address);
      const user1Reward = afterUser1Balance - beforeUser1Balance;

      // Calculate expected rewards
      // First second: User1 gets full reward
      const firstSecondReward = rewardPerSecond;
      const firstSecondAccTokenPerShare =
        (firstSecondReward * precisionFactor) / user1Deposit;
      const user1FirstSecondReward =
        (user1Deposit * firstSecondAccTokenPerShare) / precisionFactor;

      // Remaining 598 seconds: Split between User1 (1/3) and User2 (2/3)
      const remainingReward = rewardPerSecond * BigInt(598);
      const totalStaked = user1Deposit + user2Deposit;
      const remainingAccTokenPerShare =
        (remainingReward * precisionFactor) / totalStaked;
      const user1RemainingReward =
        (user1Deposit * remainingAccTokenPerShare) / precisionFactor;
      const user2RemainingReward =
        (user2Deposit * remainingAccTokenPerShare) / precisionFactor;

      // Total expected rewards
      const expectedUser1Total = user1FirstSecondReward + user1RemainingReward;
      const expectedUser2Total = user2RemainingReward;

      // Verify rewards
      expect(user1Reward).to.be.closeTo(
        expectedUser1Total,
        ethers.parseEther("0.1")
      );
      expect(user2Reward).to.be.closeTo(
        expectedUser2Total,
        ethers.parseEther("0.1")
      );

      // Total distributed should be less than or equal to 1000
      expect(user1Reward + user2Reward).to.be.lte(ethers.parseEther("1000"));
    });
  });

  describe("Reward Claiming", function () {
    let factory: LaunchPoolFactoryUpgradeable;
    let launchPool: LaunchPool;
    let rewardToken: MockToken;
    let testToken: MockToken;
    let projectId: bigint;
    let projectOwner: HardhatEthersSigner;
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
        projectOwner,
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
      await factory.connect(projectOwner).updateProjectStatus(projectId, 3); // PAUSED

      await expect(launchPool.connect(user1).claimReward()).to.be.revertedWith(
        "Pool not ended"
      );
    });
  });

  describe("ETH Staking", function () {
    let factory: LaunchPoolFactoryUpgradeable;
    let ethPool: LaunchPool;
    let rewardToken: MockToken;
    let projectId: bigint;
    let projectOwner: HardhatEthersSigner;
    let user1: HardhatEthersSigner;
    let user2: HardhatEthersSigner;
    let startTime: number;
    let endTime: number;

    beforeEach(async function () {
      const [owner, _projectOwner, _user1, _user2] = await ethers.getSigners();
      projectOwner = _projectOwner;
      user1 = _user1;
      user2 = _user2;

      // Deploy LaunchPool implementation first
      const LaunchPoolFactory = await ethers.getContractFactory("LaunchPool");
      const launchPoolImpl = await LaunchPoolFactory.deploy();
      await launchPoolImpl.waitForDeployment();

      // Deploy factory contract with UUPS proxy
      const Factory = await ethers.getContractFactory(
        "LaunchPoolFactoryUpgradeable"
      );
      factory = (await upgrades.deployProxy(
        Factory,
        [await launchPoolImpl.getAddress()],
        {
          initializer: "initialize",
          kind: "uups",
        }
      )) as LaunchPoolFactoryUpgradeable;

      // Deploy reward token
      const MockToken = await ethers.getContractFactory("MockToken");
      rewardToken = await MockToken.deploy();
      await rewardToken.waitForDeployment();

      // Set up timestamps
      const now = await time.latest();
      startTime = now + 100;
      endTime = startTime + 3600;

      // Create project with ETH pool
      const metadata = {
        projectName: "ETH Staking Project",
        website: "https://test.com",
        logo: "https://test.com/logo.png",
        discord: "https://discord.gg/test",
        twitter: "https://twitter.com/test",
        telegram: "https://t.me/test",
        tokenInfo: "ETH Staking Pool",
      };

      const ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
      const initialPools = [
        {
          stakedToken: await ethers.getContractAt("IERC20", ETH_ADDRESS),
          poolRewardAmount: ethers.parseEther("360"),
          poolLimitPerUser: ethers.parseEther("10"),
          minStakeAmount: ethers.parseEther("1"),
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
      const poolInfos = await factory.getProjectPools(projectId);
      const LaunchPool = await ethers.getContractFactory("LaunchPool");
      ethPool = LaunchPool.attach(poolInfos[0].poolAddress) as LaunchPool;

      // Fund pool with reward tokens
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
    });

    it("Should handle ETH deposits and rewards correctly", async function () {
      await time.increaseTo(startTime);

      // User1 deposits ETH
      await ethPool.connect(user1).deposit(ethers.parseEther("5"), {
        value: ethers.parseEther("5"),
      });
      await time.increase(900); // 15 minutes

      // User2 deposits ETH
      await ethPool.connect(user2).deposit(ethers.parseEther("5"), {
        value: ethers.parseEther("5"),
      });
      await time.increase(900); // Another 15 minutes

      // Check rewards
      // User1: First 15 min full reward (90), second 15 min half reward (45)
      expect(await ethPool.pendingReward(user1.address)).to.be.closeTo(
        ethers.parseEther("135"),
        ethers.parseEther("0.1")
      );

      // User2: Only second 15 min half reward (45)
      expect(await ethPool.pendingReward(user2.address)).to.be.closeTo(
        ethers.parseEther("45"),
        ethers.parseEther("0.1")
      );
    });

    it("Should handle ETH withdrawals correctly", async function () {
      await time.increaseTo(startTime);

      // User1 deposits ETH
      await ethPool.connect(user1).deposit(ethers.parseEther("5"), {
        value: ethers.parseEther("5"),
      });
      await time.increase(900);

      const beforeBalance = await ethers.provider.getBalance(user1.address);
      const tx = await ethPool
        .connect(user1)
        .withdraw(ethers.parseEther("2.5"));
      const receipt = await tx.wait();
      const gasUsed = receipt ? receipt.gasUsed * receipt.gasPrice : 0n;

      const afterBalance = await ethers.provider.getBalance(user1.address);
      // Account for gas costs in the balance check
      expect(afterBalance + gasUsed - beforeBalance).to.equal(
        ethers.parseEther("2.5")
      );

      // Rewards should be accumulated but not claimed
      expect(await ethPool.pendingReward(user1.address)).to.be.closeTo(
        ethers.parseEther("90"),
        ethers.parseEther("0.1")
      );
    });

    it("Should handle ETH emergency withdrawal in PAUSED state", async function () {
      await time.increaseTo(startTime);

      // User1 deposits ETH
      await ethPool.connect(user1).deposit(ethers.parseEther("5"), {
        value: ethers.parseEther("5"),
      });
      await time.increase(900);

      // Set project status to PAUSED
      await factory.connect(projectOwner).updateProjectStatus(projectId, 3); // PAUSED

      const beforeBalance = await ethers.provider.getBalance(user1.address);
      const tx = await ethPool.connect(user1).emergencyWithdraw();
      const receipt = await tx.wait();
      const gasUsed = receipt ? receipt.gasUsed * receipt.gasPrice : 0n;

      const afterBalance = await ethers.provider.getBalance(user1.address);
      // Account for gas costs in the balance check
      expect(afterBalance + gasUsed - beforeBalance).to.equal(
        ethers.parseEther("5")
      );
      expect(await ethPool.pendingReward(user1.address)).to.equal(0);
    });

    it("Should reject ETH deposits with incorrect value", async function () {
      await time.increaseTo(startTime);

      // Try to deposit with incorrect ETH value
      await expect(
        ethPool.connect(user1).deposit(ethers.parseEther("5"), {
          value: ethers.parseEther("3"),
        })
      ).to.be.revertedWith("Invalid ETH amount");
    });

    it("Should reject direct ETH transfers to non-ETH pools", async function () {
      // Deploy a regular ERC20 pool
      const MockToken = await ethers.getContractFactory("MockToken");
      const testToken = await MockToken.deploy();
      await testToken.waitForDeployment();

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
        {
          projectName: "Test Project",
          website: "https://test.com",
          logo: "https://test.com/logo.png",
          discord: "https://discord.gg/test",
          twitter: "https://twitter.com/test",
          telegram: "https://t.me/test",
          tokenInfo: "Test Token Info",
        },
        initialPools,
        projectOwner.address
      );

      const newProjectId = (await factory.nextProjectId()) - 1n;
      const poolInfos = await factory.getProjectPools(newProjectId);
      const LaunchPool = await ethers.getContractFactory("LaunchPool");
      const erc20Pool = LaunchPool.attach(
        poolInfos[0].poolAddress
      ) as LaunchPool;

      // Try to send ETH directly to ERC20 pool
      await expect(
        user1.sendTransaction({
          to: await erc20Pool.getAddress(),
          value: ethers.parseEther("1"),
        })
      ).to.be.revertedWith("Use deposit() to stake ETH");
    });
  });
});
