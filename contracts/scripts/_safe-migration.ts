/**
 * The contract-by-contract work of migrate-admin-to-safe.ts, split out so the
 * test suite can run it on the in-process chain against records it controls
 * (test/safe-migration.test.ts). migrate-admin-to-safe.ts only resolves the
 * chain's records, runs this, and exits non-zero when it refuses.
 *
 * Where each role-holding contract is recorded:
 *   - BlindEscrow / BlindReputation / TaskRegistry / INFT / ValidatorPool:
 *     the chain's main record (deployments/<chain>.json).
 *   - AgentFactory: the agent-factory-<chain>.json companion, which is where
 *     deploy-agent-factory.ts writes it. It mirrors the address into the main
 *     record only when that record already has the key, which settlement
 *     records (Arc) never do, so reading only the main record silently
 *     skipped Arc's factory. Both are read here, as set-factory-treasury.ts
 *     and _sync-addresses.ts already do.
 *   - USDCPaymaster: the aa-<chain>.json companion.
 */
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import { ethers } from "../lib/hh.js";
import { isLiveAddress, type DeploymentRecord } from "./_deployments.js";

export interface ChainRecords {
  main: DeploymentRecord | null;
  /** agent-factory-<chain>.json */
  agentFactory: DeploymentRecord | null;
  /** aa-<chain>.json */
  aa: DeploymentRecord | null;
}

/**
 * - admin:      custom proposeAdmin / acceptAdmin / admin() / pendingAdmin()
 * - owner2step: OpenZeppelin Ownable2Step transferOwnership / acceptOwnership
 *               / owner() / pendingOwner()
 * - owner1step: OpenZeppelin Ownable transferOwnership, immediate and
 *               irreversible
 */
export type RoleKind = "admin" | "owner2step" | "owner1step";

export interface RoleTarget {
  name: string;
  address: string;
  artifact: string;
  kind: RoleKind;
}

export interface MigrationPlan {
  /** Contracts this run must leave proposed to (or already held by) the Safe. */
  targets: RoleTarget[];
  /** Recorded and migratable, but left out on purpose (INFT without INCLUDE_INFT=yes). */
  deferred: Array<RoleTarget & { reason: string }>;
  /** Recorded role holders with no transfer function in the deployed code (probed where the source now has one). */
  nonTransferable: Array<{ name: string; address: string; reason: string; probeTwoStep?: string }>;
}

const checksum = (a: string): string => ethers.getAddress(a);
const live = (a: unknown): string | undefined => (isLiveAddress(a) ? checksum(a) : undefined);

/**
 * Every distinct live AgentFactory recorded for the chain: the companion
 * record and any mirror in the main record. Zero placeholders (base-mainnet)
 * are dropped, and a mirrored copy of the same address counts once.
 */
export function recordedAgentFactories(main: DeploymentRecord | null, companion: DeploymentRecord | null): string[] {
  const all = [companion?.contracts?.AgentFactory, main?.contracts?.AgentFactory]
    .map(live)
    .filter((a): a is string => a !== undefined);
  return [...new Set(all)];
}

