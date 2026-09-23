/**
 * Set the AgentFactory treasury — the address that receives the 1 USDC agent
 * deploy fee. Owner-only (`setTreasury` is `onlyOwner`); reverts on the zero
 * address. Network-aware; no-op if already at target. Mirrors
 * set-treasury.ts (BlindEscrow), but reads the factory from the
 * agent-factory-<record>.json companion.
 *
 * Run while owner is still the deployer EOA. Once ownership moves to a Safe,
 * call `setTreasury(addr)` through the Safe UI instead (this script will
 * refuse).
 *
 * Usage:
 *   EXPECTED_ESCROW=0x... NEW_TREASURY=0xCold \
 *     npx hardhat run scripts/set-factory-treasury.ts --network arc-testnet
 *   (EXPECTED_ESCROW names the stack the factory belongs to on shared chains;
 *   it is optional elsewhere.)
 */
import { ethers, network } from "../lib/hh.js";
import { assertSafeNetwork } from "./_guard.js";
import { preflightDeploy, recordPath, readRecord, isLiveAddress } from "./_deployments.js";

async function main() {
  await assertSafeNetwork();

  const next = process.env.NEW_TREASURY;
  if (!next || !ethers.isAddress(next) || next === ethers.ZeroAddress) {
    throw new Error(`NEW_TREASURY must be a valid non-zero address. Got: ${next}`);
  }

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const target = preflightDeploy({ chainId, deploysEscrow: false });
  const companionPath = recordPath(chainId, target.set, "agent-factory-");
  const companion = readRecord(companionPath);
  const factoryAddr = companion?.contracts?.AgentFactory;
  if (!isLiveAddress(factoryAddr)) {
    throw new Error(`No deployed AgentFactory in ${companionPath}.`);
  }

  const [signer] = await ethers.getSigners();
  const factory = await ethers.getContractAt("AgentFactory", factoryAddr);
  const [owner, current] = await Promise.all([
    (factory as any).owner(),
    (factory as any).treasury(),
  ]);

  console.log(`network: ${network.name}\nAgentFactory: ${factoryAddr}\nsigner: ${signer.address}\nowner: ${owner}`);
  console.log(`current treasury: ${current}  →  new: ${ethers.getAddress(next)}`);

  if (ethers.getAddress(current) === ethers.getAddress(next)) { console.log("✓ already set — no tx sent."); return; }
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`signer is not owner (${owner}); setTreasury is onlyOwner — run as owner or via the Safe UI.`);
  }

  const tx = await (factory as any).setTreasury(next);
  console.log("tx:", tx.hash);
  await tx.wait();
  const after = await (factory as any).treasury();
  if (ethers.getAddress(after) !== ethers.getAddress(next)) throw new Error(`post-tx treasury=${after}, expected ${next}`);
  console.log(`✓ treasury is now ${after} on ${network.name} — the 1 USDC deploy fee now lands here.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
