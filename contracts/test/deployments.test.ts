import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  assertExpectedEscrow,
  assertManifestDir,
  deployBlock,
  deploymentFileFor,
  DEPLOYMENTS_ROOT,
  loadDeployment,
  mergeRecord,
  preflightDeploy,
  readRecord,
  recordPath,
  resolveDeploymentSet,
  resolveEscrowTarget,
  SET_CHAINS,
  SHARED_CHAIN_IDS,
  writeDeployment,
  type DeploymentRecord,
} from "../scripts/_deployments";
import { assertGuardVarsNotFromDotenv, GUARD_VARS, STAGING_MANIFEST_DIR } from "../scripts/_manifest-dir";

/**
 * Deployment-set selector and the guards that keep staging ops off the
 * production escrow. Production and staging both use Base Sepolia (84532) and
 * 0G testnet (16602), so a chain id alone does not say which escrow a script
 * will touch.
 */

const BASE_SEPOLIA = 84532;
const OG_TESTNET = 16602;
const OG_MAINNET = 16661;
const BASE_MAINNET = 8453;
const CONTRACTS_ROOT = path.resolve(__dirname, "..");
/** The env hardhat.config.ts produces for a staging run. */
const STAGING = { DEPLOYMENT_SET: "staging", MANIFEST_DEFAULT_DIR: STAGING_MANIFEST_DIR };
const OTHER = "0x1111111111111111111111111111111111111111";
const ZERO = "0x0000000000000000000000000000000000000000";

const defaultEscrow = (chainId: number): string => readRecord(recordPath(chainId, "default"))!.contracts.BlindEscrow;
const PROD_BASE_ESCROW = defaultEscrow(BASE_SEPOLIA);
const PROD_OG_MAINNET_ESCROW = defaultEscrow(OG_MAINNET);

