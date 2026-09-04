/**
 * Post-deployment configuration verification (MAINNET-CHECKLIST.md §5).
 *
 * Read-only. Reads the live BlindEscrow config (admin, verifier, treasury,
 * feeBps, paused) and the native-token allowlist, and — if the corresponding
 * EXPECTED_* env vars are provided — asserts each matches, exiting non-zero on
 * any mismatch so it can gate a release. Network-aware (0g-testnet / 0g-mainnet).
 *
 * Usage:
 *   npx hardhat run scripts/verify-deployment-config.ts --network 0g-mainnet
 *   EXPECTED_ADMIN=0xSafe EXPECTED_VERIFIER=0xSigner EXPECTED_FEE_BPS=1500 \
 *     npx hardhat run scripts/verify-deployment-config.ts --network 0g-mainnet
 */
import { ethers, network } from "hardhat";
import { loadDeployment } from "./_deployments";

const NATIVE = "0x0000000000000000000000000000000000000000";

async function main() {
  const dep = await loadDeployment();
  const proxy: string = dep.contracts?.BlindEscrow;
  if (!proxy) throw new Error(`No BlindEscrow in deployments for network ${network.name} (chainId ${dep.chainId})`);
  const escrow = await ethers.getContractAt("BlindEscrow", proxy);
  console.log(`network: ${network.name}\nBlindEscrow: ${proxy}\n`);

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

  line("admin", admin, process.env.EXPECTED_ADMIN);
  line("verifier", verifier, process.env.EXPECTED_VERIFIER);
  line("treasury", treasury, process.env.EXPECTED_TREASURY);
  line("feeBps", feeBps.toString(), process.env.EXPECTED_FEE_BPS);
  line("paused", paused, process.env.EXPECTED_PAUSED);
  console.log(`    nextTaskId: ${nextTaskId}  |  native 0G in allowlist: ${nativeAllowed}`);

  // Sanity flags independent of EXPECTED_*:
  if (admin === verifier) { console.log("  ⚠ admin == verifier — these roles should be SEPARATE (checklist §3)."); }
  if (!/^0x[0-9a-fA-F]{40}$/.test(admin) || admin === NATIVE) { console.log("  ⚠ admin looks unset."); }

  console.log(fail === 0 ? "\n✓ config checks passed" : `\n✗ ${fail} EXPECTED_* mismatch(es)`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
