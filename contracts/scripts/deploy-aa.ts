/**
 * Deploy ERC-4337 AA infrastructure on Base Sepolia:
 *   1. USDCPaymaster (charges USDC instead of ETH for gas)
 *   2. BlindAccountFactory (deterministic smart account deployment)
 *   3. Fund paymaster with ETH from deployer
 *   4. Test: deploy a BlindAccount, send it USDC, submit a UserOp via bundler
 *
 * Refuses Arc (5042, 5042002): it pays gas in USDC natively.
 *
 * Writes (merges into) aa-<chain record>.json in the DEPLOYMENT_SET. On Base
 * Sepolia EXPECTED_ESCROW must name the escrow of the stack this belongs to
 * (so deploy-base.ts runs first for a new set).
 *
 * Usage:
 *   DEPLOYMENT_SET=staging EXPECTED_ESCROW=0x... PRIVATE_KEY=0x... \
 *     npx hardhat run scripts/deploy-aa.ts --network base-sepolia
 */
import { ethers } from "hardhat";
import { assertSafeNetwork } from "./_guard";
import { preflightDeploy, recordPath, writeDeployment } from "./_deployments";
import { assertAaChain } from "./_settlement";

const BASE_USDC: Record<number, string> = {
  8453:  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
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

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("ETH Balance:", ethers.formatEther(balance), "ETH");

  if (balance === 0n) {
    throw new Error("Deployer has 0 ETH balance. Fund with Base Sepolia ETH.");
  }

  console.log("Chain:", network.name, `(chainId: ${chainId})`);

  const usdcAddress = BASE_USDC[chainId];
  if (!usdcAddress) {
    throw new Error(`No USDC address for chainId ${chainId}`);
  }
  console.log("USDC:", usdcAddress);
  console.log("EntryPoint:", ENTRYPOINT_V07);
  const target = preflightDeploy({ chainId, deploysEscrow: false });
  const outPath = recordPath(chainId, target.set, "aa-");

  // ── 1. Deploy USDCPaymaster FIRST (factory needs its address) ──
  const INITIAL_ETH_PRICE_USDC = 3_000_000_000n; // 3000.00 USDC/ETH
  console.log("\n--- Deploying USDCPaymaster ---");
  const Paymaster = await ethers.getContractFactory("USDCPaymaster");
  const paymaster = await Paymaster.deploy(ENTRYPOINT_V07, usdcAddress, INITIAL_ETH_PRICE_USDC);
  await paymaster.waitForDeployment();
  const paymasterAddr = await paymaster.getAddress();
  console.log("USDCPaymaster:", paymasterAddr);
  console.log("Initial ETH/USDC price:", Number(INITIAL_ETH_PRICE_USDC) / 1e6, "USDC/ETH");

  // ── 2. Fund paymaster with ETH (for gas sponsorship) ──
  const FUND_AMOUNT = ethers.parseEther(process.env.PM_FUND_ETH || "0.003");
  console.log("\n--- Funding paymaster with", ethers.formatEther(FUND_AMOUNT), "ETH ---");
  const depositTx = await paymaster.deposit({ value: FUND_AMOUNT });
  await depositTx.wait();
  const pmEthBal = await ethers.provider.getBalance(paymasterAddr);
  console.log("Paymaster ETH at EntryPoint:", ethers.formatEther(pmEthBal));

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
  const networkName = chainId === 8453 ? "base-mainnet" : "base-sepolia";
  const deployment = writeDeployment(outPath, {
    network: networkName,
    chainId,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    note: "ERC-4337 AA infrastructure — agents pay gas in USDC instead of ETH.",
    contracts: {
      USDCPaymaster: paymasterAddr,
      BlindAccountFactory: factoryAddr,
      BlindAccountImplementation: await factory.accountImplementation(),
      EntryPoint: ENTRYPOINT_V07,
      USDC: usdcAddress,
    },
    config: {
      ethPriceInUsdc: INITIAL_ETH_PRICE_USDC.toString(),
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
