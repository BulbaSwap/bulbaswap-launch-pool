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

  describe("Pool Creation", function () {
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

    it("Should create new LaunchPool", async function () {
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

    it("Should not allow non-owner to create LaunchPool", async function () {
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

    it("Should validate LaunchPool addresses", async function () {
      const now = await time.latest();
      const startTime = now + 100;
      const endTime = startTime + 3600;

      // Cannot use the same token for both staked and reward
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
          testToken,
          ethers.parseEther("0.1"),
          startTime,
          endTime,
          ethers.parseEther("100"),
          ethers.parseEther("10"),
          metadata,
          admin.address
        )
      ).to.be.revertedWith("Tokens must be different");

      // Cannot use zero address as admin
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
          ethers.ZeroAddress
        )
      ).to.be.revertedWith("Ownable: new owner is the zero address");
    });
  });

  describe("LaunchPool Integration", function () {
    let factory: LaunchPoolFactory;
    let rewardToken: MockToken;
    let testToken: MockToken;
    let launchPool: LaunchPool;
    let owner: HardhatEthersSigner;
    let admin: HardhatEthersSigner;
    let user: HardhatEthersSigner;

    async function createPoolFixture() {
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

      const tx = await factory.deployPool(
        testToken,
        rewardToken,
        ethers.parseEther("0.1"),
        startTime,
        endTime,
        ethers.parseEther("100"),
        ethers.parseEther("10"),
        metadata,
        admin.address
      );

      const receipt = await tx.wait();
      if (!receipt) throw new Error("No receipt");

      const log = receipt.logs[0];
      const LaunchPool = await ethers.getContractFactory("LaunchPool");
      const launchPool = LaunchPool.attach(log.address) as LaunchPool;

      return {
        factory,
        rewardToken,
        testToken,
        launchPool,
        owner,
        admin,
        user,
        startTime,
        endTime,
      };
    }

    beforeEach(async function () {
      ({ factory, rewardToken, testToken, launchPool, owner, admin, user } =
        await loadFixture(createPoolFixture));
    });

    it("Should initialize LaunchPool correctly", async function () {
      expect(await launchPool.isInitialized()).to.be.true;
      expect(await launchPool.owner()).to.equal(admin.address);
      expect(await launchPool.rewardToken()).to.equal(
        await rewardToken.getAddress()
      );
      expect(await launchPool.stakedToken()).to.equal(
        await testToken.getAddress()
      );
    });

    it("Should update pool metadata", async function () {
      const { factory, launchPool } = await loadFixture(createPoolFixture);

      const newMetadata = {
        projectName: "Updated Project",
        website: "https://updated.com",
        logo: "https://updated.com/logo.png",
        discord: "https://discord.gg/updated",
        twitter: "https://twitter.com/updated",
        telegram: "https://t.me/updated",
        tokenInfo: "Updated Token Info",
      };

      const tx = await factory.updatePoolMetadata(
        await launchPool.getAddress(),
        newMetadata
      );
      await expect(tx).to.emit(factory, "PoolMetadataUpdated");

      // Non-owner should not be able to update metadata
      await expect(
        factory
          .connect(user)
          .updatePoolMetadata(await launchPool.getAddress(), newMetadata)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
  });
});
