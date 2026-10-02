import { expect } from "chai";
import hre from "hardhat";
import { upgrades as createUpgrades } from "@openzeppelin/hardhat-upgrades";
import type { Authorization, HDNodeWallet, TransactionReceipt } from "ethers";
import type { BlindAgentDelegate, BlindEscrow, MockERC20 } from "../types/ethers-contracts/index.js";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

/**
 * BlindAgentDelegate end to end: EIP-7702 type-4 transactions on the
 * in-process chain pinned to Prague (the `prague` network in
 * hardhat.config.ts), against the real BlindEscrow set up as on Arc (escrow
 * plus one allowlisted 6-decimal USDC, no registry or reputation).
 *
 * The agent is always a fresh key that never holds gas. A separate sponsor
 * account sends every transaction and pays for it, as the relayer will.
 *
 * Its own connection, not lib/hh.ts: that one is the `default` network (the
 * latest hardfork), and the OpenZeppelin upgrades plugin needs its deploys on
 * the connection it was created with.
 */
const connection = await hre.network.create("prague");
const { ethers, networkHelpers } = connection;
const upgrades = await createUpgrades(hre, connection);
const time = networkHelpers.time;

const Kind = { SubmitEvidence: 0, ReleaseUnjudgedWork: 1 } as const;

/** The EIP-712 type the wallet signs. `escrow` is not in the calldata: the
 *  delegate fills it from its immutable ESCROW. */
const CALL_TYPES = {
  Call: [
    { name: "kind", type: "uint8" },
    { name: "escrow", type: "address" },
    { name: "taskId", type: "uint256" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
const CALL_TYPE_STRING =
  "Call(uint8 kind,address escrow,uint256 taskId,bytes32 evidenceHash,uint256 nonce,uint256 deadline)";

/** ERC-7201: keccak256(abi.encode(uint256(keccak256(id)) - 1)) & ~0xff. */
function erc7201Slot(id: string): string {
  const inner = BigInt(ethers.keccak256(ethers.toUtf8Bytes(id))) - 1n;
  const outer = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [inner])));
  return ethers.toBeHex(outer & ~0xffn, 32);
}
const NONCE_SLOT = erc7201Slot("blindmarket.storage.AgentDelegate");

const ERC1271_MAGIC = "0x1626ba7e";
const ERC1271_INVALID = "0xffffffff";

/** Gas figures the tests collect; the gas report prints them. */
const gas: Record<string, { estimate: bigint; used: bigint }> = {};

interface Call {
  kind: number;
  taskId: bigint;
  evidenceHash: string;
  nonce: bigint;
  deadline: bigint;
}

