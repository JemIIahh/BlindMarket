import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { BlindEscrow, BlindReputation, TaskRegistry } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("BlindEscrow", function () {
  let escrow: BlindEscrow;
  let reputation: BlindReputation;
  let registry: TaskRegistry;
  let token: any;
  let admin: HardhatEthersSigner;
  let agent: HardhatEthersSigner;
  let worker: HardhatEthersSigner;
  let verifier: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const TASK_HASH = ethers.keccak256(ethers.toUtf8Bytes("encrypted-task-blob"));
  const EVIDENCE_HASH = ethers.keccak256(ethers.toUtf8Bytes("encrypted-evidence"));
  const EVIDENCE_HASH_2 = ethers.keccak256(ethers.toUtf8Bytes("encrypted-evidence-v2"));
  const AMOUNT = ethers.parseUnits("100", 6); // 100 USDC (6 decimals)
  const ONE_DAY = 86400;
  const ONE_WEEK = 7 * ONE_DAY;

  beforeEach(async function () {
    [admin, agent, worker, verifier, treasury, stranger] = await ethers.getSigners();

    // Deploy mock ERC-20 token
    const Token = await ethers.getContractFactory("MockERC20");
    token = await Token.deploy("Mock USDC", "MUSDC", 6);

    // Mint tokens to agent
    await token.mint(agent.address, ethers.parseUnits("10000", 6));

    // Deploy reputation
    const Rep = await ethers.getContractFactory("BlindReputation");
    reputation = (await upgrades.deployProxy(Rep, [], { kind: "uups" })) as unknown as BlindReputation;

    // Deploy registry
    const Reg = await ethers.getContractFactory("TaskRegistry");
    registry = (await upgrades.deployProxy(Reg, [], { kind: "uups" })) as unknown as TaskRegistry;

    // Deploy escrow
    const Escrow = await ethers.getContractFactory("BlindEscrow");
    escrow = (await upgrades.deployProxy(Escrow, [treasury.address, verifier.address], { kind: "uups" })) as unknown as BlindEscrow;

    // Whitelist the token
    await escrow.connect(admin).allowToken(await token.getAddress());

    // Connect escrow to reputation and registry
    await escrow.connect(admin).setReputationContract(await reputation.getAddress());
    await escrow.connect(admin).setTaskRegistry(await registry.getAddress());

    // Authorize escrow in reputation and registry
    await reputation.connect(admin).authorizeRater(await escrow.getAddress());
    await registry.connect(admin).authorizePublisher(await escrow.getAddress());

    // Agent approves escrow to spend tokens
    await token.connect(agent).approve(await escrow.getAddress(), ethers.MaxUint256);
  });

  // ── Constructor ──

  describe("constructor", function () {
    it("should reject zero treasury address", async function () {
      const Escrow = await ethers.getContractFactory("BlindEscrow");
      await expect(
        upgrades.deployProxy(Escrow, [ethers.ZeroAddress, verifier.address], { kind: "uups" })
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });

    it("should reject zero verifier address", async function () {
      const Escrow = await ethers.getContractFactory("BlindEscrow");
      await expect(
        upgrades.deployProxy(Escrow, [treasury.address, ethers.ZeroAddress], { kind: "uups" })
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });
  });

  // ── createTask ──

  describe("createTask", function () {
    it("should create a task, lock funds, and publish to registry", async function () {
      const tx = await escrow.connect(agent).createTask(
        TASK_HASH, await token.getAddress(), AMOUNT, "photography", "Lagos, Nigeria", ONE_WEEK
      );

      const task = await escrow.getTask(1);
      expect(task.agent).to.equal(agent.address);
      expect(task.worker).to.equal(ethers.ZeroAddress);
      expect(task.amount).to.equal(AMOUNT);
      expect(task.taskHash).to.equal(TASK_HASH);
      expect(task.status).to.equal(0); // Funded
      expect(task.category).to.equal("photography");
      expect(task.locationZone).to.equal("Lagos, Nigeria");
      expect(task.submissionAttempts).to.equal(0);

      // Funds in contract
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(AMOUNT);

      // Task published to registry
      expect(await registry.totalTasks()).to.equal(1);

      await expect(tx).to.emit(escrow, "TaskCreated");
    });

    it("should reject zero amount", async function () {
      await expect(
        escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), 0, "test", "test", ONE_WEEK)
      ).to.be.revertedWithCustomError(escrow, "ZeroAmount");
    });

    it("should reject empty task hash", async function () {
      await expect(
        escrow.connect(agent).createTask(ethers.ZeroHash, await token.getAddress(), AMOUNT, "test", "test", ONE_WEEK)
      ).to.be.revertedWithCustomError(escrow, "EmptyHash");
    });

    it("should reject non-whitelisted token", async function () {
      const BadToken = await ethers.getContractFactory("MockERC20");
      const badToken = await BadToken.deploy("Bad", "BAD", 18);

      await expect(
        escrow.connect(agent).createTask(TASK_HASH, await badToken.getAddress(), AMOUNT, "test", "test", ONE_WEEK)
      ).to.be.revertedWithCustomError(escrow, "TokenNotAllowed");
    });

    it("should reject deadline too short", async function () {
      await expect(
        escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "test", "test", 60) // 1 min < 1 hour minimum
      ).to.be.revertedWithCustomError(escrow, "InvalidDeadline");
    });

    it("should reject deadline too long", async function () {
      const tooLong = 91 * ONE_DAY; // > 90 days
      await expect(
        escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "test", "test", tooLong)
      ).to.be.revertedWithCustomError(escrow, "InvalidDeadline");
    });

    it("should increment task IDs", async function () {
      await escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "a", "b", ONE_WEEK);
      await escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "c", "d", ONE_WEEK);

      expect((await escrow.getTask(1)).category).to.equal("a");
      expect((await escrow.getTask(2)).category).to.equal("c");
    });
  });

  // ── assignWorker ──

  describe("assignWorker", function () {
    beforeEach(async function () {
      await escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "photo", "Lagos", ONE_WEEK);
    });

    it("should assign a worker and close registry listing", async function () {
      const tx = await escrow.connect(agent).assignWorker(1, worker.address);

      const task = await escrow.getTask(1);
      expect(task.worker).to.equal(worker.address);
      expect(task.status).to.equal(1); // Assigned

      // Registry listing closed
      expect(await registry.openTaskCount()).to.equal(0);

      await expect(tx).to.emit(escrow, "WorkerAssigned").withArgs(1, worker.address);
    });

    it("should reject non-agent", async function () {
      await expect(
        escrow.connect(worker).assignWorker(1, worker.address)
      ).to.be.revertedWithCustomError(escrow, "NotAgent");
    });

    it("should reject zero address worker", async function () {
      await expect(
        escrow.connect(agent).assignWorker(1, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });

    it("should reject self-assignment (agent = worker)", async function () {
      await expect(
        escrow.connect(agent).assignWorker(1, agent.address)
      ).to.be.revertedWithCustomError(escrow, "SelfAssignment");
    });

    it("should reject assignment after deadline", async function () {
      await time.increase(ONE_WEEK + 1);
      await expect(
        escrow.connect(agent).assignWorker(1, worker.address)
      ).to.be.revertedWithCustomError(escrow, "DeadlineReached");
    });
  });

  // ── marketplaceAssign ──
  // Verifier-gated assignment used for autonomous A2A settlement: marketplace
  // backend assigns the worker without poster involvement.

  describe("marketplaceAssign", function () {
    beforeEach(async function () {
      await escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "photo", "Lagos", ONE_WEEK);
    });

    it("should assign a worker via verifier and close registry listing", async function () {
      const tx = await escrow.connect(verifier).marketplaceAssign(1, worker.address);

      const task = await escrow.getTask(1);
      expect(task.worker).to.equal(worker.address);
      expect(task.status).to.equal(1); // Assigned

      // Registry listing closed (same downstream effect as assignWorker)
      expect(await registry.openTaskCount()).to.equal(0);

      // Reuses the existing WorkerAssigned event so off-chain listeners need no change
      await expect(tx).to.emit(escrow, "WorkerAssigned").withArgs(1, worker.address);
    });

    it("should reject non-verifier callers (including the task agent)", async function () {
      await expect(
        escrow.connect(agent).marketplaceAssign(1, worker.address)
      ).to.be.revertedWithCustomError(escrow, "NotVerifier");
      await expect(
        escrow.connect(stranger).marketplaceAssign(1, worker.address)
      ).to.be.revertedWithCustomError(escrow, "NotVerifier");
    });

    it("should reject zero address worker", async function () {
      await expect(
        escrow.connect(verifier).marketplaceAssign(1, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });

    it("should reject assigning the task agent as the worker (self-deal)", async function () {
      await expect(
        escrow.connect(verifier).marketplaceAssign(1, agent.address)
      ).to.be.revertedWithCustomError(escrow, "SelfAssignment");
    });

    it("should reject assignment after deadline", async function () {
      await time.increase(ONE_WEEK + 1);
      await expect(
        escrow.connect(verifier).marketplaceAssign(1, worker.address)
      ).to.be.revertedWithCustomError(escrow, "DeadlineReached");
    });

    it("should reject if task already assigned (status != Funded)", async function () {
      await escrow.connect(agent).assignWorker(1, worker.address);
      await expect(
        escrow.connect(verifier).marketplaceAssign(1, worker.address)
      ).to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });
  });

  // ── submitEvidence ──

  describe("submitEvidence", function () {
    beforeEach(async function () {
      await escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "photo", "Lagos", ONE_WEEK);
      await escrow.connect(agent).assignWorker(1, worker.address);
    });

    it("should submit evidence", async function () {
      const tx = await escrow.connect(worker).submitEvidence(1, EVIDENCE_HASH);

      const task = await escrow.getTask(1);
      expect(task.evidenceHash).to.equal(EVIDENCE_HASH);
      expect(task.status).to.equal(2); // Submitted
      expect(task.submissionAttempts).to.equal(1);

      await expect(tx).to.emit(escrow, "EvidenceSubmitted").withArgs(1, worker.address, EVIDENCE_HASH, 1);
    });

    it("should reject non-worker", async function () {
      await expect(
        escrow.connect(agent).submitEvidence(1, EVIDENCE_HASH)
      ).to.be.revertedWithCustomError(escrow, "NotWorker");
    });

    it("should reject empty evidence hash", async function () {
      await expect(
        escrow.connect(worker).submitEvidence(1, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(escrow, "EmptyHash");
    });

    it("should reject submission after deadline", async function () {
      await time.increase(ONE_WEEK + 1);
      await expect(
        escrow.connect(worker).submitEvidence(1, EVIDENCE_HASH)
      ).to.be.revertedWithCustomError(escrow, "DeadlineReached");
    });
  });

  // ── completeVerification (pass) ──

  describe("completeVerification (pass)", function () {
    beforeEach(async function () {
      await escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "photo", "Lagos", ONE_WEEK);
      await escrow.connect(agent).assignWorker(1, worker.address);
      await escrow.connect(worker).submitEvidence(1, EVIDENCE_HASH);
    });

    it("should release 85% to worker, 15% to treasury, and record reputation", async function () {
      const workerBefore = await token.balanceOf(worker.address);
      const treasuryBefore = await token.balanceOf(treasury.address);

      await escrow.connect(verifier).completeVerification(1, true);

      const task = await escrow.getTask(1);
      expect(task.status).to.equal(4); // Completed

      const expectedFee = (AMOUNT * 1500n) / 10000n;
      const expectedPayout = AMOUNT - expectedFee;

      expect(await token.balanceOf(worker.address)).to.equal(workerBefore + expectedPayout);
      expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore + expectedFee);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(0);

      // Reputation recorded
      const [tasksCompleted, avgScore] = await reputation.getReputation(worker.address);
      expect(tasksCompleted).to.equal(1);
      expect(avgScore).to.equal(500); // 5 * 100
    });

    it("should reject non-verifier", async function () {
      await expect(
        escrow.connect(agent).completeVerification(1, true)
      ).to.be.revertedWithCustomError(escrow, "NotVerifier");
    });
  });

  // ── completeVerification (fail) + retry ──

  describe("completeVerification (fail) + retry", function () {
    beforeEach(async function () {
      await escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "photo", "Lagos", ONE_WEEK);
      await escrow.connect(agent).assignWorker(1, worker.address);
      await escrow.connect(worker).submitEvidence(1, EVIDENCE_HASH);
    });

    it("should set status to Verified on fail and allow resubmission", async function () {
      await escrow.connect(verifier).completeVerification(1, false);

      const task = await escrow.getTask(1);
      expect(task.status).to.equal(3); // Verified (failed)

      // Funds still in contract
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(AMOUNT);

      // Worker can resubmit
      await escrow.connect(worker).submitEvidence(1, EVIDENCE_HASH_2);
      const updated = await escrow.getTask(1);
      expect(updated.status).to.equal(2); // Submitted again
      expect(updated.submissionAttempts).to.equal(2);
    });

    it("should block resubmission after max attempts", async function () {
      // Attempt 1 (already done in beforeEach) → fail
      await escrow.connect(verifier).completeVerification(1, false);

      // Attempt 2
      await escrow.connect(worker).submitEvidence(1, EVIDENCE_HASH_2);
      await escrow.connect(verifier).completeVerification(1, false);

      // Attempt 3
      const hash3 = ethers.keccak256(ethers.toUtf8Bytes("evidence-v3"));
      await escrow.connect(worker).submitEvidence(1, hash3);
      await escrow.connect(verifier).completeVerification(1, false);

      // Attempt 4 should fail — max is 3
      const hash4 = ethers.keccak256(ethers.toUtf8Bytes("evidence-v4"));
      await expect(
        escrow.connect(worker).submitEvidence(1, hash4)
      ).to.be.revertedWithCustomError(escrow, "MaxSubmissionAttemptsReached");
    });
  });

  // ── cancelTask ──

  describe("cancelTask", function () {
    beforeEach(async function () {
      await escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "photo", "Lagos", ONE_WEEK);
    });

    it("should refund agent and close registry listing", async function () {
      const before = await token.balanceOf(agent.address);
      const tx = await escrow.connect(agent).cancelTask(1);

      const task = await escrow.getTask(1);
      expect(task.status).to.equal(5); // Cancelled

      expect(await token.balanceOf(agent.address)).to.equal(before + AMOUNT);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(0);
      expect(await registry.openTaskCount()).to.equal(0);

      await expect(tx).to.emit(escrow, "TaskCancelled").withArgs(1, AMOUNT);
    });

    it("should reject cancel after assignment", async function () {
      await escrow.connect(agent).assignWorker(1, worker.address);
      await expect(
        escrow.connect(agent).cancelTask(1)
      ).to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });

    it("should reject non-agent cancel", async function () {
      await expect(
        escrow.connect(worker).cancelTask(1)
      ).to.be.revertedWithCustomError(escrow, "NotAgent");
    });
  });

  // ── claimTimeout ──

  describe("claimTimeout", function () {
    beforeEach(async function () {
      await escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "photo", "Lagos", ONE_WEEK);
      await escrow.connect(agent).assignWorker(1, worker.address);
    });

    it("should refund agent after deadline (worker ghosted)", async function () {
      const before = await token.balanceOf(agent.address);
      await time.increase(ONE_WEEK + 1);

      const tx = await escrow.connect(agent).claimTimeout(1);

      expect((await escrow.getTask(1)).status).to.equal(5); // Cancelled
      expect(await token.balanceOf(agent.address)).to.equal(before + AMOUNT);

      await expect(tx).to.emit(escrow, "DeadlineExpired").withArgs(1, AMOUNT);
    });

    it("should work for Submitted status after deadline", async function () {
      await escrow.connect(worker).submitEvidence(1, EVIDENCE_HASH);
      await time.increase(ONE_WEEK + 1);

      await escrow.connect(agent).claimTimeout(1);
      expect((await escrow.getTask(1)).status).to.equal(5);
    });

    it("should work for Verified (failed) status after deadline", async function () {
      await escrow.connect(worker).submitEvidence(1, EVIDENCE_HASH);
      await escrow.connect(verifier).completeVerification(1, false);
      await time.increase(ONE_WEEK + 1);

      await escrow.connect(agent).claimTimeout(1);
      expect((await escrow.getTask(1)).status).to.equal(5);
    });

    it("should reject before deadline", async function () {
      await expect(
        escrow.connect(agent).claimTimeout(1)
      ).to.be.revertedWithCustomError(escrow, "DeadlineNotReached");
    });

    it("should reject for Completed tasks", async function () {
      await escrow.connect(worker).submitEvidence(1, EVIDENCE_HASH);
      await escrow.connect(verifier).completeVerification(1, true);
      await time.increase(ONE_WEEK + 1);

      await expect(
        escrow.connect(agent).claimTimeout(1)
      ).to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });

    it("should reject non-agent", async function () {
      await time.increase(ONE_WEEK + 1);
      await expect(
        escrow.connect(worker).claimTimeout(1)
      ).to.be.revertedWithCustomError(escrow, "NotAgent");
    });
  });

  // ── raiseDispute + resolveDispute ──

  describe("disputes", function () {
    beforeEach(async function () {
      await escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "photo", "Lagos", ONE_WEEK);
      await escrow.connect(agent).assignWorker(1, worker.address);
      await escrow.connect(worker).submitEvidence(1, EVIDENCE_HASH);
    });

    it("should allow agent to raise dispute", async function () {
      const tx = await escrow.connect(agent).raiseDispute(1);
      expect((await escrow.getTask(1)).status).to.equal(6); // Disputed
      await expect(tx).to.emit(escrow, "TaskDisputed").withArgs(1, agent.address);
    });

    it("should allow worker to raise dispute after failed verification", async function () {
      await escrow.connect(verifier).completeVerification(1, false);
      await escrow.connect(worker).raiseDispute(1);
      expect((await escrow.getTask(1)).status).to.equal(6);
    });

    it("should reject dispute from stranger", async function () {
      await expect(
        escrow.connect(stranger).raiseDispute(1)
      ).to.be.revertedWith("not party to task");
    });

    it("should resolve dispute in worker's favor", async function () {
      await escrow.connect(agent).raiseDispute(1);

      const workerBefore = await token.balanceOf(worker.address);
      await escrow.connect(admin).resolveDispute(1, true);

      expect((await escrow.getTask(1)).status).to.equal(4); // Completed
      const fee = (AMOUNT * 1500n) / 10000n;
      expect(await token.balanceOf(worker.address)).to.equal(workerBefore + AMOUNT - fee);
    });

    it("should resolve dispute in agent's favor", async function () {
      await escrow.connect(agent).raiseDispute(1);

      const agentBefore = await token.balanceOf(agent.address);
      await escrow.connect(admin).resolveDispute(1, false);

      expect((await escrow.getTask(1)).status).to.equal(5); // Cancelled
      expect(await token.balanceOf(agent.address)).to.equal(agentBefore + AMOUNT);

      // Dispute recorded in reputation
      const [, , disputes] = await reputation.getReputation(worker.address);
      expect(disputes).to.equal(1);
    });

    it("should reject non-admin resolving dispute", async function () {
      await escrow.connect(agent).raiseDispute(1);
      await expect(
        escrow.connect(stranger).resolveDispute(1, true)
      ).to.be.revertedWithCustomError(escrow, "NotAdmin");
    });
  });

  // ── Admin functions ──

  describe("admin functions", function () {
    it("should set fee bps with event", async function () {
      await expect(escrow.connect(admin).setFeeBps(2000))
        .to.emit(escrow, "FeeBpsUpdated").withArgs(1500, 2000);
      expect(await escrow.feeBps()).to.equal(2000);
    });

    it("should reject fee above max", async function () {
      await expect(
        escrow.connect(admin).setFeeBps(3001)
      ).to.be.revertedWithCustomError(escrow, "FeeExceedsMax");
    });

    it("should reject non-admin", async function () {
      await expect(
        escrow.connect(agent).setFeeBps(1000)
      ).to.be.revertedWithCustomError(escrow, "NotAdmin");
    });

    it("should allow/disallow tokens", async function () {
      const Token2 = await ethers.getContractFactory("MockERC20");
      const token2 = await Token2.deploy("Test", "TST", 18);

      await expect(escrow.connect(admin).allowToken(await token2.getAddress()))
        .to.emit(escrow, "TokenAllowed");

      expect(await escrow.allowedTokens(await token2.getAddress())).to.be.true;

      await escrow.connect(admin).disallowToken(await token2.getAddress());
      expect(await escrow.allowedTokens(await token2.getAddress())).to.be.false;
    });

    it("should reject allowing zero address token", async function () {
      await expect(
        escrow.connect(admin).allowToken(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });
  });

  // ── 2-step admin transfer ──

  describe("admin transfer", function () {
    it("should transfer admin via propose + accept", async function () {
      await escrow.connect(admin).proposeAdmin(agent.address);
      expect(await escrow.pendingAdmin()).to.equal(agent.address);

      await escrow.connect(agent).acceptAdmin();
      expect(await escrow.admin()).to.equal(agent.address);
      expect(await escrow.pendingAdmin()).to.equal(ethers.ZeroAddress);
    });

    it("should reject accept from non-pending", async function () {
      await escrow.connect(admin).proposeAdmin(agent.address);
      await expect(
        escrow.connect(worker).acceptAdmin()
      ).to.be.revertedWithCustomError(escrow, "NotPendingAdmin");
    });

    it("should reject proposing zero address", async function () {
      await expect(
        escrow.connect(admin).proposeAdmin(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });
  });

  // ── Pause ──

  describe("pause", function () {
    it("should block createTask when paused", async function () {
      await escrow.connect(admin).pause();
      await expect(
        escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "test", "test", ONE_WEEK)
      ).to.be.revertedWithCustomError(escrow, "EnforcedPause");
    });

    it("should allow operations after unpause", async function () {
      await escrow.connect(admin).pause();
      await escrow.connect(admin).unpause();

      await expect(
        escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "test", "test", ONE_WEEK)
      ).not.to.be.reverted;
    });

    it("should reject pause from non-admin", async function () {
      await expect(
        escrow.connect(agent).pause()
      ).to.be.revertedWithCustomError(escrow, "NotAdmin");
    });
  });

  // ── View helpers ──

  describe("view functions", function () {
    it("should report task expiry status", async function () {
      await escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "test", "test", ONE_WEEK);

      expect(await escrow.isTaskExpired(1)).to.be.false;
      await time.increase(ONE_WEEK + 1);
      expect(await escrow.isTaskExpired(1)).to.be.true;
    });
  });
});
