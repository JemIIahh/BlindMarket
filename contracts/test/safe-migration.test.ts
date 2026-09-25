import { expect } from "chai";
import { ethers, upgrades } from "../lib/hh.js";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import { readRecord, recordPath, type DeploymentRecord } from "../scripts/_deployments.js";
import {
  migrationPlan,
  nextSteps,
  recordedAgentFactories,
  runSafeMigration,
  type ChainRecords,
} from "../scripts/_safe-migration.js";

/**
 * migrate-admin-to-safe.ts (security audit C39). The script read AgentFactory
 * only from the chain's main record, but deploy-agent-factory.ts records it in
 * the agent-factory-<record>.json companion, so Arc's factory was logged as
 * "SKIP" and left with the deployer EOA while the closing NEXT line still told
 * the operator to accept ownership of it. The per-contract logic now lives in
 * _safe-migration.ts; these tests run it against the committed records (pure)
 * and against real contracts on the in-process chain (nothing is broadcast
 * anywhere else).
 */

const ARC_TESTNET = 5042002;
const BASE_SEPOLIA = 84532;
const BASE_MAINNET = 8453;
const OG_MAINNET = 16661;
const ZERO = "0x0000000000000000000000000000000000000000";

const committed = (chainId: number): ChainRecords => ({
  main: readRecord(recordPath(chainId, "default")),
  agentFactory: readRecord(recordPath(chainId, "default", "agent-factory-")),
  aa: readRecord(recordPath(chainId, "default", "aa-")),
});

const rec = (contracts: Record<string, string>): DeploymentRecord => ({ network: "local", chainId: 31337, contracts });
const silent = () => {};

