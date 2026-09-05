/**
 * Resolve a chain's deployment record by chainId.
 *
 * Scripts used to resolve `deployments/${network.name}.json` — which only
 * worked by coincidence for 0G, where the hardhat network key ("0g-testnet",
 * "0g-mainnet") happens to equal the deployment filename. Base's hardhat
 * network key is "base" but deploy-base.ts writes to "base-mainnet.json" —
 * a name it chose independently — so the network.name lookup threw ENOENT
 * for Base. Resolving by chainId instead sidesteps the naming mismatch
 * entirely (this is exactly what rotate-verifier.ts already did correctly).
 */
import * as fs from "fs";
import * as path from "path";
import { ethers } from "hardhat";

export const DEPLOY_FILES: Record<number, string> = {
  16661: "0g-mainnet.json",
  16602: "0g-testnet.json",
  8453: "base-mainnet.json",
  84532: "base-sepolia.json",
};

export interface DeploymentRecord {
  network: string;
  chainId: number;
  deployer?: string;
  timestamp?: string | null;
  note?: string;
  contracts: Record<string, string>;
  config?: Record<string, unknown>;
}

/**
 * Load and parse the deployment record for a chainId. Pass a chainId if the
 * caller already has one (e.g. from assertSafeNetwork's own getNetwork()
 * call) to skip the extra RPC round-trip; otherwise it fetches its own via
 * the currently connected hardhat network.
 */
export async function loadDeployment(chainId?: number): Promise<DeploymentRecord> {
  const cid = chainId ?? Number((await ethers.provider.getNetwork()).chainId);
  const file = DEPLOY_FILES[cid];
  if (!file) {
    throw new Error(`Unknown chainId ${cid} — no deployment file mapping. Add it to _deployments.ts DEPLOY_FILES.`);
  }
  const p = path.resolve(__dirname, `../deployments/${file}`);
  if (!fs.existsSync(p)) {
    throw new Error(`Deployment file not found: ${p}`);
  }
  return JSON.parse(fs.readFileSync(p, "utf-8")) as DeploymentRecord;
}
