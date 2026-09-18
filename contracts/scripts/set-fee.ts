/**
 * Set the BlindEscrow platform fee (feeBps) on the live proxy.
 *
 * The fee is read at settlement from the global `feeBps`, so this takes effect
 * immediately for all unsettled tasks (a reduction pays workers more — safe to
 * run live). Admin-only (`setFeeBps` is `onlyAdmin`) and bounded by the
 * on-chain `MAX_FEE_BPS` (3000 = 30%). Network-aware; no-op if already at target.
 *
 * While admin is still the deployer EOA, run this directly. Once admin is the
 * Safe, execute `setFeeBps(newBps)` through the Safe UI instead (this script
 * will refuse, since the signer won't be admin).
 *
 * Usage:
 *   EXPECTED_ESCROW=0x... NEW_FEE_BPS=1000 npx hardhat run scripts/set-fee.ts --network 0g-testnet
 *   (DEPLOYMENT_SET=staging selects the staging records; EXPECTED_ESCROW is
 *   required on Base Sepolia / 0G testnet, which more than one set uses.)
 *   I_HAVE_READ_MAINNET_CHECKLIST=yes NEW_FEE_BPS=1000 \
 *     npx hardhat run scripts/set-fee.ts --network 0g-mainnet
 */
import { ethers, network } from "../lib/hh.js";
import { assertSafeNetwork } from "./_guard.js";
import { resolveEscrowTarget } from "./_deployments.js";

async function main() {
  await assertSafeNetwork();

  const raw = process.env.NEW_FEE_BPS;
  const newBps = Number(raw);
  if (!Number.isInteger(newBps) || newBps < 0 || newBps > 3000) {
    throw new Error(`NEW_FEE_BPS must be an integer 0..3000 (MAX_FEE_BPS). Got: ${raw}`);
  }

  const { escrow: proxy } = await resolveEscrowTarget({ sends: true });

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer configured — set PRIVATE_KEY in .env");
  const escrow = await ethers.getContractAt("BlindEscrow", proxy);
  const [admin, current] = await Promise.all([(escrow as any).admin(), (escrow as any).feeBps()]);

  console.log(`network: ${network.name}\nBlindEscrow: ${proxy}\nsigner: ${signer.address}\nadmin:  ${admin}`);
  console.log(`current feeBps: ${current} (${Number(current) / 100}%)  →  target: ${newBps} (${newBps / 100}%)`);

  if (Number(current) === newBps) {
    console.log("✓ already at target — no tx sent.");
    return;
  }
  if (admin.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`signer is not admin (${admin}); setFeeBps is onlyAdmin. Run as admin, or via the Safe UI.`);
  }

  const tx = await (escrow as any).setFeeBps(newBps);
  console.log("tx:", tx.hash);
  await tx.wait();

  const after = Number(await (escrow as any).feeBps());
  if (after !== newBps) throw new Error(`post-tx feeBps=${after}, expected ${newBps} — investigate.`);
  console.log(`✓ feeBps is now ${after} (${after / 100}%) on ${network.name}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
