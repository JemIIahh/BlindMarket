import { expect } from "chai";
import { ethers, upgrades, time } from "../lib/hh.js";
import type { BlindEscrow, BlindReputation, TaskRegistry } from "../types/ethers-contracts/index.js";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

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

    it("should create a task with native 0G", async function () {
      const NATIVE = ethers.ZeroAddress;
      await escrow.connect(admin).allowToken(NATIVE);
      
      const nativeAmount = ethers.parseEther("1");
      const tx = await escrow.connect(agent).createTask(
        TASK_HASH, NATIVE, nativeAmount, "native", "global", ONE_WEEK,
        { value: nativeAmount }
      );

      const task = await escrow.getTask(1);
      expect(task.token).to.equal(NATIVE);
      expect(task.amount).to.equal(nativeAmount);
      
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(nativeAmount);
      await expect(tx).to.emit(escrow, "TaskCreated");
    });

    it("should reject native task if value != amount", async function () {
      const NATIVE = ethers.ZeroAddress;
      await escrow.connect(admin).allowToken(NATIVE);
      
      await expect(
        escrow.connect(agent).createTask(TASK_HASH, NATIVE, ethers.parseEther("1"), "test", "test", ONE_WEEK, { value: ethers.parseEther("0.5") })
      ).to.be.revertedWithCustomError(escrow, "ZeroAmount");
    });

    it("should reject ERC20 task if value > 0", async function () {
      await expect(
        escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "test", "test", ONE_WEEK, { value: 1 })
      ).to.be.revertedWithCustomError(escrow, "ZeroAmount");
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

  // ── per-task verifier (verificationMode='agent') ──

  describe("per-task verifier (agent-verify)", function () {
    it("createTaskWithVerifier records the verifier and emits TaskVerifierSet", async function () {
      const t = await token.getAddress();
      await expect(
        escrow.connect(agent).createTaskWithVerifier(TASK_HASH, t, AMOUNT, "cat", "zone", ONE_WEEK, stranger.address)
      ).to.emit(escrow, "TaskVerifierSet").withArgs(1, stranger.address);
      expect(await escrow.taskVerifier(1)).to.equal(stranger.address);
    });

    it("plain createTask leaves taskVerifier unset (global-verifier path)", async function () {
      await escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "cat", "zone", ONE_WEEK);
      expect(await escrow.taskVerifier(1)).to.equal(ethers.ZeroAddress);
    });

    it("rejects the poster designating themselves as verifier", async function () {
      await expect(
        escrow.connect(agent).createTaskWithVerifier(TASK_HASH, await token.getAddress(), AMOUNT, "cat", "zone", ONE_WEEK, agent.address)
      ).to.be.revertedWithCustomError(escrow, "SelfAssignment");
    });

    it("only the designated verifier can complete it — the global verifier cannot", async function () {
      const t = await token.getAddress();
      await escrow.connect(agent).createTaskWithVerifier(TASK_HASH, t, AMOUNT, "cat", "zone", ONE_WEEK, stranger.address);
      await escrow.connect(verifier).marketplaceAssign(1, worker.address);
      await escrow.connect(worker).submitEvidence(1, EVIDENCE_HASH);

      // global marketplace verifier is NOT this task's verifier → blocked
      await expect(
        escrow.connect(verifier).completeVerification(1, true)
      ).to.be.revertedWithCustomError(escrow, "NotVerifier");

      // the poster-designated verifier settles it → escrow releases
      await expect(escrow.connect(stranger).completeVerification(1, true)).to.emit(escrow, "TaskCompleted");
      expect((await escrow.getTask(1)).status).to.equal(4); // Completed
    });

    it("the worker can never be the verifier, even if designated", async function () {
      const t = await token.getAddress();
      // Allowed at create (worker not yet known), blocked at completeVerification.
      await escrow.connect(agent).createTaskWithVerifier(TASK_HASH, t, AMOUNT, "cat", "zone", ONE_WEEK, worker.address);
      await escrow.connect(verifier).marketplaceAssign(1, worker.address);
      await escrow.connect(worker).submitEvidence(1, EVIDENCE_HASH);
      await expect(
        escrow.connect(worker).completeVerification(1, true)
      ).to.be.revertedWithCustomError(escrow, "NotVerifier");
    });

    it("global verifier still completes a normal (non-agent) task", async function () {
      const t = await token.getAddress();
      await escrow.connect(agent).createTask(TASK_HASH, t, AMOUNT, "cat", "zone", ONE_WEEK);
      await escrow.connect(verifier).marketplaceAssign(1, worker.address);
      await escrow.connect(worker).submitEvidence(1, EVIDENCE_HASH);
      await expect(escrow.connect(verifier).completeVerification(1, true)).to.emit(escrow, "TaskCompleted");
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

    it("should release 90% to worker, 10% to treasury, and record reputation", async function () {
      const workerBefore = await token.balanceOf(worker.address);
      const treasuryBefore = await token.balanceOf(treasury.address);

      await escrow.connect(verifier).completeVerification(1, true);

      const task = await escrow.getTask(1);
      expect(task.status).to.equal(4); // Completed

      const expectedFee = (AMOUNT * 1000n) / 10000n;
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

    it("escalates a Submitted task to Disputed after the deadline instead of refunding it (C18)", async function () {
      await escrow.connect(worker).submitEvidence(1, EVIDENCE_HASH);
      await time.increase(ONE_WEEK + 1);

      const before = await token.balanceOf(agent.address);
      const tx = await escrow.connect(agent).claimTimeout(1);

      const task = await escrow.getTask(1);
      expect(task.status).to.equal(6); // Disputed, not Cancelled
      expect(task.disputedAt).to.be.gt(0);
      expect(await escrow.unjudgedEscalation(1)).to.be.true;
      expect(await token.balanceOf(agent.address)).to.equal(before);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(AMOUNT);
      await expect(tx).to.emit(escrow, "UnjudgedWorkEscalated").withArgs(1);
      await expect(tx).to.emit(escrow, "TaskDisputed").withArgs(1, agent.address);
      await expect(tx).to.not.emit(escrow, "DeadlineExpired");
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

    it("should reject raiseDispute after the deadline and not block claimTimeout (#14)", async function () {
      await time.increase(ONE_WEEK + 1);
      // Neither party can raise a NEW dispute post-deadline to freeze the escrow.
      await expect(escrow.connect(worker).raiseDispute(1))
        .to.be.revertedWithCustomError(escrow, "DeadlineReached");
      await expect(escrow.connect(agent).raiseDispute(1))
        .to.be.revertedWithCustomError(escrow, "DeadlineReached");
      // The poster's claimTimeout still works; for delivered, never-judged
      // work it escalates to the admin instead of refunding (C18).
      await expect(escrow.connect(agent).claimTimeout(1)).to.not.revert(ethers);
      expect((await escrow.getTask(1)).status).to.equal(6); // Disputed
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
      const fee = (AMOUNT * 1000n) / 10000n;
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

  // ── dispute window (claimTimeout can recover a stale dispute, #013) ──

  describe("dispute window (claimTimeout recovery)", function () {
    const DISPUTE_WINDOW = 14 * ONE_DAY;

    /**
     * Directly zero out `_tasks[taskId].disputedAt` to simulate a dispute
     * raised BEFORE this upgrade shipped — those tasks never had a
     * `disputedAt` field, so the newly-appended storage slot reads as 0 for
     * them. `_tasks` lives at storage slot 1 (confirmed against the compiled
     * storageLayout); `disputedAt` is the struct's last member, at relative
     * slot offset 12 within each entry.
     */
    async function zeroOutDisputedAt(taskId: number) {
      const mappingSlot = 1n;
      const base = BigInt(
        ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [taskId, mappingSlot])
        )
      );
      const disputedAtSlot = ethers.toBeHex(base + 12n, 32);
      await ethers.provider.send("hardhat_setStorageAt", [
        await escrow.getAddress(),
        disputedAtSlot,
        ethers.ZeroHash,
      ]);
    }

    beforeEach(async function () {
      await escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "photo", "Lagos", ONE_WEEK);
      await escrow.connect(agent).assignWorker(1, worker.address);
      await escrow.connect(worker).submitEvidence(1, EVIDENCE_HASH);
    });

    it("lets claimTimeout refund the poster once a stale dispute's window has elapsed (regression)", async function () {
      await escrow.connect(agent).raiseDispute(1);
      expect((await escrow.getTask(1)).status).to.equal(6); // Disputed

      await time.increase(ONE_WEEK + 1); // past the deadline
      await time.increase(DISPUTE_WINDOW + 1); // past DISPUTE_WINDOW since disputedAt

      const before = await token.balanceOf(agent.address);
      const tx = await escrow.connect(agent).claimTimeout(1);

      expect((await escrow.getTask(1)).status).to.equal(5); // Cancelled
      expect(await token.balanceOf(agent.address)).to.equal(before + AMOUNT);
      await expect(tx).to.emit(escrow, "DeadlineExpired").withArgs(1, AMOUNT);
    });

    it("reverts DisputeWindowActive when past the deadline but still inside the window", async function () {
      await escrow.connect(agent).raiseDispute(1);
      await time.increase(ONE_WEEK + 1); // past deadline, window not yet elapsed

      await expect(
        escrow.connect(agent).claimTimeout(1)
      ).to.be.revertedWithCustomError(escrow, "DisputeWindowActive");
    });

    it("reverts DeadlineNotReached when past the window but still before the deadline (conditions compose)", async function () {
      // A long deadline so DISPUTE_WINDOW can fully elapse while still pre-deadline.
      await escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "photo", "Lagos", 30 * ONE_DAY);
      await escrow.connect(agent).assignWorker(2, worker.address);
      await escrow.connect(worker).submitEvidence(2, EVIDENCE_HASH);
      await escrow.connect(agent).raiseDispute(2);

      await time.increase(DISPUTE_WINDOW + 1); // window elapsed, 30-day deadline still far off

      await expect(
        escrow.connect(agent).claimTimeout(2)
      ).to.be.revertedWithCustomError(escrow, "DeadlineNotReached");
    });

    it("never lets claimTimeout recover a dispute with disputedAt == 0 (pre-upgrade case)", async function () {
      await escrow.connect(agent).raiseDispute(1);
      await zeroOutDisputedAt(1);
      expect((await escrow.getTask(1)).disputedAt).to.equal(0);

      await time.increase(ONE_WEEK + 1);
      await time.increase(DISPUTE_WINDOW * 10); // would be "elapsed" many times over if 0 were a real timestamp

      await expect(
        escrow.connect(agent).claimTimeout(1)
      ).to.be.revertedWithCustomError(escrow, "DisputeWindowActive");
    });

    it("still lets the admin resolveDispute during and after the window — the admin path is unchanged", async function () {
      // During the window.
      await escrow.connect(agent).raiseDispute(1);
      const workerBefore = await token.balanceOf(worker.address);
      await escrow.connect(admin).resolveDispute(1, true);
      expect((await escrow.getTask(1)).status).to.equal(4); // Completed
      const fee = (AMOUNT * 1000n) / 10000n;
      expect(await token.balanceOf(worker.address)).to.equal(workerBefore + AMOUNT - fee);

      // After the window has elapsed too — admin resolution still works, is
      // not superseded by the new claimTimeout path.
      await escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "photo", "Lagos", ONE_WEEK);
      await escrow.connect(agent).assignWorker(2, worker.address);
      await escrow.connect(worker).submitEvidence(2, EVIDENCE_HASH);
      await escrow.connect(agent).raiseDispute(2);
      await time.increase(DISPUTE_WINDOW + 1);

      const agentBefore = await token.balanceOf(agent.address);
      await escrow.connect(admin).resolveDispute(2, false);
      expect((await escrow.getTask(2)).status).to.equal(5); // Cancelled
      expect(await token.balanceOf(agent.address)).to.equal(agentBefore + AMOUNT);
    });

    it("still rejects raiseDispute after the deadline (existing griefing guard unaffected)", async function () {
      await time.increase(ONE_WEEK + 1);
      await expect(
        escrow.connect(agent).raiseDispute(1)
      ).to.be.revertedWithCustomError(escrow, "DeadlineReached");
    });
  });

  // ── Delivered work vs. the poster's timeout refund (security audit C18) ──
  // claimTimeout used to refund the poster for Submitted work (delivered before
  // the deadline, never judged) and for Verified work the moment the deadline
  // passed, while raiseDispute closed at that same deadline. Whoever held the
  // verdict (the poster in manual mode, or a per-task verifier that is the
  // poster's second wallet) could keep on-time work and take the whole escrow
  // back by staying silent or failing it.

  describe("unjudged work and failed verdicts (C18)", function () {
    const DISPUTE_WINDOW = 14 * ONE_DAY;
    const APPEAL_WINDOW = 3 * ONE_DAY;
    let posterAlt: HardhatEthersSigner; // the poster's own second wallet

    beforeEach(async function () {
      posterAlt = stranger;
    });

    async function deliveredTask(opts: { agentVerifier: boolean }) {
      const t = await token.getAddress();
      if (opts.agentVerifier) {
        await escrow.connect(agent).createTaskWithVerifier(TASK_HASH, t, AMOUNT, "c", "z", ONE_DAY, posterAlt.address);
      } else {
        await escrow.connect(agent).createTask(TASK_HASH, t, AMOUNT, "c", "z", ONE_DAY);
      }
      await escrow.connect(verifier).marketplaceAssign(1, worker.address);
      await time.increase(600);
      await escrow.connect(worker).submitEvidence(1, EVIDENCE_HASH); // ~23h50m before the deadline
    }

    async function toDeadline() {
      await time.increaseTo((await escrow.getTask(1)).deadline);
    }

    it("a silent poster-controlled verifier cannot turn on-time work into a refund (record S1)", async function () {
      await deliveredTask({ agentVerifier: true });
      await toDeadline();

      const posterBefore = await token.balanceOf(agent.address);
      await escrow.connect(agent).claimTimeout(1);
      expect((await escrow.getTask(1)).status).to.equal(6); // Disputed
      expect(await token.balanceOf(agent.address)).to.equal(posterBefore);

      // Escalated unjudged work never falls back to the poster, not even after
      // DISPUTE_WINDOW.
      await expect(escrow.connect(agent).claimTimeout(1))
        .to.be.revertedWithCustomError(escrow, "EscalatedForAdjudication");
      await time.increase(DISPUTE_WINDOW * 2);
      await expect(escrow.connect(agent).claimTimeout(1))
        .to.be.revertedWithCustomError(escrow, "EscalatedForAdjudication");

      // The admin adjudicates.
      const workerBefore = await token.balanceOf(worker.address);
      const treasuryBefore = await token.balanceOf(treasury.address);
      await escrow.connect(admin).resolveDispute(1, true);
      const fee = (AMOUNT * 1000n) / 10000n;
      expect(await token.balanceOf(worker.address)).to.equal(workerBefore + AMOUNT - fee);
      expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore + fee);
      expect(await token.balanceOf(agent.address)).to.equal(posterBefore);
    });

    it("manual mode, poster silent: the admin can still rule for the poster on bad work (record S2)", async function () {
      await deliveredTask({ agentVerifier: false });
      await toDeadline();
      await escrow.connect(agent).claimTimeout(1);

      const before = await token.balanceOf(agent.address);
      await escrow.connect(admin).resolveDispute(1, false);
      expect((await escrow.getTask(1)).status).to.equal(5); // Cancelled
      expect(await token.balanceOf(agent.address)).to.equal(before + AMOUNT);
    });

    it("pays the worker if no ruling comes within DISPUTE_WINDOW of the escalation", async function () {
      await deliveredTask({ agentVerifier: false });
      await toDeadline();
      await escrow.connect(agent).claimTimeout(1);
      const escalatedAt = (await escrow.getTask(1)).disputedAt;

      await expect(escrow.connect(agent).releaseUnjudgedWork(1))
        .to.be.revertedWithCustomError(escrow, "NotWorker");
      await time.setNextBlockTimestamp(escalatedAt + BigInt(DISPUTE_WINDOW) - 1n);
      await expect(escrow.connect(worker).releaseUnjudgedWork(1))
        .to.be.revertedWithCustomError(escrow, "DisputeWindowActive");

      const workerBefore = await token.balanceOf(worker.address);
      const treasuryBefore = await token.balanceOf(treasury.address);
      const posterBefore = await token.balanceOf(agent.address);
      const fee = (AMOUNT * 1000n) / 10000n;
      await time.setNextBlockTimestamp(escalatedAt + BigInt(DISPUTE_WINDOW));
      await expect(escrow.connect(worker).releaseUnjudgedWork(1))
        .to.emit(escrow, "UnjudgedWorkReleased").withArgs(1, AMOUNT - fee, fee)
        .and.to.emit(escrow, "TaskCompleted").withArgs(1, AMOUNT - fee, fee);

      expect((await escrow.getTask(1)).status).to.equal(4); // Completed
      expect(await token.balanceOf(worker.address)).to.equal(workerBefore + AMOUNT - fee);
      expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore + fee);
      expect(await token.balanceOf(agent.address)).to.equal(posterBefore);
      // Nobody judged it, so no rating.
      const [tasksCompleted] = await reputation.getReputation(worker.address);
      expect(tasksCompleted).to.equal(0);
    });

    it("releaseUnjudgedWork applies only to escalations, never to a dispute raised over a verdict", async function () {
      await deliveredTask({ agentVerifier: false });
      await escrow.connect(worker).raiseDispute(1);
      await time.increase(ONE_DAY + DISPUTE_WINDOW + 1);
      await expect(escrow.connect(worker).releaseUnjudgedWork(1))
        .to.be.revertedWithCustomError(escrow, "NotEscalated");
      // That dispute keeps its existing fallback to the poster.
      await expect(escrow.connect(agent).claimTimeout(1)).to.emit(escrow, "DeadlineExpired");
    });

    it("gives the worker APPEAL_WINDOW after a fail verdict, even past the deadline (record S1b/S2b)", async function () {
      await deliveredTask({ agentVerifier: true });
      await escrow.connect(posterAlt).completeVerification(1, false);
      const failedAt = await escrow.failedVerdictAt(1);
      expect(failedAt).to.be.gt(0);
      await toDeadline();

      // Past the deadline the poster cannot refund yet, and cannot raise a
      // dispute itself (the griefing guard still holds for it).
      await expect(escrow.connect(agent).claimTimeout(1))
        .to.be.revertedWithCustomError(escrow, "AppealWindowActive");
      await expect(escrow.connect(agent).raiseDispute(1))
        .to.be.revertedWithCustomError(escrow, "DeadlineReached");
      // The worker cannot resubmit past the deadline, but can appeal.
      await expect(escrow.connect(worker).submitEvidence(1, EVIDENCE_HASH_2))
        .to.be.revertedWithCustomError(escrow, "DeadlineReached");
      await expect(escrow.connect(worker).raiseDispute(1))
        .to.emit(escrow, "TaskDisputed").withArgs(1, worker.address);

      const workerBefore = await token.balanceOf(worker.address);
      await escrow.connect(admin).resolveDispute(1, true);
      const fee = (AMOUNT * 1000n) / 10000n;
      expect(await token.balanceOf(worker.address)).to.equal(workerBefore + AMOUNT - fee);
    });

    it("a fail verdict relayed after the deadline still opens the appeal window", async function () {
      await deliveredTask({ agentVerifier: false });
      await toDeadline();
      await time.increase(60);
      // Manual mode: the platform relays the poster's /verify {passed:false}.
      await escrow.connect(verifier).completeVerification(1, false);
      await expect(escrow.connect(agent).claimTimeout(1))
        .to.be.revertedWithCustomError(escrow, "AppealWindowActive");
      await expect(escrow.connect(worker).raiseDispute(1)).to.not.revert(ethers);
    });

    it("refunds the poster once an unappealed fail verdict's window has passed (control)", async function () {
      await deliveredTask({ agentVerifier: false });
      await escrow.connect(verifier).completeVerification(1, false);
      const failedAt = await escrow.failedVerdictAt(1);
      await toDeadline();

      await time.setNextBlockTimestamp(failedAt + BigInt(APPEAL_WINDOW) - 1n);
      await expect(escrow.connect(agent).claimTimeout(1))
        .to.be.revertedWithCustomError(escrow, "AppealWindowActive");

      const before = await token.balanceOf(agent.address);
      await time.setNextBlockTimestamp(failedAt + BigInt(APPEAL_WINDOW));
      await expect(escrow.connect(agent).claimTimeout(1)).to.emit(escrow, "DeadlineExpired").withArgs(1, AMOUNT);
      expect(await token.balanceOf(agent.address)).to.equal(before + AMOUNT);

      // A late appeal is refused.
      await expect(escrow.connect(worker).raiseDispute(1))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });

    it("the worker's appeal closes with APPEAL_WINDOW", async function () {
      await deliveredTask({ agentVerifier: false });
      await escrow.connect(verifier).completeVerification(1, false);
      await time.increase(ONE_DAY + APPEAL_WINDOW);
      await expect(escrow.connect(worker).raiseDispute(1))
        .to.be.revertedWithCustomError(escrow, "DeadlineReached");
    });

    it("treats a task failed before this upgrade (failedVerdictAt == 0) as it always did", async function () {
      await deliveredTask({ agentVerifier: false });
      await escrow.connect(verifier).completeVerification(1, false);

      // failedVerdictAt is the mapping right after teeSigner (slot 11), at
      // slot 12; zero task 1's entry, as for a pre-upgrade verdict.
      const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [1, 12]));
      const esc = await escrow.getAddress();
      expect(BigInt(await ethers.provider.getStorage(esc, slot))).to.equal(await escrow.failedVerdictAt(1));
      await ethers.provider.send("hardhat_setStorageAt", [esc, slot, ethers.ZeroHash]);
      expect(await escrow.failedVerdictAt(1)).to.equal(0);

      await toDeadline();
      await expect(escrow.connect(agent).claimTimeout(1)).to.emit(escrow, "DeadlineExpired");
    });

    it("an Assigned task that was never delivered is still refunded at the deadline (control)", async function () {
      await escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "c", "z", ONE_DAY);
      await escrow.connect(verifier).marketplaceAssign(1, worker.address);
      await toDeadline();
      const before = await token.balanceOf(agent.address);
      await expect(escrow.connect(agent).claimTimeout(1)).to.emit(escrow, "DeadlineExpired").withArgs(1, AMOUNT);
      expect(await token.balanceOf(agent.address)).to.equal(before + AMOUNT);
    });
  });

  // ── Admin functions ──

  describe("admin functions", function () {
    it("should set fee bps with event", async function () {
      await expect(escrow.connect(admin).setFeeBps(2000))
        .to.emit(escrow, "FeeBpsUpdated").withArgs(1000, 2000);
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

    it("should allow whitelisting zero address for native payments", async function () {
      await expect(escrow.connect(admin).allowToken(ethers.ZeroAddress))
        .to.emit(escrow, "TokenAllowed");
      expect(await escrow.allowedTokens(ethers.ZeroAddress)).to.be.true;
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
      ).to.not.revert(ethers);
    });

    it("should reject pause from non-admin", async function () {
      await expect(
        escrow.connect(agent).pause()
      ).to.be.revertedWithCustomError(escrow, "NotAdmin");
    });
  });

  // ── Emergency pause is neutral (security audit C36) ──
  // claimTimeout was not pause-gated and deadlines kept running while every
  // worker / verifier / dispute action reverted EnforcedPause, so a pause that
  // outlasted a task's remaining time let the poster take the whole escrow.

  describe("emergency pause is neutral (C36)", function () {
    const ONE_HOUR = 3600;
    // pausedTotal, pausedSince, _pausedTotalAtCreate follow failedVerdictAt
    // (12) and unjudgedEscalation (13).
    const PAUSED_SINCE_SLOT = 15;

    async function hourTask() {
      await escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "rent", "z", ONE_HOUR);
      const id = (await escrow.nextTaskId()) - 1n;
      await escrow.connect(verifier).marketplaceAssign(id, worker.address);
      return id;
    }

    it("a poster cannot claim on-time work while paused, nor right after (record scenario)", async function () {
      const id = await hourTask();
      const createdAt = (await escrow.getTask(id)).createdAt;
      await time.setNextBlockTimestamp(createdAt + 60n);
      await escrow.connect(worker).submitEvidence(id, EVIDENCE_HASH);
      await time.setNextBlockTimestamp(createdAt + 600n);
      await escrow.connect(admin).pause();

      const deadline = (await escrow.getTask(id)).deadline;
      await time.increaseTo(deadline);
      await expect(escrow.connect(agent).claimTimeout(id)).to.be.revertedWithCustomError(escrow, "EnforcedPause");
      await expect(escrow.connect(verifier).completeVerification(id, true)).to.be.revertedWithCustomError(escrow, "EnforcedPause");
      await expect(escrow.connect(worker).raiseDispute(id)).to.be.revertedWithCustomError(escrow, "EnforcedPause");

      // Two hours of pause, then unpause: the task keeps the time it had left.
      await time.setNextBlockTimestamp(createdAt + 600n + 2n * BigInt(ONE_HOUR));
      await escrow.connect(admin).unpause();
      expect(await escrow.pausedTotal()).to.equal(2n * BigInt(ONE_HOUR));
      expect(await escrow.effectiveDeadline(id)).to.equal(deadline + 2n * BigInt(ONE_HOUR));
      expect(await escrow.isTaskExpired(id)).to.be.false;
      await expect(escrow.connect(agent).claimTimeout(id)).to.be.revertedWithCustomError(escrow, "DeadlineNotReached");

      const workerBefore = await token.balanceOf(worker.address);
      const treasuryBefore = await token.balanceOf(treasury.address);
      await escrow.connect(verifier).completeVerification(id, true);
      const fee = (AMOUNT * 1000n) / 10000n;
      expect(await token.balanceOf(worker.address)).to.equal(workerBefore + AMOUNT - fee);
      expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore + fee);
    });

    it("an Assigned worker blocked by the pause can still deliver afterwards", async function () {
      const id = await hourTask();
      const deadline = (await escrow.getTask(id)).deadline;
      await time.setNextBlockTimestamp(deadline - 1800n); // 30 min left
      await escrow.connect(admin).pause();
      await expect(escrow.connect(worker).submitEvidence(id, EVIDENCE_HASH)).to.be.revertedWithCustomError(escrow, "EnforcedPause");

      await time.setNextBlockTimestamp(deadline - 1800n + 2n * BigInt(ONE_HOUR));
      await escrow.connect(admin).unpause();
      await expect(escrow.connect(agent).claimTimeout(id)).to.be.revertedWithCustomError(escrow, "DeadlineNotReached");
      await expect(escrow.connect(worker).submitEvidence(id, EVIDENCE_HASH)).to.emit(escrow, "EvidenceSubmitted");
    });

    it("a ghosted worker's task is refunded later by exactly the paused time (control)", async function () {
      const id = await hourTask();
      const deadline = (await escrow.getTask(id)).deadline;
      await escrow.connect(admin).pause();
      const pausedAt = BigInt(await time.latest());
      await time.setNextBlockTimestamp(pausedAt + 5000n);
      await escrow.connect(admin).unpause();

      const effective = deadline + 5000n;
      expect(await escrow.effectiveDeadline(id)).to.equal(effective);
      await time.setNextBlockTimestamp(effective - 1n);
      await expect(escrow.connect(agent).claimTimeout(id)).to.be.revertedWithCustomError(escrow, "DeadlineNotReached");
      const before = await token.balanceOf(agent.address);
      await time.setNextBlockTimestamp(effective);
      await expect(escrow.connect(agent).claimTimeout(id)).to.emit(escrow, "DeadlineExpired").withArgs(id, AMOUNT);
      expect(await token.balanceOf(agent.address)).to.equal(before + AMOUNT);
    });

    it("does not move the deadline of a task created after the pause", async function () {
      await escrow.connect(admin).pause();
      await time.increase(5000);
      await escrow.connect(admin).unpause();
      const id = await hourTask();
      expect(await escrow.effectiveDeadline(id)).to.equal((await escrow.getTask(id)).deadline);
    });

    it("counts a running pause in the views", async function () {
      const id = await hourTask();
      const deadline = (await escrow.getTask(id)).deadline;
      await escrow.connect(admin).pause();
      const pausedAt = BigInt(await time.latest());
      await time.increaseTo(deadline + 100n);
      const now = BigInt(await time.latest());
      expect(await escrow.effectiveDeadline(id)).to.equal(deadline + (now - pausedAt));
      expect(await escrow.isTaskExpired(id)).to.be.false;
    });

    it("keeps resolveDispute available to the admin while paused", async function () {
      const id = await hourTask();
      await escrow.connect(worker).submitEvidence(id, EVIDENCE_HASH);
      await escrow.connect(worker).raiseDispute(id);
      await escrow.connect(admin).pause();
      await expect(escrow.connect(admin).resolveDispute(id, true)).to.emit(escrow, "DisputeResolved").withArgs(id, true);
    });

    it("extends the worker's appeal window by a pause inside it", async function () {
      const id = await hourTask();
      await escrow.connect(worker).submitEvidence(id, EVIDENCE_HASH);
      await escrow.connect(verifier).completeVerification(id, false);
      const failedAt = await escrow.failedVerdictAt(id);
      await escrow.connect(admin).pause();
      const pausedAt = BigInt(await time.latest());
      await time.setNextBlockTimestamp(pausedAt + BigInt(ONE_DAY));
      await escrow.connect(admin).unpause();

      // Past the unmoved 3-day window, but inside it once the day of pause is added.
      await time.setNextBlockTimestamp(failedAt + BigInt(3 * ONE_DAY) + 100n);
      await expect(escrow.connect(agent).claimTimeout(id)).to.be.revertedWithCustomError(escrow, "AppealWindowActive");
      await expect(escrow.connect(worker).raiseDispute(id)).to.emit(escrow, "TaskDisputed");
    });

    describe("installed while paused (pausedSince unknown)", function () {
      /** What an upgrade during a pause leaves behind: paused, but pausedSince reads 0. */
      async function forgetPauseStart() {
        const esc = await escrow.getAddress();
        const slot = ethers.toBeHex(PAUSED_SINCE_SLOT, 32);
        expect(BigInt(await ethers.provider.getStorage(esc, slot))).to.equal(await escrow.pausedSince());
        await ethers.provider.send("hardhat_setStorageAt", [esc, slot, ethers.ZeroHash]);
        expect(await escrow.pausedSince()).to.equal(0);
        expect(await escrow.paused()).to.be.true;
      }

      it("never adds block.timestamp to the paused total on unpause", async function () {
        const id = await hourTask();
        const deadline = (await escrow.getTask(id)).deadline;
        await escrow.connect(admin).pause();
        await forgetPauseStart();
        await time.increase(5000);
        await escrow.connect(admin).unpause();

        // The pause went uncounted (its start is unknown) rather than pushing
        // the deadline out by decades: a ghosted worker's refund still works.
        expect(await escrow.pausedTotal()).to.equal(0);
        expect(await escrow.effectiveDeadline(id)).to.equal(deadline);
        expect(BigInt(await time.latest())).to.be.gte(deadline);
        await expect(escrow.connect(agent).claimTimeout(id)).to.emit(escrow, "DeadlineExpired");
      });

      it("lets the admin record the pause's start so it is counted", async function () {
        const id = await hourTask();
        const deadline = (await escrow.getTask(id)).deadline;
        await escrow.connect(admin).pause();
        const pausedAt = BigInt(await time.latest());
        await forgetPauseStart();

        await expect(escrow.connect(stranger).recordPauseStart(pausedAt)).to.be.revertedWithCustomError(escrow, "NotAdmin");
        const future = BigInt(await time.latest()) + 1000n;
        await expect(escrow.connect(admin).recordPauseStart(future)).to.be.revertedWithCustomError(escrow, "InvalidPauseStart");
        await expect(escrow.connect(admin).recordPauseStart(0)).to.be.revertedWithCustomError(escrow, "InvalidPauseStart");
        await expect(escrow.connect(admin).recordPauseStart(pausedAt))
          .to.emit(escrow, "PauseStartRecorded").withArgs(pausedAt);
        // One-shot: the start is known now.
        await expect(escrow.connect(admin).recordPauseStart(pausedAt)).to.be.revertedWithCustomError(escrow, "InvalidPauseStart");

        await time.setNextBlockTimestamp(pausedAt + 5000n);
        await escrow.connect(admin).unpause();
        expect(await escrow.pausedTotal()).to.equal(5000);
        expect(await escrow.effectiveDeadline(id)).to.equal(deadline + 5000n);
      });

      it("refuses recordPauseStart while unpaused", async function () {
        await expect(escrow.connect(admin).recordPauseStart(1)).to.be.revertedWithCustomError(escrow, "ExpectedPause");
      });
    });
  });

  // ── Reputation only for arm's-length, fee-bearing completions (security audit C37) ──
  // The poster picks the worker and a per-task verifier, and a 1-wei task paid
  // no fee, so one operator with three addresses could mint a five-star rating
  // for 1 wei plus gas, as often as it liked.

  describe("reputation ratings (C37)", function () {
    const NATIVE = ethers.ZeroAddress;
    const teeWallet = ethers.Wallet.createRandom();
    const ATTESTATION = "0g-tee-commitment:req=0x01,res=0x02";

    async function settle(opts: { token: string; amount: bigint; perTaskVerifier?: HardhatEthersSigner; tee?: boolean }) {
      const value = opts.token === NATIVE ? opts.amount : 0n;
      const hash = ethers.keccak256(ethers.toUtf8Bytes(`task-${await escrow.nextTaskId()}`));
      if (opts.perTaskVerifier) {
        await escrow.connect(agent).createTaskWithVerifier(hash, opts.token, opts.amount, "c", "z", ONE_DAY, opts.perTaskVerifier.address, { value });
      } else {
        await escrow.connect(agent).createTask(hash, opts.token, opts.amount, "c", "z", ONE_DAY, { value });
      }
      const id = (await escrow.nextTaskId()) - 1n;
      await escrow.connect(agent).assignWorker(id, worker.address);
      await escrow.connect(worker).submitEvidence(id, EVIDENCE_HASH);
      const v = opts.perTaskVerifier ?? verifier;
      if (opts.tee) {
        const sig = await teeWallet.signMessage(ATTESTATION);
        await escrow.connect(v).completeVerificationWithTEE(id, true, sig, ethers.hexlify(ethers.toUtf8Bytes(ATTESTATION)));
      } else {
        await escrow.connect(v).completeVerification(id, true);
      }
      expect((await escrow.getTask(id)).status).to.equal(4); // settlement itself is unaffected
      return id;
    }

    async function ratings(): Promise<bigint> {
      const [tasksCompleted] = await reputation.getReputation(worker.address);
      return tasksCompleted;
    }

    beforeEach(async function () {
      await escrow.connect(admin).allowToken(NATIVE);
      await escrow.connect(admin).setTeeSigner(teeWallet.address);
    });

    it("a 1-wei loop through a poster-designated verifier mints no rating (record attack)", async function () {
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      for (let i = 0; i < 5; i++) {
        await settle({ token: NATIVE, amount: 1n, perTaskVerifier: stranger });
      }
      const [tasksCompleted, avgScore, disputes] = await reputation.getReputation(worker.address);
      expect([tasksCompleted, avgScore, disputes]).to.deep.equal([0n, 0n, 0n]);
      expect(await ethers.provider.getBalance(treasury.address)).to.equal(treasuryBefore); // no fee paid
    });

    it("does not rate a zero-fee completion, even by the platform verifier", async function () {
      await settle({ token: await token.getAddress(), amount: 9n }); // 9 * 1000 / 10000 = 0 fee
      await settle({ token: await token.getAddress(), amount: 9n, tee: true });
      expect(await ratings()).to.equal(0);
    });

    it("does not rate a fee-bearing completion settled by a poster-designated verifier", async function () {
      await settle({ token: await token.getAddress(), amount: AMOUNT, perTaskVerifier: stranger });
      await settle({ token: await token.getAddress(), amount: AMOUNT, perTaskVerifier: stranger, tee: true });
      expect(await ratings()).to.equal(0);
    });

    it("still rates a fee-bearing completion settled by the platform verifier (control)", async function () {
      await settle({ token: await token.getAddress(), amount: 10n }); // fee 1: the smallest fee-bearing task
      await settle({ token: await token.getAddress(), amount: AMOUNT, tee: true });
      const [tasksCompleted, avgScore] = await reputation.getReputation(worker.address);
      expect(tasksCompleted).to.equal(2);
      expect(avgScore).to.equal(500);
    });

    it("applies the admin's per-token minimum, at-or-above rated", async function () {
      const t = await token.getAddress();
      await expect(escrow.connect(admin).setMinRatedAmount(t, AMOUNT * 2n))
        .to.emit(escrow, "MinRatedAmountUpdated").withArgs(t, 0, AMOUNT * 2n);
      expect(await escrow.minRatedAmount(t)).to.equal(AMOUNT * 2n);

      await settle({ token: t, amount: AMOUNT }); // below the floor
      await settle({ token: t, amount: AMOUNT, tee: true });
      expect(await ratings()).to.equal(0);

      await settle({ token: t, amount: AMOUNT * 2n }); // exactly the floor
      expect(await ratings()).to.equal(1);

      // The floor is per token: native is unaffected.
      await settle({ token: NATIVE, amount: ethers.parseEther("0.001") });
      expect(await ratings()).to.equal(2);
    });

    it("only lets the admin set the minimum", async function () {
      await expect(escrow.connect(agent).setMinRatedAmount(await token.getAddress(), 1))
        .to.be.revertedWithCustomError(escrow, "NotAdmin");
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

  // ── TEE-attested settlement ──

  describe("completeVerificationWithTEE", function () {
    // Stands in for the 0G enclave key. It only ever signs off-chain, so it
    // needs no balance and never appears as a transaction sender.
    const teeWallet = ethers.Wallet.createRandom();
    const rogueWallet = ethers.Wallet.createRandom();

    // What a 0G TEE actually signs: a commitment over an inference
    // request/response pair. Note it names no task and no verdict — that is
    // precisely why it cannot be used as an authorization token.
    const ATTESTATION_TEXT = "0g-tee-commitment:req=0xdead...,res=0xbeef...";

    let teeSig: string;
    let rogueSig: string;
    let signedText: string;

    beforeEach(async function () {
      await escrow.connect(admin).setTeeSigner(teeWallet.address);

      signedText = ethers.hexlify(ethers.toUtf8Bytes(ATTESTATION_TEXT));
      teeSig = await teeWallet.signMessage(ATTESTATION_TEXT);
      rogueSig = await rogueWallet.signMessage(ATTESTATION_TEXT);

      await escrow.connect(agent).createTask(TASK_HASH, await token.getAddress(), AMOUNT, "photo", "Lagos", ONE_WEEK);
      await escrow.connect(agent).assignWorker(1, worker.address);
      await escrow.connect(worker).submitEvidence(1, EVIDENCE_HASH);
    });

    it("does not let the worker settle its own task with a valid enclave signature", async function () {
      // The drain: any holder of any enclave signature could previously call
      // this and release the escrow to themselves without anyone verifying
      // the work. Authorization must come from the verifier gate, never from
      // a signature that is unbound to the task.
      const workerBefore = await token.balanceOf(worker.address);

      await expect(
        escrow.connect(worker).completeVerificationWithTEE(1, true, teeSig, signedText)
      ).to.be.revertedWithCustomError(escrow, "NotVerifier");

      expect(await token.balanceOf(worker.address)).to.equal(workerBefore);
      expect((await escrow.getTask(1)).status).to.equal(2); // still Submitted
    });

    it("does not let an unrelated account settle with a valid enclave signature", async function () {
      await expect(
        escrow.connect(stranger).completeVerificationWithTEE(1, true, teeSig, signedText)
      ).to.be.revertedWithCustomError(escrow, "NotVerifier");
    });

    it("lets the marketplace verifier settle and pays 90/10", async function () {
      const workerBefore = await token.balanceOf(worker.address);
      const treasuryBefore = await token.balanceOf(treasury.address);

      await expect(escrow.connect(verifier).completeVerificationWithTEE(1, true, teeSig, signedText))
        .to.emit(escrow, "TEESettled")
        .withArgs(1, true, teeWallet.address);

      const expectedFee = (AMOUNT * 1000n) / 10000n;
      const expectedPayout = AMOUNT - expectedFee;

      expect((await escrow.getTask(1)).status).to.equal(4); // Completed
      expect(await token.balanceOf(worker.address)).to.equal(workerBefore + expectedPayout);
      expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore + expectedFee);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(0);
    });

    it("rejects a signature from a key that is not the registered teeSigner", async function () {
      await expect(
        escrow.connect(verifier).completeVerificationWithTEE(1, true, rogueSig, signedText)
      ).to.be.revertedWithCustomError(escrow, "InvalidTEESignature");
    });

    it("rejects a signature over different text than the one supplied", async function () {
      const otherText = ethers.hexlify(ethers.toUtf8Bytes("some other attestation"));
      await expect(
        escrow.connect(verifier).completeVerificationWithTEE(1, true, teeSig, otherText)
      ).to.be.revertedWithCustomError(escrow, "InvalidTEESignature");
    });

    it("rejects a malformed signature instead of recovering a junk address", async function () {
      await expect(
        escrow.connect(verifier).completeVerificationWithTEE(1, true, "0xdeadbeef", signedText)
      ).to.be.revertedWithCustomError(escrow, "InvalidTEESignature");
    });

    it("reverts when no teeSigner is registered", async function () {
      await escrow.connect(admin).setTeeSigner(ethers.ZeroAddress);
      await expect(
        escrow.connect(verifier).completeVerificationWithTEE(1, true, teeSig, signedText)
      ).to.be.revertedWithCustomError(escrow, "TEESignerNotSet");
    });

    it("moves to Verified without paying out when passed is false", async function () {
      const workerBefore = await token.balanceOf(worker.address);

      await escrow.connect(verifier).completeVerificationWithTEE(1, false, teeSig, signedText);

      expect((await escrow.getTask(1)).status).to.equal(3); // Verified
      expect(await token.balanceOf(worker.address)).to.equal(workerBefore);
      expect(await escrow.failedVerdictAt(1)).to.be.gt(0); // opens the worker's appeal window (C18)
    });

    it("honors a per-task verifier over the global one", async function () {
      await escrow
        .connect(agent)
        .createTaskWithVerifier(EVIDENCE_HASH_2, await token.getAddress(), AMOUNT, "photo", "Lagos", ONE_WEEK, stranger.address);
      await escrow.connect(agent).assignWorker(2, worker.address);
      await escrow.connect(worker).submitEvidence(2, EVIDENCE_HASH);

      // The global verifier is not the designated one for task 2.
      await expect(
        escrow.connect(verifier).completeVerificationWithTEE(2, true, teeSig, signedText)
      ).to.be.revertedWithCustomError(escrow, "NotVerifier");

      await expect(escrow.connect(stranger).completeVerificationWithTEE(2, true, teeSig, signedText))
        .to.emit(escrow, "TEESettled")
        .withArgs(2, true, teeWallet.address);
    });

    it("only lets the admin set the teeSigner", async function () {
      await expect(
        escrow.connect(stranger).setTeeSigner(rogueWallet.address)
      ).to.be.revertedWithCustomError(escrow, "NotAdmin");
    });
  });
});
