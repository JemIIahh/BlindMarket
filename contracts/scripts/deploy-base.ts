/**
 * Deploy BlindEscrow to Base (payment/settlement layer).
 *
 * Only deploys BlindEscrow — TaskRegistry, BlindReputation, INFT, and
 * ValidatorPool stay on 0G where agents operate.
 *
 * Writes (merges into) the chain's record in the DEPLOYMENT_SET and refuses
 * to replace a live BlindEscrow unless ALLOW_ESCROW_REPLACE=true.
 *
 * Usage:
 *   DEPLOYMENT_SET=staging npx hardhat run scripts/deploy-base.ts --network base-sepolia
 *   I_HAVE_READ_MAINNET_CHECKLIST=yes npx hardhat run scripts/deploy-base.ts --network base
 */
import { ethers, upgrades } from "hardhat";
import { assertSafeNetwork } from "./_guard";
import { deployBlock, preflightDeploy, writeDeployment } from "./_deployments";

// Base USDC addresses
const BASE_USDC: Record<number, string> = {
  8453:  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
};

async function main() {
  await assertSafeNetwork();
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");

  if (balance === 0n) {
    throw new Error("Deployer has 0 ETH balance. Fund with Base ETH.");
  }

  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  console.log("Chain:", network.name, `(chainId: ${chainId})`);

  const usdcAddress = BASE_USDC[chainId];
  if (!usdcAddress) {
    throw new Error(`No USDC address configured for chainId ${chainId}. Add it to BASE_USDC in deploy-base.ts.`);
  }
  console.log("USDC:", usdcAddress);

  const target = preflightDeploy({ chainId, deploysEscrow: true });
  const startBlock = await ethers.provider.getBlockNumber();

  // 1. Deploy BlindEscrow (treasury = deployer, verifier = deployer for now)
  //    Verifier will be rotated to the marketplace signer post-deploy.
  console.log("\n--- Deploying BlindEscrow ---");
  const BlindEscrow = await ethers.getContractFactory("BlindEscrow");
  const escrow = await upgrades.deployProxy(
    BlindEscrow,
    [deployer.address, deployer.address], // treasury, verifier
    { kind: "uups" },
  );
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  const escrowBlock = await deployBlock(escrow, startBlock);
  console.log("BlindEscrow:", escrowAddr, `(block ${escrowBlock})`);

  // 2. Whitelist USDC
  console.log("\n--- Whitelisting USDC ---");
  await (await escrow.allowToken(usdcAddress)).wait();
  console.log("USDC whitelisted on BlindEscrow");

  // 3. Save deployment
  const networkName = chainId === 8453 ? "base-mainnet" : "base-sepolia";
  const deployment = writeDeployment(target.file, {
    network: networkName,
    chainId,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    note: "BlindEscrow only — agent infra stays on 0G. Verifier must be rotated to marketplace signer.",
    contracts: {
      BlindEscrow: escrowAddr,
      USDC: usdcAddress,
    },
    blocks: { BlindEscrow: escrowBlock },
  });
  console.log("\nDeployment saved to:", target.file, `(set ${target.set})`);

  console.log("\n=== DEPLOYMENT SUMMARY ===");
  console.log(JSON.stringify(deployment.contracts, null, 2));

  const remaining = await ethers.provider.getBalance(deployer.address);
  console.log("\nRemaining balance:", ethers.formatEther(remaining), "ETH");

  console.log("\n--- Next steps ---");
  const setEnv = target.set === "default" ? "" : `DEPLOYMENT_SET=${target.set} `;
  if (target.set === "default") {
    console.log("1. Generate marketplace signer:  npx hardhat run scripts/generate-marketplace-signer.ts --network", network.name);
  } else {
    // generate-marketplace-signer.ts writes backend/.env, which is not the
    // staging backend's environment and may hold production keys.
    console.log(`1. Signer: create a key used only by set "${target.set}" and set it as`);
    console.log(`   BASE_MARKETPLACE_SIGNER_PRIVATE_KEY in that stack's backend env (not backend/.env).`);
  }
  console.log(`2. Rotate verifier:              ${setEnv}EXPECTED_ESCROW=${escrowAddr} MARKETPLACE_SIGNER_ADDRESS=0x... npx hardhat run scripts/rotate-verifier.ts --network`, network.name);
  console.log(`3. Backend env:                  BASE_ESCROW_ADDRESS=${escrowAddr} BASE_ESCROW_DEPLOYMENT_BLOCK=${escrowBlock}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
