/**
 * Post-deployment configuration verification (MAINNET-CHECKLIST.md §5).
 *
 * Read-only. Reads the live BlindEscrow config (admin, verifier, treasury,
 * feeBps, paused) and the native-token allowlist, and — if the corresponding
 * EXPECTED_* env vars are provided — asserts each matches, exiting non-zero on
 * any mismatch so it can gate a release. Runs on any network with a record.
 *
 * It also reads the owner() of every AgentFactory recorded for the chain (the
 * agent-factory-<record>.json companion and any mirror in the main record) and
 * checks it against EXPECTED_ADMIN, so a Safe migration that left a factory
 * with the deployer EOA fails here instead of passing.
 *
 * On a chain that settles in a USDC ERC-20 (Base, Arc; see _settlement.ts) it
 * also enforces, with no EXPECTED_* needed: the escrow allows that token, the
 * escrow does NOT allow address(0), and the token reports 6 decimals and
 * symbol "USDC". On Arc the native coin is 18-decimal USDC, so an allowlisted
 * address(0) would price every task off by 10^12.
 *
 * Usage:
 *   npx hardhat run scripts/verify-deployment-config.ts --network 0g-mainnet
 *   EXPECTED_ADMIN=0xSafe EXPECTED_VERIFIER=0xSigner EXPECTED_FEE_BPS=1500 \
 *     npx hardhat run scripts/verify-deployment-config.ts --network 0g-mainnet
 *   DEPLOYMENT_SET=staging EXPECTED_ESCROW=0x... \
 *     npx hardhat run scripts/verify-deployment-config.ts --network base-sepolia
 */
import { ethers, network } from "../lib/hh.js";
import { readRecord, recordPath, resolveEscrowTarget } from "./_deployments.js";
import { recordedAgentFactories } from "./_safe-migration.js";
import { settlementInvariants } from "./_settlement-deploy.js";
import { SETTLEMENT_CHAINS, settlementTokenFor } from "./_settlement.js";

const NATIVE = "0x0000000000000000000000000000000000000000";

async function main() {
  // Read-only: prints the resolved set/escrow; EXPECTED_ESCROW is checked below
  // like the other EXPECTED_* values instead of being required.
  const { escrow: proxy, record, set } = await resolveEscrowTarget({ sends: false });
  const escrow = await ethers.getContractAt("BlindEscrow", proxy);
  console.log(`network: ${network.name}\nBlindEscrow: ${proxy}\n`);

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const settlement = SETTLEMENT_CHAINS[chainId];

  const [admin, verifier, treasury, feeBps, paused, nextTaskId, nativeAllowed] = await Promise.all([
    (escrow as any).admin(), (escrow as any).verifier(), (escrow as any).treasury(),
    (escrow as any).feeBps(), (escrow as any).paused(), (escrow as any).nextTaskId(),
    (escrow as any).allowedTokens(NATIVE),
  ]);

  let fail = 0;
  const line = (label: string, actual: unknown, expected?: string) => {
    let mark = " ";
    if (expected !== undefined) {
      const eq = String(actual).toLowerCase() === expected.toLowerCase();
      mark = eq ? "✓" : "✗";
      if (!eq) fail++;
    }
    console.log(`  ${mark} ${label}: ${actual}${expected !== undefined ? `   (expected ${expected})` : ""}`);
  };

  line("escrow", proxy, process.env.EXPECTED_ESCROW);
  line("admin", admin, process.env.EXPECTED_ADMIN);
  line("verifier", verifier, process.env.EXPECTED_VERIFIER);
  line("treasury", treasury, process.env.EXPECTED_TREASURY);
  line("feeBps", feeBps.toString(), process.env.EXPECTED_FEE_BPS);
  line("paused", paused, process.env.EXPECTED_PAUSED);
  const nativeLabel = settlement ? `native ${settlement.gasSymbol} (address(0))` : "native 0G";
  console.log(`    nextTaskId: ${nextTaskId}  |  ${nativeLabel} in allowlist: ${nativeAllowed}`);

  // Every recorded AgentFactory's owner must be the admin too. Arc's factory is
  // recorded only in the companion, which this check used to never read.
  const factories = recordedAgentFactories(record, readRecord(recordPath(chainId, set, "agent-factory-")));
  for (const addr of factories) {
    const factory = await ethers.getContractAt("AgentFactory", addr);
    const [owner, pendingOwner] = await Promise.all([(factory as any).owner(), (factory as any).pendingOwner()]);
    line(`AgentFactory ${addr} owner`, owner, process.env.EXPECTED_ADMIN);
    if (pendingOwner !== NATIVE) console.log(`    AgentFactory ${addr} pendingOwner: ${pendingOwner} (not yet accepted)`);
  }

  // Sanity flags independent of EXPECTED_*:
  if (admin === verifier) { console.log("  ⚠ admin == verifier — these roles should be SEPARATE (checklist §3)."); }
  if (!/^0x[0-9a-fA-F]{40}$/.test(admin) || admin === NATIVE) { console.log("  ⚠ admin looks unset."); }

  // Settlement invariants (header), tested in test/settlement.test.ts.
  // Enforced without EXPECTED_*.
  const checks = await settlementInvariants(escrow as any, chainId);
  if (settlement) console.log(`\n  ${settlement.label} settles in ${settlementTokenFor(chainId)}:`);
  for (const c of checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.label}`);
  const invariantFails = checks.filter((c) => !c.ok).length;

  if (fail === 0 && invariantFails === 0) console.log("\n✓ config checks passed");
  if (fail > 0) console.log(`\n✗ ${fail} EXPECTED_* mismatch(es)`);
  if (invariantFails > 0) console.log(`\n✗ ${invariantFails} settlement invariant(s) failed`);
  if (fail > 0 || invariantFails > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
