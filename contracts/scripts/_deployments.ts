/**
 * Resolve a chain's deployment record by chainId, inside a deployment SET.
 *
 * Scripts used to resolve `deployments/${network.name}.json` — which only
 * worked by coincidence for 0G, where the hardhat network key ("0g-testnet",
 * "0g-mainnet") happens to equal the deployment filename. Base's hardhat
 * network key is "base" but deploy-base.ts writes to "base-mainnet.json" —
 * a name it chose independently — so the network.name lookup threw ENOENT
 * for Base. Resolving by chainId instead sidesteps the naming mismatch
 * entirely (this is exactly what rotate-verifier.ts already did correctly).
 *
 * Deployment sets. A chainId alone does not name a stack: production settles
 * on Base Sepolia, and the staging stack gets its OWN escrows on Base Sepolia
 * and 0G testnet. `DEPLOYMENT_SET` picks the records:
 *   unset / "default" → contracts/deployments/<file>          (production + local dev)
 *   "staging"         → contracts/deployments/staging/<file>
 * Each set allows only its own chains (SET_CHAINS), and has its own
 * OpenZeppelin manifest directory (see _manifest-dir.ts).
 * sync-addresses.ts never uses this module: generated address modules only
 * ever come from the default records.
 *
 * Chains that can have a record in more than one set (SHARED_CHAIN_IDS) need
 * a second key: a script that sends transactions there must be given
 * EXPECTED_ESCROW, and it refuses unless that equals the escrow the selected
 * set resolves.
 */
import * as fs from "fs";
import * as path from "path";
import { ethers } from "../lib/hh.js";
import { STAGING_MANIFEST_DIR } from "./_manifest-dir.js";

export const DEPLOY_FILES: Record<number, string> = {
  16661: "0g-mainnet.json",
  16602: "0g-testnet.json",
  8453: "base-mainnet.json",
  84532: "base-sepolia.json",
  // Arc's hardhat networks carry these same names (arc-mainnet, arc-testnet).
  5042: "arc-mainnet.json",
  5042002: "arc-testnet.json",
};

export type DeploymentSet = "default" | "staging";

/** Chains each set may have records on. Staging: Base Sepolia, 0G testnet
 *  and Arc testnet. */
export const SET_CHAINS: Record<DeploymentSet, ReadonlySet<number>> = {
  default: new Set(Object.keys(DEPLOY_FILES).map(Number)),
  staging: new Set([84532, 16602, 5042002]),
};

/** Chains that can have a record in more than one set. */
export const SHARED_CHAIN_IDS: ReadonlySet<number> = new Set(
  Object.keys(DEPLOY_FILES)
    .map(Number)
    .filter((id) => Object.values(SET_CHAINS).filter((chains) => chains.has(id)).length > 1),
);

const CONTRACTS_ROOT = path.resolve(import.meta.dirname, "..");
export const DEPLOYMENTS_ROOT = path.join(CONTRACTS_ROOT, "deployments");
const SET_DIRS: Record<DeploymentSet, string> = {
  default: DEPLOYMENTS_ROOT,
  staging: path.join(DEPLOYMENTS_ROOT, "staging"),
};
const MANIFEST_DIRS: Record<DeploymentSet, string> = {
  default: path.join(CONTRACTS_ROOT, ".openzeppelin"),
  staging: path.join(CONTRACTS_ROOT, STAGING_MANIFEST_DIR),
};

export interface DeploymentRecord {
  network: string;
  chainId: number;
  deployer?: string;
  timestamp?: string | null;
  note?: string;
  contracts: Record<string, string>;
  config?: Record<string, unknown>;
  /** Block each contract was deployed in (indexer start blocks). Not an
   *  address, so it lives outside `contracts`; sync-addresses ignores it. */
  blocks?: Record<string, number>;
  [extra: string]: unknown;
}

type Env = Record<string, string | undefined>;

