import { expect } from "chai";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import hre from "hardhat";
import { getVersion } from "@openzeppelin/upgrades-core";
import type { ContractFactory, ContractTransactionResponse } from "ethers";
import { ethers, time } from "../lib/hh.js";

/**
 * test/fixtures/BlindEscrow-882acaf.json is the implementation both Arc
 * proxies run: BlindEscrow.sol as of 882acaf, compiled (see its _note for why
 * it is bytecode and not a source under contracts/). These tests pin that,
 * then hold the current BlindEscrow to it: every settlement the deployed code
 * can make must pay, rate and log exactly as it did, and a proxy of it must
 * upgrade to the current code with its state intact.
 */

const DEPLOYED = JSON.parse(readFileSync(new URL("./fixtures/BlindEscrow-882acaf.json", import.meta.url), "utf8")) as {
  abi: unknown[];
  bytecode: string;
};
const deployedFactory = async (): Promise<ContractFactory> => {
  const [admin] = await ethers.getSigners();
  return new ethers.ContractFactory(DEPLOYED.abi as never, DEPLOYED.bytecode, admin);
};

const MANIFESTS = [
  { chain: "Arc testnet", path: ".openzeppelin/unknown-5042002.json" },
  { chain: "Arc mainnet", path: ".openzeppelin/unknown-5042.json" },
];

/** The version (bytecode hash without metadata) of the implementation a manifest records last. */
function deployedVersion(path: string): string {
  const manifest = JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")) as { impls: Record<string, unknown> };
  const keys = Object.keys(manifest.impls);
  return keys[keys.length - 1];
}

// The ERC1967Proxy the OpenZeppelin plugin deploys. Deployed by hand here so
// both runs below put every contract at the same address.
const PROXY = JSON.parse(
  readFileSync(
    createRequire(import.meta.url).resolve(
      "@openzeppelin/upgrades-core/artifacts/@openzeppelin/contracts-v5/proxy/ERC1967/ERC1967Proxy.sol/ERC1967Proxy.json",
    ),
    "utf8",
  ),
) as { abi: unknown[]; bytecode: string };

describe("The deployed-implementation fixture is what the Arc proxies run", function () {
  for (const m of MANIFESTS) {
    it(`has the version of the ${m.chain} implementation recorded in ${m.path}`, function () {
      expect(getVersion(DEPLOYED.bytecode).linkedWithoutMetadata).to.equal(deployedVersion(m.path));
    });
  }

  it("is not in the build, so the OpenZeppelin plugin cannot match it to those manifests", async function () {
    const versions: string[] = [];
    for (const name of await hre.artifacts.getAllFullyQualifiedNames()) {
      const { bytecode } = await hre.artifacts.readArtifact(name);
      if (bytecode.length > 2) versions.push(getVersion(bytecode).linkedWithoutMetadata);
    }
    expect(versions.length).to.be.greaterThan(10);
    expect(versions).to.not.include(deployedVersion(MANIFESTS[0].path));
  });
});

type Logged = [address: string, topics: string[], data: string];
interface Run {
  trace: Array<{ label: string; logs: Logged[]; native?: bigint[] }>;
  balances: bigint[];
  tasks: unknown[];
  reputation: unknown;
}

