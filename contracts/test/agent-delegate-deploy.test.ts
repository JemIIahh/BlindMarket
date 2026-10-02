import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ethers } from "../lib/hh.js";
import { runAgentDelegateDeploy, type AgentDelegateDeploySteps } from "../scripts/_agent-delegate-deploy.js";
import { readRecord } from "../scripts/_deployments.js";
import type { SettlementChain } from "../scripts/_settlement.js";

/**
 * runAgentDelegateDeploy (scripts/deploy-agent-delegate) on the in-process
 * chain (31337), with the settlement table, escrow target and record path
 * injected. Pins that every refusal comes before the first transaction and
 * writes nothing, and what the record holds.
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

describe("runAgentDelegateDeploy (scripts/deploy-agent-delegate) on the local chain", function () {
  const CHAIN_ID = 31337;
  let dir: string;
  let escrow: string;
  let deployer: string;
  const file = () => path.join(dir, "agent-delegate-local.json");

  const table = (aa: boolean): Record<number, SettlementChain> => ({
    [CHAIN_ID]: { chainId: CHAIN_ID, label: "Local", token: ethers.ZeroAddress, gasSymbol: "USDC", nativeIsSettlementToken: true, aa },
  });
  const stepsFor = (target: string, aa = false): Partial<AgentDelegateDeploySteps> => ({
    table: table(aa),
    target: async () => ({ set: "default", escrow: target }),
    recordFile: () => file(),
  });

  before(async function () {
    [{ address: deployer }] = await ethers.getSigners();
    // Any contract stands in for the escrow: the deploy only needs its address and code.
    const Token = await ethers.getContractFactory("MockERC20");
    escrow = await (await Token.deploy("USD Coin", "USDC", 6)).getAddress();
  });
  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bm-agent-delegate-"));
  });
  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("deploys the delegate bound to the escrow and records it with the escrow and its block", async function () {
    const address = await quiet(() => runAgentDelegateDeploy({ steps: stepsFor(escrow), env: {} }));
    const rec = readRecord(file())!;
    expect(rec.network).to.equal("local");
    expect(rec.chainId).to.equal(CHAIN_ID);
    expect(rec.contracts).to.deep.equal({ BlindAgentDelegate: address });
    expect(rec.config).to.deep.equal({ escrow });
    expect(rec.blocks?.BlindAgentDelegate).to.be.a("number");
    const delegate = await ethers.getContractAt("BlindAgentDelegate", address);
    expect(await delegate.ESCROW()).to.equal(escrow);
  });

  for (const [name, steps, match] of [
    ["a chain with account abstraction", () => stepsFor(escrow, true), /without account abstraction \(Arc\), not chainId 31337/],
    ["a chain the table does not know", () => ({ ...stepsFor(escrow), table: {} }), /not chainId 31337/],
    ["an escrow with no code", () => stepsFor("0x1111111111111111111111111111111111111111"), /has no code/],
  ] as const) {
    it(`refuses ${name} before any transaction`, async function () {
      const nonceBefore = await ethers.provider.getTransactionCount(deployer);
      await rejects(() => runAgentDelegateDeploy({ steps: steps(), env: {} }), match);
      expect(await ethers.provider.getTransactionCount(deployer)).to.equal(nonceBefore);
      expect(fs.existsSync(file())).to.equal(false);
    });
  }

  it("refuses to replace a delegate recorded for the same escrow without ALLOW_DELEGATE_REPLACE=true", async function () {
    const first = await quiet(() => runAgentDelegateDeploy({ steps: stepsFor(escrow), env: {} }));
    const nonceBefore = await ethers.provider.getTransactionCount(deployer);
    for (const flag of [undefined, "1", "yes"]) {
      await rejects(
        () => runAgentDelegateDeploy({ steps: stepsFor(escrow), env: { ALLOW_DELEGATE_REPLACE: flag } }),
        /already holds BlindAgentDelegate/,
      );
    }
    expect(await ethers.provider.getTransactionCount(deployer)).to.equal(nonceBefore);
    expect(readRecord(file())!.contracts.BlindAgentDelegate).to.equal(first);

    const second = await quiet(() =>
      runAgentDelegateDeploy({ steps: stepsFor(escrow), env: { ALLOW_DELEGATE_REPLACE: "true" } }),
    );
    expect(second).to.not.equal(first);
    expect(readRecord(file())!.contracts.BlindAgentDelegate).to.equal(second);
  });

  it("replaces a delegate recorded for another escrow without the flag", async function () {
    fs.writeFileSync(
      file(),
      JSON.stringify({
        network: "local",
        chainId: CHAIN_ID,
        contracts: { BlindAgentDelegate: "0x2222222222222222222222222222222222222222" },
        config: { escrow: "0x3333333333333333333333333333333333333333" },
      }),
    );
    const address = await quiet(() => runAgentDelegateDeploy({ steps: stepsFor(escrow), env: {} }));
    const rec = readRecord(file())!;
    expect(rec.contracts.BlindAgentDelegate).to.equal(address);
    expect(rec.config).to.deep.equal({ escrow });
  });
});
