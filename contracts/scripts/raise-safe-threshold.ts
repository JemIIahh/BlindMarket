/**
 * H5 (audit): raise a 1-of-1 Gnosis Safe to a real multisig.
 *
 * The live Base Sepolia escrow admin is a Safe 1.4.1 with threshold 1 of 1 —
 * an EOA with extra steps. One key holds upgrade, fee, treasury, verifier
 * and pause powers. This script adds new owners and raises the threshold so
 * no single key can move the settlement layer alone.
 *
 * It executes THROUGH the Safe (execTransaction, eth_sign signature packing)
 * with the connected signer, which must be the current owner while threshold
 * is 1. Steps, in order:
 *   1. addOwnerWithThreshold(newOwner2, 1)   — owners 1→2, threshold stays 1
 *   2. [optional] addOwnerWithThreshold(newOwner3, 2)
 *   3. changeThreshold(TARGET)               — default 2
 * Verification at the end re-reads owners/threshold and REFUSES success
 * unless they match the requested end state.
 *
 * Guards: SAFE_ADDRESS must have bytecode; every NEW_OWNER must be a valid
 * non-zero EOA-or-contract that is not already an owner; TARGET_THRESHOLD
 * must be >= 2 and <= final owner count (refuses 1-of-N theater and
 * unexecutable N-of-M lockout alike). Dry-run first with DRY_RUN=yes to
 * print the exact calldata without sending anything.
 *
 * Usage:
 *   NEW_OWNERS=0xSecond[,0xThird] TARGET_THRESHOLD=2 \
 *     npx hardhat run scripts/raise-safe-threshold.ts --network base-sepolia
 *   DRY_RUN=yes NEW_OWNERS=0xSecond TARGET_THRESHOLD=2 \
 *     npx hardhat run scripts/raise-safe-threshold.ts --network base-sepolia
 */
import { ethers, network } from "../lib/hh.js";
import { assertSafeNetwork } from "./_guard.js";

const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)",
  "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns (bool)",
];

