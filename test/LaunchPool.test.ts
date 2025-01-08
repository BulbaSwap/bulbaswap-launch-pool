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

    // Create LaunchPool through factory
    const tx = await factory.deployPool(
      testToken,
      rewardToken,
      ethers.parseEther("0.1"),
      startTime,
      endTime,
      ethers.parseEther("100"),
      admin.address
    );

    const receipt = await tx.wait();
    if (!receipt) throw new Error("No receipt");

    const log = receipt.logs[0];
    const LaunchPool = await ethers.getContractFactory("LaunchPool");
    const launchPool = LaunchPool.attach(log.address) as LaunchPool;

    // Mint test tokens to users
    await testToken.mint(user1.address, ethers.parseEther("1000"));
    await testToken.mint(user2.address, ethers.parseEther("1000"));

    // Mint reward tokens to LaunchPool
    await rewardToken.mint(
      await launchPool.getAddress(),
      ethers.parseEther("360")
    );

    return {
      factory,
      rewardToken,
      testToken,
      launchPool,
      owner,
      admin,
      user1,
      user2,
      startTime,
      endTime,
    };
  }

  describe("Basic Functions", function () {
    let launchPool: LaunchPool;
    let testToken: MockToken;
    let rewardToken: MockToken;
    let admin: HardhatEthersSigner;
    let user1: HardhatEthersSigner;
    let user2: HardhatEthersSigner;
    let startTime: number;
    let endTime: number;

    beforeEach(async function () {
      ({
        launchPool,
        testToken,
        rewardToken,
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

    it("Should initialize with correct parameters", async function () {
      expect(await launchPool.isInitialized()).to.be.true;
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
    });

    it("Should not allow deposit before start time", async function () {
      await expect(
        launchPool.connect(user1).deposit(ethers.parseEther("10"))
      ).to.be.revertedWith("Pool has not started");
    });

    it("Should not allow deposit above limit", async function () {
      await time.increaseTo(startTime);
      await expect(
        launchPool.connect(user1).deposit(ethers.parseEther("101"))
      ).to.be.revertedWith("User amount above limit");
    });

    it("Should allow deposit within limits", async function () {
      await time.increaseTo(startTime);
      await launchPool.connect(user1).deposit(ethers.parseEther("50"));
      const userInfo = await launchPool.userInfo(user1.address);
      expect(userInfo.amount).to.equal(ethers.parseEther("50"));
    });

    it("Should calculate rewards correctly", async function () {
      await time.increaseTo(startTime);
      await launchPool.connect(user1).deposit(ethers.parseEther("100"));
      await time.increase(1800); // Increase by 30 minutes

      // 30 minutes * 0.1 token/second = 180 tokens
      const pendingReward = await launchPool.pendingReward(user1.address);
      expect(pendingReward).to.equal(ethers.parseEther("180"));
    });

    it("Should handle multiple users correctly", async function () {
      await time.increaseTo(startTime);

      // User1 stakes 100 tokens
      await launchPool.connect(user1).deposit(ethers.parseEther("100"));
      await time.increase(1800); // After 30 minutes

      // User2 stakes 50 tokens
      await launchPool.connect(user2).deposit(ethers.parseEther("50"));
      await time.increase(1800); // After another 30 minutes

      // Check rewards
      // User1: First 30 min full reward 180, next 30 min 2/3 reward 120, total 300
      expect(await launchPool.pendingReward(user1.address)).to.be.closeTo(
        ethers.parseEther("300"),
        ethers.parseEther("0.1")
      );
      // User2: Last 30 min 1/3 reward 60
      expect(await launchPool.pendingReward(user2.address)).to.be.closeTo(
        ethers.parseEther("60"),
        ethers.parseEther("0.1")
      );
    });

    it("Should allow withdrawal without claiming rewards", async function () {
      await time.increaseTo(startTime);
      await launchPool.connect(user1).deposit(ethers.parseEther("100"));
      await time.increase(1800);

      const beforeBalance = await testToken.balanceOf(user1.address);
      const beforeReward = await rewardToken.balanceOf(user1.address);

      await launchPool.connect(user1).withdraw(ethers.parseEther("100"));

      // Should get back staked tokens but no rewards
      expect(await testToken.balanceOf(user1.address)).to.equal(
        beforeBalance + ethers.parseEther("100")
      );
      expect(await rewardToken.balanceOf(user1.address)).to.equal(beforeReward);

      // Rewards should be accumulated
      expect(await launchPool.pendingReward(user1.address)).to.be.closeTo(
        ethers.parseEther("180"),
        ethers.parseEther("0.1")
      );
    });

    it("Should allow emergency withdrawal", async function () {
      await time.increaseTo(startTime);
      await launchPool.connect(user1).deposit(ethers.parseEther("100"));
      await time.increase(1800);

      const beforeBalance = await testToken.balanceOf(user1.address);
      const beforeReward = await rewardToken.balanceOf(user1.address);

      await launchPool.connect(user1).emergencyWithdraw();

      // Should return staked tokens but no rewards
      expect(await testToken.balanceOf(user1.address)).to.equal(
        beforeBalance + ethers.parseEther("100")
      );
      expect(await rewardToken.balanceOf(user1.address)).to.equal(beforeReward);
    });

    it("Should allow admin to update pool limit", async function () {
      await launchPool
        .connect(admin)
        .updatePoolLimitPerUser(true, ethers.parseEther("200"));
      expect(await launchPool.poolLimitPerUser()).to.equal(
        ethers.parseEther("200")
      );

      await launchPool.connect(admin).updatePoolLimitPerUser(false, 0);
      expect(await launchPool.hasUserLimit()).to.be.false;
      expect(await launchPool.poolLimitPerUser()).to.equal(0);
    });

    it("Should allow admin to stop rewards", async function () {
      await time.increaseTo(startTime);
      await launchPool.connect(user1).deposit(ethers.parseEther("100"));

      await launchPool.connect(admin).stopReward();
      expect(await launchPool.endTime()).to.equal(await time.latest());
    });

    it("Should allow admin to recover wrong tokens", async function () {
      const wrongToken = await (
        await ethers.getContractFactory("MockToken")
      ).deploy();
      await wrongToken.waitForDeployment();
      await wrongToken.mint(
        await launchPool.getAddress(),
        ethers.parseEther("100")
      );

      await expect(
        launchPool
          .connect(admin)
          .recoverWrongTokens(
            await testToken.getAddress(),
            ethers.parseEther("100")
          )
      ).to.be.revertedWith("Cannot be staked token");

      await expect(
        launchPool
          .connect(admin)
          .recoverWrongTokens(
            await rewardToken.getAddress(),
            ethers.parseEther("100")
          )
      ).to.be.revertedWith("Cannot be reward token");

      await launchPool
        .connect(admin)
        .recoverWrongTokens(
          await wrongToken.getAddress(),
          ethers.parseEther("100")
        );
      expect(await wrongToken.balanceOf(admin.address)).to.equal(
        ethers.parseEther("100")
      );
    });
  });

  describe("Reward Claiming", function () {
    let launchPool: LaunchPool;
    let testToken: MockToken;
    let rewardToken: MockToken;
    let admin: HardhatEthersSigner;
    let user1: HardhatEthersSigner;
    let user2: HardhatEthersSigner;
    let startTime: number;
    let endTime: number;

    beforeEach(async function () {
      ({
        launchPool,
        testToken,
        rewardToken,
        admin,
        user1,
        user2,
        startTime,
        endTime,
      } = await loadFixture(deployFixture));

      await testToken
        .connect(user1)
        .approve(await launchPool.getAddress(), ethers.parseEther("1000"));
      await testToken
        .connect(user2)
        .approve(await launchPool.getAddress(), ethers.parseEther("1000"));
    });

    it("Should not allow claiming rewards before pool ends", async function () {
      await time.increaseTo(startTime);
      await launchPool.connect(user1).deposit(ethers.parseEther("100"));
      await time.increase(1800);

      await expect(launchPool.connect(user1).claimReward()).to.be.revertedWith(
        "Pool has not ended"
      );
    });

    it("Should calculate rewards correctly for single stake period", async function () {
      await time.increaseTo(startTime);

      // Stake 50 tokens
      await launchPool.connect(user1).deposit(ethers.parseEther("50"));
      const stakeTime = await time.latest();

      // Wait 15 minutes
      await time.increase(900);

      // Expected rewards: 15 minutes * 0.1 tokens/second = 90 tokens
      const pending = await launchPool.pendingReward(user1.address);
      const expectedReward = ethers.parseEther("90");
      expect(pending).to.be.closeTo(expectedReward, ethers.parseEther("0.1"));
    });

    it("Should calculate rewards correctly after partial unstake", async function () {
      await time.increaseTo(startTime);

      // Stake 50 tokens
      await launchPool.connect(user1).deposit(ethers.parseEther("50"));
      const userInfo1 = await launchPool.userInfo(user1.address);
      console.log("After deposit:", {
        amount: ethers.formatEther(userInfo1.amount),
        rewardDebt: ethers.formatEther(userInfo1.rewardDebt),
        pendingRewards: ethers.formatEther(userInfo1.pendingRewards),
        accTokenPerShare: ethers.formatEther(
          await launchPool.accTokenPerShare()
        ),
      });

      await time.increase(900); // 15 minutes

      // Check rewards before withdraw
      const userInfo2 = await launchPool.userInfo(user1.address);
      const beforeWithdraw = await launchPool.pendingReward(user1.address);
      console.log("Before withdraw:", {
        pending: ethers.formatEther(beforeWithdraw),
        amount: ethers.formatEther(userInfo2.amount),
        rewardDebt: ethers.formatEther(userInfo2.rewardDebt),
        pendingRewards: ethers.formatEther(userInfo2.pendingRewards),
        accTokenPerShare: ethers.formatEther(
          await launchPool.accTokenPerShare()
        ),
      });

      // Withdraw half tokens
      await launchPool.connect(user1).withdraw(ethers.parseEther("25"));
      const userInfo3 = await launchPool.userInfo(user1.address);
      console.log("After withdraw:", {
        amount: ethers.formatEther(userInfo3.amount),
        rewardDebt: ethers.formatEther(userInfo3.rewardDebt),
        pendingRewards: ethers.formatEther(userInfo3.pendingRewards),
        accTokenPerShare: ethers.formatEther(
          await launchPool.accTokenPerShare()
        ),
      });

      // Wait another 15 minutes
      await time.increase(900);

      // Check final rewards
      const userInfo4 = await launchPool.userInfo(user1.address);
      const finalReward = await launchPool.pendingReward(user1.address);
      console.log("Final state:", {
        pending: ethers.formatEther(finalReward),
        amount: ethers.formatEther(userInfo4.amount),
        rewardDebt: ethers.formatEther(userInfo4.rewardDebt),
        pendingRewards: ethers.formatEther(userInfo4.pendingRewards),
        accTokenPerShare: ethers.formatEther(
          await launchPool.accTokenPerShare()
        ),
      });

      // First 15 min: 50 tokens staked = 90 tokens reward (stored in pendingRewards)
      // Second 15 min: 25 tokens staked = 90 tokens reward (new pending)
      // Total expected: 180 tokens
      expect(finalReward).to.be.closeTo(
        ethers.parseEther("180"),
        ethers.parseEther("0.1")
      );
    });

    it("Should allow claiming accumulated rewards after pool ends", async function () {
      await time.increaseTo(startTime);

      // Stake 50 tokens for 30 minutes
      await launchPool.connect(user1).deposit(ethers.parseEther("50"));
      const userInfo1 = await launchPool.userInfo(user1.address);
      console.log("After deposit:", {
        amount: ethers.formatEther(userInfo1.amount),
        rewardDebt: ethers.formatEther(userInfo1.rewardDebt),
        pendingRewards: ethers.formatEther(userInfo1.pendingRewards),
        accTokenPerShare: ethers.formatEther(
          await launchPool.accTokenPerShare()
        ),
      });

      await time.increase(1800); // 30 minutes = 180 tokens reward

      // Check pending rewards
      const userInfo2 = await launchPool.userInfo(user1.address);
      const pendingBeforeClaim = await launchPool.pendingReward(user1.address);
      console.log("Before claim:", {
        pending: ethers.formatEther(pendingBeforeClaim),
        amount: ethers.formatEther(userInfo2.amount),
        rewardDebt: ethers.formatEther(userInfo2.rewardDebt),
        pendingRewards: ethers.formatEther(userInfo2.pendingRewards),
        accTokenPerShare: ethers.formatEther(
          await launchPool.accTokenPerShare()
        ),
      });

      // Calculate remaining time until end
      const currentTime = await time.latest();
      const remainingTime = endTime - currentTime;
      await time.increase(remainingTime);

      // Check rewards at end time
      const userInfoAtEnd = await launchPool.userInfo(user1.address);
      const pendingAtEnd = await launchPool.pendingReward(user1.address);
      console.log("At end time:", {
        pending: ethers.formatEther(pendingAtEnd),
        amount: ethers.formatEther(userInfoAtEnd.amount),
        rewardDebt: ethers.formatEther(userInfoAtEnd.rewardDebt),
        pendingRewards: ethers.formatEther(userInfoAtEnd.pendingRewards),
        accTokenPerShare: ethers.formatEther(
          await launchPool.accTokenPerShare()
        ),
      });

      // Move just past end time and claim
      await time.increase(1);
      const beforeReward = await rewardToken.balanceOf(user1.address);
      await launchPool.connect(user1).claimReward();
      const afterReward = await rewardToken.balanceOf(user1.address);

      // Should receive rewards accumulated up to end time
      expect(afterReward - beforeReward).to.be.closeTo(
        pendingAtEnd,
        ethers.parseEther("0.1")
      );

      // Check final state
      const userInfoAfterClaim = await launchPool.userInfo(user1.address);
      console.log("After claim:", {
        amount: ethers.formatEther(userInfoAfterClaim.amount),
        rewardDebt: ethers.formatEther(userInfoAfterClaim.rewardDebt),
        pendingRewards: ethers.formatEther(userInfoAfterClaim.pendingRewards),
        accTokenPerShare: ethers.formatEther(
          await launchPool.accTokenPerShare()
        ),
      });

      // pendingReward should be 0 after claiming
      expect(await launchPool.pendingReward(user1.address)).to.equal(0);
    });

    it("Should track rewards correctly when multiple users stake", async function () {
      await time.increaseTo(startTime);

      // User1 stakes 50 tokens
      await launchPool.connect(user1).deposit(ethers.parseEther("50"));
      await time.increase(900); // 15 minutes

      // User2 stakes 50 tokens
      await launchPool.connect(user2).deposit(ethers.parseEther("50"));
      await time.increase(900); // Another 15 minutes

      // User1's rewards:
      // First 15 min: full pool (90 tokens)
      // Second 15 min: half pool (45 tokens)
      // Total: 135 tokens
      const user1Pending = await launchPool.pendingReward(user1.address);
      expect(user1Pending).to.be.closeTo(
        ethers.parseEther("135"),
        ethers.parseEther("0.1")
      );

      // User2's rewards:
      // Only second 15 min: half pool (45 tokens)
      const user2Pending = await launchPool.pendingReward(user2.address);
      expect(user2Pending).to.be.closeTo(
        ethers.parseEther("45"),
        ethers.parseEther("0.1")
      );
    });
  });
});
