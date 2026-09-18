/**
 * Deploy AgentFactory to Base (agent deployment coordinator).
 *
 * Accepts USDC, emits AgentDeployed events. Backend listens for these
 * events to create agent records. Each agent owns its wallet — backend
 * never signs for agents (decentralized).
 *
 * Writes (merges into) agent-factory-<chain record>.json in the DEPLOYMENT_SET,
 * and updates the AgentFactory mirror in the main record when it has one. On
 * Base Sepolia EXPECTED_ESCROW must name the escrow of the stack this belongs
 * to (so deploy-base.ts runs first for a new set).
 *
 * Usage:
 *   DEPLOYMENT_SET=staging EXPECTED_ESCROW=0x... \
 *     npx hardhat run scripts/deploy-agent-factory.ts --network base-sepolia
 *   I_HAVE_READ_MAINNET_CHECKLIST=yes npx hardhat run scripts/deploy-agent-factory.ts --network base
 */
import { ethers } from "../lib/hh.js";
import { assertSafeNetwork } from "./_guard.js";
import { deployBlock, preflightDeploy, recordPath, writeDeployment } from "./_deployments.js";

// Base USDC addresses
const BASE_USDC: Record<number, string> = {
  8453:  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
};

// Flat deploy fee: 1 USDC (6 decimals)
const DEPLOY_FEE_USDC = 1_000_000n;

async function main() {
  await assertSafeNetwork();
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");

  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  console.log("Chain:", network.name, `(chainId: ${chainId})`);

  const usdcAddress = BASE_USDC[chainId];
  if (!usdcAddress) {
    throw new Error(`No USDC address for chainId ${chainId}`);
  }
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

  // Save deployment
  const networkName = chainId === 8453 ? "base-mainnet" : "base-sepolia";
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
  console.log(`Backend env: AGENT_FACTORY_ADDRESS=${factoryAddr} AGENT_FACTORY_DEPLOYMENT_BLOCK=${factoryBlock}`);

  console.log("\n=== DEPLOYMENT SUMMARY ===");
  console.log(JSON.stringify(deployment.contracts, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
