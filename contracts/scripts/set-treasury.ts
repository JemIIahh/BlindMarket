/**
 * Set the BlindEscrow treasury — the address that receives the platform fee
 * (the 10%). Admin-only (`setTreasury` is `onlyAdmin`); reverts on the zero
 * address. Network-aware; no-op if already at target.
 *
 * Run while admin is still the deployer EOA. Once admin is the Safe, call
 * `setTreasury(addr)` through the Safe UI instead (this script will refuse).
 *
 * Usage:
 *   EXPECTED_ESCROW=0x... NEW_TREASURY=0xSafe npx hardhat run scripts/set-treasury.ts --network 0g-testnet
 *   (DEPLOYMENT_SET=staging selects the staging records; EXPECTED_ESCROW is
 *   required on Base Sepolia / 0G testnet, which more than one set uses.)
 *   I_HAVE_READ_MAINNET_CHECKLIST=yes NEW_TREASURY=0xSafe \
 *     npx hardhat run scripts/set-treasury.ts --network 0g-mainnet
 */
import { ethers, network } from "../lib/hh.js";
import { assertSafeNetwork } from "./_guard.js";
import { resolveEscrowTarget } from "./_deployments.js";

async function main() {
  await assertSafeNetwork();

  const next = process.env.NEW_TREASURY;
  if (!next || !ethers.isAddress(next) || next === ethers.ZeroAddress) {
    throw new Error(`NEW_TREASURY must be a valid non-zero address. Got: ${next}`);
  }

  const { escrow: proxy } = await resolveEscrowTarget({ sends: true });

  const [signer] = await ethers.getSigners();
  const escrow = await ethers.getContractAt("BlindEscrow", proxy);
  const [admin, current] = await Promise.all([(escrow as any).admin(), (escrow as any).treasury()]);

  console.log(`network: ${network.name}\nBlindEscrow: ${proxy}\nsigner: ${signer.address}\nadmin: ${admin}`);
  console.log(`current treasury: ${current}  →  new: ${ethers.getAddress(next)}`);

  if (ethers.getAddress(current) === ethers.getAddress(next)) { console.log("✓ already set — no tx sent."); return; }
  if (admin.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`signer is not admin (${admin}); setTreasury is onlyAdmin — run as admin or via the Safe UI.`);
  }

  const tx = await (escrow as any).setTreasury(next);
  console.log("tx:", tx.hash);
  await tx.wait();
  const after = await (escrow as any).treasury();
  if (ethers.getAddress(after) !== ethers.getAddress(next)) throw new Error(`post-tx treasury=${after}, expected ${next}`);
  console.log(`✓ treasury is now ${after} on ${network.name} — the 10% fee now lands here.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