describe("BlindAgentDelegate (EIP-7702, Prague)", function () {
  let escrow: BlindEscrow;
  let usdc: MockERC20;
  let delegate: BlindAgentDelegate;
  let admin: HardhatEthersSigner;
  let poster: HardhatEthersSigner;
  let verifier: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let sponsor: HardhatEthersSigner;
  let funder: HardhatEthersSigner;
  let agent: HDNodeWallet;
  let chainId: bigint;
  let escrowAddr: string;
  let delegateAddr: string;

  const AMOUNT = ethers.parseUnits("1", 6); // 1 USDC
  const PAYOUT = AMOUNT - (AMOUNT * 1000n) / 10_000n; // 90% at the default feeBps
  const ONE_HOUR = 3600;
  const ONE_WEEK = 7 * 86400;
  const TASK_HASH = ethers.keccak256(ethers.toUtf8Bytes("encrypted-task-blob"));
  const EVIDENCE = ethers.keccak256(ethers.toUtf8Bytes("encrypted-evidence"));

  async function deployEscrow(): Promise<BlindEscrow> {
    const Escrow = await ethers.getContractFactory("BlindEscrow");
    const e = (await upgrades.deployProxy(Escrow, [treasury.address, verifier.address], {
      kind: "uups",
    })) as unknown as BlindEscrow;
    await e.connect(admin).allowToken(await usdc.getAddress());
    await usdc.connect(poster).approve(await e.getAddress(), ethers.MaxUint256);
    return e;
  }

  async function deployDelegate(forEscrow: string): Promise<BlindAgentDelegate> {
    const Delegate = await ethers.getContractFactory("BlindAgentDelegate");
    const d = (await Delegate.deploy(forEscrow)) as unknown as BlindAgentDelegate;
    await d.waitForDeployment();
    return d;
  }

  /** A fresh key with no balance, connected to the Prague chain. */
  const freshWallet = () => ethers.Wallet.createRandom().connect(ethers.provider);

  /** The poster funds a task on `on`; the platform verifier assigns `worker`. */
  async function postAndAssign(worker: string, on: BlindEscrow = escrow, duration = ONE_WEEK): Promise<bigint> {
    const taskId = await on.nextTaskId();
    await on.connect(poster).createTask(TASK_HASH, await usdc.getAddress(), AMOUNT, "test", "global", duration);
    await on.connect(verifier).marketplaceAssign(taskId, worker);
    return taskId;
  }

  /** The delegate's ABI at a wallet's address. */
  const walletAt = (address: string) => delegate.attach(address) as unknown as BlindAgentDelegate;

  async function deadlineIn(seconds = ONE_HOUR): Promise<bigint> {
    return BigInt((await time.latest()) + seconds);
  }

  async function submitCall(taskId: bigint, nonce = 0n, evidenceHash = EVIDENCE): Promise<Call> {
    return { kind: Kind.SubmitEvidence, taskId, evidenceHash, nonce, deadline: await deadlineIn() };
  }

  async function releaseCall(taskId: bigint, nonce: bigint): Promise<Call> {
    return { kind: Kind.ReleaseUnjudgedWork, taskId, evidenceHash: ethers.ZeroHash, nonce, deadline: await deadlineIn() };
  }

  /** EIP-712 signature over `call`, by default in the wallet's own domain on this chain for `escrow`. */
  async function sign(
    signer: Pick<HDNodeWallet, "address" | "signTypedData">,
    call: Call,
    opts: { wallet?: string; chainId?: bigint; escrow?: string } = {},
  ): Promise<string> {
    const domain = {
      name: "BlindAgentDelegate",
      version: "1",
      chainId: opts.chainId ?? chainId,
      verifyingContract: opts.wallet ?? signer.address,
    };
    return signer.signTypedData(domain, CALL_TYPES, { ...call, escrow: opts.escrow ?? escrowAddr });
  }

  /** The agent's 7702 authorization to `target`, with its current nonce, pinned to this chain. */
  async function authorize(wallet: HDNodeWallet, target: string = delegateAddr, nonceOffset = 0): Promise<Authorization> {
    const nonce = (await ethers.provider.getTransactionCount(wallet.address, "pending")) + nonceOffset;
    return wallet.authorize({ address: target, nonce, chainId });
  }

  /** The sponsor sends execute() to the wallet, with `auth` riding along when given. */
  async function sponsored(wallet: string, call: Call, signature: string, auth?: Authorization) {
    return walletAt(wallet).connect(sponsor).execute(call, signature, auth ? { authorizationList: [auth] } : {});
  }

  async function receiptOf(tx: { wait(): Promise<TransactionReceipt | null> }): Promise<TransactionReceipt> {
    const r = await tx.wait();
    if (!r) throw new Error("no receipt");
    return r;
  }

  const designator = (target: string) => "0xef0100" + target.slice(2).toLowerCase();

  beforeEach(async function () {
    [admin, poster, verifier, treasury, sponsor, funder] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;

    const Token = await ethers.getContractFactory("MockERC20");
    usdc = (await Token.deploy("USD Coin", "USDC", 6)) as unknown as MockERC20;
    await usdc.mint(poster.address, ethers.parseUnits("1000", 6));

    escrow = await deployEscrow();
    escrowAddr = await escrow.getAddress();
    delegate = await deployDelegate(escrowAddr);
    delegateAddr = await delegate.getAddress();

    agent = freshWallet();
  });

  it("runs on Prague", async function () {
    expect(connection.networkConfig.type === "edr-simulated" && connection.networkConfig.hardfork).to.equal("prague");
  });

  describe("constructor", function () {
    it("stores the escrow", async function () {
      expect(await delegate.ESCROW()).to.equal(escrowAddr);
    });

    it("rejects the zero address", async function () {
      const Delegate = await ethers.getContractFactory("BlindAgentDelegate");
      await expect(Delegate.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(delegate, "ZeroAddress");
    });

    it("publishes the type hash the relayer signs against", async function () {
      expect(await delegate.CALL_TYPEHASH()).to.equal(ethers.keccak256(ethers.toUtf8Bytes(CALL_TYPE_STRING)));
      expect(ethers.TypedDataEncoder.from(CALL_TYPES).encodeType("Call")).to.equal(CALL_TYPE_STRING);
    });
  });

  describe("sponsored submitEvidence", function () {
    it("submits as the agent in one type-4 transaction the sponsor pays for; the agent never holds gas", async function () {
      const taskId = await postAndAssign(agent.address);
      const call = await submitCall(taskId);
      const signature = await sign(agent, call);
      const auth = await authorize(agent);

      const agentBefore = await ethers.provider.getBalance(agent.address);
      const sponsorBefore = await ethers.provider.getBalance(sponsor.address);
      expect(agentBefore).to.equal(0n);
      expect(await ethers.provider.getCode(agent.address)).to.equal("0x");

      const tx = await sponsored(agent.address, call, signature, auth);
      const receipt = await receiptOf(tx);

      expect(receipt.type).to.equal(4);
      expect(receipt.from).to.equal(sponsor.address);
      expect(receipt.to).to.equal(agent.address);
      await expect(tx).to.emit(escrow, "EvidenceSubmitted").withArgs(taskId, agent.address, EVIDENCE, 1);
      await expect(tx).to.emit(walletAt(agent.address), "SponsoredCall").withArgs(Kind.SubmitEvidence, taskId, 0);

      const task = await escrow.getTask(taskId);
      expect(task.status).to.equal(2); // Submitted
      expect(task.evidenceHash).to.equal(EVIDENCE);
      expect(task.worker).to.equal(agent.address);

      expect(await ethers.provider.getBalance(agent.address)).to.equal(0n);
      expect(sponsorBefore - (await ethers.provider.getBalance(sponsor.address))).to.equal(receipt.fee);
      expect(receipt.fee).to.be.greaterThan(0n);

      expect(await ethers.provider.getCode(agent.address)).to.equal(designator(delegateAddr));
      expect(await walletAt(agent.address).nonce()).to.equal(1n);
    });

    it("works without an authorization once the wallet is delegated", async function () {
      const first = await postAndAssign(agent.address);
      const c1 = await submitCall(first, 0n);
      await sponsored(agent.address, c1, await sign(agent, c1), await authorize(agent));

      const second = await postAndAssign(agent.address);
      const c2 = await submitCall(second, 1n);
      const tx = await sponsored(agent.address, c2, await sign(agent, c2));
      const receipt = await receiptOf(tx);

      expect(receipt.type).to.equal(2);
      await expect(tx).to.emit(escrow, "EvidenceSubmitted").withArgs(second, agent.address, EVIDENCE, 1);
      expect((await escrow.getTask(second)).status).to.equal(2);
      expect(await walletAt(agent.address).nonce()).to.equal(2n);
      expect(await ethers.provider.getBalance(agent.address)).to.equal(0n);
    });

    it("binds the domain to the wallet when running as delegated code, not to the delegate contract", async function () {
      const taskId = await postAndAssign(agent.address);
      const c0 = await submitCall(taskId);
      await sponsored(agent.address, c0, await sign(agent, c0), await authorize(agent));

      // eip712Domain() reads address(this) and block.chainid live.
      const asWallet = await walletAt(agent.address).eip712Domain();
      expect(asWallet.name).to.equal("BlindAgentDelegate");
      expect(asWallet.version).to.equal("1");
      expect(asWallet.chainId).to.equal(chainId);
      expect(asWallet.verifyingContract).to.equal(agent.address);
      expect((await delegate.eip712Domain()).verifyingContract).to.equal(delegateAddr);

      // _domainSeparatorV4 is the wallet's: a signature over the delegate
      // contract's own (cached) domain is refused at the wallet.
      const next = await postAndAssign(agent.address);
      const c1 = await submitCall(next, 1n);
      const forDelegate = await sign(agent, c1, { wallet: delegateAddr });
      await expect(sponsored(agent.address, c1, forDelegate)).to.be.revertedWithCustomError(delegate, "InvalidSignature");

      // Calling the deployed contract itself is inert: no key signs for it.
      // (Its own storage holds nonce 0.)
      const direct = { ...c1, nonce: 0n };
      await expect(
        delegate.connect(sponsor).execute(direct, await sign(agent, direct, { wallet: delegateAddr })),
      ).to.be.revertedWithCustomError(delegate, "InvalidSignature");
    });
  });

  describe("refuses", function () {
    let taskId: bigint;

    /** The agent is delegated and assigned a fresh task; its nonce is 0. */
    beforeEach(async function () {
      taskId = await postAndAssign(agent.address);
      const setupTx = await sponsor.sendTransaction({ to: sponsor.address, authorizationList: [await authorize(agent)] });
      await setupTx.wait();
      expect(await ethers.provider.getCode(agent.address)).to.equal(designator(delegateAddr));
      expect(await walletAt(agent.address).nonce()).to.equal(0n);
    });

    it("a signature by another key (the sponsor's)", async function () {
      const call = await submitCall(taskId);
      const signature = await sign(sponsor, call, { wallet: agent.address });
      await expect(sponsored(agent.address, call, signature)).to.be.revertedWithCustomError(delegate, "InvalidSignature");
      expect(await walletAt(agent.address).nonce()).to.equal(0n);
    });

    it("a replayed nonce", async function () {
      const call = await submitCall(taskId);
      const signature = await sign(agent, call);
      await sponsored(agent.address, call, signature);
      await expect(sponsored(agent.address, call, signature))
        .to.be.revertedWithCustomError(delegate, "InvalidNonce")
        .withArgs(1);
      expect(await walletAt(agent.address).nonce()).to.equal(1n);
    });

    it("a nonce from the future", async function () {
      const call = await submitCall(taskId, 1n);
      await expect(sponsored(agent.address, call, await sign(agent, call)))
        .to.be.revertedWithCustomError(delegate, "InvalidNonce")
        .withArgs(0);
    });

    it("an expired deadline", async function () {
      const call = await submitCall(taskId);
      const signature = await sign(agent, call);
      await time.increaseTo(call.deadline + 1n);
      await expect(sponsored(agent.address, call, signature)).to.be.revertedWithCustomError(delegate, "Expired");
      expect(await walletAt(agent.address).nonce()).to.equal(0n);
    });

    it("a signature for another chain id", async function () {
      const call = await submitCall(taskId);
      for (const other of [5042n, 5042002n]) {
        const signature = await sign(agent, call, { chainId: other });
        await expect(sponsored(agent.address, call, signature)).to.be.revertedWithCustomError(delegate, "InvalidSignature");
      }
    });

    it("a signature for another wallet", async function () {
      const other = freshWallet();
      const call = await submitCall(taskId);
      // The agent's own key, signing in another wallet's domain.
      await expect(sponsored(agent.address, call, await sign(agent, call, { wallet: other.address })))
        .to.be.revertedWithCustomError(delegate, "InvalidSignature");
      // Another wallet's valid signature for itself, replayed at the agent.
      await expect(sponsored(agent.address, call, await sign(other, call)))
        .to.be.revertedWithCustomError(delegate, "InvalidSignature");
    });

    it("a signature for another escrow, including after the wallet is re-pointed to its delegate", async function () {
      const call = await submitCall(taskId);
      const other = await deployEscrow();
      const otherAddr = await other.getAddress();
      await expect(sponsored(agent.address, call, await sign(agent, call, { escrow: otherAddr })))
        .to.be.revertedWithCustomError(delegate, "InvalidSignature");

      // Re-point the wallet to a delegate bound to the other escrow. Storage
      // is the EOA's, so the nonce carries over, and a call signed for the
      // first escrow does not run against the second.
      const used = await submitCall(taskId, 0n);
      await sponsored(agent.address, used, await sign(agent, used));
      const otherDelegate = await deployDelegate(otherAddr);
      const otherDelegateAddr = await otherDelegate.getAddress();
      await (await sponsor.sendTransaction({ to: sponsor.address, authorizationList: [await authorize(agent, otherDelegateAddr)] })).wait();
      expect(await ethers.provider.getCode(agent.address)).to.equal(designator(otherDelegateAddr));
      expect(await walletAt(agent.address).nonce()).to.equal(1n);

      const otherTask = await postAndAssign(agent.address, other);
      const forFirst = await submitCall(otherTask, 1n);
      await expect(sponsored(agent.address, forFirst, await sign(agent, forFirst)))
        .to.be.revertedWithCustomError(delegate, "InvalidSignature");
      // Signed for the escrow it is now bound to, the same call goes through.
      const tx = await sponsored(agent.address, forFirst, await sign(agent, forFirst, { escrow: otherAddr }));
      await expect(tx).to.emit(other, "EvidenceSubmitted").withArgs(otherTask, agent.address, EVIDENCE, 1);
    });

    it("an unknown kind", async function () {
      const call = { ...(await submitCall(taskId)), kind: 2 };
      // Validly signed, so only the enum check can stop it: the ABI decoder
      // rejects an out-of-range enum before any code runs.
      await expect(sponsored(agent.address, call, await sign(agent, call))).to.be.revertedWithoutReason(ethers);
      expect(await walletAt(agent.address).nonce()).to.equal(0n);
      expect((await escrow.getTask(taskId)).status).to.equal(1);
    });

    it("value sent to execute", async function () {
      const call = await submitCall(taskId);
      const data = delegate.interface.encodeFunctionData("execute", [call, await sign(agent, call)]);
      await expect(sponsor.sendTransaction({ to: agent.address, data, value: 1n })).to.be.revertedWithoutReason(ethers);
      expect(await ethers.provider.getBalance(agent.address)).to.equal(0n);
      expect(await walletAt(agent.address).nonce()).to.equal(0n);
    });

    it("a release that carries an evidence hash", async function () {
      const call = { ...(await releaseCall(taskId, 0n)), evidenceHash: EVIDENCE };
      await expect(sponsored(agent.address, call, await sign(agent, call)))
        .to.be.revertedWithCustomError(delegate, "UnexpectedEvidenceHash");
    });

    it("bubbles up an escrow revert with its original error: the wallet is not the worker", async function () {
      const someoneElses = await postAndAssign(freshWallet().address);
      const call = await submitCall(someoneElses);
      await expect(sponsored(agent.address, call, await sign(agent, call))).to.be.revertedWithCustomError(escrow, "NotWorker");
      expect(await walletAt(agent.address).nonce()).to.equal(0n);
    });

    it("bubbles up an escrow revert with its arguments: submitting twice", async function () {
      const c0 = await submitCall(taskId, 0n);
      await sponsored(agent.address, c0, await sign(agent, c0));
      const c1 = await submitCall(taskId, 1n);
      await expect(sponsored(agent.address, c1, await sign(agent, c1)))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(2, 1);
      expect(await walletAt(agent.address).nonce()).to.equal(1n);
    });
  });

  describe("a stale authorization", function () {
    it("is skipped silently: status 1, no events, no code, nothing submitted", async function () {
      const taskId = await postAndAssign(agent.address);
      const call = await submitCall(taskId);
      const stale = await authorize(agent, delegateAddr, 1); // wrong authority nonce
      const receipt = await receiptOf(await sponsored(agent.address, call, await sign(agent, call), stale));

      expect(receipt.status).to.equal(1);
      expect(receipt.logs).to.have.length(0);
      expect(await ethers.provider.getCode(agent.address)).to.equal("0x");
      expect((await escrow.getTask(taskId)).status).to.equal(1); // still Assigned
    });
  });

  describe("sponsored releaseUnjudgedWork", function () {
    it("pays the worker once the escrow's window has passed, and bubbles the window error before it", async function () {
      const taskId = await postAndAssign(agent.address, escrow, ONE_HOUR);
      const submit = await submitCall(taskId, 0n);
      await sponsored(agent.address, submit, await sign(agent, submit), await authorize(agent));

      // Never judged: past the deadline the poster escalates it rather than
      // being refunded (claimTimeout on a Submitted task).
      await time.increase(ONE_HOUR + 1);
      await escrow.connect(poster).claimTimeout(taskId);
      expect((await escrow.getTask(taskId)).status).to.equal(6); // Disputed
      expect(await escrow.unjudgedEscalation(taskId)).to.equal(true);

      const early = await releaseCall(taskId, 1n);
      await expect(sponsored(agent.address, early, await sign(agent, early)))
        .to.be.revertedWithCustomError(escrow, "DisputeWindowActive");

      await time.increase(Number(await escrow.DISPUTE_WINDOW()));
      const release = await releaseCall(taskId, 1n);
      const tx = await sponsored(agent.address, release, await sign(agent, release));
      await expect(tx).to.emit(escrow, "UnjudgedWorkReleased").withArgs(taskId, PAYOUT, AMOUNT - PAYOUT);
      await expect(tx).to.emit(walletAt(agent.address), "SponsoredCall").withArgs(Kind.ReleaseUnjudgedWork, taskId, 1);

      expect((await escrow.getTask(taskId)).status).to.equal(4); // Completed
      expect(await usdc.balanceOf(agent.address)).to.equal(PAYOUT);
      expect(await ethers.provider.getBalance(agent.address)).to.equal(0n);
    });
  });

  describe("payouts into a delegated wallet", function () {
    beforeEach(async function () {
      const taskId = await postAndAssign(agent.address);
      const call = await submitCall(taskId);
      await sponsored(agent.address, call, await sign(agent, call), await authorize(agent));
      expect(await ethers.provider.getCode(agent.address)).to.equal(designator(delegateAddr));
    });

    it("receives the ERC-20 settlement after a pass", async function () {
      await expect(escrow.connect(verifier).completeVerification(1n, true))
        .to.emit(escrow, "TaskCompleted")
        .withArgs(1n, PAYOUT, AMOUNT - PAYOUT);
      expect(await usdc.balanceOf(agent.address)).to.equal(PAYOUT);
    });

    it("receives a plain native transfer sized by gas estimation, which a 21,000 gas limit no longer covers", async function () {
      const value = ethers.parseEther("0.01");
      const estimate = await ethers.provider.estimateGas({ from: funder.address, to: agent.address, value });
      expect(estimate).to.be.greaterThan(21_000n);

      const receipt = await receiptOf(await funder.sendTransaction({ to: agent.address, value, gasLimit: estimate }));
      expect(receipt.status).to.equal(1);
      expect(await ethers.provider.getBalance(agent.address)).to.equal(value);
      gas["plain native transfer into a delegated wallet"] = { estimate, used: receipt.gasUsed };

      // receive() runs now, so a sender hard-coding 21,000 bounces, where a
      // plain EOA still takes it.
      await expect(funder.sendTransaction({ to: agent.address, value, gasLimit: 21_000n })).to.revert(ethers);
      expect(await ethers.provider.getBalance(agent.address)).to.equal(value);
      const plain = freshWallet().address;
      await (await funder.sendTransaction({ to: plain, value, gasLimit: 21_000n })).wait();
      expect(await ethers.provider.getBalance(plain)).to.equal(value);
    });
  });

  describe("ERC-1271", function () {
    beforeEach(async function () {
      await (await sponsor.sendTransaction({ to: sponsor.address, authorizationList: [await authorize(agent)] })).wait();
    });

    it("accepts the wallet's own signature and refuses anything else", async function () {
      const wallet = walletAt(agent.address);
      const hash = ethers.keccak256(ethers.toUtf8Bytes("any digest"));
      const own = agent.signingKey.sign(hash).serialized;
      expect(await wallet.isValidSignature(hash, own)).to.equal(ERC1271_MAGIC);

      // An EIP-191 message, as a third party's signature check would hash it.
      const message = "Sign in to BlindMarket";
      expect(await wallet.isValidSignature(ethers.hashMessage(message), await agent.signMessage(message))).to.equal(ERC1271_MAGIC);

      expect(await wallet.isValidSignature(hash, freshWallet().signingKey.sign(hash).serialized)).to.equal(ERC1271_INVALID);
      expect(await wallet.isValidSignature(ethers.keccak256("0x01"), own)).to.equal(ERC1271_INVALID);
      expect(await wallet.isValidSignature(hash, "0x")).to.equal(ERC1271_INVALID);
      expect(await wallet.isValidSignature(hash, "0x1234")).to.equal(ERC1271_INVALID);
      // The deployed contract has no key.
      expect(await delegate.isValidSignature(hash, own)).to.equal(ERC1271_INVALID);
    });
  });

  describe("storage", function () {
    it("keeps the nonce in its ERC-7201 slot and writes nothing else", async function () {
      expect(NONCE_SLOT).to.equal("0x2cb27ebb7a362eb42f6c76e9e3e85fc880d054822147695d5abee89e7aef5f00");
      for (let i = 0n; i < 2n; i++) {
        const taskId = await postAndAssign(agent.address);
        const call = await submitCall(taskId, i);
        await sponsored(agent.address, call, await sign(agent, call), i === 0n ? await authorize(agent) : undefined);
      }
      expect(await walletAt(agent.address).nonce()).to.equal(2n);
      expect(BigInt(await networkHelpers.getStorageAt(agent.address, NONCE_SLOT))).to.equal(2n);
      // Slots 0 and 1 are OZ EIP712's ShortStrings fallback; a short name never uses them.
      expect(BigInt(await networkHelpers.getStorageAt(agent.address, 0))).to.equal(0n);
      expect(BigInt(await networkHelpers.getStorageAt(agent.address, 1))).to.equal(0n);
    });

    it("ignores whatever else the wallet's storage holds", async function () {
      // Another delegate may have left data in the EOA's low slots.
      const junk = ethers.toBeHex(ethers.MaxUint256, 32);
      await networkHelpers.setStorageAt(agent.address, 0, junk);
      await networkHelpers.setStorageAt(agent.address, 1, junk);

      const taskId = await postAndAssign(agent.address);
      const call = await submitCall(taskId);
      await sponsored(agent.address, call, await sign(agent, call), await authorize(agent));
      expect((await escrow.getTask(taskId)).status).to.equal(2);
      expect((await walletAt(agent.address).eip712Domain()).name).to.equal("BlindAgentDelegate");
      expect(await networkHelpers.getStorageAt(agent.address, 0)).to.equal(junk);
    });
  });

  // ── Gas report ──
  // Printed, not asserted: the relayer's gas ceiling is set from these.

  describe("gas report", function () {
    async function measure(label: string, wallet: string, call: Call, signature: string, auth?: Authorization) {
      const data = delegate.interface.encodeFunctionData("execute", [call, signature]);
      const estimate = await ethers.provider.estimateGas({
        from: sponsor.address,
        to: wallet,
        data,
        ...(auth ? { authorizationList: [auth] } : {}),
      });
      const receipt = await receiptOf(await sponsored(wallet, call, signature, auth));
      expect(receipt.status).to.equal(1);
      gas[label] = { estimate, used: receipt.gasUsed };
    }

    it("measures the sponsored calls", async function () {
      // A worker paying its own gas, for comparison: plain submitEvidence.
      const direct = await ethers.getSigners().then((s) => s[6]);
      const plainTask = await postAndAssign(direct.address);
      const plainData = escrow.interface.encodeFunctionData("submitEvidence", [plainTask, EVIDENCE]);
      const plainEstimate = await ethers.provider.estimateGas({ from: direct.address, to: escrowAddr, data: plainData });
      const plain = await receiptOf(await escrow.connect(direct).submitEvidence(plainTask, EVIDENCE));
      gas["direct submitEvidence (no delegate, for comparison)"] = { estimate: plainEstimate, used: plain.gasUsed };

      const first = await postAndAssign(agent.address, escrow, ONE_HOUR);
      const c0 = await submitCall(first, 0n);
      await measure("first sponsored submitEvidence, with the authorization", agent.address, c0, await sign(agent, c0), await authorize(agent));

      const later = await postAndAssign(agent.address);
      const c1 = await submitCall(later, 1n);
      await measure("later sponsored submitEvidence", agent.address, c1, await sign(agent, c1));

      await time.increase(ONE_HOUR + 1);
      await escrow.connect(poster).claimTimeout(first);
      await time.increase(Number(await escrow.DISPUTE_WINDOW()));
      const c2 = await releaseCall(first, 2n);
      await measure("sponsored releaseUnjudgedWork", agent.address, c2, await sign(agent, c2));
    });

    after(function () {
      const rows = Object.entries(gas).map(([label, g]) => ({ call: label, gasUsed: Number(g.used), eth_estimateGas: Number(g.estimate) }));
      console.log("\n    BlindAgentDelegate gas (Hardhat EDR, hardfork prague):");
      console.table(rows);
    });
  });
});