export function resolveDeploymentSet(env: Env = process.env): DeploymentSet {
  const raw = (env.DEPLOYMENT_SET ?? "").trim();
  if (raw === "" || raw === "default") return "default";
  if (raw === "staging") return "staging";
  throw new Error(
    `Unknown DEPLOYMENT_SET="${raw}". Leave it unset for the default records, or set DEPLOYMENT_SET=staging.`,
  );
}

export function deploymentFileFor(chainId: number): string {
  const file = DEPLOY_FILES[chainId];
  if (!file) {
    throw new Error(`Unknown chainId ${chainId} — no deployment file mapping. Add it to _deployments.ts DEPLOY_FILES.`);
  }
  return file;
}

/**
 * Path of a chain's record in a set: the main record, or a companion record
 * with `prefix` ("aa-", "agent-factory-"). Throws for a chain the set does
 * not allow.
 */
export function recordPath(chainId: number, set: DeploymentSet, prefix = ""): string {
  const file = deploymentFileFor(chainId);
  if (!SET_CHAINS[set].has(chainId)) {
    throw new Error(
      `Deployment set "${set}" has no records on chainId ${chainId} ` +
        `(allowed: ${[...SET_CHAINS[set]].join(", ")}). Check DEPLOYMENT_SET and --network.`,
    );
  }
  return path.join(SET_DIRS[set], prefix + file);
}

/**
 * The OpenZeppelin manifest directory upgrades-core will use must be the
 * set's own; otherwise a staging deploy records its proxies in production's
 * manifest (or the reverse). upgrades-core resolves the directory against
 * the working directory.
 */
export function assertManifestDir(set: DeploymentSet, env: Env = process.env, cwd: string = process.cwd()): void {
  const actual = path.resolve(cwd, env.MANIFEST_DEFAULT_DIR || ".openzeppelin");
  if (actual !== MANIFEST_DIRS[set]) {
    throw new Error(
      `Set "${set}" needs the OpenZeppelin manifest directory ${MANIFEST_DIRS[set]}, but this run uses ${actual}. ` +
        `Run from contracts/ and leave MANIFEST_DEFAULT_DIR unset (hardhat.config.ts sets it for DEPLOYMENT_SET=staging).`,
    );
  }
}

export function readRecord(p: string): DeploymentRecord | null {
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf-8")) as DeploymentRecord) : null;
}

/** A real contract address: well-formed and not the zero placeholder. */
export function isLiveAddress(a: unknown): a is string {
  return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/i.test(a);
}

async function connectedChainId(): Promise<number> {
  return Number((await ethers.provider.getNetwork()).chainId);
}

/**
 * Load and parse the deployment record for a chainId in the selected set.
 * Pass a chainId if the caller already has one to skip the RPC round-trip.
 */
export async function loadDeployment(chainId?: number, set: DeploymentSet = resolveDeploymentSet()): Promise<DeploymentRecord> {
  const cid = chainId ?? (await connectedChainId());
  const p = recordPath(cid, set);
  const rec = readRecord(p);
  if (!rec) throw new Error(`Deployment file not found (set "${set}"): ${p}`);
  return rec;
}

export interface EscrowTarget {
  set: DeploymentSet;
  chainId: number;
  /** Absolute path of the main record, e.g. deployments/staging/base-sepolia.json */
  file: string;
  /** The main record, or null when it does not exist yet (fresh set). */
  record: DeploymentRecord | null;
  /** BlindEscrow of the main record, if it holds a live one. */
  escrow: string | undefined;
}

export function describeTarget(t: EscrowTarget): string {
  return (
    `[deployments] set=${t.set} chainId=${t.chainId} record=${path.relative(process.cwd(), t.file)}\n` +
    `[deployments] BlindEscrow=${t.escrow ?? "(none)"}`
  );
}

/**
 * On a shared chain, refuse unless EXPECTED_ESCROW names the resolved escrow.
 * On other chains EXPECTED_ESCROW is optional but still enforced when given.
 */
