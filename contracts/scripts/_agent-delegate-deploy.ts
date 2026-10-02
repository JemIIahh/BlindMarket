/**
 * Deploy BlindAgentDelegate, the EIP-7702 delegate hosted agent wallets point
 * at so the platform relayer can pay their escrow gas. Arc only: it is the
 * settlement chain with no account-abstraction path (SETTLEMENT_CHAINS `aa`).
 *
 * The delegate has no owner and no admin role. Its one constructor argument,
 * the escrow, is baked into the bytecode, so this script takes it from the
 * chain's main record in the DEPLOYMENT_SET (resolveEscrowTarget; on a shared
 * chain such as Arc testnet EXPECTED_ESCROW must name it) and checks the
 * deployed delegate reports it back.
 *
 * Writes (merges into) agent-delegate-<chain record>.json: the address under
 * `contracts.BlindAgentDelegate`, the escrow it is bound to under
 * `config.escrow`, and its block. sync-addresses emits it only while that
 * escrow is still the main record's (a delegate can only ever call the escrow
 * it was deployed for). Refuses to replace a delegate already recorded for the
 * same escrow unless ALLOW_DELEGATE_REPLACE=true: wallets already delegated to
 * it keep pointing there.
 *
 * Everything runs through runAgentDelegateDeploy, which tests drive on the
 * in-process chain with the table, target and record path injected.
 */
import * as path from "path";
import { ethers, network } from "../lib/hh.js";
import { assertSafeNetwork } from "./_guard.js";
import {
  deployBlock,
  isLiveAddress,
  readRecord,
  recordPath,
  resolveEscrowTarget,
  writeDeployment,
  type DeploymentSet,
} from "./_deployments.js";
import { SETTLEMENT_CHAINS, type SettlementChain } from "./_settlement.js";

type Env = Record<string, string | undefined>;

export interface AgentDelegateTarget {
  set: DeploymentSet;
  escrow: string;
}

export interface AgentDelegateDeploySteps {
  table: Readonly<Record<number, SettlementChain>>;
  /** The set and the live escrow the delegate is for. */
  target: (chainId: number, env: Env) => Promise<AgentDelegateTarget>;
  /** Where the delegate's record goes. */
  recordFile: (chainId: number, set: DeploymentSet) => string;
  write: typeof writeDeployment;
}

const DEFAULT_STEPS: AgentDelegateDeploySteps = {
  table: SETTLEMENT_CHAINS,
  target: (chainId, env) => resolveEscrowTarget({ sends: true, chainId }, env),
  recordFile: (chainId, set) => recordPath(chainId, set, "agent-delegate-"),
  write: writeDeployment,
};

const NOTE =
  "BlindAgentDelegate — EIP-7702 delegate for hosted agent wallets; the relayer pays their submitEvidence / " +
  "releaseUnjudgedWork gas. No owner. Bound for good to config.escrow.";

/**
 * The whole deploy. Every check (chain, escrow, existing record, balance)
 * runs before the first transaction; the record is written only after the
 * deployed delegate reports the expected escrow.
 */
export async function runAgentDelegateDeploy(
  opts: { steps?: Partial<AgentDelegateDeploySteps>; env?: Env } = {},
): Promise<string> {
  const steps: AgentDelegateDeploySteps = { ...DEFAULT_STEPS, ...(opts.steps ?? {}) };
  const env = opts.env ?? process.env;
  await assertSafeNetwork();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const chain = steps.table[chainId];
  if (!chain || chain.aa) {
    throw new Error(
      `BlindAgentDelegate deploys on a settlement chain without account abstraction (Arc), not chainId ${chainId}.`,
    );
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Chain:", chain.label, `(chainId: ${chainId}, hardhat network: ${network.name})`);

  const { set, escrow } = await steps.target(chainId, env);
  if ((await ethers.provider.getCode(escrow)) === "0x") {
    throw new Error(`BlindEscrow ${escrow} has no code on chainId ${chainId}.`);
  }
  console.log("BlindEscrow:", escrow);

  const outPath = steps.recordFile(chainId, set);
  const existing = readRecord(outPath);
  const recorded = existing?.contracts?.BlindAgentDelegate;
  const recordedFor = existing?.config?.escrow;
  if (
    isLiveAddress(recorded) &&
    typeof recordedFor === "string" &&
    recordedFor.toLowerCase() === escrow.toLowerCase() &&
    env.ALLOW_DELEGATE_REPLACE !== "true"
  ) {
    throw new Error(
      `${outPath} already holds BlindAgentDelegate ${recorded} for escrow ${escrow}. Wallets delegated to it keep ` +
        "pointing there. To deploy a replacement anyway set ALLOW_DELEGATE_REPLACE=true.",
    );
  }

  const balance = await ethers.provider.getBalance(deployer.address);
  // Arc's native balance is USDC with 18 decimals, so formatEther reads it too.
  console.log("Balance:", ethers.formatEther(balance), chain.gasSymbol);
  if (balance === 0n) {
    throw new Error(`Deployer has 0 ${chain.gasSymbol}. Fund it with ${chain.gasSymbol} on ${chain.label}.`);
  }

  console.log("\n--- Deploying BlindAgentDelegate ---");
  const startBlock = await ethers.provider.getBlockNumber();
  const Delegate = await ethers.getContractFactory("BlindAgentDelegate");
  const delegate = await Delegate.deploy(escrow);
  await delegate.waitForDeployment();
  const address = await delegate.getAddress();
  const block = await deployBlock(delegate, startBlock);
  console.log("BlindAgentDelegate:", address, `(block ${block})`);

  const bound = await (delegate as unknown as { ESCROW(): Promise<string> }).ESCROW();
  if (bound.toLowerCase() !== escrow.toLowerCase()) {
    throw new Error(`BlindAgentDelegate ${address} (block ${block}) reports escrow ${bound}, not ${escrow}. NOT recorded.`);
  }

  steps.write(
    outPath,
    {
      network: path.basename(outPath, ".json").replace(/^agent-delegate-/, ""),
      chainId,
      deployer: deployer.address,
      timestamp: new Date().toISOString(),
      note: NOTE,
      contracts: { BlindAgentDelegate: address },
      config: { escrow },
      blocks: { BlindAgentDelegate: block },
    },
    env,
  );
  console.log("\nDeployment saved to:", outPath, `(set ${set})`);
  console.log("\n--- Next steps ---");
  console.log("1. Regenerate the address modules: npm run sync-addresses");
  console.log(`2. Agent wallets authorize ${address} on chainId ${chainId} (never chain id 0).`);
  return address;
}
