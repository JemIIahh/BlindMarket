/**
 * Redeploy the (non-upgradeable) ValidatorPool as a fresh contract and re-wire it.
 *
 * ValidatorPool is a plain contract, NOT a UUPS proxy, so the security fixes
 * (#10 stake-lock + anti-freeze, #24 openDispute allow-list, MAX_VOTERS cap) ship
 * as a fresh deployment rather than an upgrade. The pool is currently dormant and
 * unwired, so orphaning the previous instance loses no live state.
 *
 * Stake token (ValidatorPool constructor arg):
 *   - Testnet / local: reuses the DummyStake (MockERC20) recorded in the
 *     deployments file if present; otherwise deploys a fresh MockERC20.
 *   - Mainnet: 0G mainnet has NO deployed stake ERC-20. You MUST decide and pass
 *     STAKE_TOKEN=<erc20 address> — the script refuses to guess. (The old script
 *     hardcoded 0x3af9…, which is the BlindReputation contract, not a token —
 *     staking against it would revert on safeTransferFrom.)
 *
 * Post-deploy wiring:
 *   - setAuthorizedEscrow(BlindEscrow, true): after #24, openDispute is gated to
 *     allow-listed escrows. NOTE: BlindEscrow does not yet CALL openDispute — the
 *     escrow<->pool wiring is separate future work — so this is forward-looking
 *     but correct (the deployer is the pool admin).
 *
 * Updates the connected chain's record in the DEPLOYMENT_SET in place
 * (EXPECTED_ESCROW=<that record's escrow> required on 0G testnet).
 *
 * Usage:
 *   EXPECTED_ESCROW=0x… npx hardhat run scripts/redeploy-validator-pool.ts --network 0g-testnet
 *   STAKE_TOKEN=0x… npx hardhat run scripts/redeploy-validator-pool.ts --network 0g-mainnet
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import { assertSafeNetwork, assertZeroGChain } from "./_guard";
import { resolveEscrowTarget } from "./_deployments";

const LOCAL_OR_TESTNET = new Set<number>([16602, 31337, 1337, 11155111]);

async function main() {
  await assertSafeNetwork();
  assertZeroGChain(Number((await ethers.provider.getNetwork()).chainId), "redeploy-validator-pool.ts");

  const { file: depPath, record: dep } = await resolveEscrowTarget({ sends: true });
  const contracts = dep.contracts;

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "0G");
  if (balance === 0n) throw new Error("Deployer has 0 balance. Fund it at https://faucet.0g.ai/");

  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  // ── Resolve the stake token ────────────────────────────────────────────────
  let stakeToken: string | undefined = process.env.STAKE_TOKEN || contracts.DummyStake;
  if (!stakeToken) {
    if (LOCAL_OR_TESTNET.has(chainId)) {
      console.log("\n--- No stake token recorded — deploying a fresh MockERC20 (testnet) ---");
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const mock = await MockERC20.deploy("BlindStake", "BST", 18);
      await mock.waitForDeployment();
      stakeToken = await mock.getAddress();
      contracts.DummyStake = stakeToken;
      console.log("Dummy stake token:", stakeToken);
    } else {
      throw new Error(
        "No stake token available. 0G mainnet has no deployed stake ERC-20 — decide it " +
          "and pass STAKE_TOKEN=<address>. Do NOT reuse a non-token address.",
      );
    }
  } else {
    console.log("Stake token:", stakeToken, process.env.STAKE_TOKEN ? "(from STAKE_TOKEN)" : "(recorded DummyStake)");
  }

  // ── Deploy ─────────────────────────────────────────────────────────────────
  console.log("\n--- Deploying ValidatorPool ---");
  const ValidatorPool = await ethers.getContractFactory("ValidatorPool");
  const pool = await ValidatorPool.deploy(stakeToken);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log("ValidatorPool:", poolAddr);

  // ── Wire: authorize the escrow to open disputes (#24) ──────────────────────
  const escrowAddr: string | undefined = contracts.BlindEscrow;
  if (escrowAddr) {
    console.log(`\n--- setAuthorizedEscrow(${escrowAddr}, true) ---`);
    await (await pool.setAuthorizedEscrow(escrowAddr, true)).wait();
    console.log(
      "[ok] escrow allow-listed for openDispute (note: BlindEscrow does not call " +
        "openDispute yet — escrow<->pool wiring is separate work)",
    );
  } else {
    console.warn("[warn] no BlindEscrow address recorded — skipping setAuthorizedEscrow");
  }

  // ── Persist ────────────────────────────────────────────────────────────────
  contracts.ValidatorPool = poolAddr;
  dep.validatorPoolRedeployedAt = new Date().toISOString();
  fs.writeFileSync(depPath, JSON.stringify(dep, null, 2));
  console.log("\nUpdated:", depPath);
  console.log("→ Update VALIDATOR_POOL_ADDRESS in the backend .env and the frontend constants.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
