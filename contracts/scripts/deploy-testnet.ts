/**
 * Deploy all BlindMarket contracts to 0G Testnet (Galileo).
 *
 * Deploys via UUPS proxies:
 *   1. MockERC20 (test USDC, 6 decimals)
 *   2. BlindReputation
 *   3. TaskRegistry
 *   4. BlindEscrow (needs treasury + verifier addresses)
 *   5. INFT (ERC-7857)
 *   6. ValidatorPool (stakeToken = MockERC20)
 *
 * Then wires them together:
 *   - BlindEscrow.setReputationContract(BlindReputation)
 *   - BlindEscrow.setTaskRegistry(TaskRegistry)
 *   - BlindReputation.authorizeRater(BlindEscrow)
 *   - TaskRegistry.authorizePublisher(BlindEscrow)
 *   - BlindEscrow.allowToken(MockERC20)
 *
 * Usage:
 *   npx hardhat run scripts/deploy-testnet.ts --network 0g-testnet
 */

import { ethers, upgrades } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { assertSafeNetwork } from "./_guard";

async function main() {
  await assertSafeNetwork();
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "0G");

  if (balance === 0n) {
    throw new Error("Deployer has 0 balance. Fund it at https://faucet.0g.ai/");
  }

  // 1. Deploy MockERC20 (test USDC)
  console.log("\n--- Deploying MockERC20 (testUSDC) ---");
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20.deploy("Test USDC", "USDC", 6);
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();
  console.log("MockERC20 (USDC):", usdcAddr);

  // 2. Deploy BlindReputation
  console.log("\n--- Deploying BlindReputation ---");
  const BlindReputation = await ethers.getContractFactory("BlindReputation");
  const reputation = await upgrades.deployProxy(BlindReputation, [], { kind: "uups" });
  await reputation.waitForDeployment();
  const repAddr = await reputation.getAddress();
  console.log("BlindReputation:", repAddr);

  // 3. Deploy TaskRegistry
  console.log("\n--- Deploying TaskRegistry ---");
  const TaskRegistry = await ethers.getContractFactory("TaskRegistry");
  const registry = await upgrades.deployProxy(TaskRegistry, [], { kind: "uups" });
  await registry.waitForDeployment();
  const regAddr = await registry.getAddress();
  console.log("TaskRegistry:", regAddr);

  // 4. Deploy BlindEscrow (treasury = deployer, verifier = deployer for now)
  console.log("\n--- Deploying BlindEscrow ---");
  const BlindEscrow = await ethers.getContractFactory("BlindEscrow");
  const escrow = await upgrades.deployProxy(BlindEscrow, [deployer.address, deployer.address], { kind: "uups" });
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  console.log("BlindEscrow:", escrowAddr);

  // 5. Wire contracts together
  console.log("\n--- Wiring contracts ---");

  console.log("  BlindEscrow.setReputationContract...");
  await (await escrow.setReputationContract(repAddr)).wait();

  console.log("  BlindEscrow.setTaskRegistry...");
  await (await escrow.setTaskRegistry(regAddr)).wait();

  console.log("  BlindReputation.authorizeRater(BlindEscrow)...");
  await (await reputation.authorizeRater(escrowAddr)).wait();

  console.log("  TaskRegistry.authorizePublisher(BlindEscrow)...");
  await (await registry.authorizePublisher(escrowAddr)).wait();

  console.log("  BlindEscrow.allowToken(MockERC20)...");
  await (await escrow.allowToken(usdcAddr)).wait();

  // 6. Deploy INFT (ERC-7857) — deployer is the minter, deployer acts as oracle for now
  console.log("\n--- Deploying INFT (ERC-7857) ---");
  const INFT = await ethers.getContractFactory("INFT");
  const inft = await INFT.deploy(deployer.address); // deployer as oracle placeholder
  await inft.waitForDeployment();
  const inftAddr = await inft.getAddress();
  console.log("INFT:", inftAddr);

  // 7. Deploy ValidatorPool (stakeToken = MockERC20)
  console.log("\n--- Deploying ValidatorPool ---");
  const ValidatorPool = await ethers.getContractFactory("ValidatorPool");
  const validatorPool = await ValidatorPool.deploy(usdcAddr);
  await validatorPool.waitForDeployment();
  const validatorPoolAddr = await validatorPool.getAddress();
  console.log("ValidatorPool:", validatorPoolAddr);

  // 7. Mint test USDC to deployer (1,000,000 USDC = 1e12 with 6 decimals)
  console.log("\n--- Minting 1,000,000 test USDC to deployer ---");
  await (await usdc.mint(deployer.address, 1_000_000n * 10n ** 6n)).wait();
  console.log("Done.");

  // 7. Save deployment addresses
  const deployment = {
    network: "0g-testnet-galileo",
    chainId: 16602,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      MockERC20: usdcAddr,
      BlindReputation: repAddr,
      TaskRegistry: regAddr,
      BlindEscrow: escrowAddr,
      INFT: inftAddr,
      ValidatorPool: validatorPoolAddr,
    },
  };

  const outDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const outPath = path.join(outDir, "0g-testnet.json");
  fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2));
  console.log("\nDeployment saved to:", outPath);

  console.log("\n=== DEPLOYMENT SUMMARY ===");
  console.log(JSON.stringify(deployment.contracts, null, 2));

  // Print remaining balance
  const remaining = await ethers.provider.getBalance(deployer.address);
  console.log("\nRemaining balance:", ethers.formatEther(remaining), "0G");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
