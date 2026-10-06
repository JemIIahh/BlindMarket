import { expect } from "chai";
import { ethers, upgrades, time } from "../lib/hh.js";
import type { BlindEscrow, BlindReputation, TaskRegistry } from "../types/ethers-contracts/index.js";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

// BlindEscrow enums, by index.
const PickMode = { AgentManaged: 0, CreatorReview: 1 } as const;
const Phase = { Submissions: 0, CreatorPick: 1, VerifierPick: 2, BackupPick: 3, AdminResolve: 4, Closed: 5 } as const;
const Judge = { None: 0, Creator: 1, TaskVerifier: 2, Backup: 3, Admin: 4 } as const;
const Status = { Funded: 0, Assigned: 1, Submitted: 2, Verified: 3, Completed: 4, Cancelled: 5, Disputed: 6 } as const;

const HOUR = 3600;
const DAY = 24 * HOUR;
const WINDOW = 48 * HOUR; // VERIFIER_PICK_WINDOW and BACKUP_PICK_WINDOW

describe("BlindEscrow open submission", function () {
  let escrow: BlindEscrow;
  let reputation: BlindReputation;
  let registry: TaskRegistry;
  let token: any;
  let tokenAddress: string;
  let admin: HardhatEthersSigner;
  let agent: HardhatEthersSigner;
  let worker: HardhatEthersSigner;
  let verifier: HardhatEthersSigner; // the global verifier: the backup judge
  let treasury: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let taskV: HardhatEthersSigner; // the task verifier
  let s1: HardhatEthersSigner;
  let s2: HardhatEthersSigner;
  let s3: HardhatEthersSigner;

  const TASK_HASH = ethers.keccak256(ethers.toUtf8Bytes("open task brief"));
  const E1 = ethers.keccak256(ethers.toUtf8Bytes("result 1"));
  const E2 = ethers.keccak256(ethers.toUtf8Bytes("result 2"));
  const E3 = ethers.keccak256(ethers.toUtf8Bytes("result 3"));
  const SCORECARD = ethers.keccak256(ethers.toUtf8Bytes("scorecard"));
  const AMOUNT = ethers.parseUnits("100", 6);
  const FEE = AMOUNT / 10n; // feeBps 1000

  beforeEach(async function () {
    [admin, agent, worker, verifier, treasury, stranger, taskV, s1, s2, s3] = await ethers.getSigners();

    token = await (await ethers.getContractFactory("MockERC20")).deploy("Mock USDC", "MUSDC", 6);
    tokenAddress = await token.getAddress();
    await token.mint(agent.address, ethers.parseUnits("100000", 6));

    reputation = (await upgrades.deployProxy(await ethers.getContractFactory("BlindReputation"), [], { kind: "uups" })) as unknown as BlindReputation;
    registry = (await upgrades.deployProxy(await ethers.getContractFactory("TaskRegistry"), [], { kind: "uups" })) as unknown as TaskRegistry;
    escrow = (await upgrades.deployProxy(await ethers.getContractFactory("BlindEscrow"), [treasury.address, verifier.address], {
      kind: "uups",
    })) as unknown as BlindEscrow;

    await escrow.connect(admin).allowToken(tokenAddress);
    await escrow.connect(admin).setReputationContract(await reputation.getAddress());
    await escrow.connect(admin).setTaskRegistry(await registry.getAddress());
    await reputation.connect(admin).authorizeRater(await escrow.getAddress());
    await registry.connect(admin).authorizePublisher(await escrow.getAddress());
    await token.connect(agent).approve(await escrow.getAddress(), ethers.MaxUint256);
  });

  async function createOpen(o: { mode?: number; window?: number; amount?: bigint; token?: string; duration?: number; verifierAgent?: string } = {}) {
    const mode = o.mode ?? PickMode.CreatorReview;
    const window = o.window ?? (mode === PickMode.CreatorReview ? DAY : 0);
    const amount = o.amount ?? AMOUNT;
    const tok = o.token ?? tokenAddress;
    const value = tok === ethers.ZeroAddress ? amount : 0n;
    await escrow
      .connect(agent)
      .createTaskOpen(TASK_HASH, tok, amount, "general", "global", o.duration ?? DAY, o.verifierAgent ?? taskV.address, mode, window, { value });
    return (await escrow.nextTaskId()) - 1n;
  }

  const deadlineOf = (id: bigint) => escrow.effectiveDeadline(id);
  /** The next transaction is mined at `ts`. */
  const at = (ts: bigint | number) => time.setNextBlockTimestamp(ts);
  const ratings = async (who: string) => (await reputation.getReputation(who))[0];

  // ── createTaskOpen ──

  describe("createTaskOpen", function () {
    it("records an open task with its verifier, mode and window, and takes the escrow", async function () {
      const tx = escrow
        .connect(agent)
        .createTaskOpen(TASK_HASH, tokenAddress, AMOUNT, "general", "global", DAY, taskV.address, PickMode.CreatorReview, DAY);
      await expect(tx).to.emit(escrow, "TaskVerifierSet").withArgs(1, taskV.address);
      await expect(tx).to.emit(escrow, "OpenTaskCreated").withArgs(1, PickMode.CreatorReview, DAY);
      await expect(tx).to.emit(escrow, "TaskCreated");

      const t = await escrow.getTask(1);
      expect(t.agent).to.equal(agent.address);
      expect(t.worker).to.equal(ethers.ZeroAddress);
      expect(t.status).to.equal(Status.Funded);
      expect(await escrow.taskVerifier(1)).to.equal(taskV.address);
      const o = await escrow.getOpenTask(1);
      expect([o.open, o.mode, o.creatorWindow, o.closedBy]).to.deep.equal([true, BigInt(PickMode.CreatorReview), BigInt(DAY), BigInt(Judge.None)]);
      expect(await escrow.submissionCount(1)).to.equal(0);
      expect(await escrow.openPhase(1)).to.equal(Phase.Submissions);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(AMOUNT);
      expect(await registry.totalTasks()).to.equal(1);
    });

    it("takes a native-token escrow", async function () {
      await escrow.connect(admin).allowToken(ethers.ZeroAddress);
      const id = await createOpen({ token: ethers.ZeroAddress, amount: ethers.parseEther("1") });
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(ethers.parseEther("1"));
      expect((await escrow.getOpenTask(id)).open).to.equal(true);
    });

    it("requires a task verifier, and not the poster", async function () {
      await expect(createOpen({ verifierAgent: ethers.ZeroAddress })).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      await expect(createOpen({ verifierAgent: agent.address })).to.be.revertedWithCustomError(escrow, "SelfAssignment");
    });

    it("bounds the creator window to 1 hour .. 7 days, and requires 0 for AgentManaged", async function () {
      await expect(createOpen({ window: HOUR - 1 })).to.be.revertedWithCustomError(escrow, "InvalidPickWindow");
      await expect(createOpen({ window: 7 * DAY + 1 })).to.be.revertedWithCustomError(escrow, "InvalidPickWindow");
      await expect(createOpen({ window: 0 })).to.be.revertedWithCustomError(escrow, "InvalidPickWindow");
      await expect(createOpen({ mode: PickMode.AgentManaged, window: HOUR })).to.be.revertedWithCustomError(escrow, "InvalidPickWindow");
      expect(await createOpen({ window: HOUR })).to.equal(1n);
      expect(await createOpen({ window: 7 * DAY })).to.equal(2n);
      expect(await createOpen({ mode: PickMode.AgentManaged })).to.equal(3n);
      expect(await escrow.MIN_CREATOR_WINDOW()).to.equal(HOUR);
      expect(await escrow.MAX_CREATOR_WINDOW()).to.equal(7 * DAY);
    });

    it("validates like createTask (amount, hash, token, duration) and is pause-gated", async function () {
      await expect(createOpen({ amount: 0n })).to.be.revertedWithCustomError(escrow, "ZeroAmount");
      await expect(createOpen({ duration: HOUR - 1 })).to.be.revertedWithCustomError(escrow, "InvalidDeadline");
      await expect(createOpen({ token: stranger.address })).to.be.revertedWithCustomError(escrow, "TokenNotAllowed");
      await escrow.connect(admin).pause();
      await expect(createOpen()).to.be.revertedWithCustomError(escrow, "EnforcedPause");
    });

    it("leaves every other task closed to open submission", async function () {
      await escrow.connect(agent).createTask(TASK_HASH, tokenAddress, AMOUNT, "c", "z", DAY);
      expect((await escrow.getOpenTask(1)).open).to.equal(false);
      await expect(escrow.openPhase(1)).to.be.revertedWithCustomError(escrow, "NotOpenTask");
      await expect(escrow.connect(s1).submitOpen(1, E1)).to.be.revertedWithCustomError(escrow, "NotOpenTask");
    });
  });

  // ── submitOpen ──

  describe("submitOpen", function () {
    it("records one submission per address, counts it and emits it", async function () {
      const id = await createOpen();
      await expect(escrow.connect(s1).submitOpen(id, E1)).to.emit(escrow, "OpenSubmission").withArgs(id, s1.address, E1, 1);
      await expect(escrow.connect(s2).submitOpen(id, E2)).to.emit(escrow, "OpenSubmission").withArgs(id, s2.address, E2, 2);
      expect(await escrow.submissionCount(id)).to.equal(2);
      expect(await escrow.submissionOf(id, s1.address)).to.equal(E1);
      expect(await escrow.submissionOf(id, s2.address)).to.equal(E2);
      expect(await escrow.submissionOf(id, s3.address)).to.equal(ethers.ZeroHash);
      // Status is untouched: still open to everyone else.
      expect((await escrow.getTask(id)).status).to.equal(Status.Funded);
    });

    it("refuses a second submission from the same address, even with other evidence", async function () {
      const id = await createOpen();
      await escrow.connect(s1).submitOpen(id, E1);
      await expect(escrow.connect(s1).submitOpen(id, E2)).to.be.revertedWithCustomError(escrow, "AlreadySubmitted");
      expect(await escrow.submissionOf(id, s1.address)).to.equal(E1);
      expect(await escrow.submissionCount(id)).to.equal(1);
    });

    it("refuses the poster, the task verifier and the global verifier", async function () {
      const id = await createOpen();
      for (const judge of [agent, taskV, verifier]) {
        await expect(escrow.connect(judge).submitOpen(id, E1)).to.be.revertedWithCustomError(escrow, "SelfAssignment");
      }
    });

    it("refuses an empty hash", async function () {
      const id = await createOpen();
      await expect(escrow.connect(s1).submitOpen(id, ethers.ZeroHash)).to.be.revertedWithCustomError(escrow, "EmptyHash");
    });

    it("closes at the effective deadline", async function () {
      const id = await createOpen();
      const d = await deadlineOf(id);
      await at(d - 1n);
      await escrow.connect(s1).submitOpen(id, E1);
      await at(d);
      await expect(escrow.connect(s2).submitOpen(id, E2)).to.be.revertedWithCustomError(escrow, "DeadlineReached");
    });

    it("moves the deadline by the time paused, and is pause-gated", async function () {
      const id = await createOpen();
      const d = (await escrow.getTask(id)).deadline;
      await escrow.connect(admin).pause();
      await expect(escrow.connect(s1).submitOpen(id, E1)).to.be.revertedWithCustomError(escrow, "EnforcedPause");
      await time.increase(HOUR);
      await escrow.connect(admin).unpause();
      const paused = (await deadlineOf(id)) - d;
      expect(paused).to.be.greaterThanOrEqual(BigInt(HOUR));
      await at(d + paused - 1n); // past the creation-time deadline, inside the moved one
      await escrow.connect(s1).submitOpen(id, E1);
    });

    it("refuses a closed task", async function () {
      const id = await createOpen();
      await escrow.connect(agent).cancelTask(id);
      await expect(escrow.connect(s1).submitOpen(id, E1))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(Status.Cancelled, Status.Funded);
    });
  });

  // ── The poster cannot pull the escrow, nor anyone assign ──

  describe("cancel lock and assignment", function () {
    it("lets the poster cancel while nothing is submitted", async function () {
      const id = await createOpen();
      await expect(escrow.connect(agent).cancelTask(id)).to.emit(escrow, "TaskCancelled").withArgs(id, AMOUNT);
      expect(await registry.openTaskCount()).to.equal(0);
    });

    it("refuses cancelTask once anything is submitted, before and after the deadline", async function () {
      const id = await createOpen();
      await escrow.connect(s1).submitOpen(id, E1);
      await expect(escrow.connect(agent).cancelTask(id)).to.be.revertedWithCustomError(escrow, "HasSubmissions");
      await time.increaseTo((await deadlineOf(id)) + 10n);
      await expect(escrow.connect(agent).cancelTask(id)).to.be.revertedWithCustomError(escrow, "HasSubmissions");
    });

    it("refuses assignWorker and marketplaceAssign for any open task, with or without submissions", async function () {
      const id = await createOpen();
      await expect(escrow.connect(agent).assignWorker(id, worker.address)).to.be.revertedWithCustomError(escrow, "OpenTaskUnsupported");
      await expect(escrow.connect(verifier).marketplaceAssign(id, worker.address)).to.be.revertedWithCustomError(escrow, "OpenTaskUnsupported");
      await escrow.connect(s1).submitOpen(id, E1);
      await expect(escrow.connect(agent).assignWorker(id, s1.address)).to.be.revertedWithCustomError(escrow, "OpenTaskUnsupported");
      await expect(escrow.connect(verifier).marketplaceAssign(id, s1.address)).to.be.revertedWithCustomError(escrow, "OpenTaskUnsupported");
    });

    it("still assigns a single-worker task (control)", async function () {
      await escrow.connect(agent).createTask(TASK_HASH, tokenAddress, AMOUNT, "c", "z", DAY);
      await expect(escrow.connect(verifier).marketplaceAssign(1, worker.address)).to.emit(escrow, "WorkerAssigned");
    });
  });

  // ── The single-worker lifecycle cannot reach an open task ──

  describe("single-worker functions on an open task", function () {
    const tee = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes("enclave")));
    const TEXT = ethers.hexlify(ethers.toUtf8Bytes("attestation"));

    it("revert before the pick", async function () {
      await escrow.connect(admin).setTeeSigner(tee.address);
      const sig = await tee.signMessage("attestation");
      const id = await createOpen();
      await escrow.connect(s1).submitOpen(id, E1);
      const invalid = (p: Promise<unknown>) => expect(p).to.be.revertedWithCustomError(escrow, "InvalidStatus");

      await expect(escrow.connect(s1).submitEvidence(id, E1)).to.be.revertedWithCustomError(escrow, "NotWorker");
      await invalid(escrow.connect(taskV).completeVerification(id, true));
      await expect(escrow.connect(verifier).completeVerification(id, true)).to.be.revertedWithCustomError(escrow, "NotVerifier");
      await invalid(escrow.connect(taskV).completeVerificationWithTEE(id, true, sig, TEXT));
      await invalid(escrow.connect(agent).raiseDispute(id));
      await expect(escrow.connect(s1).raiseDispute(id)).to.be.revertedWith("not party to task");
      await invalid(escrow.connect(admin).resolveDispute(id, true));
      await expect(escrow.connect(s1).releaseUnjudgedWork(id)).to.be.revertedWithCustomError(escrow, "NotWorker");
      await expect(escrow.connect(agent).claimTimeout(id)).to.be.revertedWithCustomError(escrow, "DeadlineNotReached");
      await time.increaseTo((await deadlineOf(id)) + 10n);
      await invalid(escrow.connect(agent).claimTimeout(id));
      expect((await escrow.getTask(id)).status).to.equal(Status.Funded);
    });

    it("revert after the pick, for the winner too", async function () {
      const id = await createOpen();
      await escrow.connect(s1).submitOpen(id, E1);
      await at(await deadlineOf(id));
      await escrow.connect(agent).selectWinner(id, s1.address, SCORECARD);
      const invalid = (p: Promise<unknown>) => expect(p).to.be.revertedWithCustomError(escrow, "InvalidStatus");
      await invalid(escrow.connect(s1).submitEvidence(id, E2));
      await invalid(escrow.connect(taskV).completeVerification(id, true));
      await invalid(escrow.connect(s1).raiseDispute(id));
      await invalid(escrow.connect(admin).resolveDispute(id, true));
      await invalid(escrow.connect(s1).releaseUnjudgedWork(id));
      await invalid(escrow.connect(agent).claimTimeout(id));
      await invalid(escrow.connect(agent).cancelTask(id));
    });
  });

  // ── Phases ──

  describe("phases", function () {
    it("CreatorReview: submissions, creator, task verifier, backup, then admin, at exact boundaries", async function () {
      const id = await createOpen({ window: 6 * HOUR });
      const d = await deadlineOf(id);
      const ends = [d, d + BigInt(6 * HOUR), d + BigInt(6 * HOUR + WINDOW), d + BigInt(6 * HOUR + 2 * WINDOW)];
      const expected = [Phase.Submissions, Phase.CreatorPick, Phase.VerifierPick, Phase.BackupPick, Phase.AdminResolve];
      for (let i = 0; i < ends.length; i++) {
        await time.increaseTo(ends[i] - 1n);
        expect(await escrow.openPhase(id), `just before end ${i}`).to.equal(expected[i]);
        await time.increaseTo(ends[i]);
        expect(await escrow.openPhase(id), `at end ${i}`).to.equal(expected[i + 1]);
      }
      await time.increase(365 * DAY);
      expect(await escrow.openPhase(id)).to.equal(Phase.AdminResolve);
    });

    it("AgentManaged: no creator phase; the task verifier's starts at the deadline", async function () {
      const id = await createOpen({ mode: PickMode.AgentManaged });
      const d = await deadlineOf(id);
      await time.increaseTo(d - 1n);
      expect(await escrow.openPhase(id)).to.equal(Phase.Submissions);
      await time.increaseTo(d);
      expect(await escrow.openPhase(id)).to.equal(Phase.VerifierPick);
      await time.increaseTo(d + BigInt(WINDOW));
      expect(await escrow.openPhase(id)).to.equal(Phase.BackupPick);
      await time.increaseTo(d + BigInt(2 * WINDOW));
      expect(await escrow.openPhase(id)).to.equal(Phase.AdminResolve);
    });

    it("a pause inside a window extends it by the time paused", async function () {
      const id = await createOpen({ mode: PickMode.AgentManaged });
      await escrow.connect(s1).submitOpen(id, E1);
      const d = await deadlineOf(id);
      await time.increaseTo(d + BigInt(WINDOW) - 100n);
      await escrow.connect(admin).pause();
      await time.increase(DAY);
      await escrow.connect(admin).unpause();
      // The verifier's window, which would have closed a day ago, is still open.
      expect(await escrow.openPhase(id)).to.equal(Phase.VerifierPick);
      await escrow.connect(taskV).selectWinnerByVerifier(id, s1.address, SCORECARD);
      expect((await escrow.getTask(id)).status).to.equal(Status.Completed);
    });

    it("is Closed once a winner is paid or the task refunded", async function () {
      const a = await createOpen();
      await escrow.connect(agent).cancelTask(a);
      expect(await escrow.openPhase(a)).to.equal(Phase.Closed);
    });
  });

  // ── Picks ──

  describe("selectWinner (the poster, CreatorReview)", function () {
    it("pays the winner 90% and the treasury 10%, records the pick and closes the listing", async function () {
      const id = await createOpen();
      await escrow.connect(s1).submitOpen(id, E1);
      await escrow.connect(s2).submitOpen(id, E2);
      await at(await deadlineOf(id));
      const tx = escrow.connect(agent).selectWinner(id, s2.address, SCORECARD);
      await expect(tx).to.emit(escrow, "WinnerSelected").withArgs(id, s2.address, Judge.Creator, SCORECARD);
      await expect(tx).to.emit(escrow, "TaskCompleted").withArgs(id, AMOUNT - FEE, FEE);
      await expect(tx).to.changeTokenBalances(ethers, token, [s2, treasury, s1], [AMOUNT - FEE, FEE, 0]);

      const t = await escrow.getTask(id);
      expect([t.worker, t.evidenceHash, t.status]).to.deep.equal([s2.address, E2, BigInt(Status.Completed)]);
      expect((await escrow.getOpenTask(id)).closedBy).to.equal(Judge.Creator);
      expect(await escrow.scorecardOf(id)).to.equal(SCORECARD);
      expect(await registry.openTaskCount()).to.equal(0);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(0);
    });

    it("only the poster, only in the creator window", async function () {
      const id = await createOpen({ window: HOUR });
      await escrow.connect(s1).submitOpen(id, E1);
      const d = await deadlineOf(id);
      await at(d - 1n);
      await expect(escrow.connect(agent).selectWinner(id, s1.address, SCORECARD))
        .to.be.revertedWithCustomError(escrow, "WrongPhase")
        .withArgs(Phase.Submissions);
      for (const other of [taskV, verifier, admin, s2]) {
        await expect(escrow.connect(other).selectWinner(id, s1.address, SCORECARD)).to.be.revertedWithCustomError(escrow, "NotAgent");
      }
      await at(d + BigInt(HOUR));
      await expect(escrow.connect(agent).selectWinner(id, s1.address, SCORECARD))
        .to.be.revertedWithCustomError(escrow, "WrongPhase")
        .withArgs(Phase.VerifierPick);
    });

    it("works on the last second of the creator window", async function () {
      const id = await createOpen({ window: HOUR });
      await escrow.connect(s1).submitOpen(id, E1);
      await at((await deadlineOf(id)) + BigInt(HOUR) - 1n);
      await expect(escrow.connect(agent).selectWinner(id, s1.address, SCORECARD)).to.emit(escrow, "WinnerSelected");
    });

    it("never in AgentManaged mode", async function () {
      const id = await createOpen({ mode: PickMode.AgentManaged });
      await escrow.connect(s1).submitOpen(id, E1);
      await at(await deadlineOf(id));
      await expect(escrow.connect(agent).selectWinner(id, s1.address, SCORECARD))
        .to.be.revertedWithCustomError(escrow, "WrongPhase")
        .withArgs(Phase.VerifierPick);
    });

    it("only an address that submitted can win", async function () {
      const id = await createOpen();
      await escrow.connect(s1).submitOpen(id, E1);
      await at(await deadlineOf(id));
      await expect(escrow.connect(agent).selectWinner(id, s2.address, SCORECARD)).to.be.revertedWithCustomError(escrow, "NoSubmission");
      await expect(escrow.connect(agent).selectWinner(id, ethers.ZeroAddress, SCORECARD)).to.be.revertedWithCustomError(escrow, "NoSubmission");
    });

    it("cannot pick twice", async function () {
      const id = await createOpen();
      await escrow.connect(s1).submitOpen(id, E1);
      await escrow.connect(s2).submitOpen(id, E2);
      await at(await deadlineOf(id));
      await escrow.connect(agent).selectWinner(id, s1.address, SCORECARD);
      await expect(escrow.connect(agent).selectWinner(id, s2.address, SCORECARD))
        .to.be.revertedWithCustomError(escrow, "WrongPhase")
        .withArgs(Phase.Closed);
    });

    it("is pause-gated", async function () {
      const id = await createOpen();
      await escrow.connect(s1).submitOpen(id, E1);
      await time.increaseTo(await deadlineOf(id));
      await escrow.connect(admin).pause();
      await expect(escrow.connect(agent).selectWinner(id, s1.address, SCORECARD)).to.be.revertedWithCustomError(escrow, "EnforcedPause");
    });
  });

  describe("selectWinnerByVerifier (the task verifier)", function () {
    it("only the task verifier, only in its window, after the creator's", async function () {
      const id = await createOpen({ window: HOUR });
      await escrow.connect(s1).submitOpen(id, E1);
      const start = (await deadlineOf(id)) + BigInt(HOUR);
      await at(start - 1n);
      await expect(escrow.connect(taskV).selectWinnerByVerifier(id, s1.address, SCORECARD))
        .to.be.revertedWithCustomError(escrow, "WrongPhase")
        .withArgs(Phase.CreatorPick);
      for (const other of [agent, verifier, admin, s2]) {
        await expect(escrow.connect(other).selectWinnerByVerifier(id, s1.address, SCORECARD)).to.be.revertedWithCustomError(escrow, "NotVerifier");
      }
      await at(start + BigInt(WINDOW));
      await expect(escrow.connect(taskV).selectWinnerByVerifier(id, s1.address, SCORECARD))
        .to.be.revertedWithCustomError(escrow, "WrongPhase")
        .withArgs(Phase.BackupPick);
    });

    it("AgentManaged: picks from the deadline and pays 90/10", async function () {
      const id = await createOpen({ mode: PickMode.AgentManaged });
      await escrow.connect(s1).submitOpen(id, E1);
      await escrow.connect(s2).submitOpen(id, E2);
      await at(await deadlineOf(id));
      const tx = escrow.connect(taskV).selectWinnerByVerifier(id, s1.address, SCORECARD);
      await expect(tx).to.emit(escrow, "WinnerSelected").withArgs(id, s1.address, Judge.TaskVerifier, SCORECARD);
      await expect(tx).to.changeTokenBalances(ethers, token, [s1, treasury], [AMOUNT - FEE, FEE]);
      expect((await escrow.getOpenTask(id)).closedBy).to.equal(Judge.TaskVerifier);
    });

    it("does not reach a single-worker task with a per-task verifier", async function () {
      await escrow.connect(agent).createTaskWithVerifier(TASK_HASH, tokenAddress, AMOUNT, "c", "z", DAY, taskV.address);
      await expect(escrow.connect(taskV).selectWinnerByVerifier(1, s1.address, SCORECARD)).to.be.revertedWithCustomError(escrow, "NotOpenTask");
    });
  });

  describe("selectWinnerByBackup (the global verifier)", function () {
    it("only the global verifier, only in the backup window", async function () {
      const id = await createOpen({ mode: PickMode.AgentManaged });
      await escrow.connect(s1).submitOpen(id, E1);
      const start = (await deadlineOf(id)) + BigInt(WINDOW);
      await at(start - 1n);
      await expect(escrow.connect(verifier).selectWinnerByBackup(id, s1.address, SCORECARD))
        .to.be.revertedWithCustomError(escrow, "WrongPhase")
        .withArgs(Phase.VerifierPick);
      for (const other of [agent, taskV, admin, s2]) {
        await expect(escrow.connect(other).selectWinnerByBackup(id, s1.address, SCORECARD)).to.be.revertedWithCustomError(escrow, "NotVerifier");
      }
      await at(start + BigInt(WINDOW));
      await expect(escrow.connect(verifier).selectWinnerByBackup(id, s1.address, SCORECARD))
        .to.be.revertedWithCustomError(escrow, "WrongPhase")
        .withArgs(Phase.AdminResolve);
    });

    it("pays 90/10 in its window", async function () {
      const id = await createOpen();
      await escrow.connect(s1).submitOpen(id, E1);
      await at((await deadlineOf(id)) + BigInt(DAY + WINDOW));
      const tx = escrow.connect(verifier).selectWinnerByBackup(id, s1.address, SCORECARD);
      await expect(tx).to.emit(escrow, "WinnerSelected").withArgs(id, s1.address, Judge.Backup, SCORECARD);
      await expect(tx).to.changeTokenBalances(ethers, token, [s1, treasury], [AMOUNT - FEE, FEE]);
    });

    it("cannot pay itself, even when it submitted before becoming the verifier", async function () {
      const id = await createOpen({ mode: PickMode.AgentManaged });
      await escrow.connect(s1).submitOpen(id, E1);
      await escrow.connect(admin).setVerifier(s1.address);
      await at((await deadlineOf(id)) + BigInt(WINDOW));
      await expect(escrow.connect(s1).selectWinnerByBackup(id, s1.address, SCORECARD)).to.be.revertedWithCustomError(escrow, "SelfAssignment");
    });
  });

  describe("resolveOpenTask (the admin)", function () {
    it("only the admin, only after the backup window, with no end", async function () {
      const id = await createOpen({ mode: PickMode.AgentManaged });
      await escrow.connect(s1).submitOpen(id, E1);
      const start = (await deadlineOf(id)) + BigInt(2 * WINDOW);
      await at(start - 1n);
      await expect(escrow.connect(admin).resolveOpenTask(id, s1.address, SCORECARD))
        .to.be.revertedWithCustomError(escrow, "WrongPhase")
        .withArgs(Phase.BackupPick);
      for (const other of [agent, taskV, verifier, s2]) {
        await expect(escrow.connect(other).resolveOpenTask(id, s1.address, SCORECARD)).to.be.revertedWithCustomError(escrow, "NotAdmin");
      }
      await at(start + BigInt(365 * DAY));
      const tx = escrow.connect(admin).resolveOpenTask(id, s1.address, SCORECARD);
      await expect(tx).to.emit(escrow, "WinnerSelected").withArgs(id, s1.address, Judge.Admin, SCORECARD);
      await expect(tx).to.changeTokenBalances(ethers, token, [s1, treasury], [AMOUNT - FEE, FEE]);
    });

    it("refunds the poster in full when it names no winner", async function () {
      const id = await createOpen();
      await escrow.connect(s1).submitOpen(id, E1);
      await at((await deadlineOf(id)) + BigInt(DAY + 2 * WINDOW));
      const tx = escrow.connect(admin).resolveOpenTask(id, ethers.ZeroAddress, SCORECARD);
      await expect(tx).to.emit(escrow, "OpenTaskVoided").withArgs(id, Judge.Admin, SCORECARD);
      await expect(tx).to.emit(escrow, "TaskCancelled").withArgs(id, AMOUNT);
      await expect(tx).to.changeTokenBalances(ethers, token, [agent, treasury, s1], [AMOUNT, 0, 0]);
      expect((await escrow.getTask(id)).status).to.equal(Status.Cancelled);
      expect((await escrow.getOpenTask(id)).closedBy).to.equal(Judge.Admin);
    });

    it("still works while the escrow is paused", async function () {
      const id = await createOpen({ mode: PickMode.AgentManaged });
      await escrow.connect(s1).submitOpen(id, E1);
      await time.increaseTo((await deadlineOf(id)) + BigInt(2 * WINDOW));
      await escrow.connect(admin).pause();
      await expect(escrow.connect(admin).resolveOpenTask(id, s1.address, SCORECARD)).to.emit(escrow, "WinnerSelected");
    });

    it("cannot pay the admin itself", async function () {
      const id = await createOpen({ mode: PickMode.AgentManaged });
      await escrow.connect(admin).submitOpen(id, E1);
      await at((await deadlineOf(id)) + BigInt(2 * WINDOW));
      await expect(escrow.connect(admin).resolveOpenTask(id, admin.address, SCORECARD)).to.be.revertedWithCustomError(escrow, "SelfAssignment");
    });
  });

  // ── Voids ──

  describe("voidOpenTask", function () {
    it("nothing submitted: the poster, once the deadline has passed", async function () {
      const id = await createOpen();
      const d = await deadlineOf(id);
      for (const other of [taskV, verifier, admin, s1]) {
        await expect(escrow.connect(other).voidOpenTask(id, ethers.ZeroHash)).to.be.revertedWithCustomError(escrow, "NotAgent");
      }
      await at(d - 1n);
      await expect(escrow.connect(agent).voidOpenTask(id, ethers.ZeroHash))
        .to.be.revertedWithCustomError(escrow, "WrongPhase")
        .withArgs(Phase.Submissions);
      await at(d);
      const tx = escrow.connect(agent).voidOpenTask(id, ethers.ZeroHash);
      await expect(tx).to.emit(escrow, "OpenTaskVoided").withArgs(id, Judge.Creator, ethers.ZeroHash);
      await expect(tx).to.emit(escrow, "TaskCancelled").withArgs(id, AMOUNT);
      await expect(tx).to.changeTokenBalances(ethers, token, [agent, treasury], [AMOUNT, 0]);
      expect(await registry.openTaskCount()).to.equal(0);
      await expect(escrow.connect(agent).voidOpenTask(id, ethers.ZeroHash))
        .to.be.revertedWithCustomError(escrow, "WrongPhase")
        .withArgs(Phase.Closed);
    });

    it("something submitted: neither the poster nor the task verifier can void it", async function () {
      const id = await createOpen();
      await escrow.connect(s1).submitOpen(id, E1);
      const d = await deadlineOf(id);
      for (const ts of [d, d + BigInt(DAY), d + BigInt(DAY + WINDOW), d + BigInt(DAY + 2 * WINDOW)]) {
        await time.increaseTo(ts);
        await expect(escrow.connect(agent).voidOpenTask(id, SCORECARD)).to.be.revertedWithCustomError(escrow, "NotVerifier");
        await expect(escrow.connect(taskV).voidOpenTask(id, SCORECARD)).to.be.revertedWithCustomError(escrow, "NotVerifier");
      }
    });

    it("something submitted: the global verifier, only in the backup window", async function () {
      const id = await createOpen();
      await escrow.connect(s1).submitOpen(id, E1);
      const start = (await deadlineOf(id)) + BigInt(DAY + WINDOW);
      await at(start - 1n);
      await expect(escrow.connect(verifier).voidOpenTask(id, SCORECARD))
        .to.be.revertedWithCustomError(escrow, "WrongPhase")
        .withArgs(Phase.VerifierPick);
      await at(start);
      const tx = escrow.connect(verifier).voidOpenTask(id, SCORECARD);
      await expect(tx).to.emit(escrow, "OpenTaskVoided").withArgs(id, Judge.Backup, SCORECARD);
      await expect(tx).to.changeTokenBalances(ethers, token, [agent, s1, treasury], [AMOUNT, 0, 0]);
      expect(await escrow.scorecardOf(id)).to.equal(SCORECARD);
      expect((await escrow.getOpenTask(id)).closedBy).to.equal(Judge.Backup);
    });

    it("something submitted: the global verifier cannot void once the admin's turn has come", async function () {
      const id = await createOpen({ mode: PickMode.AgentManaged });
      await escrow.connect(s1).submitOpen(id, E1);
      await at((await deadlineOf(id)) + BigInt(2 * WINDOW));
      await expect(escrow.connect(verifier).voidOpenTask(id, SCORECARD))
        .to.be.revertedWithCustomError(escrow, "WrongPhase")
        .withArgs(Phase.AdminResolve);
    });

    it("is pause-gated", async function () {
      const id = await createOpen();
      await time.increaseTo(await deadlineOf(id));
      await escrow.connect(admin).pause();
      await expect(escrow.connect(agent).voidOpenTask(id, ethers.ZeroHash)).to.be.revertedWithCustomError(escrow, "EnforcedPause");
    });
  });

  // ── Funds always have a way out ──

  describe("the escalation chain", function () {
    it("CreatorReview, nobody acts until the admin: every stage passes in turn and the admin pays", async function () {
      const id = await createOpen({ window: 2 * HOUR });
      await escrow.connect(s1).submitOpen(id, E1);
      await escrow.connect(s2).submitOpen(id, E2);
      const d = await deadlineOf(id);
      const seen: bigint[] = [];
      for (const ts of [d, d + BigInt(2 * HOUR), d + BigInt(2 * HOUR + WINDOW), d + BigInt(2 * HOUR + 2 * WINDOW)]) {
        await time.increaseTo(ts);
        seen.push(await escrow.openPhase(id));
      }
      expect(seen).to.deep.equal([Phase.CreatorPick, Phase.VerifierPick, Phase.BackupPick, Phase.AdminResolve].map(BigInt));
      await expect(escrow.connect(admin).resolveOpenTask(id, s2.address, SCORECARD)).to.changeTokenBalances(ethers, token, [s2, treasury], [AMOUNT - FEE, FEE]);
    });
  });

  // ── Payout and rating ──

  describe("payout and rating", function () {
    /** A single-worker task settled by the platform verifier, for comparison. */
    async function singlePayout(amount: bigint) {
      await escrow.connect(agent).createTask(TASK_HASH, tokenAddress, amount, "c", "z", DAY);
      const id = (await escrow.nextTaskId()) - 1n;
      await escrow.connect(verifier).marketplaceAssign(id, worker.address);
      await escrow.connect(worker).submitEvidence(id, E1);
      const tx = await escrow.connect(verifier).completeVerification(id, true);
      const log = (await tx.wait())!.logs.map((l) => escrow.interface.parseLog(l)).find((p) => p?.name === "TaskCompleted")!;
      return [log.args.workerPayout as bigint, log.args.platformFee as bigint];
    }

    /** An open task won by s1, picked by `judge`. Returns the TaskCompleted split. */
    async function openPayout(amount: bigint, judge: number) {
      const id = await createOpen({ amount, mode: PickMode.CreatorReview, window: HOUR });
      await escrow.connect(s1).submitOpen(id, E1);
      const d = await deadlineOf(id);
      let tx;
      if (judge === Judge.Creator) {
        await at(d);
        tx = await escrow.connect(agent).selectWinner(id, s1.address, SCORECARD);
      } else if (judge === Judge.TaskVerifier) {
        await at(d + BigInt(HOUR));
        tx = await escrow.connect(taskV).selectWinnerByVerifier(id, s1.address, SCORECARD);
      } else if (judge === Judge.Backup) {
        await at(d + BigInt(HOUR + WINDOW));
        tx = await escrow.connect(verifier).selectWinnerByBackup(id, s1.address, SCORECARD);
      } else {
        await at(d + BigInt(HOUR + 2 * WINDOW));
        tx = await escrow.connect(admin).resolveOpenTask(id, s1.address, SCORECARD);
      }
      const log = (await tx.wait())!.logs.map((l) => escrow.interface.parseLog(l)).find((p) => p?.name === "TaskCompleted")!;
      return [log.args.workerPayout as bigint, log.args.platformFee as bigint];
    }

    it("splits exactly as completeVerification does, for every judge, amount and fee", async function () {
      for (const amount of [AMOUNT, 9n, 10n, 12_345_679n]) {
        const expected = await singlePayout(amount);
        for (const judge of [Judge.Creator, Judge.TaskVerifier, Judge.Backup, Judge.Admin]) {
          expect(await openPayout(amount, judge), `amount ${amount}, judge ${judge}`).to.deep.equal(expected);
        }
      }
      await escrow.connect(admin).setFeeBps(2500); // read at settlement
      const expected = await singlePayout(AMOUNT);
      expect(expected).to.deep.equal([AMOUNT - AMOUNT / 4n, AMOUNT / 4n]);
      expect(await openPayout(AMOUNT, Judge.Backup)).to.deep.equal(expected);
    });

    it("pays a native-token winner the same split", async function () {
      await escrow.connect(admin).allowToken(ethers.ZeroAddress);
      const amount = ethers.parseEther("1");
      const id = await createOpen({ token: ethers.ZeroAddress, amount });
      await escrow.connect(s1).submitOpen(id, E1);
      await at(await deadlineOf(id));
      await expect(escrow.connect(agent).selectWinner(id, s1.address, SCORECARD)).to.changeEtherBalances(ethers, 
        [s1, treasury],
        [ethers.parseEther("0.9"), ethers.parseEther("0.1")],
      );
    });

    it("rates the winner only when the backup judge or the admin picked", async function () {
      await openPayout(AMOUNT, Judge.Creator);
      await openPayout(AMOUNT, Judge.TaskVerifier);
      expect(await ratings(s1.address)).to.equal(0);
      await openPayout(AMOUNT, Judge.Backup);
      expect(await ratings(s1.address)).to.equal(1);
      await openPayout(AMOUNT, Judge.Admin);
      expect(await ratings(s1.address)).to.equal(2);
      expect((await reputation.getReputation(s1.address))[1]).to.equal(500); // score 5
    });

    it("applies the fee and minimum-amount conditions to backup and admin picks", async function () {
      await openPayout(9n, Judge.Backup); // fee rounds to 0
      await openPayout(9n, Judge.Admin);
      expect(await ratings(s1.address)).to.equal(0);
      await escrow.connect(admin).setMinRatedAmount(tokenAddress, AMOUNT * 2n);
      await openPayout(AMOUNT, Judge.Backup);
      expect(await ratings(s1.address)).to.equal(0);
      await openPayout(AMOUNT * 2n, Judge.Admin);
      expect(await ratings(s1.address)).to.equal(1);
    });

    it("leaves single-worker ratings as they were (control)", async function () {
      await singlePayout(AMOUNT);
      expect(await ratings(worker.address)).to.equal(1);
    });
  });

  // ── Many submitters ──

  describe("at scale", function () {
    const N = 500;

    it(`keeps submit and every pick flat from 1 to ${N} submitters`, async function () {
      this.timeout(300_000);
      // Deterministic submitter wallets, funded for gas.
      const submitters = Array.from({ length: N }, (_, i) =>
        new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(`open submitter ${i}`)), ethers.provider),
      );
      for (const w of submitters) await ethers.provider.send("hardhat_setBalance", [w.address, "0x56BC75E2D63100000"]);
      // Evidence hashes with no zero byte, so every submit's calldata costs the same.
      const evidence = (i: number) => {
        let h = ethers.keccak256(ethers.toUtf8Bytes(`open result ${i}`));
        for (let k = 0; ethers.getBytes(h).includes(0); k++) h = ethers.keccak256(ethers.toUtf8Bytes(`open result ${i}.${k}`));
        return h;
      };

      const small = await createOpen({ window: HOUR });
      const large = await createOpen({ window: HOUR });

      const submitGas: bigint[] = [];
      for (let i = 0; i < N; i++) {
        const receipt = await (await escrow.connect(submitters[i]).submitOpen(large, evidence(i))).wait();
        submitGas.push(receipt!.gasUsed);
      }
      const smallFirst = (await (await escrow.connect(submitters[0]).submitOpen(small, evidence(0))).wait())!.gasUsed;
      // The first submission moves the counter off zero; every later one costs the same, the 2nd as the 500th.
      expect(smallFirst).to.equal(submitGas[0]);
      expect(new Set(submitGas.slice(1).map(String)).size, `submits 2..${N} cost the same`).to.equal(1);

      expect(await escrow.submissionCount(large)).to.equal(N);
      expect(await escrow.submissionCount(small)).to.equal(1);
      for (const i of [0, 1, 249, 250, N - 1]) {
        expect(await escrow.submissionOf(large, submitters[i].address)).to.equal(evidence(i));
      }

      // Each pick path, on each task, from the same state: same winner, same pre-state.
      const winner = submitters[0];
      type Path = { name: string; offset: number; send: (id: bigint) => Promise<any> };
      const paths: Path[] = [
        { name: "selectWinner", offset: 0, send: (id) => escrow.connect(agent).selectWinner(id, winner.address, SCORECARD) },
        { name: "selectWinnerByVerifier", offset: HOUR, send: (id) => escrow.connect(taskV).selectWinnerByVerifier(id, winner.address, SCORECARD) },
        { name: "selectWinnerByBackup", offset: HOUR + WINDOW, send: (id) => escrow.connect(verifier).selectWinnerByBackup(id, winner.address, SCORECARD) },
        { name: "voidOpenTask (backup)", offset: HOUR + WINDOW, send: (id) => escrow.connect(verifier).voidOpenTask(id, SCORECARD) },
        { name: "resolveOpenTask (winner)", offset: HOUR + 2 * WINDOW, send: (id) => escrow.connect(admin).resolveOpenTask(id, winner.address, SCORECARD) },
        { name: "resolveOpenTask (void)", offset: HOUR + 2 * WINDOW, send: (id) => escrow.connect(admin).resolveOpenTask(id, ethers.ZeroAddress, SCORECARD) },
      ];
      const rows: Array<[string, bigint, bigint]> = [
        ["submitOpen, first on the task", smallFirst, submitGas[0]],
        [`submitOpen, 2nd vs ${N}th`, submitGas[1], submitGas[N - 1]],
      ];
      for (const p of paths) {
        const gas: bigint[] = [];
        for (const id of [small, large]) {
          const snapshot = await ethers.provider.send("evm_snapshot", []);
          await at((await deadlineOf(large)) + BigInt(p.offset)); // `large` was created a block after `small`: inside both windows
          const before = await token.balanceOf(winner.address);
          const receipt = await (await p.send(id)).wait();
          gas.push(receipt.gasUsed);
          const won = (await escrow.getTask(id)).status === BigInt(Status.Completed);
          expect(await token.balanceOf(winner.address)).to.equal(before + (won ? AMOUNT - FEE : 0n));
          await ethers.provider.send("evm_revert", [snapshot]);
        }
        expect(gas[0], `${p.name} costs the same at 1 and ${N} submitters`).to.equal(gas[1]);
        rows.push([p.name, gas[0], gas[1]]);
      }
      console.log(`\n      gas used: path | N=1 | N=${N}`);
      for (const [name, a, b] of rows) console.log(`      ${name} | ${a} | ${b}`);
    });
  });
});
