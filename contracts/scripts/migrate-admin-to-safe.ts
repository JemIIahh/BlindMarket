/**
 * Migrate admin / ownership of the mainnet contracts to a Gnosis Safe.
 *
 * Roles today are a single hot EOA — this hands control to a multisig. Run
 * while the deployer EOA is still admin (it signs the propose/transfer txs).
 *
 *   - BlindEscrow / BlindReputation / TaskRegistry: `proposeAdmin(SAFE)`.
 *     TWO-STEP and reversible — the Safe must then call `acceptAdmin()` from the
 *     Safe UI to actually take control. Until it does, the EOA stays admin.
 *   - AgentFactory: `transferOwnership(SAFE)`. Ownable2Step (OpenZeppelin) —
 *     also TWO-STEP and reversible, but a DIFFERENT function pair
 *     (transferOwnership/acceptOwnership + owner()) than the custom
 *     proposeAdmin/acceptAdmin/admin() the contracts above use, so it can't
 *     share the twoStep loop. Only present on Base deployments.
 *   - INFT: `transferOwnership(SAFE)`. ONE-STEP and IRREVERSIBLE. Gated behind
 *     INCLUDE_INFT=yes so it can't happen by accident. INFT is dormant (see
 *     MAINNET-DECISIONS.md §5); you may prefer to leave it and move it when the
 *     iNFT feature is activated.
 *
 * Guards: SAFE_ADDRESS must be a DEPLOYED CONTRACT (has bytecode) — this is the
 * main defense against handing the protocol to a mistyped EOA. Each contract is
 * skipped if it's absent from this chain's deployment file, or if the EOA
 * isn't its current admin/owner (idempotent-ish).
 *
 * Usage:
 *   I_HAVE_READ_MAINNET_CHECKLIST=yes SAFE_ADDRESS=0xSafe \
 *     npx hardhat run scripts/migrate-admin-to-safe.ts --network 0g-mainnet
 *   # add INCLUDE_INFT=yes to also transfer INFT ownership (irreversible)
 *
 * AFTER this runs: from the Safe, call acceptAdmin() on BlindEscrow /
 * BlindReputation / TaskRegistry, and acceptOwnership() on AgentFactory.
 * Verify with verify-deployment-config.ts.
 */
import { ethers, network } from "../lib/hh.js";
import { assertSafeNetwork } from "./_guard.js";
import { loadDeployment } from "./_deployments.js";

async function main() {
  await assertSafeNetwork();

  const safe = process.env.SAFE_ADDRESS;
  if (!safe || !ethers.isAddress(safe) || safe === ethers.ZeroAddress) {
    throw new Error(`SAFE_ADDRESS must be a valid non-zero address. Got: ${safe}`);
  }
  const safeAddr = ethers.getAddress(safe);

  // Primary guard: a real Safe is a contract. Refuse to hand control to an EOA.
  const code = await ethers.provider.getCode(safeAddr);
  if (code === "0x") {
    throw new Error(`SAFE_ADDRESS ${safeAddr} has NO bytecode — it is not a deployed contract. ` +
      `Refusing to migrate control to a possibly-mistyped EOA.`);
  }

  const dep = await loadDeployment();
  const c = dep.contracts;
  const [signer] = await ethers.getSigners();
  console.log(`network: ${network.name}\nsigner (deployer EOA): ${signer.address}\ntarget Safe: ${safeAddr}\n`);

  // 2-step UUPS contracts: proposeAdmin (reversible; Safe must acceptAdmin after).
  // Not every chain's deployment file has all three — Base, for instance, only
  // deploys BlindEscrow — so a missing address is a SKIP, not a crash.
  const twoStep = [
    { name: "BlindEscrow", addr: c.BlindEscrow, art: "BlindEscrow" },
    { name: "BlindReputation", addr: c.BlindReputation, art: "BlindReputation" },
    { name: "TaskRegistry", addr: c.TaskRegistry, art: "TaskRegistry" },
  ];
  for (const t of twoStep) {
    if (!t.addr) {
      console.log(`- ${t.name}: no address in this deployment file — SKIP.`);
      continue;
    }
    const ct = await ethers.getContractAt(t.art, t.addr);
    const admin = await (ct as any).admin();
    if (admin.toLowerCase() !== signer.address.toLowerCase()) {
      console.log(`- ${t.name}: admin is ${admin} (not the signer) — SKIP.`);
      continue;
    }
    const tx = await (ct as any).proposeAdmin(safeAddr);
    await tx.wait();
    console.log(`- ${t.name}: proposeAdmin(${safeAddr}) ✓ (tx ${tx.hash}) — Safe must acceptAdmin().`);
  }

  // AgentFactory: Ownable2Step (OpenZeppelin) — transferOwnership() then the
  // Safe must call acceptOwnership() from the Safe UI. Two-step and
  // reversible until accepted, same as the contracts above, but a different
  // function pair so it can't reuse the twoStep loop. Only present on Base.
  if (!c.AgentFactory) {
    console.log(`- AgentFactory: no address in this deployment file — SKIP.`);
  } else {
    const factory = await ethers.getContractAt("AgentFactory", c.AgentFactory);
    const owner = await (factory as any).owner();
    if (owner.toLowerCase() !== signer.address.toLowerCase()) {
      console.log(`- AgentFactory: owner is ${owner} (not the signer) — SKIP.`);
    } else {
      const tx = await (factory as any).transferOwnership(safeAddr);
      await tx.wait();
      console.log(`- AgentFactory: transferOwnership(${safeAddr}) ✓ (tx ${tx.hash}) — Safe must acceptOwnership().`);
    }
  }

  // 1-step INFT (irreversible) — opt-in only.
  if (process.env.INCLUDE_INFT === "yes") {
    if (!c.INFT) {
      console.log(`- INFT: no address in this deployment file — SKIP.`);
    } else {
      const inft = await ethers.getContractAt("INFT", c.INFT);
      const owner = await (inft as any).owner();
      if (owner.toLowerCase() !== signer.address.toLowerCase()) {
        console.log(`- INFT: owner is ${owner} (not the signer) — SKIP.`);
      } else {
        const tx = await (inft as any).transferOwnership(safeAddr);
        await tx.wait();
        console.log(`- INFT: transferOwnership(${safeAddr}) ✓ (tx ${tx.hash}) — IRREVERSIBLE, done.`);
      }
    }
  } else {
    console.log(`- INFT: skipped (set INCLUDE_INFT=yes to transfer its ownership — irreversible).`);
  }

  console.log(`\nNEXT: from the Safe UI, call acceptAdmin() on BlindEscrow, BlindReputation, TaskRegistry (whichever were proposed above), and acceptOwnership() on AgentFactory.`);
  console.log(`Then verify: EXPECTED_ADMIN=${safeAddr} npx hardhat run scripts/verify-deployment-config.ts --network ${network.name}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