export function assertExpectedEscrow(t: Pick<EscrowTarget, "set" | "chainId" | "escrow">, env: Env = process.env): void {
  const expected = (env.EXPECTED_ESCROW ?? "").trim();
  if (!expected) {
    if (!SHARED_CHAIN_IDS.has(t.chainId)) return;
    throw new Error(
      `chainId ${t.chainId} is used by more than one deployment set, so this script needs ` +
        `EXPECTED_ESCROW=<the BlindEscrow you mean to act on>. Set "${t.set}" resolves ` +
        `${t.escrow ?? "no escrow"}; check DEPLOYMENT_SET before copying it.`,
    );
  }
  if (!isLiveAddress(expected)) throw new Error(`EXPECTED_ESCROW="${expected}" is not a non-zero address.`);
  if (!t.escrow || t.escrow.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `EXPECTED_ESCROW=${expected} but set "${t.set}" on chainId ${t.chainId} resolves BlindEscrow=` +
        `${t.escrow ?? "(none)"}. Refusing. Check DEPLOYMENT_SET.`,
    );
  }
}

/**
 * Resolve set + chain + main record + escrow, print them, and apply the
 * EXPECTED_ESCROW guard when the script sends transactions. Throws when the
 * chain is not in the set, the manifest directory is not the set's, or the
 * record is missing or holds no live BlindEscrow.
 */
export async function resolveEscrowTarget(
  opts: { sends: boolean; chainId?: number },
  env: Env = process.env,
): Promise<EscrowTarget & { record: DeploymentRecord; escrow: string }> {
  const set = resolveDeploymentSet(env);
  const chainId = opts.chainId ?? (await connectedChainId());
  const file = recordPath(chainId, set);
  assertManifestDir(set, env);
  const record = readRecord(file);
  if (!record) throw new Error(`Deployment file not found (set "${set}"): ${file}`);
  const escrow = record.contracts?.BlindEscrow;
  const t = { set, chainId, file, record, escrow: isLiveAddress(escrow) ? escrow : undefined };
  console.log(describeTarget(t));
  if (!isLiveAddress(escrow)) {
    throw new Error(`No deployed BlindEscrow in ${file} (holds ${escrow ?? "no address"}).`);
  }
  if (opts.sends) assertExpectedEscrow(t, env);
  return { ...t, escrow };
}

/**
 * Pre-flight for deploy scripts, run BEFORE any contract is deployed. Prints
 * the target and, when `deploysEscrow`, refuses to replace a live BlindEscrow
 * unless ALLOW_ESCROW_REPLACE=true AND EXPECTED_ESCROW names it, and refuses
 * a FIRST default escrow on a shared chain unless DEPLOYMENT_SET=default is
 * passed explicitly. Scripts that deploy companions (AgentFactory, AA) instead require
 * EXPECTED_ESCROW on a shared chain: it names the stack they belong to.
 */
export function preflightDeploy(
  opts: { chainId: number; deploysEscrow: boolean },
  env: Env = process.env,
): EscrowTarget {
  const set = resolveDeploymentSet(env);
  const file = recordPath(opts.chainId, set);
  assertManifestDir(set, env);
  const record = readRecord(file);
  if (record && record.chainId !== opts.chainId) {
    throw new Error(`${file} records chainId ${record.chainId}, but the connected chain is ${opts.chainId}.`);
  }
  const escrow = isLiveAddress(record?.contracts?.BlindEscrow) ? record!.contracts.BlindEscrow : undefined;
  const t = { set, chainId: opts.chainId, file, record, escrow };
  console.log(describeTarget(t));
  if (!opts.deploysEscrow) {
    assertExpectedEscrow(t, env);
    return t;
  }
  // A first default escrow on a shared chain (Arc testnet today) is what
  // sync-addresses publishes to production's generated modules, and the
  // "already holds" refusal below cannot catch a forgotten
  // DEPLOYMENT_SET=staging when there is nothing to replace yet.
  if (!escrow && set === "default" && SHARED_CHAIN_IDS.has(opts.chainId) && (env.DEPLOYMENT_SET ?? "").trim() !== "default") {
    throw new Error(
      `chainId ${opts.chainId} is shared by more than one deployment set, and the default set has no escrow there yet. ` +
        `sync-addresses would publish a new default escrow to the generated address modules. For the staging stack pass ` +
        `DEPLOYMENT_SET=staging; to create the default record pass DEPLOYMENT_SET=default.`,
    );
  }
  if (escrow) {
    if (env.ALLOW_ESCROW_REPLACE !== "true") {
      const hint = set === "default" ? "To stand up a separate stack use DEPLOYMENT_SET=staging; to" : "To";
      throw new Error(
        `${file} already holds BlindEscrow ${escrow} (set "${set}"). Refusing to deploy a replacement. ` +
          `${hint} really replace it set ALLOW_ESCROW_REPLACE=true and EXPECTED_ESCROW=${escrow}.`,
      );
    }
    // Replacing an escrow always names the one being replaced, shared chain
    // or not: a lingering exported ALLOW_ESCROW_REPLACE=true must not be
    // enough on its own.
    if (!(env.EXPECTED_ESCROW ?? "").trim()) {
      throw new Error(`ALLOW_ESCROW_REPLACE=true also needs EXPECTED_ESCROW=${escrow}, the escrow being replaced.`);
    }
    assertExpectedEscrow(t, env);
  }
  return t;
}