/** Run fn with console.log silenced (the resolvers print their target). */
async function quiet<T>(fn: () => T | Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

async function rejects(fn: () => unknown, match: RegExp): Promise<void> {
  let err: unknown;
  try {
    await quiet(fn);
  } catch (e) {
    err = e;
  }
  expect(err, `expected an error matching ${match}`).to.be.instanceOf(Error);
  expect((err as Error).message).to.match(match);
}

describe("deployment sets (scripts/_deployments)", function () {
  describe("resolveDeploymentSet", function () {
    it("defaults when DEPLOYMENT_SET is unset, empty or 'default'", function () {
      expect(resolveDeploymentSet({})).to.equal("default");
      expect(resolveDeploymentSet({ DEPLOYMENT_SET: "" })).to.equal("default");
      expect(resolveDeploymentSet({ DEPLOYMENT_SET: "default" })).to.equal("default");
    });

    it("selects staging", function () {
      expect(resolveDeploymentSet({ DEPLOYMENT_SET: "staging" })).to.equal("staging");
      expect(resolveDeploymentSet({ DEPLOYMENT_SET: " staging " })).to.equal("staging");
    });

    it("refuses anything else rather than guessing", function () {
      expect(() => resolveDeploymentSet({ DEPLOYMENT_SET: "Staging" })).to.throw(/Unknown DEPLOYMENT_SET/);
      expect(() => resolveDeploymentSet({ DEPLOYMENT_SET: "prod" })).to.throw(/Unknown DEPLOYMENT_SET/);
    });
  });

  describe("recordPath", function () {
    it("keeps default records where they are and staging ones in staging/", function () {
      expect(recordPath(BASE_SEPOLIA, "default")).to.equal(path.join(DEPLOYMENTS_ROOT, "base-sepolia.json"));
      expect(recordPath(BASE_SEPOLIA, "staging")).to.equal(path.join(DEPLOYMENTS_ROOT, "staging", "base-sepolia.json"));
      expect(recordPath(BASE_SEPOLIA, "staging", "aa-")).to.equal(path.join(DEPLOYMENTS_ROOT, "staging", "aa-base-sepolia.json"));
      expect(recordPath(OG_TESTNET, "staging")).to.equal(path.join(DEPLOYMENTS_ROOT, "staging", "0g-testnet.json"));
    });

    it("throws for a chain with no record mapping", function () {
      expect(() => deploymentFileFor(1)).to.throw(/Unknown chainId 1/);
      expect(() => recordPath(1, "default")).to.throw(/Unknown chainId 1/);
    });

    it("allows staging only on Base Sepolia and 0G testnet", function () {
      expect([...SET_CHAINS.staging].sort()).to.deep.equal([OG_TESTNET, BASE_SEPOLIA]);
      expect(() => recordPath(OG_MAINNET, "staging")).to.throw(/no records on chainId 16661/);
      expect(() => recordPath(BASE_MAINNET, "staging", "aa-")).to.throw(/no records on chainId 8453/);
      for (const id of [OG_MAINNET, OG_TESTNET, BASE_MAINNET, BASE_SEPOLIA]) expect(() => recordPath(id, "default")).to.not.throw();
    });

    it("treats as shared exactly the chains more than one set allows", function () {
      expect([...SHARED_CHAIN_IDS].sort()).to.deep.equal([OG_TESTNET, BASE_SEPOLIA]);
    });
  });

  describe("assertManifestDir", function () {
    it("wants .openzeppelin for the default set and .openzeppelin/staging for staging", function () {
      expect(() => assertManifestDir("default", {}, CONTRACTS_ROOT)).to.not.throw();
      expect(() => assertManifestDir("staging", { MANIFEST_DEFAULT_DIR: STAGING_MANIFEST_DIR }, CONTRACTS_ROOT)).to.not.throw();
      expect(() => assertManifestDir("staging", { MANIFEST_DEFAULT_DIR: path.join(CONTRACTS_ROOT, STAGING_MANIFEST_DIR) }, "/")).to.not.throw();
    });

    it("refuses a staging run that would write production's manifests", function () {
      expect(() => assertManifestDir("staging", {}, CONTRACTS_ROOT)).to.throw(/needs the OpenZeppelin manifest directory/);
      expect(() => assertManifestDir("staging", { MANIFEST_DEFAULT_DIR: ".openzeppelin" }, CONTRACTS_ROOT)).to.throw(/staging/);
    });

    it("refuses a default run pointed at the staging manifests or run from elsewhere", function () {
      expect(() => assertManifestDir("default", { MANIFEST_DEFAULT_DIR: STAGING_MANIFEST_DIR }, CONTRACTS_ROOT)).to.throw(/needs/);
      expect(() => assertManifestDir("default", {}, path.dirname(CONTRACTS_ROOT))).to.throw(/Run from contracts/);
    });

    it("is what hardhat.config.ts sets up for DEPLOYMENT_SET=staging", function () {
      const dir = path.join(CONTRACTS_ROOT, STAGING_MANIFEST_DIR);
      expect(fs.existsSync(path.join(dir, ".gitkeep"))).to.equal(true);
      const cfg = fs.readFileSync(path.join(CONTRACTS_ROOT, "hardhat.config.ts"), "utf-8");
      const firstImport = cfg.split("\n").find((l) => l.startsWith("import "));
      expect(firstImport).to.match(/from "\.\/scripts\/_manifest-dir"/);
    });
  });

  describe("guard variables from contracts/.env", function () {
    it("accepts the environment as the shell gave it", function () {
      expect(() => assertGuardVarsNotFromDotenv(process.env)).to.not.throw();
    });

    for (const k of GUARD_VARS) {
      it(`refuses ${k} added or changed after the snapshot`, function () {
        const env = { ...process.env, [k]: `${process.env[k] ?? ""}-from-dotenv` };
        expect(() => assertGuardVarsNotFromDotenv(env)).to.throw(new RegExp(`${k} came from contracts/.env`));
      });
    }
  });

  describe("staging records", function () {
    for (const chainId of [BASE_SEPOLIA, OG_TESTNET]) {
      it(`never reuse the default escrow on chain ${chainId}`, async function () {
        const staging = readRecord(recordPath(chainId, "staging"));
        if (!staging) {
          await rejects(() => loadDeployment(chainId, "staging"), /not found \(set "staging"\)/);
          return;
        }
        expect(staging.chainId).to.equal(chainId);
        expect(staging.contracts.BlindEscrow?.toLowerCase()).to.not.equal(defaultEscrow(chainId).toLowerCase());
      });
    }
  });

  describe("assertExpectedEscrow", function () {
    const shared = { set: "default" as const, chainId: BASE_SEPOLIA, escrow: PROD_BASE_ESCROW };

    it("requires EXPECTED_ESCROW on a shared chain", function () {
      expect(() => assertExpectedEscrow(shared, {})).to.throw(/needs EXPECTED_ESCROW/);
    });

    it("accepts a matching EXPECTED_ESCROW in any case", function () {
      expect(() => assertExpectedEscrow(shared, { EXPECTED_ESCROW: PROD_BASE_ESCROW.toLowerCase() })).to.not.throw();
    });

    it("refuses a different escrow", function () {
      expect(() => assertExpectedEscrow(shared, { EXPECTED_ESCROW: OTHER })).to.throw(/Refusing/);
    });

    it("refuses a malformed or zero EXPECTED_ESCROW", function () {
      expect(() => assertExpectedEscrow(shared, { EXPECTED_ESCROW: "0x1234" })).to.throw(/not a non-zero address/);
      expect(() => assertExpectedEscrow(shared, { EXPECTED_ESCROW: ZERO })).to.throw(/not a non-zero address/);
    });

    it("refuses when the set resolves no escrow", function () {
      expect(() => assertExpectedEscrow({ ...shared, escrow: undefined }, { EXPECTED_ESCROW: OTHER })).to.throw(/resolves BlindEscrow=\(none\)/);
    });

    it("is optional on a chain only one set uses, but enforced when given", function () {
      const single = { set: "default" as const, chainId: OG_MAINNET, escrow: PROD_OG_MAINNET_ESCROW };
      expect(() => assertExpectedEscrow(single, {})).to.not.throw();
      expect(() => assertExpectedEscrow(single, { EXPECTED_ESCROW: OTHER })).to.throw(/Refusing/);
    });
  });

  describe("resolveEscrowTarget", function () {
    it("stops a staging run that forgot DEPLOYMENT_SET before it touches production", async function () {
      // The operator means the staging escrow but the default set resolves production's.
      await rejects(
        () => resolveEscrowTarget({ sends: true, chainId: BASE_SEPOLIA }, { EXPECTED_ESCROW: OTHER }),
        /set "default" on chainId 84532 resolves BlindEscrow=0x/,
      );
    });

    it("requires EXPECTED_ESCROW for a sending script on a shared chain", async function () {
      await rejects(() => resolveEscrowTarget({ sends: true, chainId: BASE_SEPOLIA }, {}), /needs EXPECTED_ESCROW/);
    });

    it("resolves production's escrow when it is named", async function () {
      const t = await quiet(() => resolveEscrowTarget({ sends: true, chainId: BASE_SEPOLIA }, { EXPECTED_ESCROW: PROD_BASE_ESCROW }));
      expect(t.set).to.equal("default");
      expect(t.escrow).to.equal(PROD_BASE_ESCROW);
      expect(t.file).to.equal(path.join(DEPLOYMENTS_ROOT, "base-sepolia.json"));
    });

    it("lets read-only scripts resolve without EXPECTED_ESCROW", async function () {
      const t = await quiet(() => resolveEscrowTarget({ sends: false, chainId: BASE_SEPOLIA }, {}));
      expect(t.escrow).to.equal(PROD_BASE_ESCROW);
    });

    it("does not require EXPECTED_ESCROW on 0G mainnet", async function () {
      const t = await quiet(() => resolveEscrowTarget({ sends: true, chainId: OG_MAINNET }, {}));
      expect(t.escrow).to.equal(PROD_OG_MAINNET_ESCROW);
    });

    it("refuses staging on a chain the set does not allow", async function () {
      await rejects(() => resolveEscrowTarget({ sends: false, chainId: OG_MAINNET }, STAGING), /no records on chainId 16661/);
    });

    it("refuses staging without the staging manifest directory", async function () {
      await rejects(
        () => resolveEscrowTarget({ sends: false, chainId: BASE_SEPOLIA }, { DEPLOYMENT_SET: "staging" }),
        /manifest directory/,
      );
    });

    it("reads staging records only when DEPLOYMENT_SET=staging", async function () {
      const env = { ...STAGING, EXPECTED_ESCROW: PROD_BASE_ESCROW };
      // Production's escrow is never what the staging set resolves (missing
      // record or a different escrow): either way this refuses.
      await rejects(
        () => resolveEscrowTarget({ sends: true, chainId: BASE_SEPOLIA }, env),
        /not found \(set "staging"\)|set "staging" on chainId 84532 resolves/,
      );
    });
  });

  describe("preflightDeploy", function () {
    it("refuses to deploy over production's Base Sepolia escrow", async function () {
      await rejects(() => preflightDeploy({ chainId: BASE_SEPOLIA, deploysEscrow: true }, {}), /already holds BlindEscrow .*ALLOW_ESCROW_REPLACE=true/);
    });

    it("still needs EXPECTED_ESCROW to replace an escrow on a shared chain", async function () {
      await rejects(
        () => preflightDeploy({ chainId: BASE_SEPOLIA, deploysEscrow: true }, { ALLOW_ESCROW_REPLACE: "true" }),
        /needs EXPECTED_ESCROW/,
      );
      const t = await quiet(() =>
        preflightDeploy({ chainId: BASE_SEPOLIA, deploysEscrow: true }, { ALLOW_ESCROW_REPLACE: "true", EXPECTED_ESCROW: PROD_BASE_ESCROW }),
      );
      expect(t.escrow).to.equal(PROD_BASE_ESCROW);
    });

    it("only accepts the exact string 'true' for ALLOW_ESCROW_REPLACE", async function () {
      await rejects(() => preflightDeploy({ chainId: OG_MAINNET, deploysEscrow: true }, { ALLOW_ESCROW_REPLACE: "1" }), /already holds/);
      await quiet(() => preflightDeploy({ chainId: OG_MAINNET, deploysEscrow: true }, { ALLOW_ESCROW_REPLACE: "true" }));
    });

    it("requires companion deploys on a shared chain to name their stack's escrow", async function () {
      await rejects(() => preflightDeploy({ chainId: BASE_SEPOLIA, deploysEscrow: false }, {}), /needs EXPECTED_ESCROW/);
      await rejects(() => preflightDeploy({ chainId: BASE_SEPOLIA, deploysEscrow: false }, { EXPECTED_ESCROW: OTHER }), /Refusing/);
      await quiet(() => preflightDeploy({ chainId: BASE_SEPOLIA, deploysEscrow: false }, { EXPECTED_ESCROW: PROD_BASE_ESCROW }));
    });

    it("refuses staging on a chain the set does not allow, or with production's manifests", async function () {
      await rejects(() => preflightDeploy({ chainId: BASE_MAINNET, deploysEscrow: true }, STAGING), /no records on chainId 8453/);
      await rejects(
        () => preflightDeploy({ chainId: BASE_SEPOLIA, deploysEscrow: true }, { DEPLOYMENT_SET: "staging" }),
        /manifest directory/,
      );
    });

    it("targets the staging record when DEPLOYMENT_SET=staging", async function () {
      const env = { ...STAGING, ALLOW_ESCROW_REPLACE: "false" };
      const file = path.join(DEPLOYMENTS_ROOT, "staging", "base-sepolia.json");
      if (readRecord(file)) {
        // Once staging exists it is guarded like any other record.
        await rejects(() => preflightDeploy({ chainId: BASE_SEPOLIA, deploysEscrow: true }, env), /staging.*already holds/);
        return;
      }
      const t = await quiet(() => preflightDeploy({ chainId: BASE_SEPOLIA, deploysEscrow: true }, env));
      expect(t).to.deep.include({ set: "staging", file, record: null, escrow: undefined });
    });
  });

  describe("mergeRecord / writeDeployment", function () {
    let dir: string;
    beforeEach(function () {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "bm-deployments-"));
    });
    afterEach(function () {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const existing = (): DeploymentRecord => ({
      network: "base-sepolia",
      chainId: BASE_SEPOLIA,
      deployer: OTHER,
      note: "old note",
      contracts: { BlindEscrow: PROD_BASE_ESCROW, AgentFactory: OTHER, USDC: OTHER },
      config: { keep: 1 },
      blocks: { BlindEscrow: 1 },
    });
    const put = (p: string, rec: DeploymentRecord) => fs.writeFileSync(p, JSON.stringify(rec, null, 2));
    const replacement = "0x2222222222222222222222222222222222222222";

    it("keeps contracts the deploy did not write (the lost AgentFactory)", function () {
      const merged = mergeRecord(existing(), {
        network: "base-sepolia",
        chainId: BASE_SEPOLIA,
        note: "new note",
        contracts: { BlindEscrow: replacement, USDC: OTHER },
        blocks: { BlindEscrow: 99 },
        config: { added: 2 },
      });
      expect(merged.contracts).to.deep.equal({ BlindEscrow: replacement, AgentFactory: OTHER, USDC: OTHER });
      expect(merged.blocks).to.deep.equal({ BlindEscrow: 99 });
      expect(merged.config).to.deep.equal({ keep: 1, added: 2 });
      expect(merged.note).to.equal("old note");
      expect(merged.deployer).to.equal(OTHER);
    });

    it("creates a new record, including its directory", function () {
      const p = path.join(dir, "staging", "base-sepolia.json");
      writeDeployment(
        p,
        { network: "base-sepolia", chainId: BASE_SEPOLIA, note: "fresh", contracts: { BlindEscrow: replacement }, blocks: { BlindEscrow: 7 } },
        {},
      );
      const written = readRecord(p)!;
      expect(written.note).to.equal("fresh");
      expect(written.contracts).to.deep.equal({ BlindEscrow: replacement });
      expect(written.blocks).to.deep.equal({ BlindEscrow: 7 });
      expect(written).to.not.have.property("config");
    });

    it("refuses to overwrite a live escrow without ALLOW_ESCROW_REPLACE=true", function () {
      const p = path.join(dir, "base-sepolia.json");
      put(p, existing());
      const update = { network: "base-sepolia", chainId: BASE_SEPOLIA, contracts: { BlindEscrow: replacement } };
      expect(() => writeDeployment(p, update, {})).to.throw(/refusing to overwrite/);
      expect(readRecord(p)!.contracts.BlindEscrow).to.equal(PROD_BASE_ESCROW);
      writeDeployment(p, update, { ALLOW_ESCROW_REPLACE: "true" });
      expect(readRecord(p)!.contracts).to.include({ BlindEscrow: replacement, AgentFactory: OTHER });
    });

    it("allows writes that keep the escrow or leave it out", function () {
      const p = path.join(dir, "base-sepolia.json");
      put(p, existing());
      writeDeployment(p, { network: "base-sepolia", chainId: BASE_SEPOLIA, contracts: { BlindEscrow: PROD_BASE_ESCROW.toLowerCase() } }, {});
      writeDeployment(p, { network: "base-sepolia", chainId: BASE_SEPOLIA, contracts: { AgentFactory: replacement } }, {});
      expect(readRecord(p)!.contracts.AgentFactory).to.equal(replacement);
    });

    it("fills a zero placeholder escrow without the flag", function () {
      const p = path.join(dir, "base-mainnet.json");
      put(p, { network: "base-mainnet", chainId: 8453, contracts: { BlindEscrow: ZERO } });
      writeDeployment(p, { network: "base-mainnet", chainId: 8453, contracts: { BlindEscrow: replacement } }, {});
      expect(readRecord(p)!.contracts.BlindEscrow).to.equal(replacement);
    });

    it("refuses to write one chain's deployment into another chain's record", function () {
      const p = path.join(dir, "0g-testnet.json");
      put(p, { network: "0g-testnet-galileo", chainId: OG_TESTNET, contracts: {} });
      expect(() => writeDeployment(p, { network: "base-sepolia", chainId: BASE_SEPOLIA, contracts: {} }, {})).to.throw(/records chainId 16602/);
    });
  });

  describe("deployBlock", function () {
    it("uses the deployment receipt's block", async function () {
      const c = { deploymentTransaction: () => ({ wait: async () => ({ blockNumber: 42 }) }) };
      expect(await deployBlock(c, 10)).to.equal(42);
    });

    it("falls back to the lower bound without a receipt", async function () {
      expect(await deployBlock({ deploymentTransaction: () => null }, 10)).to.equal(10);
      expect(await deployBlock({ deploymentTransaction: () => ({ wait: async () => null }) }, 10)).to.equal(10);
    });
  });

  describe("sync-addresses", function () {
    it("reads only the default records", function () {
      const src = fs.readFileSync(path.resolve(__dirname, "../scripts/sync-addresses.ts"), "utf-8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code).to.not.match(/_deployments/);
      expect(code).to.not.match(/staging/);
      expect(code).to.match(/path\.resolve\(__dirname, "\.\.\/deployments"\)/);
    });
  });
});
