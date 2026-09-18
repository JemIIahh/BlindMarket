import { expect } from "chai";
import { ethers } from "../lib/hh.js";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

describe("AgentFactory", function () {
  let factory: any;
  let usdc: any;
  let owner: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const DEPLOY_FEE = ethers.parseUnits("1", 6); // 1 USDC

  beforeEach(async function () {
    [owner, treasury, user, stranger] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    usdc = await Token.deploy("Mock USDC", "MUSDC", 6);
    await usdc.mint(user.address, ethers.parseUnits("100", 6));

    const Factory = await ethers.getContractFactory("AgentFactory");
    factory = await Factory.deploy(await usdc.getAddress(), treasury.address, DEPLOY_FEE);

    await usdc.connect(user).approve(await factory.getAddress(), ethers.MaxUint256);
  });

  describe("deployAgent", function () {
    it("sends the fee to treasury and retains nothing", async function () {
      const treasuryBefore = await usdc.balanceOf(treasury.address);
      const userBefore = await usdc.balanceOf(user.address);

      await factory.connect(user).deployAgent(0);

      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore + DEPLOY_FEE);
      expect(await usdc.balanceOf(user.address)).to.equal(userBefore - DEPLOY_FEE);
      // The contract must never sit on user funds.
      expect(await usdc.balanceOf(await factory.getAddress())).to.equal(0);
    });

    it("emits AgentDeployed with an incrementing nonce", async function () {
      await expect(factory.connect(user).deployAgent(0))
        .to.emit(factory, "AgentDeployed")
        .withArgs(user.address, 0, 1, anyUint());

      await expect(factory.connect(user).deployAgent(0))
        .to.emit(factory, "AgentDeployed")
        .withArgs(user.address, 0, 2, anyUint());

      expect(await factory.nonce()).to.equal(2);
    });

    it("rejects agent funding rather than stranding it in the contract", async function () {
      // There is no on-chain agent wallet to forward funding to at this point,
      // so a non-zero amount would be unrecoverable except by the owner.
      await expect(
        factory.connect(user).deployAgent(ethers.parseUnits("50", 6))
      ).to.be.revertedWithCustomError(factory, "AgentFundingNotSupported");

      expect(await usdc.balanceOf(await factory.getAddress())).to.equal(0);
    });

    it("reverts when deploy is not enabled", async function () {
      await factory.connect(owner).setDeployFee(0);
      await expect(factory.connect(user).deployAgent(0)).to.be.revertedWith("Deploy not enabled");
    });

    it("reverts without a USDC approval", async function () {
      await usdc.connect(user).approve(await factory.getAddress(), 0);
      await expect(factory.connect(user).deployAgent(0)).to.revert(ethers);
    });
  });

  describe("admin", function () {
    it("requires a two-step ownership transfer", async function () {
      await factory.connect(owner).transferOwnership(stranger.address);
      // Ownership does not move until the new owner accepts — a mistyped
      // address cannot brick the contract.
      expect(await factory.owner()).to.equal(owner.address);
      expect(await factory.pendingOwner()).to.equal(stranger.address);

      await factory.connect(stranger).acceptOwnership();
      expect(await factory.owner()).to.equal(stranger.address);
    });

    it("only lets the owner change treasury and fee", async function () {
      await expect(factory.connect(stranger).setTreasury(stranger.address)).to.be.revertedWithCustomError(
        factory,
        "OwnableUnauthorizedAccount"
      );
      await expect(factory.connect(stranger).setDeployFee(0)).to.be.revertedWithCustomError(
        factory,
        "OwnableUnauthorizedAccount"
      );
    });

    it("rejects a zero treasury", async function () {
      await expect(factory.connect(owner).setTreasury(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
    });

    it("emits on emergency withdrawal", async function () {
      // Simulate tokens sent here by mistake.
      await usdc.connect(user).transfer(await factory.getAddress(), DEPLOY_FEE);

      await expect(factory.connect(owner).emergencyWithdraw(DEPLOY_FEE))
        .to.emit(factory, "EmergencyWithdrawal")
        .withArgs(owner.address, DEPLOY_FEE);
    });
  });
});

// Matches any uint — used for the block timestamp in AgentDeployed.
function anyUint() {
  return (v: bigint) => typeof v === "bigint" && v >= 0n;
}