export interface RecordUpdate {
  network: string;
  chainId: number;
  deployer?: string;
  timestamp?: string | null;
  note?: string;
  contracts: Record<string, string>;
  config?: Record<string, unknown>;
  blocks?: Record<string, number>;
}

/**
 * Merge a deploy's output into an existing record: keys it doesn't write
 * survive, and an existing `note` (often written by hand) is kept, unless the
 * record was a placeholder (no live BlindEscrow) that this deploy fills.
 */
export function mergeRecord(existing: DeploymentRecord | null, update: RecordUpdate): DeploymentRecord {
  const merged: DeploymentRecord = {
    ...(existing ?? {}),
    ...Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined)),
    contracts: { ...(existing?.contracts ?? {}), ...update.contracts },
  } as DeploymentRecord;
  const fillsPlaceholder = !isLiveAddress(existing?.contracts?.BlindEscrow) && isLiveAddress(update.contracts.BlindEscrow);
  if (existing?.note !== undefined && !fillsPlaceholder) merged.note = existing.note;
  if (fillsPlaceholder && update.note === undefined) delete merged.note;
  if (existing?.config || update.config) merged.config = { ...(existing?.config ?? {}), ...(update.config ?? {}) };
  if (existing?.blocks || update.blocks) merged.blocks = { ...(existing?.blocks ?? {}), ...(update.blocks ?? {}) };
  return merged;
}

/**
 * Merge `update` into the record at `p` and write it. Refuses a chainId
 * mismatch, and a changed live BlindEscrow without ALLOW_ESCROW_REPLACE=true
 * (backstop for preflightDeploy).
 */
export function writeDeployment(p: string, update: RecordUpdate, env: Env = process.env): DeploymentRecord {
  const existing = readRecord(p);
  if (existing && existing.chainId !== update.chainId) {
    throw new Error(`${p} records chainId ${existing.chainId}; refusing to write chainId ${update.chainId} into it.`);
  }
  const prev = existing?.contracts?.BlindEscrow;
  const next = update.contracts.BlindEscrow;
  if (isLiveAddress(prev) && next !== undefined && next.toLowerCase() !== prev.toLowerCase() && env.ALLOW_ESCROW_REPLACE !== "true") {
    throw new Error(`${p} holds BlindEscrow ${prev}; refusing to overwrite it with ${next} without ALLOW_ESCROW_REPLACE=true.`);
  }
  const merged = mergeRecord(existing, update);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

/** Block a contract was deployed in; falls back to a lower bound taken before
 *  deploying (safe for an indexer start block) when no receipt is available. */
export async function deployBlock(
  contract: { deploymentTransaction(): { wait(): Promise<{ blockNumber: number } | null> } | null },
  lowerBound: number,
): Promise<number> {
  const receipt = await contract.deploymentTransaction()?.wait();
  return receipt?.blockNumber ?? lowerBound;
}
