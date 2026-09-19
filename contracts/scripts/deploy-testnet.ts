/**
 * Deploy all BlindMarket contracts to 0G Testnet (Galileo).
 * Uses Native 0G for bounties.
 *
 * Deploys via UUPS proxies:
 *   1. BlindReputation
 *   2. TaskRegistry
 *   3. BlindEscrow (needs treasury + verifier addresses)
 *   4. INFT (ERC-7857)
 *   5. ValidatorPool (stakeToken = MockERC20)
 *
 * Then wires them together:
 *   - BlindEscrow.setReputationContract(BlindReputation)
 *   - BlindEscrow.setTaskRegistry(TaskRegistry)
 *   - BlindReputation.authorizeRater(BlindEscrow)
 *   - TaskRegistry.authorizePublisher(BlindEscrow)
 *   - BlindEscrow.allowToken(Native 0G)
 *
 * Writes (merges into) 0g-testnet.json in the DEPLOYMENT_SET and refuses to
 * replace a live BlindEscrow unless ALLOW_ESCROW_REPLACE=true.
 *
 * Usage:
 *   DEPLOYMENT_SET=staging npx hardhat run scripts/deploy-testnet.ts --network 0g-testnet
 */

import { ethers, upgrades } from "../lib/hh.js";
import { assertSafeNetwork } from "./_guard.js";
import { deployBlock, preflightDeploy, writeDeployment } from "./_deployments.js";

const OG_TESTNET_CHAIN_ID = 16602;

async function main() {
  await assertSafeNetwork();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== OG_TESTNET_CHAIN_ID) {
    throw new Error(`deploy-testnet.ts deploys the 0G testnet stack; connected chainId is ${chainId}. Use --network 0g-testnet.`);
  }
  const target = preflightDeploy({ chainId, deploysEscrow: true });
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "0G");

  if (balance === 0n) {
    throw new Error("Deployer has 0 balance. Fund it at https://faucet.0g.ai/");
  }

  const startBlock = await ethers.provider.getBlockNumber();

  // 1. Native 0G
  const nativeAddr = "0x0000000000000000000000000000000000000000";
  console.log("\n--- Using Native 0G for bounties ---");

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
  const escrowBlock = await deployBlock(escrow, startBlock);
  console.log("BlindEscrow:", escrowAddr, `(block ${escrowBlock})`);

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

  console.log("  BlindEscrow.allowToken(Native 0G)...");
  await (await escrow.allowToken(nativeAddr)).wait();

  // 6. Deploy INFT (ERC-7857) — deployer is the minter, deployer acts as oracle for now
  console.log("\n--- Deploying INFT (ERC-7857) ---");
  const INFT = await ethers.getContractFactory("INFT");
  const inft = await INFT.deploy(deployer.address); // deployer as oracle placeholder
  await inft.waitForDeployment();
  const inftAddr = await inft.getAddress();
  console.log("INFT:", inftAddr);

  // 7. Deploy ValidatorPool (stakeToken = MockERC20)
  console.log("\n--- Deploying ValidatorPool (with dummy stake token) ---");
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const dummyStake = await MockERC20.deploy("BlindStake", "BST", 18);
  await dummyStake.waitForDeployment();
  const dummyStakeAddr = await dummyStake.getAddress();
  console.log("Dummy Stake Token:", dummyStakeAddr);

  const ValidatorPool = await ethers.getContractFactory("ValidatorPool");
  const validatorPool = await ValidatorPool.deploy(dummyStakeAddr);
  await validatorPool.waitForDeployment();
  const validatorPoolAddr = await validatorPool.getAddress();
  console.log("ValidatorPool:", validatorPoolAddr);

  // 8. Save deployment addresses
  const deployment = writeDeployment(target.file, {
    network: "0g-testnet-galileo",
    chainId,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      Native0G: nativeAddr,
      BlindReputation: repAddr,
      TaskRegistry: regAddr,
      BlindEscrow: escrowAddr,
      INFT: inftAddr,
      ValidatorPool: validatorPoolAddr,
      DummyStake: dummyStakeAddr,
    },
    blocks: { BlindEscrow: escrowBlock },
  });
  console.log("\nDeployment saved to:", target.file, `(set ${target.set})`);
  console.log(`Backend env: BLIND_ESCROW_ADDRESS=${escrowAddr} ESCROW_DEPLOYMENT_BLOCK=${escrowBlock}`);

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
