/**
 * Resume deployment of BlindMarket contracts to 0G Mainnet (16661).
 * Use this if the initial deploy-mainnet.ts failed halfway.
 */

import { ethers, upgrades } from "../lib/hh.js";
import * as fs from "fs";
import * as path from "path";
import { assertSafeNetwork } from "./_guard.js";

async function main() {
  await assertSafeNetwork();
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  // Addresses from failed run
  const repAddr = "0x3af9232009C5da30AdA366B6E09849A040162A1a";
  const regAddr = "0x9CCF9c196006B573FaA9C9c9CebDd1296dbd5cE0";
  const escrowAddr = "0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff";
  const inftAddr = "0xfE70a007AFD022A4824d1975A1facFA266F66E28";
  const nativeAddr = "0x0000000000000000000000000000000000000000";

  console.log("Resuming from existing contracts:");
  console.log("  BlindReputation:", repAddr);
  console.log("  TaskRegistry:", regAddr);
  console.log("  BlindEscrow:", escrowAddr);
  console.log("  INFT:", inftAddr);

  // 7. Deploy ValidatorPool (stakeToken = placeholder for now)
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
  const deployment = {
    network: "0g-mainnet",
    chainId: 16661,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      Native0G: nativeAddr,
      BlindReputation: repAddr,
      TaskRegistry: regAddr,
      BlindEscrow: escrowAddr,
      INFT: inftAddr,
      ValidatorPool: validatorPoolAddr,
    },
  };

  const outDir = path.join(import.meta.dirname, "..", "deployments");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const outPath = path.join(outDir, "0g-mainnet.json");
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
