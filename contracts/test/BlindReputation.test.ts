import { expect } from "chai";
import { ethers, upgrades } from "../lib/hh.js";
import type { BlindReputation } from "../types/ethers-contracts/index.js";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

describe("BlindReputation", function () {
  let reputation: BlindReputation;
  let admin: HardhatEthersSigner;
  let escrow: HardhatEthersSigner;
  let worker: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  beforeEach(async function () {
    [admin, escrow, worker, stranger] = await ethers.getSigners();

    const Rep = await ethers.getContractFactory("BlindReputation");
    reputation = (await upgrades.deployProxy(Rep, [], { kind: "uups" })) as unknown as BlindReputation;

    await reputation.connect(admin).authorizeRater(escrow.address);
  });

  describe("rate", function () {
    it("should record a rating with taskId", async function () {
      const tx = await reputation.connect(escrow).rate(worker.address, 5, 1);

      const [tasksCompleted, avgScore, disputes] = await reputation.getReputation(worker.address);
      expect(tasksCompleted).to.equal(1);
      expect(avgScore).to.equal(500);
      expect(disputes).to.equal(0);

      await expect(tx).to.emit(reputation, "Rated").withArgs(worker.address, escrow.address, 5, 1);
    });

    it("should compute average over multiple ratings", async function () {
      await reputation.connect(escrow).rate(worker.address, 5, 1);
      await reputation.connect(escrow).rate(worker.address, 3, 2); // different taskId

      const [tasksCompleted, avgScore] = await reputation.getReputation(worker.address);
      expect(tasksCompleted).to.equal(2);
      expect(avgScore).to.equal(400); // (5+3)/2 = 4.00 → 400
    });

    it("should reject duplicate rating for same task", async function () {
      await reputation.connect(escrow).rate(worker.address, 5, 1);
      await expect(
        reputation.connect(escrow).rate(worker.address, 4, 1) // same taskId
      ).to.be.revertedWithCustomError(reputation, "AlreadyRated");
    });

    it("should reject score below 1", async function () {
      await expect(
        reputation.connect(escrow).rate(worker.address, 0, 1)
      ).to.be.revertedWithCustomError(reputation, "InvalidScore");
    });

    it("should reject score above 5", async function () {
      await expect(
        reputation.connect(escrow).rate(worker.address, 6, 1)
      ).to.be.revertedWithCustomError(reputation, "InvalidScore");
    });

    it("should reject unauthorized rater", async function () {
      await expect(
        reputation.connect(stranger).rate(worker.address, 4, 1)
      ).to.be.revertedWithCustomError(reputation, "NotAuthorizedRater");
    });

    it("should reject zero address worker", async function () {
      await expect(
        reputation.connect(escrow).rate(ethers.ZeroAddress, 3, 1)
      ).to.be.revertedWithCustomError(reputation, "ZeroAddress");
    });
  });

  describe("recordDispute", function () {
    it("should increment disputes with taskId", async function () {
      const tx = await reputation.connect(escrow).recordDispute(worker.address, 1);

      const [, , disputes] = await reputation.getReputation(worker.address);
      expect(disputes).to.equal(1);

      await expect(tx).to.emit(reputation, "DisputeRecorded").withArgs(worker.address, 1);
    });

    it("should reject unauthorized", async function () {
      await expect(
        reputation.connect(stranger).recordDispute(worker.address, 1)
      ).to.be.revertedWithCustomError(reputation, "NotAuthorizedRater");
    });
  });

  describe("hasBeenRated", function () {
    it("should track per-task rating status", async function () {
      expect(await reputation.hasBeenRated(worker.address, 1)).to.be.false;

      await reputation.connect(escrow).rate(worker.address, 4, 1);

      expect(await reputation.hasBeenRated(worker.address, 1)).to.be.true;
      expect(await reputation.hasBeenRated(worker.address, 2)).to.be.false; // different task
    });
  });

  describe("getReputation", function () {
    it("should return zeros for unknown worker", async function () {
      const [tasksCompleted, avgScore, disputes] = await reputation.getReputation(stranger.address);
      expect(tasksCompleted).to.equal(0);
      expect(avgScore).to.equal(0);
      expect(disputes).to.equal(0);
    });
  });

  describe("admin functions", function () {
    it("should authorize and revoke raters", async function () {
      await reputation.connect(admin).authorizeRater(stranger.address);
      await reputation.connect(stranger).rate(worker.address, 4, 99);

      await reputation.connect(admin).revokeRater(stranger.address);
      await expect(
        reputation.connect(stranger).rate(worker.address, 3, 100)
      ).to.be.revertedWithCustomError(reputation, "NotAuthorizedRater");
    });

    it("should reject authorizing zero address", async function () {
      await expect(
        reputation.connect(admin).authorizeRater(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(reputation, "ZeroAddress");
    });

    it("should reject non-admin authorize", async function () {
      await expect(
        reputation.connect(stranger).authorizeRater(stranger.address)
      ).to.be.revertedWithCustomError(reputation, "NotAdmin");
    });
  });

  describe("admin transfer", function () {
    it("should transfer via propose + accept", async function () {
      await reputation.connect(admin).proposeAdmin(stranger.address);
      await reputation.connect(stranger).acceptAdmin();
      expect(await reputation.admin()).to.equal(stranger.address);
    });

    it("should reject accept from wrong address", async function () {
      await reputation.connect(admin).proposeAdmin(stranger.address);
      await expect(
        reputation.connect(worker).acceptAdmin()
      ).to.be.revertedWithCustomError(reputation, "NotPendingAdmin");
    });
  });

  describe("pause", function () {
    it("should block rating when paused", async function () {
      await reputation.connect(admin).pause();
      await expect(
        reputation.connect(escrow).rate(worker.address, 5, 1)
      ).to.be.revertedWithCustomError(reputation, "EnforcedPause");
    });

    it("should allow after unpause", async function () {
      await reputation.connect(admin).pause();
      await reputation.connect(admin).unpause();
      await expect(
        reputation.connect(escrow).rate(worker.address, 5, 1)
      ).to.not.revert(ethers);
    });
  });
});
