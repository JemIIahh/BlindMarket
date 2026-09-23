/**
 * Deploy ERC-4337 AA infrastructure on a CCTP source chain:
 *   1. USDCPaymaster (charges USDC instead of native gas)
 *   2. BlindAccountFactory (deterministic smart account deployment)
 *   3. Fund paymaster with native gas from deployer
 *   4. Test: deploy a BlindAccount, send it USDC, submit a UserOp via bundler
 *
 * External wallets pay source-chain gas in USDC through this: their
 * BlindAccount runs approve+burn as a UserOp, the paymaster fronts native
 * gas and takes USDC in postOp. Refuses Arc (5042, 5042002): it pays gas in
 * USDC natively.
 *
 * Writes (merges into) aa-<chain record>.json in the DEPLOYMENT_SET. On a
 * shared chain EXPECTED_ESCROW must name the escrow of the stack this
 * belongs to.
 *
 * Usage:
 *   DEPLOYMENT_SET=staging EXPECTED_ESCROW=0x... PRIVATE_KEY=0x... \
 *     npx hardhat run scripts/deploy-aa.ts --network base-sepolia
 *   npx hardhat run scripts/deploy-aa.ts --network ethereum-sepolia
 *   npx hardhat run scripts/deploy-aa.ts --network arbitrum-sepolia
 *
 * Env:
 *   PM_FUND_NATIVE — native gas to deposit at the paymaster (default "0.003")
 *   PM_NATIVE_PRICE_USDC — native token price in USDC with 6 decimals
 *     (default "3000000000" = 3000 USDC; override per chain, e.g. POL/MATIC
 *     is far cheaper than ETH)
 */
import * as path from "path";
import { ethers } from "../lib/hh.js";
import { assertSafeNetwork } from "./_guard.js";
import { deploymentFileFor, preflightDeploy, recordPath, writeDeployment } from "./_deployments.js";
import { assertAaChain } from "./_settlement.js";
import { checkSettlementToken } from "./_settlement-deploy.js";

// USDC ERC-20 per chain. Mirrors backend/src/config.ts CCTP_*_USDC_ADDRESS
// defaults (the backend prices and allowlists from the same table); the
// on-chain checkSettlementToken below re-verifies decimals/symbol before
// anything is deployed, so a drifted entry fails loudly instead of binding
// the paymaster to the wrong token.
const CHAIN_USDC: Record<number, string> = {
  8453:  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
  1:      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Ethereum
  11155111: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // Ethereum Sepolia
  42161:  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Arbitrum
  421614: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", // Arbitrum Sepolia
  11155420: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7", // Optimism Sepolia
  137:    "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // Polygon PoS
  80002:  "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582", // Polygon Amoy
};

// Native gas coin per chain, for balance messages only.
const CHAIN_GAS: Record<number, string> = {
  137: "POL",
  80002: "POL",
};

const ENTRYPOINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