describe("BlindEscrow payouts match the deployed implementation", function () {
  const AMOUNT = ethers.parseUnits("100", 6);
  const EVIDENCE = ethers.keccak256(ethers.toUtf8Bytes("evidence"));
  const HOUR = 3600;
  const DAY = 24 * HOUR;
  // A fixed enclave key, so both runs sign the same bytes.
  const tee = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes("blindmarket test enclave")));
  const ATTESTATION = "0g-tee-commitment:req=0x01,res=0x02";

  /**
   * Deploys token, reputation, registry and a BlindEscrow proxy on `impl`,
   * then runs every settlement path once, each transaction at a fixed
   * timestamp. Returns every log of every scenario transaction and the end
   * state. From the same snapshot, both implementations make the same
   * deployments at the same nonces, so the same addresses.
   */
  async function run(impl: "deployed" | "current"): Promise<Run> {
    const [admin, agent, worker, verifier, treasury, stranger] = await ethers.getSigners();
    const trace: Run["trace"] = [];
    let clock = (await time.latest()) + 1000;
    const tick = async (seconds = 10) => {
      clock += seconds;
      await time.setNextBlockTimestamp(clock);
    };
    const deploy = async (factory: ContractFactory, ...args: unknown[]) => {
      await tick();
      const c = await factory.deploy(...args);
      await c.waitForDeployment();
      return c;
    };
    const proxy = async (factory: ContractFactory, init: unknown[]) => {
      const implementation = await deploy(factory);
      const data = implementation.interface.encodeFunctionData("initialize", init);
      await tick();
      const Proxy = new ethers.ContractFactory(PROXY.abi as never, PROXY.bytecode, admin);
      const p = await Proxy.deploy(await implementation.getAddress(), data);
      await p.waitForDeployment();
      return factory.attach(await p.getAddress()) as any;
    };
    /** One scenario transaction, logged. `watch` records those native balance changes over it. */
    const step = async (label: string, send: () => Promise<ContractTransactionResponse>, watch: string[] = []) => {
      await tick();
      const before = await Promise.all(watch.map((a) => ethers.provider.getBalance(a)));
      const receipt = (await (await send()).wait())!;
      const after = await Promise.all(watch.map((a) => ethers.provider.getBalance(a)));
      trace.push({
        label,
        logs: receipt.logs.map((l) => [l.address, [...l.topics], l.data] as Logged),
        ...(watch.length ? { native: after.map((b, i) => b - before[i]) } : {}),
      });
    };

    const token: any = await deploy(await ethers.getContractFactory("MockERC20"), "Mock USDC", "MUSDC", 6);
    const reputation = await proxy(await ethers.getContractFactory("BlindReputation"), []);
    const registry = await proxy(await ethers.getContractFactory("TaskRegistry"), []);
    const escrowFactory = impl === "deployed" ? await deployedFactory() : await ethers.getContractFactory("BlindEscrow");
    const escrow = await proxy(escrowFactory, [treasury.address, verifier.address]);
    const t = await token.getAddress();
    const e = await escrow.getAddress();
    const NATIVE = ethers.ZeroAddress;

    await step("mint", () => token.mint(agent.address, ethers.parseUnits("10000", 6)));
    await step("approve", () => token.connect(agent).approve(e, ethers.MaxUint256));
    await step("allow token", () => escrow.connect(admin).allowToken(t));
    await step("allow native", () => escrow.connect(admin).allowToken(NATIVE));
    await step("set reputation", () => escrow.connect(admin).setReputationContract(reputation.getAddress()));
    await step("set registry", () => escrow.connect(admin).setTaskRegistry(registry.getAddress()));
    await step("authorize rater", () => reputation.connect(admin).authorizeRater(e));
    await step("authorize publisher", () => registry.connect(admin).authorizePublisher(e));
    await step("set tee signer", () => escrow.connect(admin).setTeeSigner(tee.address));

    let nextId = 1n;
    /** createTask (or createTaskWithVerifier), then assign through the platform verifier or the poster. */
    const open = async (label: string, o: { amount?: bigint; token?: string; perTaskVerifier?: string; duration?: number; byPoster?: boolean } = {}) => {
      const id = nextId++;
      const amount = o.amount ?? AMOUNT;
      const tok = o.token ?? t;
      const value = tok === NATIVE ? amount : 0n;
      const hash = ethers.keccak256(ethers.toUtf8Bytes(`task ${id}`));
      const duration = o.duration ?? DAY;
      await step(`${label}: create`, () =>
        o.perTaskVerifier
          ? escrow.connect(agent).createTaskWithVerifier(hash, tok, amount, "c", "z", duration, o.perTaskVerifier, { value })
          : escrow.connect(agent).createTask(hash, tok, amount, "c", "z", duration, { value }),
      );
      await step(`${label}: assign`, () =>
        o.byPoster ? escrow.connect(agent).assignWorker(id, worker.address) : escrow.connect(verifier).marketplaceAssign(id, worker.address),
      );
      return id;
    };
    const submit = (label: string, id: bigint) => step(`${label}: submit`, () => escrow.connect(worker).submitEvidence(id, EVIDENCE));

    // completeVerification, platform verifier, fee-bearing: paid 90/10, rated 5.
    let id = await open("platform pass");
    await submit("platform pass", id);
    await step("platform pass: verdict", () => escrow.connect(verifier).completeVerification(id, true));

    // completeVerification by a poster-designated verifier: paid, not rated.
    id = await open("agent-verified pass", { perTaskVerifier: stranger.address, byPoster: true });
    await submit("agent-verified pass", id);
    await step("agent-verified pass: verdict", () => escrow.connect(stranger).completeVerification(id, true));

    // A fee that rounds to zero: paid in full, not rated.
    id = await open("zero fee", { amount: 9n });
    await submit("zero fee", id);
    await step("zero fee: verdict", () => escrow.connect(verifier).completeVerification(id, true));

    // completeVerificationWithTEE: paid, rated 5.
    const signature = await tee.signMessage(ATTESTATION);
    const signedText = ethers.hexlify(ethers.toUtf8Bytes(ATTESTATION));
    id = await open("tee pass");
    await submit("tee pass", id);
    await step("tee pass: verdict", () => escrow.connect(verifier).completeVerificationWithTEE(id, true, signature, signedText));

    // TEE fail, then the worker's appeal resolved for the worker: paid, rated 3.
    id = await open("dispute for worker");
    await submit("dispute for worker", id);
    await step("dispute for worker: fail", () => escrow.connect(verifier).completeVerificationWithTEE(id, false, signature, signedText));
    await step("dispute for worker: raise", () => escrow.connect(worker).raiseDispute(id));
    await step("dispute for worker: resolve", () => escrow.connect(admin).resolveDispute(id, true));

    // Dispute resolved for the poster: refunded, dispute recorded.
    id = await open("dispute for poster");
    await submit("dispute for poster", id);
    await step("dispute for poster: raise", () => escrow.connect(agent).raiseDispute(id));
    await step("dispute for poster: resolve", () => escrow.connect(admin).resolveDispute(id, false));

    // Delivered, never judged: escalated at the deadline, then released to the worker.
    id = await open("unjudged", { duration: HOUR });
    await submit("unjudged", id);
    clock += HOUR;
    await step("unjudged: escalate", () => escrow.connect(agent).claimTimeout(id));
    clock += 14 * DAY;
    await step("unjudged: release", () => escrow.connect(worker).releaseUnjudgedWork(id));

    // Native token: the worker and the treasury receive exactly the split.
    id = await open("native", { token: NATIVE, amount: ethers.parseEther("1") });
    await submit("native", id);
    await step("native: verdict", () => escrow.connect(verifier).completeVerification(id, true), [worker.address, treasury.address]);

    // Below the per-token rating floor: paid, not rated.
    await step("rating floor", () => escrow.connect(admin).setMinRatedAmount(t, AMOUNT * 2n));
    id = await open("below floor");
    await submit("below floor", id);
    await step("below floor: verdict", () => escrow.connect(verifier).completeVerification(id, true));

    // The fee is read at settlement: a change after creation applies.
    id = await open("fee change");
    await submit("fee change", id);
    await step("fee change: set", () => escrow.connect(admin).setFeeBps(2500));
    await step("fee change: verdict", () => escrow.connect(verifier).completeVerification(id, true));

    // Three failed attempts: Verified, dispute recorded; refunded after the appeal window.
    id = await open("three fails");
    for (let i = 1; i <= 3; i++) {
      await submit(`three fails ${i}`, id);
      await step(`three fails ${i}: verdict`, () => escrow.connect(verifier).completeVerification(id, false));
    }
    clock += DAY + 3 * DAY;
    await step("three fails: timeout", () => escrow.connect(agent).claimTimeout(id));

    // Refund paths.
    const funded = nextId++;
    await step("cancel: create", () => escrow.connect(agent).createTask(ethers.keccak256(ethers.toUtf8Bytes("cancel")), t, AMOUNT, "c", "z", DAY));
    await step("cancel", () => escrow.connect(agent).cancelTask(funded));
    id = await open("ghosted", { duration: HOUR });
    clock += HOUR;
    await step("ghosted: timeout", () => escrow.connect(agent).claimTimeout(id));

    const holders = [agent, worker, verifier, treasury, stranger, admin].map((s) => s.address);
    return {
      trace,
      balances: await Promise.all([...holders, e].map((a) => token.balanceOf(a))),
      tasks: await Promise.all(Array.from({ length: Number(nextId) - 1 }, (_, i) => escrow.getTask(i + 1).then((r: unknown) => JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))))),
      reputation: (await reputation.getReputation(worker.address)).map(String),
    };
  }

  it("pays, rates and logs every settlement exactly as the deployed implementation", async function () {
    const snapshot = await ethers.provider.send("evm_snapshot", []);
    const deployed = await run("deployed");
    await ethers.provider.send("evm_revert", [snapshot]);
    const current = await run("current");

    // Not vacuous: the deployed run paid, rated and refunded.
    const iface = (await ethers.getContractFactory("BlindEscrow")).interface;
    const completed = deployed.trace.flatMap((s) =>
      s.logs.flatMap(([, topics, data]) => {
        const parsed = iface.parseLog({ topics, data });
        return parsed?.name === "TaskCompleted" ? [[s.label, parsed.args.workerPayout, parsed.args.platformFee]] : [];
      }),
    );
    expect(completed).to.deep.include(["platform pass: verdict", AMOUNT - AMOUNT / 10n, AMOUNT / 10n]);
    expect(completed).to.deep.include(["zero fee: verdict", 9n, 0n]);
    expect(completed).to.deep.include(["fee change: verdict", AMOUNT - AMOUNT / 4n, AMOUNT / 4n]);
    expect(completed).to.have.length(9);
    // Rated: platform pass (5), tee pass (5), dispute for worker (3), native (5). Two disputes recorded.
    expect(deployed.reputation).to.deep.equal(["4", "450", "2"]);
    const native = deployed.trace.find((s) => s.label === "native: verdict")!.native!;
    expect(native).to.deep.equal([ethers.parseEther("0.9"), ethers.parseEther("0.1")]);

    expect(current.trace.map((s) => s.label)).to.deep.equal(deployed.trace.map((s) => s.label));
    for (let i = 0; i < deployed.trace.length; i++) {
      expect(current.trace[i], deployed.trace[i].label).to.deep.equal(deployed.trace[i]);
    }
    expect(current.balances).to.deep.equal(deployed.balances);
    expect(current.tasks).to.deep.equal(deployed.tasks);
    expect(current.reputation).to.deep.equal(deployed.reputation);
  });
});

