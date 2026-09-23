/**
 * Deploy AgentFactory to a settlement chain (Base or Arc) — the agent
 * deployment coordinator.
 *
 * Accepts USDC, emits AgentDeployed events. Backend listens for these
 * events to create agent records. Each agent owns its wallet — backend
 * never signs for agents (decentralized).
 *
 * Writes (merges into) agent-factory-<chain record>.json in the DEPLOYMENT_SET,
 * and updates the AgentFactory mirror in the main record when it has one. On
 * a shared chain (Base Sepolia, Arc testnet) EXPECTED_ESCROW must name the
 * escrow of the stack this belongs to (so deploy-base.ts / deploy-settlement.ts
 * runs first for a new set).
 *
 * Usage:
 *   DEPLOYMENT_SET=staging EXPECTED_ESCROW=0x... \
 *     npx hardhat run scripts/deploy-agent-factory.ts --network base-sepolia
 *   EXPECTED_ESCROW=0x... \
 *     npx hardhat run scripts/deploy-agent-factory.ts --network arc-testnet
 *   I_HAVE_READ_MAINNET_CHECKLIST=yes npx hardhat run scripts/deploy-agent-factory.ts --network base
 */
import * as path from "path";
import { ethers } from "../lib/hh.js";
import { assertSafeNetwork } from "./_guard.js";
import { deploymentFileFor, deployBlock, preflightDeploy, recordPath, writeDeployment } from "./_deployments.js";
import { settlementChainFor } from "./_settlement.js";

// Flat deploy fee: 1 USDC (6 decimals)
const DEPLOY_FEE_USDC = 1_000_000n;

async function main() {
  await assertSafeNetwork();
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  // Throws for a chain with no settlement token (0G) — the factory only
  // deploys where tasks settle in a USDC ERC-20 (Base, Arc).
  const chain = settlementChainFor(chainId);
  const usdcAddress = chain.token;

  const balance = await ethers.provider.getBalance(deployer.address);
  // Arc's native balance is USDC with 18 decimals, so formatEther reads it too.
  console.log("Balance:", ethers.formatEther(balance), chain.gasSymbol);
  if (balance === 0n) {
    throw new Error(`Deployer has 0 ${chain.gasSymbol}. Fund it with ${chain.gasSymbol} on ${chain.label}.`);
  }
  console.log("Chain:", chain.label, `(chainId: ${chainId}, hardhat network: ${network.name})`);
  console.log("USDC:", usdcAddress);
  const target = preflightDeploy({ chainId, deploysEscrow: false });
  const outPath = recordPath(chainId, target.set, "agent-factory-");
  const startBlock = await ethers.provider.getBlockNumber();

  // Treasury = deployer (can be updated later)
  const treasury = deployer.address;

  console.log("\n--- Deploying AgentFactory ---");
  const AgentFactory = await ethers.getContractFactory("AgentFactory");
  const factory = await AgentFactory.deploy(usdcAddress, treasury, DEPLOY_FEE_USDC);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  const factoryBlock = await deployBlock(factory, startBlock);
  console.log("AgentFactory:", factoryAddr, `(block ${factoryBlock})`);
  console.log("Deploy fee:", Number(DEPLOY_FEE_USDC) / 1e6, "USDC");

  // Save deployment — the record's own file name (e.g. "arc-testnet").
  const networkName = path.basename(deploymentFileFor(chainId), ".json");
  const deployment = writeDeployment(outPath, {
    network: networkName,
    chainId,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    note: "AgentFactory — accepts USDC, emits AgentDeployed events. Backend listens.",
    contracts: {
      AgentFactory: factoryAddr,
      USDC: usdcAddress,
      Treasury: treasury,
    },
    config: {
      deployFeeUsdc: DEPLOY_FEE_USDC.toString(),
    },
    blocks: { AgentFactory: factoryBlock },
  });
  console.log("\nDeployment saved to:", outPath);
  // sync-addresses prefers the main record's AgentFactory over this companion
  // record, so a stale mirror there would hide the new factory.
  if (target.record && "AgentFactory" in target.record.contracts) {
    writeDeployment(target.file, { network: target.record.network, chainId, contracts: { AgentFactory: factoryAddr } });
    console.log("Updated AgentFactory mirror in:", target.file);
  }
  // The backend listens on one factory: Base's via AGENT_FACTORY_ADDRESS, Arc's
  // via ARC_AGENT_FACTORY_ADDRESS (see backend/src/services/agentFactoryListener.ts).
  const envPrefix = chain.nativeIsSettlementToken ? "ARC_" : "";
  console.log(`Backend env: ${envPrefix}AGENT_FACTORY_ADDRESS=${factoryAddr} ${envPrefix}AGENT_FACTORY_DEPLOYMENT_BLOCK=${factoryBlock}`);

  console.log("\n=== DEPLOYMENT SUMMARY ===");
  console.log(JSON.stringify(deployment.contracts, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
