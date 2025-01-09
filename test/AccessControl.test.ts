import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { LaunchPool, LaunchPoolFactory, MockToken } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Access Control", function () {
  async function deployFixture() {
    const [owner, admin, user1] = await ethers.getSigners();

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
      rewardPerSecond: ethers.parseEther("0.1"),
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

    // Mint and fund reward tokens
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
      user1,
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
        rewardPerSecond: 0,
        poolLimitPerUser: 0,
        minStakeAmount: 0,
        admin: ethers.ZeroAddress,
      };

      await expect(
        factory
          .connect(user1)
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

    it("Should allow owner to create project and add pool", async function () {
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
        rewardPerSecond: 0,
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

      await expect(
        factory.addPoolToProject(
          projectId,
          testToken,
          ethers.parseEther("0.1"),
          ethers.parseEther("100"),
          ethers.parseEther("10"),
          admin.address
        )
      ).to.emit(factory, "NewLaunchPool");
    });

    it("Should only allow owner to update project metadata", async function () {
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
      ).to.be.revertedWith("Ownable: caller is not the owner");

      await expect(
        factory.updateProjectMetadata(projectId, newMetadata)
      ).to.emit(factory, "PoolMetadataUpdated");
    });

    it("Should only allow owner to transfer ownership", async function () {
      await expect(
        factory.connect(user1).transferOwnership(user1.address)
      ).to.be.revertedWith("Ownable: caller is not the owner");

      await expect(factory.transferOwnership(user1.address))
        .to.emit(factory, "OwnershipTransferred")
        .withArgs(owner.address, user1.address);
    });
  });

  describe("LaunchPool Access Control", function () {
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

    it("Should only allow admin to update minimum stake amount", async function () {
      await expect(
        launchPool.connect(user1).updateMinStakeAmount(ethers.parseEther("20"))
      ).to.be.revertedWith("Ownable: caller is not the owner");

      await expect(
        launchPool.connect(admin).updateMinStakeAmount(ethers.parseEther("20"))
      )
        .to.emit(launchPool, "NewMinStakeAmount")
        .withArgs(ethers.parseEther("20"));
    });

    it("Should only allow admin to update pool limit", async function () {
      await expect(
        launchPool
          .connect(user1)
          .updatePoolLimitPerUser(true, ethers.parseEther("200"))
      ).to.be.revertedWith("Ownable: caller is not the owner");

      await expect(
        launchPool
          .connect(admin)
          .updatePoolLimitPerUser(true, ethers.parseEther("200"))
      )
        .to.emit(launchPool, "NewPoolLimit")
        .withArgs(ethers.parseEther("200"));
    });

    it("Should only allow admin to stop rewards", async function () {
      await expect(launchPool.connect(user1).stopReward()).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );

      await expect(launchPool.connect(admin).stopReward()).to.emit(
        launchPool,
        "RewardsStop"
      );
    });

    it("Should only allow admin to recover wrong tokens", async function () {
      // Deploy a new token to test recovery
      const MockToken = await ethers.getContractFactory("MockToken");
      const wrongToken = await MockToken.deploy();
      await wrongToken.waitForDeployment();
      await wrongToken.mint(
        await launchPool.getAddress(),
        ethers.parseEther("100")
      );

      await factory.updateProjectStatus(projectId, 3); // PAUSED

      await expect(
        launchPool
          .connect(user1)
          .recoverWrongTokens(
            await wrongToken.getAddress(),
            ethers.parseEther("100")
          )
      ).to.be.revertedWith("Ownable: caller is not the owner");

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
      await expect(
        launchPool
          .connect(user1)
          .updateRewardPerSecond(ethers.parseEther("0.2"))
      ).to.be.revertedWith("Ownable: caller is not the owner");

      await expect(
        launchPool
          .connect(admin)
          .updateRewardPerSecond(ethers.parseEther("0.2"))
      )
        .to.emit(launchPool, "NewRewardPerSecond")
        .withArgs(ethers.parseEther("0.2"));
    });

    it("Should only allow admin to update start and end times before start", async function () {
      const now = await time.latest();
      const newStartTime = now + 200;
      const newEndTime = newStartTime + 3600;

      await expect(
        launchPool
          .connect(user1)
          .updateStartAndEndTimes(newStartTime, newEndTime)
      ).to.be.revertedWith("Ownable: caller is not the owner");

      await expect(
        launchPool
          .connect(admin)
          .updateStartAndEndTimes(newStartTime, newEndTime)
      )
        .to.emit(launchPool, "NewStartAndEndTimes")
        .withArgs(newStartTime, newEndTime);
    });

    it("Should only allow admin to perform emergency reward withdrawal", async function () {
      await factory.updateProjectStatus(projectId, 3); // PAUSED

      await expect(
        launchPool
          .connect(user1)
          .emergencyRewardWithdraw(ethers.parseEther("100"))
      ).to.be.revertedWith("Ownable: caller is not the owner");

      await expect(
        launchPool
          .connect(admin)
          .emergencyRewardWithdraw(ethers.parseEther("100"))
      ).not.to.be.reverted;
    });
  });
});
