/**
 * Rotate the on-chain verifier role on BlindEscrow.
 *
 * Calls escrow.setVerifier(newAddr) using the deployer/admin key in
 * contracts/.env (PRIVATE_KEY). Reads the new address from the
 * MARKETPLACE_SIGNER_ADDRESS env var (or process.argv[2] as fallback).
 * Verifies the rotation by re-reading the verifier slot from the live RPC.
 *
 * Usage:
 *   MARKETPLACE_SIGNER_ADDRESS=0x... npx hardhat run scripts/rotate-verifier.ts --network 0g-mainnet
 *   DEPLOYMENT_SET=staging EXPECTED_ESCROW=0x... MARKETPLACE_SIGNER_ADDRESS=0x... \
 *     npx hardhat run scripts/rotate-verifier.ts --network base-sepolia
 * On Base Sepolia / 0G testnet (used by more than one deployment set)
 * EXPECTED_ESCROW is required and must equal the resolved escrow.
 *
 * Pre-requisites:
 *   - PRIVATE_KEY in contracts/.env is the current admin (BlindEscrow.admin())
 *   - The new address has been funded with the chain's gas coin (0G, ETH on
 *     Base, USDC on Arc) so it can later send transactions; setVerifier
 *     itself is paid by the admin, not the new verifier.
 */

import { ethers } from "hardhat";
import { assertSafeNetwork } from "./_guard";
import { resolveEscrowTarget } from "./_deployments";

async function main() {
  await assertSafeNetwork();
  const newAddr = process.env.MARKETPLACE_SIGNER_ADDRESS ?? process.argv[2];
  if (!newAddr || !/^0x[0-9a-fA-F]{40}$/.test(newAddr)) {
    throw new Error(
      "Provide the new verifier address via MARKETPLACE_SIGNER_ADDRESS=0x... or as the first argument.",
    );
  }

  const { escrow: proxyAddress } = await resolveEscrowTarget({ sends: true });

  const [signer] = await ethers.getSigners();
  console.log("Signer (must be admin):", signer.address);

  const escrow = await ethers.getContractAt("BlindEscrow", proxyAddress, signer);

  // Pre-flight checks
  const onChainAdmin = await (escrow as unknown as { admin: () => Promise<string> }).admin();
  if (onChainAdmin.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Signer is not the admin. on-chain admin=${onChainAdmin}, signer=${signer.address}. ` +
        "Update PRIVATE_KEY in contracts/.env to the admin's key.",
    );
  }

  const currentVerifier = await (escrow as unknown as { verifier: () => Promise<string> }).verifier();
  console.log("Current verifier:", currentVerifier);
  console.log("New verifier:    ", newAddr);

  if (currentVerifier.toLowerCase() === newAddr.toLowerCase()) {
    console.log("[noop] verifier already set to that address — nothing to do.");
    return;
  }

  console.log("\nSending setVerifier tx...");
  const tx = await (escrow as unknown as { setVerifier: (a: string) => Promise<{ hash: string; wait: () => Promise<{ status?: number; blockNumber?: number }> }> })
    .setVerifier(newAddr);
  console.log("  tx hash:", tx.hash);
  const receipt = await tx.wait();
  console.log(`  confirmed in block ${receipt?.blockNumber} (status=${receipt?.status})`);

  // Re-read from chain to confirm
  const finalVerifier = await (escrow as unknown as { verifier: () => Promise<string> }).verifier();
  if (finalVerifier.toLowerCase() !== newAddr.toLowerCase()) {
    throw new Error(
      `Rotation did not stick. Expected ${newAddr}, on-chain reads ${finalVerifier}.`,
    );
  }
  console.log("\n[ok] verifier rotation confirmed on chain:", finalVerifier);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