async function main() {
  await assertSafeNetwork();

  const safeAddrRaw = process.env.SAFE_ADDRESS;
  if (!safeAddrRaw || !ethers.isAddress(safeAddrRaw) || safeAddrRaw === ethers.ZeroAddress) {
    throw new Error(`SAFE_ADDRESS must be a valid non-zero address. Got: ${safeAddrRaw}`);
  }
  const safeAddr = ethers.getAddress(safeAddrRaw);
  if ((await ethers.provider.getCode(safeAddr)) === "0x") {
    throw new Error(`SAFE_ADDRESS ${safeAddr} has NO bytecode — not a deployed contract. Refusing.`);
  }

  const newOwners = (process.env.NEW_OWNERS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
      if (!ethers.isAddress(s) || s === ethers.ZeroAddress) throw new Error(`NEW_OWNERS contains invalid address: ${s}`);
      return ethers.getAddress(s);
    });
  if (newOwners.length === 0) throw new Error("NEW_OWNERS is required (comma-separated, 1–2 addresses).");
  if (newOwners.length > 2) throw new Error("Add at most 2 owners per run — re-run for more.");
  if (new Set(newOwners).size !== newOwners.length) throw new Error("NEW_OWNERS contains duplicates.");

  const targetThreshold = parseInt(process.env.TARGET_THRESHOLD ?? "2", 10);
  if (!Number.isInteger(targetThreshold) || targetThreshold < 2) {
    throw new Error(`TARGET_THRESHOLD must be an integer >= 2 (1-of-N is the theater this script removes). Got: ${process.env.TARGET_THRESHOLD}`);
  }

  const dryRun = process.env.DRY_RUN === "yes";
  const [signer] = await ethers.getSigners();
  const safe = new ethers.Contract(safeAddr, SAFE_ABI, signer);

  const owners: string[] = await safe.getOwners();
  const threshold: bigint = await safe.getThreshold();
  console.log(`network: ${network.name}\nsafe: ${safeAddr}\nowners (${owners.length}, threshold ${threshold}): ${owners.join(", ")}\nsigner: ${signer.address}\n`);

  if (threshold !== 1n || owners.length !== 1) {
    throw new Error(`Expected a 1-of-1 Safe (threshold 1, 1 owner). Found threshold ${threshold} with ${owners.length} owner(s) — this script is for the 1-of-1 case only.`);
  }
  if (owners[0].toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not the sole owner ${owners[0]} — cannot execute.`);
  }
  for (const o of newOwners) {
    if (owners.some((e) => e.toLowerCase() === o.toLowerCase())) throw new Error(`${o} is already an owner.`);
  }
  const finalCount = owners.length + newOwners.length;
  if (targetThreshold > finalCount) {
    throw new Error(`TARGET_THRESHOLD ${targetThreshold} exceeds final owner count ${finalCount} — the Safe would lock permanently. Refusing.`);
  }

  // Build the call sequence: add owners first (threshold 1 throughout — the
  // sole owner can still execute alone), raise the threshold LAST so no
  // intermediate state needs a signature we don't have yet.
  const iface = new ethers.Interface([
    "function addOwnerWithThreshold(address,uint256)",
    "function changeThreshold(uint256)",
  ]);
  const calls: Array<{ label: string; data: string }> = [];
  let runningThreshold = 1;
  for (const o of newOwners) {
    calls.push({ label: `addOwnerWithThreshold(${o}, ${runningThreshold})`, data: iface.encodeFunctionData("addOwnerWithThreshold", [o, runningThreshold]) });
  }
  if (targetThreshold !== runningThreshold) {
    calls.push({ label: `changeThreshold(${targetThreshold})`, data: iface.encodeFunctionData("changeThreshold", [targetThreshold]) });
  }

  if (dryRun) {
    console.log("DRY_RUN=yes — calldata (execute in Safe UI Transaction Builder or re-run without DRY_RUN):");
    for (const c of calls) console.log(`- ${c.label}\n  to: ${safeAddr}\n  data: ${c.data}`);
    return;
  }

  // Execute each step through the Safe. eth_sign packing: Safe expects
  // v > 30 for eth_sign signatures, so add 4 to the recovery id.
  for (const c of calls) {
    const nonce: bigint = await safe.nonce();
    const txHash: string = await safe.getTransactionHash(
      safeAddr, 0, c.data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce,
    );
    const flat = await signer.signMessage(ethers.getBytes(txHash));
    const { r, s, v } = ethers.Signature.from(flat);
    const packed = ethers.concat([r, s, new Uint8Array([v + 4])]);
    console.log(`executing: ${c.label} (safe nonce ${nonce})`);
    const tx = await safe.execTransaction(
      safeAddr, 0, c.data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, packed,
    );
    await tx.wait();
    console.log(`  ✓ ${tx.hash}`);
  }

  const endOwners: string[] = await safe.getOwners();
  const endThreshold: bigint = await safe.getThreshold();
  console.log(`\nfinal: ${endOwners.length} owners, threshold ${endThreshold}: ${endOwners.join(", ")}`);
  const wantOwners = new Set([...owners.map((o) => o.toLowerCase()), ...newOwners.map((o) => o.toLowerCase())]);
  const gotOwners = new Set(endOwners.map((o) => o.toLowerCase()));
  if (endThreshold !== BigInt(targetThreshold) || wantOwners.size !== gotOwners.size || ![...wantOwners].every((o) => gotOwners.has(o))) {
    throw new Error("VERIFICATION FAILED — on-chain end state does not match the requested one. Investigate before proceeding.");
  }
  console.log("VERIFIED: Safe is now a real multisig. Re-run the audit's H5 on-chain check (getOwners/getThreshold) to close the finding.");
}

main().catch((e) => { console.error(e); process.exit(1); });