async function main() {
  await assertSafeNetwork();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  // Arc pays gas in USDC natively: no USDCPaymaster there, whatever
  // BASE_USDC above ever lists. Checked before anything else is read.
  assertAaChain(chainId);

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const gasSymbol = CHAIN_GAS[chainId] ?? "ETH";
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), gasSymbol);

  if (balance === 0n) {
    throw new Error(`Deployer has 0 ${gasSymbol} balance. Fund it with ${gasSymbol} on chainId ${chainId}.`);
  }

  console.log("Chain:", network.name, `(chainId: ${chainId})`);

  const usdcAddress = CHAIN_USDC[chainId];
  if (!usdcAddress) {
    throw new Error(`No USDC address for chainId ${chainId}`);
  }
  console.log("USDC:", usdcAddress);
  await checkSettlementToken(usdcAddress);
  console.log("USDC checked: 6 decimals, symbol USDC.");
  console.log("EntryPoint:", ENTRYPOINT_V07);
  const target = preflightDeploy({ chainId, deploysEscrow: false });
  const outPath = recordPath(chainId, target.set, "aa-");

  // ── 1. Deploy USDCPaymaster FIRST (factory needs its address) ──
  const INITIAL_NATIVE_PRICE_USDC = BigInt(process.env.PM_NATIVE_PRICE_USDC || "3000000000"); // 3000.00 USDC/native
  console.log("\n--- Deploying USDCPaymaster ---");
  const Paymaster = await ethers.getContractFactory("USDCPaymaster");
  const paymaster = await Paymaster.deploy(ENTRYPOINT_V07, usdcAddress, INITIAL_NATIVE_PRICE_USDC);
  await paymaster.waitForDeployment();
  const paymasterAddr = await paymaster.getAddress();
  console.log("USDCPaymaster:", paymasterAddr);
  console.log(`Initial ${gasSymbol}/USDC price:`, Number(INITIAL_NATIVE_PRICE_USDC) / 1e6, `USDC/${gasSymbol}`);

  // ── 2. Fund paymaster with native gas (for sponsorship) ──
  const FUND_AMOUNT = ethers.parseEther(process.env.PM_FUND_NATIVE ?? process.env.PM_FUND_ETH ?? "0.003");
  console.log("\n--- Funding paymaster with", ethers.formatEther(FUND_AMOUNT), gasSymbol, "---");
  const depositTx = await paymaster.deposit({ value: FUND_AMOUNT });
  await depositTx.wait();
  // The deposit lives in the EntryPoint's accounting, not the paymaster's
  // own balance (reading that always prints 0 after depositTo).
  const entryPoint = await ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)"],
    ENTRYPOINT_V07,
  );
  const pmDeposit = await entryPoint.balanceOf(paymasterAddr);
  console.log(`Paymaster ${gasSymbol} at EntryPoint:`, ethers.formatEther(pmDeposit));

  // ── 3. Deploy BlindAccountFactory (with paymaster + USDC addresses) ──
  console.log("\n--- Deploying BlindAccountFactory ---");
  const Factory = await ethers.getContractFactory("BlindAccountFactory");
  const factory = await Factory.deploy(ENTRYPOINT_V07, usdcAddress, paymasterAddr);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("BlindAccountFactory:", factoryAddr);

  // ── 4. Test: deploy a BlindAccount via factory ──
  console.log("\n--- Test: deploying a BlindAccount ---");
  const testSalt = ethers.keccak256(ethers.toUtf8Bytes("test-account-" + Date.now()));

  // Compute CREATE2 address off-chain (factory.getAddress no longer exists
  // because the viaIR optimizer miscompiles address() inside view functions).
  const baFactory = await ethers.getContractFactory("BlindAccount");
  const testConstructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address"],
    [deployer.address, usdcAddress, paymasterAddr],
  );
  const testInitCode = ethers.concat([baFactory.bytecode, testConstructorArgs]);
  const testInitCodeHash = ethers.keccak256(testInitCode);
  const testAddr = ethers.getCreate2Address(factoryAddr, testSalt, testInitCodeHash);
  console.log("Counterfactual address:", testAddr);

  const createTx = await factory.createAccount(deployer.address, testSalt);
  const receipt = await createTx.wait();
  console.log("BlindAccount deployed at:", testAddr);
  console.log("Gas used:", receipt?.gasUsed.toString());

  // ── 5. Save deployment ──
  const networkName = path.basename(deploymentFileFor(chainId), ".json");
  const deployment = writeDeployment(outPath, {
    network: networkName,
    chainId,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    note: "ERC-4337 AA infrastructure — users pay gas in USDC instead of native gas.",
    contracts: {
      USDCPaymaster: paymasterAddr,
      BlindAccountFactory: factoryAddr,
      BlindAccountImplementation: await factory.accountImplementation(),
      EntryPoint: ENTRYPOINT_V07,
      USDC: usdcAddress,
    },
    config: {
      ethPriceInUsdc: INITIAL_NATIVE_PRICE_USDC.toString(),
      maxGasLimit: "1000000",
    },
  });
  console.log("\nDeployment saved to:", outPath);

  console.log("\n=== DEPLOYMENT SUMMARY ===");
  console.log(JSON.stringify(deployment.contracts, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