// The storage-layout side of this upgrade (OpenZeppelin's report against the
// manifests' deployed layout) is escrowLayout.test.ts; on the live proxies it
// is scripts/validate-escrow-upgrade.ts.
describe("Upgrading a proxy of the deployed implementation to the current BlindEscrow", function () {
  const AMOUNT = ethers.parseUnits("100", 6);
  const FEE = AMOUNT / 10n;
  const EVIDENCE = ethers.keccak256(ethers.toUtf8Bytes("evidence"));
  const HOUR = 3600;
  const DAY = 24 * HOUR;
  const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

  it("keeps every task, balance and setting, and every in-flight task finishes as it would have", async function () {
    const [admin, agent, worker, verifier, treasury, stranger, s1, s2] = await ethers.getSigners();
    const token: any = await (await ethers.getContractFactory("MockERC20")).deploy("Mock USDC", "MUSDC", 6);
    const t = await token.getAddress();
    await token.mint(agent.address, ethers.parseUnits("10000", 6));
    // An ERC1967 proxy of the deployed implementation, initialized as deploy-base.ts does.
    const Deployed = await deployedFactory();
    const v1 = await Deployed.deploy();
    await v1.waitForDeployment();
    const init = Deployed.interface.encodeFunctionData("initialize", [treasury.address, verifier.address]);
    const erc1967 = await new ethers.ContractFactory(PROXY.abi as never, PROXY.bytecode, admin).deploy(await v1.getAddress(), init);
    await erc1967.waitForDeployment();
    const e = await erc1967.getAddress();
    const proxy: any = Deployed.attach(e);
    await proxy.connect(admin).allowToken(t);
    await proxy.connect(admin).setMinRatedAmount(t, 5n);
    await proxy.connect(admin).setTeeSigner(stranger.address);
    await token.connect(agent).approve(e, ethers.MaxUint256);
    // A completed pause, so pausedTotal is non-zero.
    await proxy.connect(admin).pause();
    await time.increase(HOUR);
    await proxy.connect(admin).unpause();

    const create = async (perTaskVerifier?: string, duration = DAY) => {
      const hash = ethers.keccak256(ethers.toUtf8Bytes(`task ${await proxy.nextTaskId()}`));
      if (perTaskVerifier) await proxy.connect(agent).createTaskWithVerifier(hash, t, AMOUNT, "c", "z", duration, perTaskVerifier);
      else await proxy.connect(agent).createTask(hash, t, AMOUNT, "c", "z", duration);
      return (await proxy.nextTaskId()) - 1n;
    };
    // One task in every state the deployed code can leave one in.
    const funded = await create();
    const assigned = await create();
    await proxy.connect(verifier).marketplaceAssign(assigned, worker.address);
    const submitted = await create(s1.address);
    await proxy.connect(agent).assignWorker(submitted, worker.address);
    await proxy.connect(worker).submitEvidence(submitted, EVIDENCE);
    const failed = await create();
    await proxy.connect(verifier).marketplaceAssign(failed, worker.address);
    await proxy.connect(worker).submitEvidence(failed, EVIDENCE);
    await proxy.connect(verifier).completeVerification(failed, false);
    const disputed = await create();
    await proxy.connect(verifier).marketplaceAssign(disputed, worker.address);
    await proxy.connect(worker).submitEvidence(disputed, EVIDENCE);
    await proxy.connect(agent).raiseDispute(disputed);
    const escalated = await create(undefined, HOUR);
    await proxy.connect(verifier).marketplaceAssign(escalated, worker.address);
    await proxy.connect(worker).submitEvidence(escalated, EVIDENCE);
    await time.increase(HOUR);
    await proxy.connect(agent).claimTimeout(escalated);
    const completed = await create();
    await proxy.connect(verifier).marketplaceAssign(completed, worker.address);
    await proxy.connect(worker).submitEvidence(completed, EVIDENCE);
    await proxy.connect(verifier).completeVerification(completed, true);
    const cancelled = await create();
    await proxy.connect(agent).cancelTask(cancelled);
    const ids = [funded, assigned, submitted, failed, disputed, escalated, completed, cancelled];

    const plain = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
    const snapshotState = async (c: any) => ({
      settings: plain(
        await Promise.all([
          c.admin(), c.pendingAdmin(), c.treasury(), c.verifier(), c.feeBps(), c.allowedTokens(t), c.reputationContract(),
          c.taskRegistry(), c.teeSigner(), c.pausedTotal(), c.pausedSince(), c.minRatedAmount(t), c.nextTaskId(), c.paused(),
        ]),
      ),
      tasks: plain(
        await Promise.all(
          ids.map(async (id) => [
            await c.getTask(id), await c.taskVerifier(id), await c.failedVerdictAt(id), await c.unjudgedEscalation(id), await c.effectiveDeadline(id),
          ]),
        ),
      ),
      balance: String(await token.balanceOf(e)),
    });
    const before = await snapshotState(proxy);
    const implBefore = await ethers.provider.getStorage(e, IMPLEMENTATION_SLOT);
    expect(before.balance).to.equal(String(6n * AMOUNT)); // funded, assigned, submitted, failed, disputed, escalated

    // The upgrade itself, as the admin sends it: deploy the implementation, then upgradeToAndCall with no call.
    const Current = await ethers.getContractFactory("BlindEscrow");
    const v2 = await Current.deploy();
    await v2.waitForDeployment();
    await expect(proxy.connect(stranger).upgradeToAndCall(await v2.getAddress(), "0x")).to.be.revertedWithCustomError(proxy, "NotAdmin");
    await proxy.connect(admin).upgradeToAndCall(await v2.getAddress(), "0x");
    const upgraded: any = Current.attach(e);
    expect(await ethers.provider.getStorage(e, IMPLEMENTATION_SLOT)).to.not.equal(implBefore);
    expect(ethers.getAddress("0x" + (await ethers.provider.getStorage(e, IMPLEMENTATION_SLOT)).slice(-40))).to.equal(await v2.getAddress());
    expect(await snapshotState(upgraded)).to.deep.equal(before);
    for (const id of ids) {
      expect((await upgraded.getOpenTask(id)).open).to.equal(false);
      expect(await upgraded.submissionCount(id)).to.equal(0);
    }

    // Every in-flight task carries on under the new code.
    const paid = async (send: () => Promise<unknown>, to: string, amount: bigint) => {
      const b = await token.balanceOf(to);
      await send();
      expect(await token.balanceOf(to)).to.equal(b + amount);
    };
    await paid(() => upgraded.connect(agent).cancelTask(funded), agent.address, AMOUNT);
    await upgraded.connect(worker).submitEvidence(assigned, EVIDENCE);
    await paid(() => upgraded.connect(verifier).completeVerification(assigned, true), worker.address, AMOUNT - FEE);
    await paid(() => upgraded.connect(s1).completeVerification(submitted, true), worker.address, AMOUNT - FEE);
    await upgraded.connect(worker).submitEvidence(failed, EVIDENCE); // a retry after the failed verdict
    expect((await upgraded.getTask(failed)).submissionAttempts).to.equal(2);
    await paid(() => upgraded.connect(verifier).completeVerification(failed, true), worker.address, AMOUNT - FEE);
    await paid(() => upgraded.connect(admin).resolveDispute(disputed, true), worker.address, AMOUNT - FEE);
    await expect(upgraded.connect(worker).releaseUnjudgedWork(escalated)).to.be.revertedWithCustomError(upgraded, "DisputeWindowActive");
    await time.increase(14 * DAY);
    await paid(() => upgraded.connect(worker).releaseUnjudgedWork(escalated), worker.address, AMOUNT - FEE);
    expect(await token.balanceOf(e)).to.equal(0);
    expect(await token.balanceOf(treasury.address)).to.equal(6n * FEE); // completed before the upgrade, five after

    // And the new code's features work on the upgraded proxy.
    await upgraded.connect(agent).createTaskOpen(ethers.id("open"), t, AMOUNT, "c", "z", DAY, stranger.address, 0, 0);
    const open = (await upgraded.nextTaskId()) - 1n;
    await upgraded.connect(s1).submitOpen(open, EVIDENCE);
    await upgraded.connect(s2).submitOpen(open, ethers.id("other"));
    await expect(upgraded.connect(agent).cancelTask(open)).to.be.revertedWithCustomError(upgraded, "HasSubmissions");
    await time.increaseTo(await upgraded.effectiveDeadline(open));
    await paid(() => upgraded.connect(stranger).selectWinnerByVerifier(open, s2.address, ethers.id("scorecard")), s2.address, AMOUNT - FEE);
    await upgraded.connect(agent).createTasks(t, [
      { taskHash: ethers.id("batch 1"), amount: AMOUNT, category: "c", locationZone: "z", duration: DAY, verifierAgent: ethers.ZeroAddress },
      { taskHash: ethers.id("batch 2"), amount: AMOUNT, category: "c", locationZone: "z", duration: DAY, verifierAgent: stranger.address },
    ]);
    expect(await token.balanceOf(e)).to.equal(2n * AMOUNT);
  });
});
