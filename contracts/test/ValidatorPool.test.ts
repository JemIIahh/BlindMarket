import { expect } from "chai";
import { ethers } from "hardhat";
import { ValidatorPool } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("ValidatorPool", function () {
  let pool: ValidatorPool;
  let token: any;
  let mockEscrow: any;
  let admin: HardhatEthersSigner;
  let v1: HardhatEthersSigner;
  let v2: HardhatEthersSigner;
  let v3: HardhatEthersSigner;
  let escrow: HardhatEthersSigner; // signer used for openDispute in basic tests
  let stranger: HardhatEthersSigner;

  // Contract uses 6-decimal USDC (MIN_STAKE = 100e6). Master commit 393ebb0
  // changed the contract constant from 100e18 → 100e6 without updating this
  // test, so the "reverts if stake below minimum" assertion was broken on
  // master. Fixed as part of the merge resolution. AMOUNT (only used as a
  // dispute payout sentinel) is left at parseEther since the contract doesn't
  // compare it against a USDC-denominated bound.
  const MIN_STAKE = ethers.parseUnits("100", 6);
  const VOTE_WINDOW = 48 * 3600;
  const TASK_ID = 1;
  const AMOUNT = ethers.parseEther("500");

  beforeEach(async () => {
    [admin, v1, v2, v3, escrow, stranger] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    token = await Token.deploy("Stake Token", "STK", 18);

    for (const signer of [v1, v2, v3]) {
      await token.mint(signer.address, ethers.parseEther("1000"));
    }

    const Pool = await ethers.getContractFactory("ValidatorPool");
    pool = await Pool.deploy(await token.getAddress());

    const MockEscrow = await ethers.getContractFactory("MockEscrow");
    mockEscrow = await MockEscrow.deploy();
  });

  // ── Registration ──────────────────────────────────────────────────────────

  describe("register", () => {
    it("registers a validator with sufficient stake", async () => {
      await token.connect(v1).approve(await pool.getAddress(), MIN_STAKE);
      await expect(pool.connect(v1).register(MIN_STAKE))
        .to.emit(pool, "ValidatorRegistered")
        .withArgs(v1.address, MIN_STAKE);

      const val = await pool.validators(v1.address);
      expect(val.active).to.be.true;
      expect(val.stake).to.equal(MIN_STAKE);
    });

    it("reverts if stake below minimum", async () => {
      await token.connect(v1).approve(await pool.getAddress(), MIN_STAKE);
      await expect(pool.connect(v1).register(MIN_STAKE - 1n))
        .to.be.revertedWithCustomError(pool, "InsufficientStake");
    });

    it("reverts if already registered", async () => {
      await token.connect(v1).approve(await pool.getAddress(), MIN_STAKE * 2n);
      await pool.connect(v1).register(MIN_STAKE);
      await expect(pool.connect(v1).register(MIN_STAKE))
        .to.be.revertedWithCustomError(pool, "AlreadyValidator");
    });
  });

  describe("unstake", () => {
    it("returns stake and deactivates validator", async () => {
      await token.connect(v1).approve(await pool.getAddress(), MIN_STAKE);
      await pool.connect(v1).register(MIN_STAKE);

      const before = await token.balanceOf(v1.address);
      await pool.connect(v1).unstake();
      const after = await token.balanceOf(v1.address);

      expect(after - before).to.equal(MIN_STAKE);
      expect((await pool.validators(v1.address)).active).to.be.false;
    });

    it("reverts if not a validator", async () => {
      await expect(pool.connect(stranger).unstake())
        .to.be.revertedWithCustomError(pool, "NotValidator");
    });
  });

  // ── Dispute Lifecycle ─────────────────────────────────────────────────────

  async function registerAll() {
    for (const signer of [v1, v2, v3]) {
      await token.connect(signer).approve(await pool.getAddress(), MIN_STAKE);
      await pool.connect(signer).register(MIN_STAKE);
    }
  }

  async function openDispute() {
    const tx = await pool.connect(escrow).openDispute(TASK_ID, await token.getAddress(), AMOUNT);
    const receipt = await tx.wait();
    const event = receipt?.logs.find((l: any) => {
      try { return pool.interface.parseLog(l)?.name === "DisputeOpened"; } catch { return false; }
    });
    return Number(pool.interface.parseLog(event as any)?.args?.disputeId);
  }

  describe("openDispute", () => {
    it("opens a dispute and emits event", async () => {
      await expect(pool.connect(escrow).openDispute(TASK_ID, await token.getAddress(), AMOUNT))
        .to.emit(pool, "DisputeOpened")
        .withArgs(1, TASK_ID, escrow.address);

      const d = await pool.getDispute(1);
      expect(d.taskId).to.equal(TASK_ID);
      expect(d.finalized).to.be.false;
    });
  });

  describe("vote", () => {
    it("allows active validators to vote", async () => {
      await registerAll();
      const dId = await openDispute();

      await expect(pool.connect(v1).vote(dId, 1)) // Vote.Worker = 1
        .to.emit(pool, "Voted")
        .withArgs(dId, v1.address, 1);

      expect(await pool.getVote(dId, v1.address)).to.equal(1);
    });

    it("reverts double vote", async () => {
      await registerAll();
      const dId = await openDispute();
      await pool.connect(v1).vote(dId, 1);
      await expect(pool.connect(v1).vote(dId, 1))
        .to.be.revertedWithCustomError(pool, "AlreadyVoted");
    });

    it("reverts if not a validator", async () => {
      const dId = await openDispute();
      await expect(pool.connect(stranger).vote(dId, 1))
        .to.be.revertedWithCustomError(pool, "NotValidator");
    });

    it("reverts after vote window", async () => {
      await registerAll();
      const dId = await openDispute();
      await time.increase(VOTE_WINDOW + 1);
      await expect(pool.connect(v1).vote(dId, 1))
        .to.be.revertedWithCustomError(pool, "VoteWindowClosed");
    });
  });

  describe("finalizeDispute", () => {
    it("reverts before vote window closes", async () => {
      await registerAll();
      const dId = await openDispute();
      await pool.connect(v1).vote(dId, 1);
      await expect(pool.finalizeDispute(dId))
        .to.be.revertedWithCustomError(pool, "VoteWindowOpen");
    });

    it("finalizes with insufficient votes (no quorum)", async () => {
      await registerAll();
      const dId = await openDispute();
      // Only 2 votes — below MIN_VOTES=3
      await pool.connect(v1).vote(dId, 1);
      await pool.connect(v2).vote(dId, 1);
      await time.increase(VOTE_WINDOW + 1);

      await expect(pool.finalizeDispute(dId))
        .to.emit(pool, "DisputeFinalized");

      expect((await pool.getDispute(dId)).finalized).to.be.true;
    });

  async function openDisputeViaContract() {
    const MockEscrowFactory = await ethers.getContractFactory("MockEscrow");
    const me = await MockEscrowFactory.deploy();
    const meAddr = await me.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [meAddr]);
    await ethers.provider.send("hardhat_setBalance", [meAddr, "0x1000000000000000000"]);
    const meSigner = await ethers.getSigner(meAddr);
    const tx = await pool.connect(meSigner).openDispute(TASK_ID, await token.getAddress(), AMOUNT);
    const receipt = await tx.wait();
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [meAddr]);
    const event = receipt?.logs.find((l: any) => { try { return pool.interface.parseLog(l)?.name === "DisputeOpened"; } catch { return false; } });
    const dId = Number(pool.interface.parseLog(event as any)?.args?.disputeId);
    return { dId, me };
  }

    it("slashes wrong voters and rewards correct voters", async () => {
      await registerAll();
      const { dId, me } = await openDisputeViaContract();

      await pool.connect(v1).vote(dId, 1); // Worker
      await pool.connect(v2).vote(dId, 1); // Worker
      await pool.connect(v3).vote(dId, 2); // Agent (wrong)

      await time.increase(VOTE_WINDOW + 1);

      const v3StakeBefore = (await pool.validators(v3.address)).stake;
      await pool.finalizeDispute(dId);
      const v3StakeAfter = (await pool.validators(v3.address)).stake;

      expect(v3StakeAfter).to.be.lt(v3StakeBefore);
      expect((await pool.validators(v1.address)).stake).to.be.gt(MIN_STAKE);
      expect(await me.resolveCount()).to.equal(1);
      expect(await me.lastWorkerFavored()).to.be.true;
    });

    it("worker wins when votes tied", async () => {
      await registerAll();
      const { dId } = await openDisputeViaContract();

      const [,,,,,, v4] = await ethers.getSigners();
      await token.mint(v4.address, ethers.parseEther("1000"));
      await token.connect(v4).approve(await pool.getAddress(), MIN_STAKE);
      await pool.connect(v4).register(MIN_STAKE);

      await pool.connect(v1).vote(dId, 1);
      await pool.connect(v2).vote(dId, 1);
      await pool.connect(v3).vote(dId, 2);
      await pool.connect(v4).vote(dId, 2);

      await time.increase(VOTE_WINDOW + 1);
      await pool.finalizeDispute(dId);

      expect((await pool.getDispute(dId)).workerFavored).to.be.true;
    });

    it("reverts double finalize", async () => {
      await registerAll();
      const { dId } = await openDisputeViaContract();
      await pool.connect(v1).vote(dId, 1);
      await pool.connect(v2).vote(dId, 1);
      await pool.connect(v3).vote(dId, 1);
      await time.increase(VOTE_WINDOW + 1);
      await pool.finalizeDispute(dId);
      await expect(pool.finalizeDispute(dId))
        .to.be.revertedWithCustomError(pool, "AlreadyFinalized");
    });
  });

  describe("activeValidatorCount", () => {
    it("returns correct count", async () => {
      expect(await pool.activeValidatorCount()).to.equal(0);
      await registerAll();
      expect(await pool.activeValidatorCount()).to.equal(3);
      await pool.connect(v1).unstake();
      expect(await pool.activeValidatorCount()).to.equal(2);
    });
  });
});
