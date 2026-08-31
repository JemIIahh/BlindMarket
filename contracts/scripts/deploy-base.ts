/**
 * Deploy BlindEscrow to Base (payment/settlement layer).
 *
 * Only deploys BlindEscrow — TaskRegistry, BlindReputation, INFT, and
 * ValidatorPool stay on 0G where agents operate.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-base.ts --network base-sepolia
 *   I_HAVE_READ_MAINNET_CHECKLIST=yes npx hardhat run scripts/deploy-base.ts --network base
 */
import { ethers, upgrades } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { assertSafeNetwork } from "./_guard";

// Base USDC addresses
const BASE_USDC: Record<number, string> = {
  8453:  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  84532: "0x036CbD53842c5426634c4923a64805772f97d1b6".toLowerCase(), // Base Sepolia
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
  console.log("BlindEscrow:", escrowAddr);

  // 2. Whitelist USDC
  console.log("\n--- Whitelisting USDC ---");
  await (await escrow.allowToken(usdcAddress)).wait();
  console.log("USDC whitelisted on BlindEscrow");

  // 3. Save deployment
  const networkName = chainId === 8453 ? "base-mainnet" : "base-sepolia";
  const deployment = {
    network: networkName,
    chainId,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    note: "BlindEscrow only — agent infra stays on 0G. Verifier must be rotated to marketplace signer.",
    contracts: {
      BlindEscrow: escrowAddr,
      USDC: usdcAddress,
    },
  };

  const outDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const outPath = path.join(outDir, `${networkName}.json`);
  fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2));
  console.log("\nDeployment saved to:", outPath);

  console.log("\n=== DEPLOYMENT SUMMARY ===");
  console.log(JSON.stringify(deployment.contracts, null, 2));

  const remaining = await ethers.provider.getBalance(deployer.address);
  console.log("\nRemaining balance:", ethers.formatEther(remaining), "ETH");

  console.log("\n--- Next steps ---");
  console.log("1. Generate marketplace signer:  npx hardhat run scripts/generate-marketplace-signer.ts --network", network.name);
  console.log("2. Rotate verifier:              MARKETPLACE_SIGNER_ADDRESS=0x... npx hardhat run scripts/rotate-verifier.ts --network", network.name);
  console.log("   (update rotate-verifier.ts to use Base escrow address if needed)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
