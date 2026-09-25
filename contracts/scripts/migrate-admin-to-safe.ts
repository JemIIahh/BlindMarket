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
 *     proposeAdmin/acceptAdmin/admin() the contracts above use. Read from the
 *     agent-factory-<record>.json companion (where deploy-agent-factory.ts
 *     writes it) as well as any mirror in the main record, so Arc's factory,
 *     which is recorded only in the companion, is migrated too. Every distinct
 *     live factory is migrated; zero placeholders are ignored.
 *   - INFT: `transferOwnership(SAFE)`. ONE-STEP and IRREVERSIBLE. Gated behind
 *     INCLUDE_INFT=yes so it can't happen by accident. INFT is dormant (see
 *     MAINNET-DECISIONS.md §5); you may prefer to leave it and move it when the
 *     iNFT feature is activated.
 *   - ValidatorPool and the recorded USDCPaymasters have no transfer function:
 *     reported as still held by the deployer (they need a redeploy), never
 *     silently skipped.
 *
 * Guards: SAFE_ADDRESS must be a DEPLOYED CONTRACT (has bytecode) — this is the
 * main defense against handing the protocol to a mistyped EOA. Every recorded
 * contract's holder is read BEFORE anything is sent: if one is held by neither
 * the signer nor the Safe the run sends nothing and exits non-zero, naming it
 * (it used to log SKIP, and the operator could believe the deployer held no
 * role afterwards). Contracts absent from this chain's records are skipped.
 * Re-running is safe: contracts already held by, or already proposed to, the
 * Safe get no new transaction.
 *
 * Usage:
 *   I_HAVE_READ_MAINNET_CHECKLIST=yes SAFE_ADDRESS=0xSafe \
 *     npx hardhat run scripts/migrate-admin-to-safe.ts --network 0g-mainnet
 *   # add INCLUDE_INFT=yes to also transfer INFT ownership (irreversible)
 *   # on Base Sepolia / 0G testnet also set EXPECTED_ESCROW=<escrow> (and
 *   # DEPLOYMENT_SET=staging for the staging stack)
 *
 * AFTER this runs: the closing NEXT lines name exactly which contracts the Safe
 * must acceptAdmin() / acceptOwnership() on. Verify with
 * verify-deployment-config.ts (it also checks each AgentFactory's owner).
 *
 * The per-contract logic lives in _safe-migration.ts (tested in
 * test/safe-migration.test.ts); this file resolves the records and runs it.
 */
import { ethers, network } from "../lib/hh.js";
import { assertSafeNetwork } from "./_guard.js";
import { readRecord, recordPath, resolveEscrowTarget } from "./_deployments.js";
import { migrationPlan, nextSteps, runSafeMigration } from "./_safe-migration.js";

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

  const { record: main, set, chainId } = await resolveEscrowTarget({ sends: true });
  const records = {
    main,
    agentFactory: readRecord(recordPath(chainId, set, "agent-factory-")),
    aa: readRecord(recordPath(chainId, set, "aa-")),
  };
  const [signer] = await ethers.getSigners();
  console.log(`network: ${network.name}\nsigner (deployer EOA): ${signer.address}\ntarget Safe: ${safeAddr}\n`);

  const plan = migrationPlan(records, { includeInft: process.env.INCLUDE_INFT === "yes" });
  const outcome = await runSafeMigration({ signer, safe: safeAddr, plan });
  for (const line of nextSteps(outcome, safeAddr, network.name)) console.log(line);
}

main().catch((e) => { console.error(e); process.exit(1); });