export function migrationPlan(records: ChainRecords, opts: { includeInft: boolean }): MigrationPlan {
  const c = records.main?.contracts ?? {};
  const plan: MigrationPlan = { targets: [], deferred: [], nonTransferable: [] };

  for (const name of ["BlindEscrow", "BlindReputation", "TaskRegistry"]) {
    const address = live(c[name]);
    if (address) plan.targets.push({ name, address, artifact: name, kind: "admin" });
  }
  for (const address of recordedAgentFactories(records.main, records.agentFactory)) {
    plan.targets.push({ name: "AgentFactory", address, artifact: "AgentFactory", kind: "owner2step" });
  }
  const inft = live(c.INFT);
  if (inft) {
    const t: RoleTarget = { name: "INFT", address: inft, artifact: "INFT", kind: "owner1step" };
    if (opts.includeInft) plan.targets.push(t);
    else plan.deferred.push({ ...t, reason: "set INCLUDE_INFT=yes to transfer it (one-step, irreversible)" });
  }

  const pool = live(c.ValidatorPool);
  if (pool) {
    plan.nonTransferable.push({
      name: "ValidatorPool",
      address: pool,
      reason: "admin is fixed at deploy and has no transfer function; redeploy it from the Safe to move it",
    });
  }
  const paymaster = live(records.aa?.contracts?.USDCPaymaster);
  if (paymaster) {
    plan.nonTransferable.push({
      name: "USDCPaymaster",
      address: paymaster,
      reason: "this deployment predates ownership transfer; redeploy it (with a new BlindAccountFactory) and transfer the new one",
      // Paymasters built from the current source have Ownable2Step-style
      // transferOwnership/pendingOwner: those are migrated like AgentFactory.
      probeTwoStep: "USDCPaymaster",
    });
  }
  return plan;
}

export interface MigrationOutcome {
  /** Now pending the Safe's accept (sent this run, or already pending). */
  proposed: Array<RoleTarget & { tx?: string }>;
  /** INFT transferred this run (one-step: nothing to accept). */
  transferred: Array<RoleTarget & { tx: string }>;
  alreadySafe: RoleTarget[];
  deferred: Array<RoleTarget & { reason: string; holder: string }>;
  nonTransferable: Array<{ name: string; address: string; reason: string; holder: string }>;
}

type Log = (msg: string) => void;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

async function holderOf(t: RoleTarget): Promise<{ holder: string; pending?: string }> {
  const ct = (await ethers.getContractAt(t.artifact, t.address)) as any;
  if (t.kind === "admin") return { holder: await ct.admin(), pending: await ct.pendingAdmin() };
  if (t.kind === "owner2step") return { holder: await ct.owner(), pending: await ct.pendingOwner() };
  return { holder: await ct.owner() };
}

async function supportsTwoStep(artifact: string, address: string): Promise<boolean> {
  try {
    await ((await ethers.getContractAt(artifact, address)) as any).pendingOwner.staticCall();
    return true;
  } catch {
    return false;
  }
}

/**
 * Read every target's current holder first, and refuse (sending nothing) if
 * any is held by neither the signer nor the Safe: that contract cannot be
 * migrated by this run, and "SKIP" used to let the operator believe the
 * deployer EOA held no role afterwards. Then propose / transfer each one the
 * signer still holds. Idempotent: a target already pending the Safe gets no
 * new transaction.
 */
