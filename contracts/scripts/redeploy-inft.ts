/**
 * Redeploy the (non-upgradeable) INFT (ERC-7857) as a fresh contract.
 *
 * INFT is a plain Ownable contract, NOT a proxy, so the #27 fix (usage
 * authorizations are invalidated on EVERY transfer via the OZ _update hook)
 * ships as a fresh deployment. The authorization feature is dormant in
 * production (nothing reads isAuthorized) and NFTs are minted best-effort, so
 * orphaning the previous instance loses no load-bearing state. NOTE: any INFTs
 * already minted on the OLD contract are NOT migrated.
 *
 * Oracle: the TEE transfer-proof oracle (INFT constructor arg). deploy-testnet
 * used the deployer as a placeholder; override with INFT_ORACLE=<address>. INFT
 * needs NO on-chain wiring — the backend (agentRunner.deployAgent) is the minter,
 * so update the backend's INFT address after redeploy.
 *
 * Updates the connected chain's record in the DEPLOYMENT_SET in place
 * (EXPECTED_ESCROW=<that record's escrow> required on 0G testnet).
 *
 * Usage:
 *   EXPECTED_ESCROW=0x… npx hardhat run scripts/redeploy-inft.ts --network 0g-testnet
 *   INFT_ORACLE=0x… npx hardhat run scripts/redeploy-inft.ts --network 0g-mainnet
 */

import { ethers } from "../lib/hh.js";
import * as fs from "fs";
import { assertSafeNetwork, assertZeroGChain } from "./_guard.js";
import { resolveEscrowTarget } from "./_deployments.js";

async function main() {
  await assertSafeNetwork();
  assertZeroGChain(Number((await ethers.provider.getNetwork()).chainId), "redeploy-inft.ts");

  const { file: depPath, record: dep } = await resolveEscrowTarget({ sends: true });
  const contracts = dep.contracts;

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "0G");
  if (balance === 0n) throw new Error("Deployer has 0 balance. Fund it at https://faucet.0g.ai/");

  const oracle = process.env.INFT_ORACLE || deployer.address;
  if (!process.env.INFT_ORACLE) {
    console.warn(
      `[warn] INFT_ORACLE not set — using the deployer (${deployer.address}) as the oracle ` +
        "placeholder (matches deploy-testnet). Set a real TEE oracle before production use.",
    );
  }

  console.log("\n--- Deploying INFT (ERC-7857) ---");
  console.log("Oracle:", oracle);
  const INFT = await ethers.getContractFactory("INFT");
  const inft = await INFT.deploy(oracle);
  await inft.waitForDeployment();
  const inftAddr = await inft.getAddress();
  console.log("INFT:", inftAddr);
  console.log("Owner:", await inft.owner()); // read-only sanity: contract is live

  // ── Persist ────────────────────────────────────────────────────────────────
  contracts.INFT = inftAddr;
  dep.inftRedeployedAt = new Date().toISOString();
  fs.writeFileSync(depPath, JSON.stringify(dep, null, 2));
  console.log("\nUpdated:", depPath);
  console.log("→ Update the INFT address in the backend (agentRunner mints INFTs). No on-chain wiring needed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
