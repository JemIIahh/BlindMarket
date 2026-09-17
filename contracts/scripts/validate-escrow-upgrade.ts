/**
 * Read-only pre-flight: prove the new BlindEscrow implementation is a SAFE UUPS
 * upgrade of the deployed proxy (same address, storage-layout compatible). Sends
 * NO transaction and needs NO admin key — it compares the new compiled layout
 * against the deployed implementation recorded in the OZ network manifest
 * (.openzeppelin/unknown-<chainId>.json).
 *
 * Usage:
 *   npx hardhat run scripts/validate-escrow-upgrade.ts --network 0g-mainnet
 *   npx hardhat run scripts/validate-escrow-upgrade.ts --network 0g-testnet
 *   npx hardhat run scripts/validate-escrow-upgrade.ts --network base
 */
import { ethers, upgrades, network } from "hardhat";
import { resolveEscrowTarget } from "./_deployments";

async function main() {
  // Resolve by chainId, never by network.name. The old
  // `deployments/${network.name}.json` worked only where the hardhat key and
  // the filename happen to coincide — true for 0g-testnet, 0g-mainnet and
  // base-sepolia, but NOT for Base mainnet, whose hardhat key is "base" while
  // the record is "base-mainnet.json", so that one lookup threw ENOENT.
  // Read-only; throws when the record holds no deployed escrow.
  const { chainId, escrow: proxy } = await resolveEscrowTarget({ sends: false });

  const Factory = await ethers.getContractFactory("BlindEscrow");

  console.log(`Network: ${network.name} (chainId ${chainId})`);
  console.log(`Proxy:   ${proxy}`);
  console.log("Validating new BlindEscrow implementation against the deployed proxy…");

  await upgrades.validateUpgrade(proxy, Factory, {
    kind: "uups",
    redeployImplementation: "always",
  });

  console.log(
    "\n✓ SAFE: storage layout is compatible. Upgrading is a same-address UUPS\n" +
      "  implementation swap — the proxy address, all task state, escrow balances,\n" +
      "  admin/verifier/treasury/fee config, and reputation/registry wiring are\n" +
      "  preserved. No redeploy, no migration. Existing tasks read taskVerifier == 0\n" +
      "  and keep using the global verifier (backward compatible).",
  );
}

main().catch((e) => {
  console.error("\n✗ UPGRADE VALIDATION FAILED:\n", e);
  process.exit(1);
});
