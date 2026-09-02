/**
 * Upgrade BlindEscrow on Base to add TEE settlement (completeVerificationWithTEE).
 *
 * Deploys a new implementation, calls upgradeToAndCall, then sets the teeSigner.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-tee-settlement.ts --network base
 *   TEE_SIGNER_ADDRESS=0x... npx hardhat run scripts/upgrade-tee-settlement.ts --network base
 */
import { ethers, upgrades } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");

  // Load existing deployment
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const networkName = chainId === 8453 ? "base-mainnet" : chainId === 84532 ? "base-sepolia" : `chain-${chainId}`;
  const deploymentPath = path.join(__dirname, "..", "deployments", `${networkName}.json`);

  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`No deployment found at ${deploymentPath}. Deploy first with deploy-base.ts.`);
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
  const escrowAddr = deployment.contracts?.BlindEscrow;
  if (!escrowAddr) {
    throw new Error("BlindEscrow address not found in deployment file.");
  }
  console.log("BlindEscrow:", escrowAddr);

  // 1. Deploy new implementation
  console.log("\n--- Deploying new implementation ---");
  const BlindEscrowV2 = await ethers.getContractFactory("BlindEscrow");
  const impl = await BlindEscrowV2.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log("New implementation:", implAddr);

  // 2. Upgrade proxy
  console.log("\n--- Upgrading proxy ---");
  const escrow = await BlindEscrowV2.attach(escrowAddr);
  const proxy = await upgrades.upgradeProxy(escrowAddr, BlindEscrowV2, { call: "initialize" });
  await proxy.waitForDeployment();
  console.log("Proxy upgraded to:", await proxy.getAddress());

  // 3. Set teeSigner
  const teeSigner = process.env.TEE_SIGNER_ADDRESS;
  if (!teeSigner) {
    console.log("\nTEE_SIGNER_ADDRESS not set — skipping setTeeSigner. Run later:");
    console.log(`  TEE_SIGNER_ADDRESS=0x... npx hardhat run scripts/set-tee-signer.ts --network ${network.name}`);
  } else {
    console.log("\n--- Setting teeSigner ---");
    const tx = await (escrow as any).setTeeSigner(teeSigner);
    await tx.wait();
    console.log("teeSigner set to:", teeSigner);
  }

  // 4. Update deployment file
  deployment.contracts.implementation = implAddr;
  deployment.lastUpgrade = new Date().toISOString();
  deployment.upgrades = deployment.upgrades || [];
  deployment.upgrades.push({
    date: new Date().toISOString(),
    feature: "TEE settlement (completeVerificationWithTEE)",
    implementation: implAddr,
  });
  fs.writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2));
  console.log("\nDeployment updated:", deploymentPath);

  console.log("\n=== SUMMARY ===");
  console.log("Proxy:", escrowAddr);
  console.log("New implementation:", implAddr);
  if (teeSigner) console.log("teeSigner:", teeSigner);

  const remaining = await ethers.provider.getBalance(deployer.address);
  console.log("\nRemaining balance:", ethers.formatEther(remaining), "ETH");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