describe("Safe migration (scripts/_safe-migration, migrate-admin-to-safe.ts)", function () {
  describe("recordedAgentFactories", function () {
    it("finds Arc testnet's factory, which only the agent-factory- companion records", function () {
      const r = committed(ARC_TESTNET);
      expect(r.main!.contracts.AgentFactory).to.equal(undefined);
      expect(recordedAgentFactories(r.main, r.agentFactory)).to.deep.equal([
        "0x1E9Abb2F2e66b8Af35BED730500A94760E133a3B",
      ]);
    });

    it("counts Base Sepolia's mirrored factory once", function () {
      const r = committed(BASE_SEPOLIA);
      expect(recordedAgentFactories(r.main, r.agentFactory)).to.deep.equal([
        "0x6B50aB21fd0c1E33731db1e2847ea62c9dBf4FC9",
      ]);
    });

    it("ignores zero placeholders (base-mainnet.json) and missing records", function () {
      expect(recordedAgentFactories(readRecord(recordPath(BASE_MAINNET, "default")), null)).to.deep.equal([]);
      expect(recordedAgentFactories(null, null)).to.deep.equal([]);
      expect(recordedAgentFactories(rec({ AgentFactory: ZERO }), rec({ AgentFactory: ZERO }))).to.deep.equal([]);
    });

    it("returns both when the mirror and the companion disagree, case-insensitively deduped", function () {
      const a = "0x1111111111111111111111111111111111111111";
      const b = "0x2222222222222222222222222222222222222222";
      expect(recordedAgentFactories(rec({ AgentFactory: a }), rec({ AgentFactory: b }))).to.deep.equal([b, a]);
      expect(recordedAgentFactories(rec({ AgentFactory: a.toUpperCase().replace("0X", "0x") }), rec({ AgentFactory: a })))
        .to.have.length(1);
    });
  });

  describe("migrationPlan on the committed records", function () {
    it("includes Arc testnet's AgentFactory alongside its escrow", function () {
      const plan = migrationPlan(committed(ARC_TESTNET), { includeInft: false });
      expect(plan.targets.map((t) => `${t.name}:${t.kind}:${t.address}`)).to.deep.equal([
        "BlindEscrow:admin:0xaBf70843E0380F1e749d2b85C30dD6820Ff5C731",
        "AgentFactory:owner2step:0x1E9Abb2F2e66b8Af35BED730500A94760E133a3B",
      ]);
    });

    it("lists 0G mainnet's admin contracts, defers INFT unless included, and reports ValidatorPool", function () {
      const plan = migrationPlan(committed(OG_MAINNET), { includeInft: false });
      expect(plan.targets.map((t) => t.name)).to.deep.equal(["BlindEscrow", "BlindReputation", "TaskRegistry"]);
      expect(plan.deferred.map((t) => t.name)).to.deep.equal(["INFT"]);
      expect(plan.nonTransferable.map((t) => t.name)).to.deep.equal(["ValidatorPool"]);

      const withInft = migrationPlan(committed(OG_MAINNET), { includeInft: true });
      expect(withInft.targets.map((t) => t.name)).to.include("INFT");
      expect(withInft.deferred).to.deep.equal([]);
    });

    it("reports Base Sepolia's recorded USDCPaymaster (aa- companion) instead of skipping it", function () {
      const plan = migrationPlan(committed(BASE_SEPOLIA), { includeInft: false });
      expect(plan.targets.map((t) => t.name)).to.deep.equal(["BlindEscrow", "AgentFactory"]);
      expect(plan.nonTransferable.map((t) => `${t.name}:${t.address}`)).to.deep.equal([
        "USDCPaymaster:0xb71D820Be2a1637504ACd6B76276e4C74425D3fF",
      ]);
    });
  });

  describe("runSafeMigration on the local chain", function () {
    let deployer: HardhatEthersSigner;
    let safe: HardhatEthersSigner; // stands in for the Safe (an EOA here, so it can accept)
    let other: HardhatEthersSigner;
    let escrow: any;
    let factory: any;
    let records: ChainRecords;

    beforeEach(async function () {
      [deployer, safe, other] = await ethers.getSigners();
      const Token = await ethers.getContractFactory("MockERC20");
      const usdc = await Token.deploy("USD Coin", "USDC", 6);
      const Escrow = await ethers.getContractFactory("BlindEscrow");
      escrow = await upgrades.deployProxy(Escrow, [deployer.address, deployer.address], { kind: "uups" });
      const Factory = await ethers.getContractFactory("AgentFactory");
      factory = await Factory.deploy(await usdc.getAddress(), deployer.address, 1_000_000n);
      // Arc's layout: the main record holds only the escrow; the factory is in
      // the companion.
      records = {
        main: rec({ BlindEscrow: await escrow.getAddress(), USDC: await usdc.getAddress() }),
        agentFactory: rec({ AgentFactory: await factory.getAddress() }),
        aa: null,
      };
    });

    const run = () =>
      runSafeMigration({ signer: deployer, safe: safe.address, plan: migrationPlan(records, { includeInft: false }), log: silent });

    it("proposes the Safe on a factory recorded only in the companion, and says so in NEXT", async function () {
      const out = await run();

      expect(await escrow.pendingAdmin()).to.equal(safe.address);
      expect(await factory.pendingOwner()).to.equal(safe.address);
      expect(out.proposed.map((t) => t.name)).to.deep.equal(["BlindEscrow", "AgentFactory"]);
      expect(out.proposed.every((t) => typeof t.tx === "string")).to.be.true;

      const next = nextSteps(out, safe.address, "arc-testnet").join("\n");
      expect(next).to.contain(`acceptAdmin() on BlindEscrow ${await escrow.getAddress()}`);
      expect(next).to.contain(`acceptOwnership() on AgentFactory ${await factory.getAddress()}`);
      expect(next).to.not.contain("STILL NOT HELD");
    });

    it("sends nothing on a re-run while the proposals are pending, and still lists them", async function () {
      await run();
      const nonce = await ethers.provider.getTransactionCount(deployer.address);
      const out = await run();
      expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce);
      expect(out.proposed.map((t) => [t.name, t.tx])).to.deep.equal([["BlindEscrow", undefined], ["AgentFactory", undefined]]);
      expect(nextSteps(out, safe.address, "x").join("\n")).to.contain("acceptOwnership() on AgentFactory");
    });

    it("prints no accept step once the Safe holds everything", async function () {
      await run();
      await escrow.connect(safe).acceptAdmin();
      await factory.connect(safe).acceptOwnership();

      const out = await run();
      expect(out.proposed).to.deep.equal([]);
      expect(out.alreadySafe.map((t) => t.name)).to.deep.equal(["BlindEscrow", "AgentFactory"]);
      const next = nextSteps(out, safe.address, "x").join("\n");
      expect(next).to.contain("nothing is waiting for the Safe to accept");
      expect(next).to.not.contain("acceptAdmin()");
      expect(next).to.not.contain("acceptOwnership()");
    });

    it("names only what was proposed: an escrow already held by the Safe gets no accept line", async function () {
      await escrow.proposeAdmin(safe.address);
      await escrow.connect(safe).acceptAdmin();
      const next = nextSteps(await run(), safe.address, "x").join("\n");
      expect(next).to.not.contain("acceptAdmin()");
      expect(next).to.contain(`acceptOwnership() on AgentFactory ${await factory.getAddress()}`);
    });

    it("refuses, sending nothing, when a recorded contract is held by neither the signer nor the Safe", async function () {
      await factory.transferOwnership(other.address);
      await factory.connect(other).acceptOwnership();
      const nonce = await ethers.provider.getTransactionCount(deployer.address);

      let err: Error | undefined;
      try {
        await run();
      } catch (e) {
        err = e as Error;
      }
      expect(err, "expected the run to refuse").to.be.instanceOf(Error);
      expect(err!.message).to.match(/Refusing to migrate/);
      expect(err!.message).to.contain(`AgentFactory ${await factory.getAddress()}: owner is ${other.address}`);
      // Nothing was sent, not even the escrow's proposal.
      expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce);
      expect(await escrow.pendingAdmin()).to.equal(ZERO);
    });

    it("migrates every distinct recorded factory, mirror and companion alike", async function () {
      const Factory = await ethers.getContractFactory("AgentFactory");
      const second = await Factory.deploy(await factory.usdc(), deployer.address, 1_000_000n);
      records.main!.contracts.AgentFactory = await second.getAddress();

      const out = await run();
      expect(out.proposed.filter((t) => t.name === "AgentFactory")).to.have.length(2);
      expect(await factory.pendingOwner()).to.equal(safe.address);
      expect(await second.pendingOwner()).to.equal(safe.address);
    });

    it("reports contracts it cannot migrate as still held, and migrates a paymaster that can move", async function () {
      const Pool = await ethers.getContractFactory("ValidatorPool");
      const pool = await Pool.deploy(await factory.usdc());
      records.main!.contracts.ValidatorPool = await pool.getAddress();
      const Paymaster = await ethers.getContractFactory("USDCPaymaster");
      const paymaster = await Paymaster.deploy(other.address, await factory.usdc(), 3_000_000_000n);
      records.aa = rec({ USDCPaymaster: await paymaster.getAddress() });

      const out = await run();
      expect(out.nonTransferable.map((n) => `${n.name}:${n.holder}`)).to.deep.equal([`ValidatorPool:${deployer.address}`]);
      // The current USDCPaymaster source has two-step ownership, so it is proposed.
      expect(await paymaster.pendingOwner()).to.equal(safe.address);
      const next = nextSteps(out, safe.address, "x").join("\n");
      expect(next).to.contain("STILL NOT HELD BY THE SAFE");
      expect(next).to.contain(`ValidatorPool ${await pool.getAddress()}`);
      expect(next).to.contain(`acceptOwnership() on USDCPaymaster ${await paymaster.getAddress()}`);
    });

    it("reports a recorded paymaster without two-step ownership (the deployed ones) as still held", async function () {
      // Any contract with owner() and no pendingOwner() behaves like the
      // recorded paymasters, which predate ownership transfer.
      const Inft = await ethers.getContractFactory("INFT");
      const oldStyle = await Inft.deploy(other.address);
      records.aa = rec({ USDCPaymaster: await oldStyle.getAddress() });

      const out = await run();
      expect(out.nonTransferable.map((n) => `${n.name}:${n.address}:${n.holder}`)).to.deep.equal([
        `USDCPaymaster:${await oldStyle.getAddress()}:${deployer.address}`,
      ]);
      expect(nextSteps(out, safe.address, "x").join("\n")).to.contain(`USDCPaymaster ${await oldStyle.getAddress()}`);
    });
  });
});