export async function runSafeMigration(opts: {
  /** The deployer EOA: the holder expected today, and the sender of every proposal. */
  signer: HardhatEthersSigner;
  safe: string;
  plan: MigrationPlan;
  log?: Log;
}): Promise<MigrationOutcome> {
  const { signer, safe } = opts;
  const log = opts.log ?? ((m: string) => console.log(m));
  const plan: MigrationPlan = { targets: [...opts.plan.targets], deferred: [...opts.plan.deferred], nonTransferable: [] };

  // A recorded paymaster built from the current source can be migrated.
  for (const n of opts.plan.nonTransferable) {
    if (n.probeTwoStep && (await supportsTwoStep(n.probeTwoStep, n.address))) {
      plan.targets.push({ name: n.name, address: n.address, artifact: n.probeTwoStep, kind: "owner2step" });
    } else {
      plan.nonTransferable.push(n);
    }
  }

  const reads = await Promise.all(plan.targets.map(async (t) => ({ t, ...(await holderOf(t)) })));
  const foreign = reads.filter((r) => !same(r.holder, signer.address) && !same(r.holder, safe));
  if (foreign.length > 0) {
    throw new Error(
      "Refusing to migrate: these recorded contracts are held by neither the signer nor the Safe, so this run " +
        "cannot hand them to the Safe:\n" +
        foreign.map((r) => `  - ${r.t.name} ${r.t.address}: ${r.t.kind === "admin" ? "admin" : "owner"} is ${r.holder}`).join("\n") +
        "\nNothing was sent. Resolve these (or correct the deployment records) and run again.",
    );
  }

  const out: MigrationOutcome = { proposed: [], transferred: [], alreadySafe: [], deferred: [], nonTransferable: [] };
  for (const { t, holder, pending } of reads) {
    const label = `${t.name} ${t.address}`;
    if (same(holder, safe)) {
      log(`- ${label}: already held by the Safe.`);
      out.alreadySafe.push(t);
      continue;
    }
    if (pending !== undefined && same(pending, safe)) {
      log(`- ${label}: already proposed to the Safe — waiting for its accept.`);
      out.proposed.push(t);
      continue;
    }
    const ct = (await ethers.getContractAt(t.artifact, t.address, signer)) as any;
    if (t.kind === "admin") {
      const tx = await ct.proposeAdmin(safe);
      await tx.wait();
      log(`- ${label}: proposeAdmin(${safe}) ✓ (tx ${tx.hash}) — Safe must acceptAdmin().`);
      out.proposed.push({ ...t, tx: tx.hash });
    } else if (t.kind === "owner2step") {
      const tx = await ct.transferOwnership(safe);
      await tx.wait();
      log(`- ${label}: transferOwnership(${safe}) ✓ (tx ${tx.hash}) — Safe must acceptOwnership().`);
      out.proposed.push({ ...t, tx: tx.hash });
    } else {
      const tx = await ct.transferOwnership(safe);
      await tx.wait();
      log(`- ${label}: transferOwnership(${safe}) ✓ (tx ${tx.hash}) — IRREVERSIBLE, done.`);
      out.transferred.push({ ...t, tx: tx.hash });
    }
  }

  for (const d of plan.deferred) {
    const { holder } = await holderOf(d);
    if (same(holder, safe)) {
      out.alreadySafe.push(d);
      continue;
    }
    log(`- ${d.name} ${d.address}: NOT migrated, owner stays ${holder} — ${d.reason}.`);
    out.deferred.push({ ...d, holder });
  }
  for (const n of plan.nonTransferable) {
    const ct = (await ethers.getContractAt(n.name, n.address)) as any;
    const holder: string = n.name === "ValidatorPool" ? await ct.admin() : await ct.owner();
    log(`- ${n.name} ${n.address}: CANNOT be migrated by this script (held by ${holder}) — ${n.reason}.`);
    out.nonTransferable.push({ ...n, holder });
  }
  return out;
}

/** The closing instructions: an accept step only for what is actually pending. */
export function nextSteps(out: MigrationOutcome, safe: string, networkName: string): string[] {
  const lines: string[] = [""];
  const admins = out.proposed.filter((t) => t.kind === "admin");
  const owners = out.proposed.filter((t) => t.kind === "owner2step");
  if (admins.length === 0 && owners.length === 0) {
    lines.push("NEXT: nothing is waiting for the Safe to accept.");
  } else {
    lines.push("NEXT: from the Safe UI:");
    for (const t of admins) lines.push(`  - call acceptAdmin() on ${t.name} ${t.address}`);
    for (const t of owners) lines.push(`  - call acceptOwnership() on ${t.name} ${t.address}`);
  }
  const stillHeld = [...out.deferred, ...out.nonTransferable];
  if (stillHeld.length > 0) {
    lines.push("STILL NOT HELD BY THE SAFE after this run (the deployer EOA keeps these roles):");
    for (const s of stillHeld) lines.push(`  - ${s.name} ${s.address} (held by ${s.holder}): ${s.reason}`);
  }
  lines.push(`Then verify: EXPECTED_ADMIN=${safe} npx hardhat run scripts/verify-deployment-config.ts --network ${networkName}`);
  return lines;
}
