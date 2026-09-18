import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import hre, { ethers, upgrades } from "hardhat";
import {
  ARC_MAINNET_CHAIN_ID,
  ARC_TESTNET_CHAIN_ID,
  ARC_USDC,
  assertAaChain,
  assertNotNative,
  SETTLEMENT_CHAINS,
  settlementChainFor,
  settlementTokenFor,
} from "../scripts/_settlement";
import { ALLOWED_TESTNETS } from "../scripts/_guard";
import { DEPLOY_FILES, DEPLOYMENTS_ROOT, preflightDeploy, readRecord, writeDeployment } from "../scripts/_deployments";
import {
  assertEscrowAllowlist,
  checkSettlementToken,
  deployEscrow,
  settlementInvariants,
  settlementRecord,
  waitForTokenAllowed,
} from "../scripts/deploy-settlement";
import { render } from "../scripts/sync-addresses";
import { STAGING_MANIFEST_DIR } from "../scripts/_manifest-dir";

/**
 * Arc contracts tooling: the settlement token table, the guards around it,
 * the steps of deploy-settlement.ts (run against the in-process hardhat
 * chain), and what sync-addresses emits once Arc records and deployment
 * blocks exist.
 */

const ZERO = "0x0000000000000000000000000000000000000000";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ESCROW_X = "0x1111111111111111111111111111111111111111";

