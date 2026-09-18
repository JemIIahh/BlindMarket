import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ethers } from "hardhat";
import { runSettlementDeploy, type SettlementDeploySteps } from "../scripts/deploy-settlement";
import { preflightDeploy, readRecord, writeDeployment } from "../scripts/_deployments";
import type { SettlementChain } from "../scripts/_settlement";

/**
 * runSettlementDeploy end to end on the in-process hardhat chain (31337),
 * with the settlement table and the record path injected. The pieces are
 * unit-tested elsewhere; this pins the ORDER: token check and record guards
 * before the first transaction, the record written only after the deploy's
 * allowlist check, and nothing written when a step refuses.
 */

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

async function rejects(fn: () => Promise<unknown>, match: RegExp): Promise<void> {
  let err: unknown;
  try {
    await quiet(fn);
  } catch (e) {
    err = e;
  }
  expect(err, `expected an error matching ${match}`).to.be.instanceOf(Error);
  expect((err as Error).message).to.match(match);
}

describe("runSettlementDeploy (scripts/deploy-settlement) on the local chain", function () {
  let dir: string;
  let usdc: string;
  let deployer: string;
  const CHAIN_ID = 31337;
  const file = () => path.join(dir, "local.json");

  const tableWith = (token: string): Record<number, SettlementChain> => ({
    [CHAIN_ID]: { chainId: CHAIN_ID, label: "Local", token, gasSymbol: "ETH", nativeIsSettlementToken: false, aa: false },
  });

  /** A preflight that targets the temp record instead of deployments/. */
  const localPreflight: typeof preflightDeploy = (opts) => {
    const record = readRecord(file());
    if (record?.contracts?.BlindEscrow) throw new Error(`${file()} already holds BlindEscrow ${record.contracts.BlindEscrow}`);
    return { set: "default", chainId: opts.chainId, file: file(), record, escrow: undefined };
  };

  before(async function () {
    [{ address: deployer }] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    usdc = await (await Token.deploy("USD Coin", "USDC", 6)).getAddress();
  });
  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bm-settlement-deploy-"));
  });
  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("deploys, allowlists the token, and writes the record with its block", async function () {
    const calls: string[] = [];
    const steps: Partial<SettlementDeploySteps> = {
      table: tableWith(usdc),
      preflight: (o) => { calls.push("preflight"); return localPreflight(o); },
      write: (p, u, e) => { calls.push("write"); return writeDeployment(p, u, e ?? {}); },
    };
    const nonceBefore = await ethers.provider.getTransactionCount(deployer);
    await quiet(() => runSettlementDeploy({ steps }));
    const rec = readRecord(file())!;
    expect(rec.network).to.equal("local");
    expect(rec.chainId).to.equal(CHAIN_ID);
    expect(rec.contracts.USDC).to.equal(usdc);
    const escrow = await ethers.getContractAt("BlindEscrow", rec.contracts.BlindEscrow);
    expect(await escrow.allowedTokens(usdc)).to.equal(true);
    expect(await escrow.allowedTokens(ethers.ZeroAddress)).to.equal(false);
    expect(rec.blocks?.BlindEscrow).to.be.a("number");
    expect(await ethers.provider.getCode(rec.contracts.BlindEscrow, rec.blocks!.BlindEscrow)).to.not.equal("0x");
    expect(calls).to.deep.equal(["preflight", "write"]);
    expect(await ethers.provider.getTransactionCount(deployer)).to.be.greaterThan(nonceBefore);
  });

  it("checks the token before any transaction, and writes nothing when it fails", async function () {
    const Token = await ethers.getContractFactory("MockERC20");
    const t2 = await (await Token.deploy("USD Coin", "USDC", 2)).getAddress();
    const nonceBefore = await ethers.provider.getTransactionCount(deployer);
    let preflightCalled = false;
    await rejects(
      () => runSettlementDeploy({ steps: { table: tableWith(t2), preflight: (o) => { preflightCalled = true; return localPreflight(o); } } }),
      /reports 2 decimals/,
    );
    expect(preflightCalled).to.equal(false);
    expect(await ethers.provider.getTransactionCount(deployer)).to.equal(nonceBefore);
    expect(fs.existsSync(file())).to.equal(false);
  });

  it("runs the record guards before deploying, and writes nothing when they refuse", async function () {
    fs.writeFileSync(file(), JSON.stringify({ network: "local", chainId: CHAIN_ID, contracts: { BlindEscrow: "0x1111111111111111111111111111111111111111" } }));
    const nonceBefore = await ethers.provider.getTransactionCount(deployer);
    await rejects(() => runSettlementDeploy({ steps: { table: tableWith(usdc), preflight: localPreflight } }), /already holds BlindEscrow/);
    expect(await ethers.provider.getTransactionCount(deployer)).to.equal(nonceBefore);
    expect(readRecord(file())!.contracts.BlindEscrow).to.equal("0x1111111111111111111111111111111111111111");
  });

  it("does not record an escrow whose allowlist check failed", async function () {
    const steps: Partial<SettlementDeploySteps> = {
      table: tableWith(usdc),
      preflight: localPreflight,
      deploy: async () => { throw new Error("BlindEscrow 0x2222222222222222222222222222222222222222 (block 5) was deployed but is NOT recorded: The escrow allows address(0)."); },
    };
    await rejects(() => runSettlementDeploy({ steps }), /NOT recorded/);
    expect(fs.existsSync(file())).to.equal(false);
  });

  it("refuses a chain the table does not know, and the wrapper's chain restriction", async function () {
    await rejects(() => runSettlementDeploy({ steps: { table: {} } }), /chainId 31337 has no settlement token/);
    await rejects(() => runSettlementDeploy({ only: [8453, 84532], script: "deploy-base.ts", steps: { table: tableWith(usdc) } }), /deploy-base\.ts deploys on chainId 8453 or 84532 only, not 31337/);
  });

  it("refuses address(0) in the table before anything else", async function () {
    const nonceBefore = await ethers.provider.getTransactionCount(deployer);
    await rejects(() => runSettlementDeploy({ steps: { table: tableWith(ethers.ZeroAddress) } }), /Refusing address\(0\)/);
    expect(await ethers.provider.getTransactionCount(deployer)).to.equal(nonceBefore);
  });
});
