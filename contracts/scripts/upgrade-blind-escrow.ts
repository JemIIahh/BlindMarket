/**
 * Upgrade the BlindEscrow UUPS proxy to the currently compiled implementation.
 *
 * Reads the proxy address from the connected chain's deployment record in the
 * DEPLOYMENT_SET (EXPECTED_ESCROW required on Base Sepolia / 0G testnet). Deploys a new implementation ONLY if the compiled bytecode
 * actually differs from what's live (redeployImplementation defaults to
 * 'onchange'); a genuine no-op otherwise. The proxy address, all task state,
 * escrow balances, admin, verifier, treasury, fee config, token allowlist, and
 * reputation/registry wiring are preserved — only the code changes.
 *
 * The output is UNAMBIGUOUS: it always ends by verifying that the proxy's live
 * code is byte-equivalent to the compiled BlindEscrow (normalizing the UUPS
 * __self immutable), and reports either "upgraded & verified" or "already
 * current & verified" — never a bare "no-op" you have to second-guess.
 *
 * (History: this script used to force redeployImplementation:'always', which
 * deployed a throwaway impl every run and, combined with a stale post-tx RPC
 * read, made a SUCCESSFUL upgrade print as a no-op. Both are fixed here.)
 *
 * Prerequisites:
 *   - PRIVATE_KEY = the current admin (the proxy deployer by default).
 *   - Admin funded with 0G for gas.
 *   - scripts/validate-escrow-upgrade.ts (read-only storage check) — also
 *     enforced here as a hard gate.
 *
 * Usage:
 *   EXPECTED_ESCROW=<escrow> PRIVATE_KEY=<admin_pk> npx hardhat run scripts/upgrade-blind-escrow.ts --network 0g-testnet
 *   PRIVATE_KEY=<admin_pk> npx hardhat run scripts/upgrade-blind-escrow.ts --network 0g-mainnet
 */

import { gasSymbolFor } from "./_settlement";
import { ethers, upgrades } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { assertSafeNetwork } from "./_guard";
import { resolveEscrowTarget } from "./_deployments";

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** Authoritative EIP-1967 impl read (OZ's helper can serve stale cached values
 *  right after an upgrade). */
async function readImpl(proxy: string): Promise<string> {
  const raw = await ethers.provider.getStorage(proxy, IMPL_SLOT);
  return ethers.getAddress("0x" + raw.slice(-40));
}

/** Two deployments of identical source differ only in the UUPS __self immutable
 *  (each impl stores address(this)). Zero it out so bytecode can be compared. */
function normalizeSelf(code: string, impl: string): string {
  const a = impl.toLowerCase().replace(/^0x/, "");
  return code.toLowerCase().split(a).join("0".repeat(40));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await assertSafeNetwork();

  const { escrow: proxy, record: deployments } = await resolveEscrowTarget({ sends: true });
  const expectedAdmin: string | undefined = deployments.deployer;

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer configured — set PRIVATE_KEY in .env");
  console.log("Upgrader:", signer.address);
  if (expectedAdmin && expectedAdmin.toLowerCase() !== signer.address.toLowerCase()) {
    console.warn(
      `[warn] signer (${signer.address}) is not the recorded deployer (${expectedAdmin}); the on-chain admin check will revert if it isn't the current admin.`,
    );
  }
  const balance = await ethers.provider.getBalance(signer.address);
  const gas = gasSymbolFor(Number((await ethers.provider.getNetwork()).chainId));
  console.log("Balance:", ethers.formatEther(balance), gas);
  if (balance === 0n) throw new Error(`Upgrader has 0 ${gas}. Fund it${gas === "0G" ? " at https://faucet.0g.ai/" : ""}.`);

  const Factory = await ethers.getContractFactory("BlindEscrow");

  // Hard storage-layout gate (same check as validate-escrow-upgrade.ts).
  await upgrades.validateUpgrade(proxy, Factory, { kind: "uups" });
  console.log("[ok] storage layout compatible");

  const preImpl = await readImpl(proxy);
  console.log(`\n--- Upgrading BlindEscrow proxy ${proxy} ---`);
  console.log("Implementation before:", preImpl);

  const upgraded = await upgrades.upgradeProxy(proxy, Factory, { kind: "uups" });
  await upgraded.waitForDeployment();

  // Authoritative post-upgrade impl read, retrying through RPC lag.
  let postImpl = await readImpl(proxy);
  for (let i = 0; i < 8 && postImpl === preImpl; i++) {
    await sleep(1500);
    postImpl = await readImpl(proxy);
  }
  console.log("Implementation after: ", postImpl);

  // ── Verification gate ──────────────────────────────────────────────────────
  // The proxy's live code MUST be byte-equivalent to the freshly compiled
  // BlindEscrow (after zeroing __self). Catches a silently-skipped upgrade AND a
  // stale address read — turning the old ambiguous "no-op" into a real verdict.
  const liveCode = await ethers.provider.getCode(postImpl);
  const artifact = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../artifacts/contracts/BlindEscrow.sol/BlindEscrow.json"), "utf-8"),
  );
  const compiled: string =
    typeof artifact.deployedBytecode === "string" ? artifact.deployedBytecode : artifact.deployedBytecode.object;

  const verified = normalizeSelf(liveCode, postImpl) === normalizeSelf(compiled, postImpl);
  if (!verified) {
    throw new Error(
      "VERIFICATION FAILED: the proxy's live implementation is NOT byte-equivalent to the " +
        "compiled BlindEscrow. Do NOT trust this upgrade — investigate before proceeding.",
    );
  }

  if (postImpl.toLowerCase() === preImpl.toLowerCase()) {
    console.log("\n✓ Already current & VERIFIED — the proxy already runs the compiled BlindEscrow (no upgrade needed).");
  } else {
    console.log("\n✓ Upgraded & VERIFIED — the proxy now runs the compiled BlindEscrow.");
  }
  console.log(`Proxy address (unchanged): ${proxy}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
