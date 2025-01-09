import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { LaunchPool, LaunchPoolFactory, MockToken } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Access Control", function () {
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
      ethers.parseEther("10"),
      {
        projectName: "Test Project",
        website: "https://test.com",
        logo: "https://test.com/logo.png",
        discord: "https://discord.gg/test",
        twitter: "https://twitter.com/test",
        telegram: "https://t.me/test",
        tokenInfo: "Test Token Info",
      },
      admin.address
    );

    const receipt = await tx.wait();
    if (!receipt) throw new Error("No receipt");

    const log = receipt.logs[0];
    const LaunchPool = await ethers.getContractFactory("LaunchPool");
    const launchPool = LaunchPool.attach(log.address) as LaunchPool;

    // Mint tokens
    await testToken.mint(user1.address, ethers.parseEther("1000"));
    await testToken.mint(user2.address, ethers.parseEther("1000"));
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

  describe("LaunchPoolFactory Access Control", function () {
    let factory: LaunchPoolFactory;
    let rewardToken: MockToken;
    let testToken: MockToken;
    let owner: HardhatEthersSigner;
    let admin: HardhatEthersSigner;
    let user1: HardhatEthersSigner;

    beforeEach(async function () {
      ({ factory, rewardToken, testToken, owner, admin, user1 } =
        await loadFixture(deployFixture));
    });

    it("Should not allow non-owner to create pool", async function () {
      const now = await time.latest();
      await time.increase(100); // Increase time to ensure different timestamps
      const startTime = now + 200;
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
          .connect(user1)
          .deployPool(
            testToken,
            rewardToken,
            ethers.parseEther("0.1"),
            startTime,
            endTime,
            ethers.parseEther("100"),
            ethers.parseEther("10"),
            metadata,
            admin.address
          )
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("Should allow owner to create pool", async function () {
      const now = await time.latest();
      await time.increase(200); // Increase time to ensure different timestamps
      const startTime = now + 300;
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
        factory.deployPool(
          testToken,
          rewardToken,
          ethers.parseEther("0.1"),
          startTime,
          endTime,
          ethers.parseEther("100"),
          ethers.parseEther("10"),
          metadata,
          admin.address
        )
      ).to.emit(factory, "NewLaunchPool");
    });

    it("Should only allow owner to update pool metadata", async function () {
      const { factory, launchPool } = await loadFixture(deployFixture);

      const newMetadata = {
        projectName: "Updated Project",
        website: "https://updated.com",
        logo: "https://updated.com/logo.png",
        discord: "https://discord.gg/updated",
        twitter: "https://twitter.com/updated",
        telegram: "https://t.me/updated",
        tokenInfo: "Updated Token Info",
      };

      // Non-owner should not be able to update metadata
      await expect(
        factory
          .connect(user1)
          .updatePoolMetadata(await launchPool.getAddress(), newMetadata)
      ).to.be.revertedWith("Ownable: caller is not the owner");

      // Owner should be able to update metadata
      await expect(
        factory
          .connect(owner)
          .updatePoolMetadata(await launchPool.getAddress(), newMetadata)
      ).to.emit(factory, "PoolMetadataUpdated");
    });

    it("Should only allow owner to transfer ownership", async function () {
      // Non-owner should not be able to transfer ownership
      await expect(
        factory.connect(user1).transferOwnership(admin.address)
      ).to.be.revertedWith("Ownable: caller is not the owner");

      // Owner should be able to transfer ownership
      await factory.connect(owner).transferOwnership(admin.address);
      expect(await factory.owner()).to.equal(admin.address);
    });
  });

  describe("LaunchPool Access Control", function () {
    let launchPool: LaunchPool;
    let testToken: MockToken;
    let rewardToken: MockToken;
    let admin: HardhatEthersSigner;
    let user1: HardhatEthersSigner;
    let user2: HardhatEthersSigner;

    beforeEach(async function () {
      ({ launchPool, testToken, rewardToken, admin, user1, user2 } =
        await loadFixture(deployFixture));

      await testToken
        .connect(user1)
        .approve(await launchPool.getAddress(), ethers.parseEther("1000"));
      await testToken
        .connect(user2)
        .approve(await launchPool.getAddress(), ethers.parseEther("1000"));
    });

    it("Should only allow admin to update minimum stake amount", async function () {
      // Non-admin should not be able to update minimum stake amount
      await expect(
        launchPool.connect(user1).updateMinStakeAmount(ethers.parseEther("20"))
      ).to.be.revertedWith("Ownable: caller is not the owner");

      // Admin should be able to update minimum stake amount
      await expect(
        launchPool.connect(admin).updateMinStakeAmount(ethers.parseEther("20"))
      ).to.emit(launchPool, "NewMinStakeAmount");
    });

    it("Should only allow admin to update pool limit", async function () {
      // Non-admin should not be able to update pool limit
      await expect(
        launchPool
          .connect(user1)
          .updatePoolLimitPerUser(true, ethers.parseEther("200"))
      ).to.be.revertedWith("Ownable: caller is not the owner");

      // Admin should be able to update pool limit
      await expect(
        launchPool
          .connect(admin)
          .updatePoolLimitPerUser(true, ethers.parseEther("200"))
      ).to.emit(launchPool, "NewPoolLimit");
    });

    it("Should only allow admin to stop rewards", async function () {
      // Non-admin should not be able to stop rewards
      await expect(launchPool.connect(user1).stopReward()).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );

      // Admin should be able to stop rewards
      const currentTime = await time.latest();
      const tx = await launchPool.connect(admin).stopReward();
      await tx.wait();
      expect(await launchPool.endTime()).to.equal(currentTime);
    });

    it("Should only allow admin to recover wrong tokens", async function () {
      const wrongToken = await (
        await ethers.getContractFactory("MockToken")
      ).deploy();
      await wrongToken.waitForDeployment();
      await wrongToken.mint(
        await launchPool.getAddress(),
        ethers.parseEther("100")
      );

      // Non-admin should not be able to recover tokens
      await expect(
        launchPool
          .connect(user1)
          .recoverWrongTokens(
            await wrongToken.getAddress(),
            ethers.parseEther("100")
          )
      ).to.be.revertedWith("Ownable: caller is not the owner");

      // Admin should be able to recover tokens
      await expect(
        launchPool
          .connect(admin)
          .recoverWrongTokens(
            await wrongToken.getAddress(),
            ethers.parseEther("100")
          )
      ).to.emit(launchPool, "AdminTokenRecovery");
    });

    it("Should only allow admin to update reward per second before start", async function () {
      // Non-admin should not be able to update reward per second
      await expect(
        launchPool
          .connect(user1)
          .updateRewardPerSecond(ethers.parseEther("0.2"))
      ).to.be.revertedWith("Ownable: caller is not the owner");

      // Admin should be able to update reward per second before start
      await expect(
        launchPool
          .connect(admin)
          .updateRewardPerSecond(ethers.parseEther("0.2"))
      ).to.emit(launchPool, "NewRewardPerSecond");

      // Admin should not be able to update reward per second after start
      await time.increaseTo(await launchPool.startTime());
      await expect(
        launchPool
          .connect(admin)
          .updateRewardPerSecond(ethers.parseEther("0.3"))
      ).to.be.revertedWith("Pool has started");
    });

    it("Should only allow admin to update start and end times before start", async function () {
      const now = await time.latest();
      const newStartTime = now + 200;
      const newEndTime = newStartTime + 3600;

      // Non-admin should not be able to update times
      await expect(
        launchPool
          .connect(user1)
          .updateStartAndEndTimes(newStartTime, newEndTime)
      ).to.be.revertedWith("Ownable: caller is not the owner");

      // Admin should be able to update times before start
      await expect(
        launchPool
          .connect(admin)
          .updateStartAndEndTimes(newStartTime, newEndTime)
      ).to.emit(launchPool, "NewStartAndEndTimes");

      // Admin should not be able to update times after start
      await time.increaseTo(newStartTime);
      await expect(
        launchPool
          .connect(admin)
          .updateStartAndEndTimes(newStartTime + 100, newEndTime + 100)
      ).to.be.revertedWith("Pool has started");
    });

    it("Should only allow admin to perform emergency reward withdrawal", async function () {
      // Non-admin should not be able to perform emergency reward withdrawal
      await expect(
        launchPool
          .connect(user1)
          .emergencyRewardWithdraw(ethers.parseEther("100"))
      ).to.be.revertedWith("Ownable: caller is not the owner");

      // Admin should be able to perform emergency reward withdrawal
      const beforeBalance = await rewardToken.balanceOf(admin.address);
      await launchPool
        .connect(admin)
        .emergencyRewardWithdraw(ethers.parseEther("100"));
      const afterBalance = await rewardToken.balanceOf(admin.address);
      expect(afterBalance - beforeBalance).to.equal(ethers.parseEther("100"));
    });
  });
});
