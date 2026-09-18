/**
 * Redeploy ONLY BlindAccountFactory (+ new BlindAccount implementation) on
 * Base Sepolia, reusing the existing USDCPaymaster.
 *
 * Why: BlindAccount.execute was strict onlyOwner, but the ERC-4337 flow has
 * the EntryPoint call execute() — every live UserOp reverted with
 * "BlindAccount: not owner" (proven by UserOp receipt 0x5b3b98.. on-chain).
 * The fix (onlyEntryPointOrOwner) changes account bytecode, so all
 * CREATE2-derived smart account addresses change. The paymaster is untouched
 * (redeploying it would strand its EntryPoint ETH deposit).
 *
 * After running: update backend .env BLIND_ACCOUNT_FACTORY_ADDRESS (or re-run
 * sync-addresses.ts), re-run the smart-account migration, rewind any
 * submitted-but-unbroadcast tasks, fund the NEW smart accounts, restart workers.
 *
 * Usage (EXPECTED_ESCROW = the escrow of the stack whose aa- record you mean;
 * add DEPLOYMENT_SET=staging for the staging stack):
 *   EXPECTED_ESCROW=0x... npx hardhat run scripts/redeploy-blindaccount-factory.ts --network base-sepolia
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import { assertSafeNetwork } from "./_guard";
import { preflightDeploy, recordPath } from "./_deployments";
import { assertAaChain } from "./_settlement";

const ENTRYPOINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

async function main() {
  await assertSafeNetwork();
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  assertAaChain(chainId);
  const target = preflightDeploy({ chainId, deploysEscrow: false });
  const outPath = recordPath(chainId, target.set, "aa-");
  if (!fs.existsSync(outPath)) throw new Error(`No existing deployment file at ${outPath}`);
  const prev = JSON.parse(fs.readFileSync(outPath, "utf-8"));

  const paymasterAddr: string = prev.contracts.USDCPaymaster;
  const usdcAddr: string = prev.contracts.USDC;
  const entrypoint: string = prev.contracts.EntryPoint ?? ENTRYPOINT_V07;
  console.log("Reusing paymaster:", paymasterAddr);
  console.log("USDC:", usdcAddr);
  console.log("EntryPoint:", entrypoint);

  console.log("\n--- Deploying new BlindAccountFactory ---");
  const Factory = await ethers.getContractFactory("BlindAccountFactory");
  const factory = await Factory.deploy(entrypoint, usdcAddr, paymasterAddr);
  const deployTx = factory.deploymentTransaction();
  console.log("Deploy tx:", deployTx?.hash);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("BlindAccountFactory:", factoryAddr);
  // Public RPCs can serve stale state right after deployment — wait for code.
  for (let i = 0; i < 30; i++) {
    const code = await ethers.provider.getCode(factoryAddr);
    if (code && code !== "0x") break;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  const implAddr: string = await factory.accountImplementation();
  console.log("BlindAccountFactory:", factoryAddr);
  console.log("BlindAccountImplementation:", implAddr);
  if (implAddr.toLowerCase() === String(prev.contracts.BlindAccountImplementation).toLowerCase()) {
    throw new Error("Implementation address unchanged — the BlindAccount fix may not have compiled in. Aborting before overwriting the deployment file.");
  }

  // Sanity: deploy one account through the new factory.
  console.log("\n--- Test: deploying a BlindAccount ---");
  const salt = ethers.keccak256(ethers.toUtf8Bytes("redeploy-test-" + Date.now()));
  const tx = await factory.createAccount(deployer.address, salt);
  const receipt = await tx.wait();
  console.log("Test account deployed, gas used:", receipt?.gasUsed.toString());

  prev.contracts.BlindAccountFactory = factoryAddr;
  prev.contracts.BlindAccountImplementation = implAddr;
  prev.timestamp = new Date().toISOString();
  prev.note =
    "ERC-4337 AA infrastructure — agents pay gas in USDC instead of ETH. " +
    "Factory redeployed: BlindAccount.execute now allows the EntryPoint (onlyEntryPointOrOwner); " +
    "strict onlyOwner reverted every live UserOp. Smart account addresses changed — re-migrate agents.";
  fs.writeFileSync(outPath, JSON.stringify(prev, null, 2));
  console.log("\nUpdated:", outPath);
  console.log(JSON.stringify(prev.contracts, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
