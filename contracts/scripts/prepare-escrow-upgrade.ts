/**
 * Upgrade a BlindEscrow UUPS proxy whose admin is a CONTRACT (a Safe), in two
 * parts. upgrade-blind-escrow.ts cannot do this: it sends upgradeToAndCall
 * from PRIVATE_KEY, which only works while the admin is that key.
 *
 *   Part 1 (this script, default): deploy the new implementation and print the
 *     Safe transaction. Any funded key works — deploying an implementation
 *     needs no admin rights and changes nothing about the proxy.
 *   Part 2 (the Safe): call upgradeToAndCall(<impl>, 0x) on the proxy.
 *   Part 3 (this script, VERIFY=1): read-only. Confirms the proxy's live code
 *     is byte-equivalent to the compiled BlindEscrow.
 *
 * The proxy address, all task state, balances and config are preserved. The
 * storage-layout check (validateUpgrade) is a hard gate, as in
 * upgrade-blind-escrow.ts. Reuses an already deployed implementation with the
 * same bytecode (prepareUpgrade's default), so re-running Part 1 is a no-op.
 *
 * Usage:
 *   PRIVATE_KEY=<any funded key> npx hardhat run scripts/prepare-escrow-upgrade.ts --network base-sepolia
 *   VERIFY=1 npx hardhat run scripts/prepare-escrow-upgrade.ts --network base-sepolia
 */

import { ethers, upgrades } from "../lib/hh.js";
import * as fs from "fs";
import * as path from "path";
import { assertSafeNetwork } from "./_guard.js";
import { loadDeployment } from "./_deployments.js";

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

async function readImpl(proxy: string): Promise<string> {
  const raw = await ethers.provider.getStorage(proxy, IMPL_SLOT);
  return ethers.getAddress("0x" + raw.slice(-40));
}

/** Two deployments of identical source differ only in the UUPS __self immutable. */
function normalizeSelf(code: string, impl: string): string {
  const a = impl.toLowerCase().replace(/^0x/, "");
  return code.toLowerCase().split(a).join("0".repeat(40));
}

function compiledBytecode(): string {
  const artifact = JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, "../artifacts/contracts/BlindEscrow.sol/BlindEscrow.json"), "utf-8"),
  );
  return typeof artifact.deployedBytecode === "string" ? artifact.deployedBytecode : artifact.deployedBytecode.object;
}

async function isCompiled(impl: string): Promise<boolean> {
  const live = await ethers.provider.getCode(impl);
  return normalizeSelf(live, impl) === normalizeSelf(compiledBytecode(), impl);
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const dep = await loadDeployment(chainId);
  const proxy: string | undefined = dep.contracts?.BlindEscrow;
  if (!proxy || /^0x0{40}$/i.test(proxy)) throw new Error(`No deployed BlindEscrow for chainId ${chainId}`);

  const escrow = await ethers.getContractAt("BlindEscrow", proxy);
  const admin: string = await escrow.admin();
  const current = await readImpl(proxy);
  console.log(`Proxy:          ${proxy} (chainId ${chainId})`);
  console.log(`Admin:          ${admin}`);
  console.log(`Implementation: ${current}`);

  if (process.env.VERIFY === "1") {
    if (!(await isCompiled(current))) {
      throw new Error("NOT UPGRADED: the proxy's live implementation is not byte-equivalent to the compiled BlindEscrow.");
    }
    console.log("\n✓ VERIFIED — the proxy runs the compiled BlindEscrow.");
    return;
  }

  await assertSafeNetwork();
  if (await isCompiled(current)) {
    console.log("\n✓ Already current — the proxy already runs the compiled BlindEscrow. Nothing to do.");
    return;
  }
  if ((await ethers.provider.getCode(admin)) === "0x") {
    console.warn("[warn] the admin is a plain key, not a contract: upgrade-blind-escrow.ts does this in one step.");
  }

  const Factory = await ethers.getContractFactory("BlindEscrow");
  await upgrades.validateUpgrade(proxy, Factory, { kind: "uups" });
  console.log("[ok] storage layout compatible");

  const impl = String(await upgrades.prepareUpgrade(proxy, Factory, { kind: "uups" }));
  if (!(await isCompiled(impl))) throw new Error(`Deployed implementation ${impl} is not the compiled BlindEscrow — do not use it.`);
  const data = escrow.interface.encodeFunctionData("upgradeToAndCall", [impl, "0x"]);

  console.log(`\n✓ New implementation deployed & verified: ${impl}`);
  console.log("\nSafe transaction (the proxy is NOT upgraded until the Safe executes this):");
  console.log(`  to:    ${proxy}`);
  console.log("  value: 0");
  console.log(`  data:  ${data}`);
  console.log(`\nThen: VERIFY=1 npx hardhat run scripts/prepare-escrow-upgrade.ts --network <same network>`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
