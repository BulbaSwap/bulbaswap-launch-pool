import { expect } from "chai";
import { ethers } from "hardhat";
import { MockToken } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("MockToken", function () {
  let token: MockToken;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, user] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockToken");
    token = await MockToken.deploy();
    await token.waitForDeployment();
  });

  describe("Deployment", function () {
    it("Should set the right name and symbol", async function () {
      expect(await token.name()).to.equal("Mock Token");
      expect(await token.symbol()).to.equal("MTK");
    });

    it("Should set the right owner", async function () {
      expect(await token.owner()).to.equal(owner.address);
    });
  });

  describe("Minting", function () {
    it("Should allow owner to mint tokens", async function () {
      const amount = ethers.parseEther("100");
      await token.mint(user.address, amount);
      expect(await token.balanceOf(user.address)).to.equal(amount);
    });

    it("Should not allow non-owner to mint tokens", async function () {
      const amount = ethers.parseEther("100");
      await expect(
        token.connect(user).mint(user.address, amount)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
  });

  describe("Transfers", function () {
    beforeEach(async function () {
      await token.mint(owner.address, ethers.parseEther("1000"));
    });

    it("Should transfer tokens between accounts", async function () {
      const amount = ethers.parseEther("100");
      await token.transfer(user.address, amount);
      expect(await token.balanceOf(user.address)).to.equal(amount);
    });

    it("Should fail if sender doesn't have enough tokens", async function () {
      const initialOwnerBalance = await token.balanceOf(owner.address);
      await expect(
        token.connect(user).transfer(owner.address, 1)
      ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
      expect(await token.balanceOf(owner.address)).to.equal(
        initialOwnerBalance
      );
    });
  });
});
