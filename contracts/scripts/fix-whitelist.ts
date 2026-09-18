// Whitelist the native 0G token (address(0)) on the LIVE BlindEscrow.
//
// Background: until this script lands correctly, posters using native-0G saw
// every `createTask` revert with `TokenNotAllowed()`. The previous version of
// this file hardcoded an address that no longer matched the deployed contract,
// so re-running it had no effect on the live system — phantom tasks (Redis
// meta written speculatively before the tx, no on-chain counterpart) piled up
// and agents got stuck retrying NOT_INDEXED forever.
//
// Address resolution order:
//   1. CLI arg:    pnpm hardhat run scripts/fix-whitelist.ts --network <net> -- <address>
//   2. ENV:        BLIND_ESCROW_ADDRESS (same source of truth as backend/.env)
//   3. Deployments file for the active network
//
// The script refuses to run if no address is resolvable, instead of falling
// back to a hardcoded value that goes stale across redeploys.

import { ethers, network } from "../lib/hh.js";
import { loadDeployment, DEPLOY_FILES } from "./_deployments.js";

/** 0G chain ids. This script whitelists the NATIVE token (address(0)), which
 *  on 0G is 0G itself. On Base, address(0) is ETH — whitelisting it on a USDC
 *  settlement escrow is not a thing we ever want, so the script refuses rather
 *  than doing it by accident. */
const OG_CHAIN_IDS = new Set([16661, 16602]);

async function resolveEscrowAddress(chainId: number): Promise<string> {
  const fromArg = process.argv.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  if (fromArg) return ethers.getAddress(fromArg);

  const fromEnv = process.env.BLIND_ESCROW_ADDRESS;
  if (fromEnv && /^0x[0-9a-fA-F]{40}$/.test(fromEnv)) return ethers.getAddress(fromEnv);

  // Resolve by chainId, never by network.name. The old code did
  // `network.name.includes("mainnet") ? "0g-mainnet" : "0g-testnet"`, so
  // `--network base` (hardhat's key for Base MAINNET, which does not contain
  // "mainnet") silently resolved a 0G escrow address while connected to Base.
  //
  // Measured, not assumed: that did NOT reach the admin-gated write. The 0G
  // address holds no code on Base, so `escrow.admin()` fails first with
  // ethers BAD_DATA ("could not decode result data") and main() throws. The
  // resolution is silently wrong; the script is loud. Same shape as the
  // worked example in CLAUDE.md — whether a wrong-chain call reverts or
  // succeeds depends on whether that address happens to hold code over there,
  // which is luck, not a safety property. Hence resolving by chainId.
  const rec = await loadDeployment(chainId);
  const addr = rec.contracts?.BlindEscrow;
  if (addr && /^0x[0-9a-fA-F]{40}$/.test(addr)) return ethers.getAddress(addr);

  throw new Error(
    "Could not resolve BlindEscrow address. Pass as CLI arg, set BLIND_ESCROW_ADDRESS env, " +
      `or populate contracts/deployments/${DEPLOY_FILES[chainId] ?? `<chainId ${chainId}>`}`,
  );
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (!OG_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `Refusing to run on chainId ${chainId} (${network.name}). This script whitelists the ` +
        `native token (address(0)); that is only meaningful on 0G. Base settles in USDC, ` +
        `which deploy-base.ts already whitelists.`,
    );
  }

  const escrowAddr = await resolveEscrowAddress(chainId);
  const nativeAddr = "0x0000000000000000000000000000000000000000";

  console.log(`Network:  ${network.name} (chainId ${chainId})`);
  console.log(`Escrow:   ${escrowAddr}`);

  const BlindEscrow = await ethers.getContractFactory("BlindEscrow");
  const escrow = BlindEscrow.attach(escrowAddr);

  const [signer] = await ethers.getSigners();
  const admin = await escrow.admin();
  console.log(`Admin:    ${admin}`);
  console.log(`Signer:   ${signer.address}`);
  if (admin.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Signer ${signer.address} is not the contract admin (${admin}). ` +
        `Use the admin key — allowToken is admin-gated.`,
    );
  }

  const before = await escrow.allowedTokens(nativeAddr);
  console.log(`native allowed (before): ${before}`);

  if (before) {
    console.log("Already whitelisted — nothing to do.");
    return;
  }

  console.log("Sending allowToken(0x0)…");
  const tx = await escrow.allowToken(nativeAddr);
  console.log(`tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`confirmed: block=${receipt?.blockNumber} status=${receipt?.status}`);

  const after = await escrow.allowedTokens(nativeAddr);
  console.log(`native allowed (after):  ${after}`);
  if (!after) throw new Error("Whitelist tx confirmed but allowedTokens still false — investigate.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
