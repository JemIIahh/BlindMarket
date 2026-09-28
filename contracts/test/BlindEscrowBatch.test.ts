import { expect } from "chai";
import { ethers, upgrades } from "../lib/hh.js";
import type { BlindEscrow, TaskRegistry } from "../types/ethers-contracts/index.js";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

/**
 * createTasks: many tasks in one transaction, one transfer for the total.
 * Every task must be recorded exactly as createTask / createTaskWithVerifier
 * records it, and any invalid task must revert the whole batch.
 */
describe("BlindEscrow.createTasks", function () {
  let escrow: BlindEscrow;
  let registry: TaskRegistry;
  let token: any;
  let tokenAddress: string;
  let escrowAddress: string;
  let admin: HardhatEthersSigner;
  let agent: HardhatEthersSigner;
  let verifier: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let agentVerifier: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const ONE_DAY = 86400;
  const usdc = (n: string) => ethers.parseUnits(n, 6);

  type TaskInput = {
    taskHash: string;
    amount: bigint;
    category: string;
    locationZone: string;
    duration: number;
    verifierAgent: string;
  };

  const input = (i: number, over: Partial<TaskInput> = {}): TaskInput => ({
    taskHash: ethers.keccak256(ethers.toUtf8Bytes(`batch-task-${i}`)),
    amount: usdc(String(i + 1)),
    category: i % 2 ? "research" : "general",
    locationZone: i % 2 ? "eu" : "global",
    duration: ONE_DAY * (i + 1),
    verifierAgent: ethers.ZeroAddress,
    ...over,
  });

  const inputs = (n: number) => Array.from({ length: n }, (_, i) => input(i));

  // EIP-7825 (Osaka) caps one transaction at 2^24 gas, below the block limit;
  // the simulated chain enforces it, and so may a live one.
  const EIP7825_TX_GAS_CAP = 16_777_216n;
  const txGasCap = async () => {
    const blockLimit = (await ethers.provider.getBlock("latest"))!.gasLimit;
    return blockLimit - 1n < EIP7825_TX_GAS_CAP ? blockLimit - 1n : EIP7825_TX_GAS_CAP;
  };
  const sum = (tasks: TaskInput[]) => tasks.reduce((s, t) => s + t.amount, 0n);

  async function snapshot() {
    return {
      nextTaskId: await escrow.nextTaskId(),
      agentBalance: await token.balanceOf(agent.address),
      escrowBalance: await token.balanceOf(escrowAddress),
    };
  }

  async function expectNothingRecorded(before: Awaited<ReturnType<typeof snapshot>>) {
    const after = await snapshot();
    expect(after.nextTaskId).to.equal(before.nextTaskId);
    expect(after.agentBalance).to.equal(before.agentBalance);
    expect(after.escrowBalance).to.equal(before.escrowBalance);
    expect((await escrow.getTask(before.nextTaskId)).agent).to.equal(ethers.ZeroAddress);
  }

  beforeEach(async function () {
    [admin, agent, verifier, treasury, agentVerifier, stranger] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    token = await Token.deploy("Mock USDC", "MUSDC", 6);
    tokenAddress = await token.getAddress();
    await token.mint(agent.address, usdc("1000000"));

    const Reg = await ethers.getContractFactory("TaskRegistry");
    registry = (await upgrades.deployProxy(Reg, [], { kind: "uups" })) as unknown as TaskRegistry;

    const Escrow = await ethers.getContractFactory("BlindEscrow");
    escrow = (await upgrades.deployProxy(Escrow, [treasury.address, verifier.address], { kind: "uups" })) as unknown as BlindEscrow;
    escrowAddress = await escrow.getAddress();

    await escrow.connect(admin).allowToken(tokenAddress);
    await escrow.connect(admin).setTaskRegistry(await registry.getAddress());
    await registry.connect(admin).authorizePublisher(escrowAddress);

    await token.connect(agent).approve(escrowAddress, ethers.MaxUint256);
  });

  it("exposes MAX_BATCH = 50 for clients to detect batch support", async function () {
    expect(await escrow.MAX_BATCH()).to.equal(50n);
  });

  it("records every task with consecutive ids and pulls the total in exactly one transfer", async function () {
    const tasks = inputs(3);
    const before = await snapshot();
    expect(before.nextTaskId).to.equal(1n);

    expect(await escrow.connect(agent).createTasks.staticCall(tokenAddress, tasks)).to.equal(1n);
    const tx = await escrow.connect(agent).createTasks(tokenAddress, tasks);
    const receipt = (await tx.wait())!;
    const block = (await ethers.provider.getBlock(receipt.blockNumber))!;

    expect(await escrow.nextTaskId()).to.equal(4n);
    for (let i = 0; i < tasks.length; i++) {
      const t = await escrow.getTask(BigInt(i + 1));
      expect(t.agent).to.equal(agent.address);
      expect(t.worker).to.equal(ethers.ZeroAddress);
      expect(t.token).to.equal(tokenAddress);
      expect(t.amount).to.equal(tasks[i].amount);
      expect(t.taskHash).to.equal(tasks[i].taskHash);
      expect(t.status).to.equal(0n); // Funded
      expect(t.category).to.equal(tasks[i].category);
      expect(t.locationZone).to.equal(tasks[i].locationZone);
      expect(t.createdAt).to.equal(BigInt(block.timestamp));
      expect(t.deadline).to.equal(BigInt(block.timestamp + tasks[i].duration));
      expect(await escrow.taskVerifier(BigInt(i + 1))).to.equal(ethers.ZeroAddress);
    }

    // One ERC-20 Transfer for the whole batch: agent → escrow, the total.
    const transferTopic = token.interface.getEvent("Transfer")!.topicHash;
    const transfers = receipt.logs.filter((l) => l.address === tokenAddress && l.topics[0] === transferTopic);
    expect(transfers).to.have.length(1);
    const parsed = token.interface.parseLog(transfers[0])!;
    expect(parsed.args.from).to.equal(agent.address);
    expect(parsed.args.to).to.equal(escrowAddress);
    expect(parsed.args.value).to.equal(sum(tasks));

    const after = await snapshot();
    expect(before.agentBalance - after.agentBalance).to.equal(sum(tasks));
    expect(after.escrowBalance - before.escrowBalance).to.equal(sum(tasks));
  });

  it("emits TaskCreated per task, in input order, with the same fields createTask emits", async function () {
    const tasks = inputs(4);
    const receipt = (await (await escrow.connect(agent).createTasks(tokenAddress, tasks)).wait())!;
    const block = (await ethers.provider.getBlock(receipt.blockNumber))!;
    const created = receipt.logs
      .filter((l) => l.address === escrowAddress)
      .map((l) => escrow.interface.parseLog(l))
      .filter((e) => e?.name === "TaskCreated");
    expect(created.map((e) => e!.args.taskId)).to.deep.equal([1n, 2n, 3n, 4n]);
    created.forEach((e, i) => {
      expect(e!.args.agent).to.equal(agent.address);
      expect(e!.args.token).to.equal(tokenAddress);
      expect(e!.args.amount).to.equal(tasks[i].amount);
      expect(e!.args.taskHash).to.equal(tasks[i].taskHash);
      expect(e!.args.category).to.equal(tasks[i].category);
      expect(e!.args.locationZone).to.equal(tasks[i].locationZone);
      expect(e!.args.deadline).to.equal(BigInt(block.timestamp + tasks[i].duration));
    });
  });

  it("keeps ids consecutive after single-task creates, and single creates continue after a batch", async function () {
    await escrow.connect(agent).createTask(ethers.keccak256(ethers.toUtf8Bytes("single-1")), tokenAddress, usdc("1"), "general", "global", ONE_DAY);
    expect(await escrow.connect(agent).createTasks.staticCall(tokenAddress, inputs(2))).to.equal(2n);
    await escrow.connect(agent).createTasks(tokenAddress, inputs(2));
    await expect(
      escrow.connect(agent).createTask(ethers.keccak256(ethers.toUtf8Bytes("single-2")), tokenAddress, usdc("1"), "general", "global", ONE_DAY),
    ).to.emit(escrow, "TaskCreated").withArgs(4n, agent.address, tokenAddress, usdc("1"), ethers.keccak256(ethers.toUtf8Bytes("single-2")), "general", "global", (d: bigint) => d > 0n);
    expect(await escrow.nextTaskId()).to.equal(5n);
  });

  it("sets per-task verifiers only where given, with TaskVerifierSet for those tasks", async function () {
    const tasks = [input(0), input(1, { verifierAgent: agentVerifier.address }), input(2)];
    const receipt = (await (await escrow.connect(agent).createTasks(tokenAddress, tasks)).wait())!;
    expect(await escrow.taskVerifier(1n)).to.equal(ethers.ZeroAddress);
    expect(await escrow.taskVerifier(2n)).to.equal(agentVerifier.address);
    expect(await escrow.taskVerifier(3n)).to.equal(ethers.ZeroAddress);
    const set = receipt.logs
      .filter((l) => l.address === escrowAddress)
      .map((l) => escrow.interface.parseLog(l))
      .filter((e) => e?.name === "TaskVerifierSet");
    expect(set).to.have.length(1);
    expect(set[0]!.args.taskId).to.equal(2n);
    expect(set[0]!.args.verifier).to.equal(agentVerifier.address);
  });

  it("reverts the whole batch when a task names the poster as its verifier", async function () {
    const before = await snapshot();
    const tasks = [input(0), input(1, { verifierAgent: agent.address }), input(2)];
    await expect(escrow.connect(agent).createTasks(tokenAddress, tasks)).to.be.revertedWithCustomError(escrow, "SelfAssignment");
    await expectNothingRecorded(before);
  });

  it("rejects an empty batch", async function () {
    await expect(escrow.connect(agent).createTasks(tokenAddress, [])).to.be.revertedWithCustomError(escrow, "EmptyBatch");
  });

  it("rejects more than MAX_BATCH tasks", async function () {
    const before = await snapshot();
    await expect(escrow.connect(agent).createTasks(tokenAddress, inputs(51))).to.be.revertedWithCustomError(escrow, "BatchTooLarge");
    await expectNothingRecorded(before);
  });

  // Arc runs without a TaskRegistry: an escrow with none connected, as there.
  async function bareEscrow(): Promise<BlindEscrow> {
    const Escrow = await ethers.getContractFactory("BlindEscrow");
    const bare = (await upgrades.deployProxy(Escrow, [treasury.address, verifier.address], { kind: "uups" })) as unknown as BlindEscrow;
    await bare.connect(admin).allowToken(tokenAddress);
    await token.connect(agent).approve(await bare.getAddress(), ethers.MaxUint256);
    return bare;
  }

  it("fits a full MAX_BATCH under the 2^24 per-transaction gas cap without a TaskRegistry (the Arc setup)", async function () {
    const bare = await bareEscrow();
    const tasks = inputs(50);
    const receipt = (await (await bare.connect(agent).createTasks(tokenAddress, tasks, { gasLimit: await txGasCap() })).wait())!;
    expect(receipt.status).to.equal(1);
    expect(await bare.nextTaskId()).to.equal(51n);
    expect(await token.balanceOf(await bare.getAddress())).to.equal(sum(tasks));
  });

  const invalid: Array<[string, Partial<TaskInput>, string]> = [
    ["a zero amount", { amount: 0n }, "ZeroAmount"],
    ["an empty hash", { taskHash: ethers.ZeroHash }, "EmptyHash"],
    ["a duration under an hour", { duration: 3599 }, "InvalidDeadline"],
    ["a duration over 90 days", { duration: 90 * ONE_DAY + 1 }, "InvalidDeadline"],
  ];
  for (const [label, over, error] of invalid) {
    it(`reverts the whole batch, recording nothing, for ${label} in any task`, async function () {
      const before = await snapshot();
      const tasks = [input(0), input(1), input(2, over)];
      await expect(escrow.connect(agent).createTasks(tokenAddress, tasks)).to.be.revertedWithCustomError(escrow, error);
      await expectNothingRecorded(before);
    });
  }

  it("rejects a token that is not allowed", async function () {
    const Token = await ethers.getContractFactory("MockERC20");
    const other = await Token.deploy("Other", "OTH", 6);
    await other.mint(agent.address, usdc("100"));
    await other.connect(agent).approve(escrowAddress, ethers.MaxUint256);
    const before = await snapshot();
    await expect(escrow.connect(agent).createTasks(await other.getAddress(), inputs(2))).to.be.revertedWithCustomError(escrow, "TokenNotAllowed");
    await expectNothingRecorded(before);
  });

  it("rejects the native token even when it is allowed", async function () {
    await escrow.connect(admin).allowToken(ethers.ZeroAddress);
    const tasks = inputs(2);
    await expect(
      escrow.connect(agent).createTasks(ethers.ZeroAddress, tasks, { value: sum(tasks) }),
    ).to.be.revertedWithCustomError(escrow, "TokenNotAllowed");
  });

  it("rejects any value sent with an ERC-20 batch", async function () {
    const before = await snapshot();
    await expect(escrow.connect(agent).createTasks(tokenAddress, inputs(2), { value: 1n })).to.be.revertedWithCustomError(escrow, "ZeroAmount");
    await expectNothingRecorded(before);
  });

  it("is blocked while the escrow is paused", async function () {
    await escrow.connect(admin).pause();
    await expect(escrow.connect(agent).createTasks(tokenAddress, inputs(2))).to.be.revertedWithCustomError(escrow, "EnforcedPause");
  });

  it("reverts every task when the allowance is short of the total", async function () {
    const tasks = inputs(3);
    await token.connect(agent).approve(escrowAddress, sum(tasks) - 1n);
    const before = await snapshot();
    await expect(escrow.connect(agent).createTasks(tokenAddress, tasks)).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
    await expectNothingRecorded(before);
  });

  it("reverts every task when the balance is short of the total", async function () {
    const tasks = inputs(3);
    await token.mint(stranger.address, sum(tasks) - 1n);
    await token.connect(stranger).approve(escrowAddress, ethers.MaxUint256);
    const next = await escrow.nextTaskId();
    await expect(escrow.connect(stranger).createTasks(tokenAddress, tasks)).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
    expect(await escrow.nextTaskId()).to.equal(next);
    expect(await token.balanceOf(stranger.address)).to.equal(sum(tasks) - 1n);
  });

  it("stops a token that re-enters createTasks from transferFrom", async function () {
    const Rent = await ethers.getContractFactory("ReentrantERC20");
    const rent: any = await Rent.deploy();
    const rentAddress = await rent.getAddress();
    await escrow.connect(admin).allowToken(rentAddress);
    await rent.mint(agent.address, usdc("100"));
    await rent.connect(agent).approve(escrowAddress, ethers.MaxUint256);
    await rent.arm(escrowAddress);
    const next = await escrow.nextTaskId();
    await expect(escrow.connect(agent).createTasks(rentAddress, inputs(2))).to.be.revertedWithCustomError(escrow, "ReentrancyGuardReentrantCall");
    expect(await escrow.nextTaskId()).to.equal(next);
  });

  it("publishes each task to the TaskRegistry when one is connected", async function () {
    await escrow.connect(agent).createTasks(tokenAddress, inputs(3));
    for (const id of [1n, 2n, 3n]) expect(await registry.taskExists(id)).to.equal(true);
  });

  it("records tasks the rest of the escrow treats like single-created ones (the poster can cancel for a refund)", async function () {
    const tasks = inputs(2);
    await escrow.connect(agent).createTasks(tokenAddress, tasks);
    const before = await token.balanceOf(agent.address);
    await expect(escrow.connect(agent).cancelTask(2n)).to.emit(escrow, "TaskCancelled").withArgs(2n, tasks[1].amount);
    expect((await token.balanceOf(agent.address)) - before).to.equal(tasks[1].amount);
    expect((await escrow.getTask(1n)).status).to.equal(0n); // the other task is untouched
    await expect(escrow.connect(stranger).cancelTask(1n)).to.be.revertedWithCustomError(escrow, "NotAgent");
  });

  it("gas: createTasks at 1, 10, 25 and 50 tasks, with and without a TaskRegistry", async function () {
    const blockGasLimit = (await ethers.provider.getBlock("latest"))!.gasLimit;
    const cap = await txGasCap();
    const measure = async (esc: BlindEscrow, n: number): Promise<bigint | null> => {
      try {
        const r = (await (await esc.connect(agent).createTasks(tokenAddress, inputs(n), { gasLimit: cap })).wait())!;
        return r.gasUsed;
      } catch {
        return null; // ran out of gas under the cap
      }
    };
    const bare = await bareEscrow();
    const single = (await (await bare.connect(agent).createTask(ethers.keccak256(ethers.toUtf8Bytes("gas-single")), tokenAddress, usdc("1"), "general", "global", ONE_DAY)).wait())!.gasUsed;
    const rows: string[] = [`single createTask, no registry: ${single}`];
    const results: Record<string, Record<number, bigint | null>> = { bare: {}, registry: {} };
    for (const n of [1, 10, 25, 50]) {
      results.bare[n] = await measure(bare, n);
      results.registry[n] = await measure(escrow, n);
      const fmt = (g: bigint | null) => (g === null ? `over the ${cap} cap` : `${g} (${g / BigInt(n)}/task)`);
      rows.push(`n=${n}: no registry ${fmt(results.bare[n])} | with registry ${fmt(results.registry[n])}`);
    }
    const perTask = (r: Record<number, bigint | null>) => (r[25]! - r[10]!) / 15n;
    rows.push(`marginal per task: no registry ${perTask(results.bare)}, with registry ${perTask(results.registry)}`);
    console.log(`      block gas limit ${blockGasLimit}, per-tx cap ${cap}\n      ${rows.join("\n      ")}`);

    // The Arc setup fits every size up to MAX_BATCH; the registry setup at least 25.
    for (const n of [1, 10, 25, 50]) expect(typeof results.bare[n], `no registry, n=${n}`).to.equal("bigint");
    for (const n of [1, 10, 25]) expect(typeof results.registry[n], `registry, n=${n}`).to.equal("bigint");
  });
});
