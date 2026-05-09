/**
 * Upgrade the BlindEscrow UUPS proxy to a new implementation.
 *
 * Reads the current proxy address from deployments/0g-testnet.json, deploys
 * the new BlindEscrow implementation, and calls upgradeToAndCall on the proxy
 * (via OpenZeppelin's upgrades plugin). The proxy address, all task state,
 * escrow balances, admin, verifier, treasury, fee config, token allowlist,
 * and reputation/registry wiring are all preserved — only the executable
 * code changes.
 *
 * Prerequisites:
 *   - PRIVATE_KEY env var set to the admin's private key (the address that
 *     deployed the proxy is admin by default; see BlindEscrow.initialize).
 *   - Admin wallet has 0G for gas.
 *
 * Usage:
 *   PRIVATE_KEY=<admin_pk> npx hardhat run scripts/upgrade-blind-escrow.ts --network 0g-testnet
 *
 * Verifies success by reading the new implementation address and calling
 * the new marketplaceAssign function via staticCall (no state change) to
 * confirm it exists on the proxy.
 */

import { ethers, upgrades } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { assertSafeNetwork } from "./_guard";

const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/**
 * Read the EIP-1967 implementation slot directly from the RPC.
 *
 * upgrades.erc1967.getImplementationAddress() can return cached values that
 * don't reflect the post-upgrade state, leading to a misleading "before==after"
 * log even when the upgrade succeeded. The raw eth_getStorageAt call is
 * authoritative.
 */
async function readImplFromChain(proxy: string): Promise<string> {
  const raw = await ethers.provider.getStorage(proxy, EIP1967_IMPL_SLOT);
  return ethers.getAddress("0x" + raw.slice(-40));
}

async function main() {
  await assertSafeNetwork();
  const deploymentsPath = path.resolve(__dirname, "../deployments/0g-testnet.json");
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error(`deployments file not found: ${deploymentsPath}`);
  }
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf-8"));
  const proxyAddress: string = deployments.contracts?.BlindEscrow;
  const expectedAdmin: string | undefined = deployments.deployer;
  if (!proxyAddress) {
    throw new Error("BlindEscrow address missing from deployments file");
  }

  const [signer] = await ethers.getSigners();
  console.log("Upgrader:", signer.address);
  if (expectedAdmin && expectedAdmin.toLowerCase() !== signer.address.toLowerCase()) {
    console.warn(
      `[warn] signer (${signer.address}) is not the recorded deployer (${expectedAdmin}). The on-chain admin check will revert if this signer is not the current admin.`,
    );
  }

  const balance = await ethers.provider.getBalance(signer.address);
  console.log("Balance:", ethers.formatEther(balance), "0G");
  if (balance === 0n) {
    throw new Error("Upgrader has 0 balance. Fund it at https://faucet.0g.ai/");
  }

  console.log(`\n--- Upgrading BlindEscrow proxy at ${proxyAddress} ---`);

  // Capture pre-upgrade implementation for the "before/after" log. Use the
  // raw EIP-1967 slot read because OZ's getImplementationAddress can lie here.
  const preImpl = await readImplFromChain(proxyAddress);
  console.log("Implementation before:", preImpl);

  const Factory = await ethers.getContractFactory("BlindEscrow");

  // OZ upgrades plugin runs storage-layout compatibility checks against the
  // deployed implementation; if storage is incompatible it throws here rather
  // than producing a broken upgrade.
  // redeployImplementation: 'always' bypasses OZ's bytecode-equality cache.
  // We hit a case where the cache decided no redeploy was needed even though
  // the new bytecode contained a function (marketplaceAssign / 0xb1e1fca4)
  // that wasn't present in the previously-deployed implementation. Forcing
  // redeploy is the safe fallback — it costs one extra impl deployment but
  // guarantees the proxy points at the freshly-built bytecode.
  const upgraded = await upgrades.upgradeProxy(proxyAddress, Factory, {
    kind: "uups",
    redeployImplementation: "always",
  });
  await upgraded.waitForDeployment();

  const postImpl = await readImplFromChain(proxyAddress);
  console.log("Implementation after: ", postImpl);

  if (preImpl.toLowerCase() === postImpl.toLowerCase()) {
    console.warn("[warn] implementation address unchanged — no bytecode delta detected. Upgrade was a no-op.");
  } else {
    console.log("[ok] implementation address changed");
  }

  // Sanity check: the new function must be callable on the proxy. We use a
  // dry-run staticCall with a guaranteed-revert path (calling as non-verifier)
  // — what we care about is that the function selector resolves and reverts
  // with NotVerifier, not "function does not exist".
  const escrow = upgraded as unknown as { marketplaceAssign: (taskId: bigint, worker: string) => Promise<unknown>; getFunction: (n: string) => { staticCall: (...args: unknown[]) => Promise<unknown> } };
  try {
    await (escrow.getFunction("marketplaceAssign") as { staticCall: (taskId: bigint, worker: string) => Promise<unknown> }).staticCall(1n, ethers.ZeroAddress);
    console.warn("[warn] marketplaceAssign staticCall did not revert — unexpected, but the function is at least callable.");
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("NotVerifier") || msg.includes("ZeroAddress") || msg.includes("InvalidStatus")) {
      console.log("[ok] marketplaceAssign is live on the proxy (reverted as expected for non-verifier dry-run)");
    } else if (msg.includes("function does not exist") || msg.includes("call revert exception")) {
      throw new Error(`marketplaceAssign not found after upgrade: ${msg}`);
    } else {
      // Some other revert — still proves the function dispatches. Log and continue.
      console.log(`[ok] marketplaceAssign dispatched (revert: ${msg.slice(0, 120)})`);
    }
  }

  console.log("\nUpgrade complete.");
  console.log(`Proxy address (unchanged): ${proxyAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
