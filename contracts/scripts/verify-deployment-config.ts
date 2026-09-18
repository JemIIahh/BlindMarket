/**
 * Post-deployment configuration verification (MAINNET-CHECKLIST.md §5).
 *
 * Read-only. Reads the live BlindEscrow config (admin, verifier, treasury,
 * feeBps, paused) and the native-token allowlist, and — if the corresponding
 * EXPECTED_* env vars are provided — asserts each matches, exiting non-zero on
 * any mismatch so it can gate a release. Network-aware (0g-testnet / 0g-mainnet).
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
import { ethers, network } from "hardhat";
import { resolveEscrowTarget } from "./_deployments";
import { checkSettlementToken } from "./deploy-settlement";
import { SETTLEMENT_CHAINS, settlementTokenFor } from "./_settlement";

const NATIVE = "0x0000000000000000000000000000000000000000";

async function main() {
  // Read-only: prints the resolved set/escrow; EXPECTED_ESCROW is checked below
  // like the other EXPECTED_* values instead of being required.
  const { escrow: proxy } = await resolveEscrowTarget({ sends: false });
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

  // Sanity flags independent of EXPECTED_*:
  if (admin === verifier) { console.log("  ⚠ admin == verifier — these roles should be SEPARATE (checklist §3)."); }
  if (!/^0x[0-9a-fA-F]{40}$/.test(admin) || admin === NATIVE) { console.log("  ⚠ admin looks unset."); }

  // Settlement invariants (header). Enforced without EXPECTED_*.
  let invariantFails = 0;
  const invariant = (label: string, ok: boolean) => {
    if (!ok) invariantFails++;
    console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  };
  if (settlement) {
    const token = settlementTokenFor(chainId);
    console.log(`\n  ${settlement.label} settles in ${token}:`);
    invariant("escrow allows the settlement token", (await (escrow as any).allowedTokens(token)) === true);
    invariant("escrow does not allow address(0)", nativeAllowed === false);
    let tokenError: string | undefined;
    try {
      await checkSettlementToken(token);
    } catch (e) {
      tokenError = (e as Error).message;
    }
    invariant(`token reports 6 decimals and symbol USDC${tokenError ? ` (${tokenError})` : ""}`, tokenError === undefined);
  }

  if (fail === 0 && invariantFails === 0) console.log("\n✓ config checks passed");
  if (fail > 0) console.log(`\n✗ ${fail} EXPECTED_* mismatch(es)`);
  if (invariantFails > 0) console.log(`\n✗ ${invariantFails} settlement invariant(s) failed`);
  if (fail > 0 || invariantFails > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