async function rejects(fn: () => Promise<unknown>, match: RegExp): Promise<void> {
  let err: unknown;
  const log = console.log;
  console.log = () => {};
  try {
    await fn();
  } catch (e) {
    err = e;
  } finally {
    console.log = log;
  }
  expect(err, `expected an error matching ${match}`).to.be.instanceOf(Error);
  expect((err as Error).message).to.match(match);
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

describe("Arc settlement tooling", function () {
  describe("settlement token table (scripts/_settlement)", function () {
    it("maps Base and Arc to their USDC ERC-20", function () {
      expect(settlementTokenFor(8453)).to.equal(BASE_USDC);
      expect(settlementTokenFor(84532)).to.equal(BASE_SEPOLIA_USDC);
      expect(settlementTokenFor(ARC_TESTNET_CHAIN_ID)).to.equal(ARC_USDC);
      expect(settlementTokenFor(ARC_MAINNET_CHAIN_ID)).to.equal(ARC_USDC);
      expect(ARC_USDC).to.equal("0x3600000000000000000000000000000000000000");
    });

    it("has no token for 0G, local or unknown chains", function () {
      for (const id of [16661, 16602, 31337, 1]) {
        expect(() => settlementTokenFor(id)).to.throw(new RegExp(`chainId ${id} has no settlement token`));
      }
    });

    it("never holds address(0), and each entry is keyed by its own chain id", function () {
      for (const [id, chain] of Object.entries(SETTLEMENT_CHAINS)) {
        expect(chain.chainId).to.equal(Number(id));
        expect(() => assertNotNative(chain.token)).to.not.throw();
      }
    });

    it("marks Arc as paying gas in its settlement token, with no account abstraction", function () {
      for (const id of [ARC_TESTNET_CHAIN_ID, ARC_MAINNET_CHAIN_ID]) {
        expect(settlementChainFor(id)).to.include({ gasSymbol: "USDC", nativeIsSettlementToken: true, aa: false });
      }
      for (const id of [8453, 84532]) {
        expect(settlementChainFor(id)).to.include({ gasSymbol: "ETH", nativeIsSettlementToken: false, aa: true });
      }
    });

    it("agrees with the USDC the Base records hold", function () {
      const usdcIn = (file: string) => readRecord(path.join(DEPLOYMENTS_ROOT, file))!.contracts.USDC;
      expect(usdcIn("base-mainnet.json")).to.equal(settlementTokenFor(8453));
      for (const file of ["base-sepolia.json", "aa-base-sepolia.json", "agent-factory-base-sepolia.json"]) {
        expect(usdcIn(file), file).to.equal(settlementTokenFor(84532));
      }
    });
  });

  describe("assertNotNative", function () {
    it("refuses address(0)", function () {
      expect(() => assertNotNative(ZERO)).to.throw(/Refusing address\(0\)/);
      expect(() => assertNotNative(ZERO.toUpperCase().replace("0X", "0x"))).to.throw(/Refusing address\(0\)/);
    });

    it("refuses anything that is not an address", function () {
      for (const bad of ["", "0x1234", ARC_USDC.slice(2), `${ARC_USDC}00`, "native"]) {
        expect(() => assertNotNative(bad), bad).to.throw(/is not an address/);
      }
    });

    it("returns a real token unchanged", function () {
      expect(assertNotNative(ARC_USDC)).to.equal(ARC_USDC);
      expect(assertNotNative(BASE_SEPOLIA_USDC)).to.equal(BASE_SEPOLIA_USDC);
    });
  });

  describe("assertAaChain (deploy-aa.ts)", function () {
    it("refuses both Arc chains", function () {
      expect(() => assertAaChain(ARC_TESTNET_CHAIN_ID)).to.throw(/Refusing to deploy account-abstraction infrastructure on Arc Testnet/);
      expect(() => assertAaChain(ARC_MAINNET_CHAIN_ID)).to.throw(/on Arc Mainnet/);
    });

    it("leaves Base and other chains to deploy-aa.ts's own checks", function () {
      for (const id of [8453, 84532, 31337]) expect(() => assertAaChain(id)).to.not.throw();
    });
  });

  describe("mainnet guard (scripts/_guard)", function () {
    it("treats Arc testnet as a testnet and Arc mainnet as gated", function () {
      expect(ALLOWED_TESTNETS.has(ARC_TESTNET_CHAIN_ID)).to.equal(true);
      expect(ALLOWED_TESTNETS.has(ARC_MAINNET_CHAIN_ID)).to.equal(false);
      expect(ALLOWED_TESTNETS.has(8453)).to.equal(false);
      expect(ALLOWED_TESTNETS.has(84532)).to.equal(true);
    });
  });

  describe("hardhat networks", function () {
    const net = (name: string) => hre.config.networks[name] as { chainId?: number; url?: string } | undefined;

    it("defines arc-testnet on 5042002 with a default RPC", function () {
      expect(net("arc-testnet")?.chainId).to.equal(ARC_TESTNET_CHAIN_ID);
      expect(net("arc-testnet")?.url).to.equal(process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.io");
    });

    it("defines arc-mainnet on 5042 with no default RPC", function () {
      expect(net("arc-mainnet")?.chainId).to.equal(ARC_MAINNET_CHAIN_ID);
      expect(net("arc-mainnet")?.url).to.equal(process.env.ARC_MAINNET_RPC_URL ?? "");
    });

    it("names every record's network after its file, except Base mainnet's legacy 'base'", function () {
      for (const [id, file] of Object.entries(DEPLOY_FILES)) {
        const name = Number(id) === 8453 ? "base" : file.replace(/\.json$/, "");
        expect(net(name)?.chainId, `${file} -> network ${name}`).to.equal(Number(id));
      }
    });
  });

  describe("deploy-settlement.ts steps", function () {
    let deployer: Awaited<ReturnType<typeof ethers.getSigners>>[number];
    let usdc: string;

    before(async function () {
      [deployer] = await ethers.getSigners();
      const Token = await ethers.getContractFactory("MockERC20");
      usdc = await (await Token.deploy("USD Coin", "USDC", 6)).getAddress();
    });

    describe("checkSettlementToken", function () {
      it("accepts a 6-decimal USDC", async function () {
        await checkSettlementToken(usdc);
      });

      it("refuses a token with other decimals (Arc's native view is 18)", async function () {
        const Token = await ethers.getContractFactory("MockERC20");
        const t18 = await (await Token.deploy("USD Coin", "USDC", 18)).getAddress();
        await rejects(() => checkSettlementToken(t18), /reports 18 decimals/);
        const t2 = await (await Token.deploy("USD Coin", "USDC", 2)).getAddress();
        await rejects(() => checkSettlementToken(t2), /reports 2 decimals/);
      });

      it("refuses another 6-decimal token", async function () {
        const Token = await ethers.getContractFactory("MockERC20");
        const usdt = await (await Token.deploy("Tether", "USDT", 6)).getAddress();
        await rejects(() => checkSettlementToken(usdt), /symbol "USDT"/);
      });

      it("refuses an address with no code, and address(0) before any request", async function () {
        await rejects(() => checkSettlementToken(ESCROW_X), /has no code/);
        await rejects(() => checkSettlementToken(ZERO), /Refusing address\(0\)/);
      });
    });

    describe("deployEscrow", function () {
      it("deploys an escrow that allows the token and not address(0), and returns its block", async function () {
        const deployed = await quiet(() => deployEscrow(usdc, deployer));
        const escrow = await ethers.getContractAt("BlindEscrow", deployed.address);
        expect(await escrow.allowedTokens(usdc)).to.equal(true);
        expect(await escrow.allowedTokens(ZERO)).to.equal(false);
        expect(await escrow.admin()).to.equal(deployer.address);
        expect(await escrow.verifier()).to.equal(deployer.address);
        const code = await ethers.provider.getCode(deployed.address, deployed.block);
        const before = await ethers.provider.getCode(deployed.address, deployed.block - 1);
        expect(code).to.not.equal("0x");
        expect(before).to.equal("0x");
      });

      it("does not hand back an escrow that comes up allowing address(0)", async function () {
        // Stands in for a changed initializer: the deployed proxy already
        // allows the native coin before deployEscrow allowlists the token.
        const original = upgrades.deployProxy;
        (upgrades as any).deployProxy = async (...args: Parameters<typeof original>) => {
          const proxy = await original(...args);
          await proxy.waitForDeployment();
          await (await (proxy as any).allowToken(ZERO)).wait();
          return proxy;
        };
        try {
          await rejects(() => deployEscrow(usdc, deployer), /BlindEscrow 0x[0-9a-fA-F]{40} \(block \d+\) was deployed but is NOT recorded: .*allows address\(0\)/);
        } finally {
          (upgrades as any).deployProxy = original;
        }
      });

      it("waits out a stale 'token not allowed' read after allowToken", async function () {
        // Stands in for an RPC that answers from before the allowToken
        // receipt: the first two reads of the token's allowance say false.
        const original = upgrades.deployProxy;
        let staleReads = 2;
        (upgrades as any).deployProxy = async (...args: Parameters<typeof original>) => {
          const proxy: any = await original(...args);
          return new Proxy(proxy, {
            get(target, prop) {
              if (prop === "allowedTokens") {
                return async (t: string) => {
                  if (t.toLowerCase() === usdc.toLowerCase() && staleReads > 0) {
                    staleReads--;
                    return false;
                  }
                  return target.allowedTokens(t);
                };
              }
              const v = Reflect.get(target, prop);
              return typeof v === "function" ? v.bind(target) : v;
            },
          });
        };
        try {
          const deployed = await quiet(() => deployEscrow(usdc, deployer, { delayMs: 1 }));
          expect(staleReads).to.equal(0);
          expect(await (await ethers.getContractAt("BlindEscrow", deployed.address)).allowedTokens(usdc)).to.equal(true);
        } finally {
          (upgrades as any).deployProxy = original;
        }
      });

      it("refuses address(0) before sending anything", async function () {
        const nonce = await ethers.provider.getTransactionCount(deployer.address);
        await rejects(() => deployEscrow(ZERO, deployer), /Refusing address\(0\)/);
        expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce);
      });
    });

    describe("assertEscrowAllowlist", function () {
      it("passes a correctly configured escrow", async function () {
        const deployed = await quiet(() => deployEscrow(usdc, deployer));
        await assertEscrowAllowlist(await ethers.getContractAt("BlindEscrow", deployed.address), usdc);
      });

      it("fails an escrow that also allows address(0)", async function () {
        const deployed = await quiet(() => deployEscrow(usdc, deployer));
        const escrow = await ethers.getContractAt("BlindEscrow", deployed.address);
        await (await escrow.allowToken(ZERO)).wait();
        await rejects(() => assertEscrowAllowlist(escrow, usdc), /allows address\(0\)/);
      });

      it("fails an escrow that does not allow the token", async function () {
        const deployed = await quiet(() => deployEscrow(usdc, deployer));
        const escrow = await ethers.getContractAt("BlindEscrow", deployed.address);
        await (await escrow.disallowToken(usdc)).wait();
        await rejects(() => assertEscrowAllowlist(escrow, usdc), /does not allow the settlement token/);
      });
    });

    describe("waitForTokenAllowed", function () {
      const fake = (answers: boolean[]) => {
        let calls = 0;
        return {
          get calls() {
            return calls;
          },
          allowedTokens: async () => answers[Math.min(calls++, answers.length - 1)],
        };
      };

      it("returns once the read turns true", async function () {
        const escrow = fake([false, false, true]);
        expect(await waitForTokenAllowed(escrow, usdc, { tries: 5, delayMs: 1 })).to.equal(true);
        expect(escrow.calls).to.equal(3);
      });

      it("gives up after `tries` reads", async function () {
        const escrow = fake([false]);
        expect(await waitForTokenAllowed(escrow, usdc, { tries: 3, delayMs: 1 })).to.equal(false);
        expect(escrow.calls).to.equal(3);
      });
    });

    describe("settlementInvariants (verify-deployment-config.ts)", function () {
      const tableFor = (token: string) => ({ 31337: { token } });
      const deployed = async () =>
        ethers.getContractAt("BlindEscrow", (await quiet(() => deployEscrow(usdc, deployer))).address);
      const failing = (checks: { label: string; ok: boolean }[]) => checks.filter((c) => !c.ok).map((c) => c.label);

      it("passes a correctly configured escrow", async function () {
        const checks = await settlementInvariants(await deployed(), 31337, { table: tableFor(usdc) });
        expect(checks).to.have.length(3);
        expect(failing(checks)).to.deep.equal([]);
      });

      it("fails an escrow that allows address(0), and only that check", async function () {
        const escrow = await deployed();
        await (await escrow.allowToken(ZERO)).wait();
        expect(failing(await settlementInvariants(escrow, 31337, { table: tableFor(usdc) }))).to.deep.equal([
          "escrow does not allow address(0)",
        ]);
      });

      it("fails an escrow that does not allow the settlement token", async function () {
        const escrow = await deployed();
        await (await escrow.disallowToken(usdc)).wait();
        expect(failing(await settlementInvariants(escrow, 31337, { table: tableFor(usdc) }))).to.deep.equal([
          "escrow allows the settlement token",
        ]);
      });

      it("fails a token that is not 6-decimal USDC, saying why", async function () {
        const Token = await ethers.getContractFactory("MockERC20");
        const t18 = await (await Token.deploy("USD Coin", "USDC", 18)).getAddress();
        const escrow = await deployed();
        await (await escrow.allowToken(t18)).wait();
        const failed = failing(await settlementInvariants(escrow, 31337, { table: tableFor(t18) }));
        expect(failed).to.have.length(1);
        expect(failed[0]).to.match(/token reports 6 decimals and symbol USDC \(.*reports 18 decimals/);
      });

      it("checks nothing on a chain with no settlement token (0G)", async function () {
        const escrow = await deployed();
        expect(await settlementInvariants(escrow, 16602)).to.deep.equal([]);
        expect(await settlementInvariants(escrow, 16661)).to.deep.equal([]);
        expect(await settlementInvariants(escrow, 1, { table: tableFor(usdc) })).to.deep.equal([]);
      });

      it("checks Base and Arc from the real table", async function () {
        // On this chain their tokens have no code, so only the token check fails.
        const escrow = await deployed();
        for (const id of [8453, 84532, ARC_TESTNET_CHAIN_ID, ARC_MAINNET_CHAIN_ID]) {
          const checks = await settlementInvariants(escrow, id);
          expect(checks, String(id)).to.have.length(3);
          expect(failing(checks)).to.deep.equal(["escrow allows the settlement token", `token reports 6 decimals and symbol USDC (Settlement token ${settlementTokenFor(id)} has no code on this chain.)`]);
        }
      });
    });

    describe("settlementRecord", function () {
      const escrow = { address: ESCROW_X, block: 1234 };

      it("records Arc under its file's name, with the ERC-20 and the block", function () {
        const rec = settlementRecord(settlementChainFor(ARC_TESTNET_CHAIN_ID), deployer.address, escrow, "t");
        expect(rec).to.deep.include({ network: "arc-testnet", chainId: ARC_TESTNET_CHAIN_ID, deployer: deployer.address, timestamp: "t" });
        expect(rec.contracts).to.deep.equal({ BlindEscrow: ESCROW_X, USDC: ARC_USDC });
        expect(rec.blocks).to.deep.equal({ BlindEscrow: 1234 });
        expect(rec.note).to.match(/address\(0\).*never be allowlisted/);
        expect(settlementRecord(settlementChainFor(ARC_MAINNET_CHAIN_ID), deployer.address, escrow, "t").network).to.equal("arc-mainnet");
      });

      it("records Base exactly as deploy-base.ts did", function () {
        const rec = settlementRecord(settlementChainFor(84532), deployer.address, escrow, "t");
        expect(rec).to.deep.equal({
          network: "base-sepolia",
          chainId: 84532,
          deployer: deployer.address,
          timestamp: "t",
          note: "BlindEscrow only — agent infra stays on 0G. Verifier must be rotated to marketplace signer.",
          contracts: { BlindEscrow: ESCROW_X, USDC: BASE_SEPOLIA_USDC },
          blocks: { BlindEscrow: 1234 },
        });
        expect(settlementRecord(settlementChainFor(8453), deployer.address, escrow, "t").network).to.equal("base-mainnet");
      });

      it("merges into an existing record instead of replacing it", function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bm-settlement-"));
        try {
          const p = path.join(dir, "arc-testnet.json");
          fs.writeFileSync(
            p,
            JSON.stringify({ network: "arc-testnet", chainId: ARC_TESTNET_CHAIN_ID, note: "hand note", contracts: { Other: ESCROW_X }, blocks: { Other: 7 } }),
          );
          writeDeployment(p, settlementRecord(settlementChainFor(ARC_TESTNET_CHAIN_ID), deployer.address, { address: deployer.address, block: 9 }, "t"), {});
          const rec = readRecord(p)!;
          expect(rec.contracts).to.deep.equal({ Other: ESCROW_X, BlindEscrow: deployer.address, USDC: ARC_USDC });
          expect(rec.blocks).to.deep.equal({ Other: 7, BlindEscrow: 9 });
          // The record had no escrow, so the deploy's note replaces the old
          // one (mergeRecord's placeholder rule).
          expect(rec.note).to.match(/never be allowlisted/);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    });

    describe("preflightDeploy on Arc", function () {
      it("lets a first Arc testnet escrow deploy in either set, naming the default set explicitly", async function () {
        if (!readRecord(path.join(DEPLOYMENTS_ROOT, "arc-testnet.json"))) {
          // A forgotten DEPLOYMENT_SET=staging would otherwise create the
          // default record that sync-addresses publishes.
          await rejects(
            async () => preflightDeploy({ chainId: ARC_TESTNET_CHAIN_ID, deploysEscrow: true }, {}),
            /default set has no escrow there yet.*DEPLOYMENT_SET=staging.*DEPLOYMENT_SET=default/,
          );
          const t = await quiet(async () =>
            preflightDeploy({ chainId: ARC_TESTNET_CHAIN_ID, deploysEscrow: true }, { DEPLOYMENT_SET: "default" }),
          );
          expect(t).to.deep.include({ set: "default", record: null, escrow: undefined });
        }
        if (!readRecord(path.join(DEPLOYMENTS_ROOT, "staging", "arc-testnet.json"))) {
          const env = { DEPLOYMENT_SET: "staging", MANIFEST_DEFAULT_DIR: STAGING_MANIFEST_DIR };
          const t = await quiet(async () => preflightDeploy({ chainId: ARC_TESTNET_CHAIN_ID, deploysEscrow: true }, env));
          expect(t).to.deep.include({ set: "staging", file: path.join(DEPLOYMENTS_ROOT, "staging", "arc-testnet.json") });
        }
      });

      it("keeps Arc mainnet out of staging", async function () {
        const env = { DEPLOYMENT_SET: "staging", MANIFEST_DEFAULT_DIR: STAGING_MANIFEST_DIR };
        await rejects(async () => preflightDeploy({ chainId: ARC_MAINNET_CHAIN_ID, deploysEscrow: true }, env), /no records on chainId 5042 /);
      });
    });
  });

  describe("sync-addresses render()", function () {
    const committed = fs.readFileSync(path.resolve(__dirname, "../../backend/src/contractAddresses.ts"), "utf-8");
    let dir: string;

    beforeEach(function () {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "bm-sync-"));
      for (const f of fs.readdirSync(DEPLOYMENTS_ROOT)) {
        if (f.endsWith(".json")) fs.copyFileSync(path.join(DEPLOYMENTS_ROOT, f), path.join(dir, f));
      }
    });
    afterEach(function () {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const put = (file: string, rec: object) => fs.writeFileSync(path.join(dir, file), JSON.stringify(rec));
    const edit = (file: string, fn: (rec: any) => void) => {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
      fn(rec);
      put(file, rec);
    };
    /** The object literal a generated `export const NAME = {...} as const;` holds. */
    const exported = (src: string, name: string): any => {
      const m = src.match(new RegExp(`export const ${name} = ([\\s\\S]*?) as const;`));
      return m ? JSON.parse(m[1]) : undefined;
    };

    it("renders today's records byte for byte as the committed module, with no Arc and no blocks", function () {
      expect(render()).to.equal(committed);
      expect(render(dir)).to.equal(committed);
      expect(committed).to.not.match(/arc|DEPLOYMENT_BLOCKS/);
    });

    it("adds arcTestnet (and only it) once arc-testnet.json exists", function () {
      put("arc-testnet.json", { network: "arc-testnet", chainId: ARC_TESTNET_CHAIN_ID, contracts: { BlindEscrow: ESCROW_X, USDC: ARC_USDC } });
      const out = render(dir);
      const addrs = exported(out, "CONTRACT_ADDRESSES");
      expect(Object.keys(addrs)).to.deep.equal(["mainnet", "testnet", "base", "baseTestnet", "arcTestnet"]);
      expect(addrs.arcTestnet).to.deep.equal({ blindEscrow: ESCROW_X, USDC: ARC_USDC });
      expect(out).to.not.match(/DEPLOYMENT_BLOCKS/);
      // Everything before Arc is unchanged.
      expect(out.startsWith(committed.slice(0, committed.lastIndexOf("\n  }\n}")))).to.equal(true);
    });

    it("adds arc after baseTestnet once arc-mainnet.json exists", function () {
      put("arc-mainnet.json", { network: "arc-mainnet", chainId: ARC_MAINNET_CHAIN_ID, contracts: { BlindEscrow: ESCROW_X, USDC: ARC_USDC } });
      put("arc-testnet.json", { network: "arc-testnet", chainId: ARC_TESTNET_CHAIN_ID, contracts: { BlindEscrow: ZERO, USDC: ARC_USDC } });
      const addrs = exported(render(dir), "CONTRACT_ADDRESSES");
      expect(Object.keys(addrs)).to.deep.equal(["mainnet", "testnet", "base", "baseTestnet", "arc", "arcTestnet"]);
      expect(addrs.arc.blindEscrow).to.equal(ESCROW_X);
      expect(addrs.arcTestnet).to.deep.equal({ USDC: ARC_USDC });
    });

    it("emits DEPLOYMENT_BLOCKS for the contracts it emits, keyed like CONTRACT_ADDRESSES", function () {
      put("arc-testnet.json", {
        network: "arc-testnet",
        chainId: ARC_TESTNET_CHAIN_ID,
        contracts: { BlindEscrow: ESCROW_X, USDC: ARC_USDC },
        blocks: { BlindEscrow: 123 },
      });
      edit("base-sepolia.json", (r) => (r.blocks = { BlindEscrow: 46211199 }));
      const out = render(dir);
      expect(exported(out, "DEPLOYMENT_BLOCKS")).to.deep.equal({ baseTestnet: { blindEscrow: 46211199 }, arcTestnet: { blindEscrow: 123 } });
      expect(out.indexOf("DEPLOYMENT_BLOCKS")).to.be.greaterThan(out.indexOf("CONTRACT_ADDRESSES"));
    });

    it("drops the block of a zero placeholder", function () {
      edit("base-mainnet.json", (r) => (r.blocks = { BlindEscrow: 5 }));
      expect(render(dir)).to.equal(committed);
    });

    it("takes a mirrored AgentFactory's block from the record that holds the same address", function () {
      edit("agent-factory-base-sepolia.json", (r) => (r.blocks = { AgentFactory: 777 }));
      expect(exported(render(dir), "DEPLOYMENT_BLOCKS")).to.deep.equal({ baseTestnet: { agentFactory: 777 } });

      // A companion record whose factory is not the one emitted gives no block.
      edit("agent-factory-base-sepolia.json", (r) => (r.contracts.AgentFactory = ESCROW_X));
      expect(render(dir)).to.not.match(/DEPLOYMENT_BLOCKS/);
    });

    it("refuses a block that is not a block number", function () {
      edit("base-sepolia.json", (r) => (r.blocks = { BlindEscrow: "46211199" }));
      expect(() => render(dir)).to.throw(/blocks\.BlindEscrow is not a block number/);
      for (const bad of [-1, 1.5]) {
        edit("base-sepolia.json", (r) => (r.blocks = { BlindEscrow: bad }));
        expect(() => render(dir), String(bad)).to.throw(/blocks\.BlindEscrow is not a block number/);
      }
    });

    it("still refuses a missing main record for the non-Arc networks", function () {
      fs.rmSync(path.join(dir, "base-sepolia.json"));
      expect(() => render(dir)).to.throw(/Deployment record not found/);
    });
  });
});
