/**
 * Single source of truth for contract addresses.
 *
 * The backend and frontend Docker images ship WITHOUT the contracts/ dir, so
 * they can't import deployments/*.json directly. Instead this generator reads
 * the deployment records (the authoritative source, updated by the deploy
 * scripts) and writes a committed address module into each app. Both apps import
 * their generated module as the env-var fallback — so the addresses are declared
 * in exactly one place and propagated mechanically, killing the drift class where
 * config.ts / constants.ts / deployments/*.json diverge.
 *
 * Run after any deploy / redeploy / upgrade:
 *   npx hardhat run scripts/sync-addresses.ts
 * CI drift guard (fails if the committed modules are stale):
 *   CHECK=1 npx hardhat run scripts/sync-addresses.ts
 *
 * Only the DEFAULT records feed the generated modules. DEPLOYMENT_SET is
 * deliberately ignored and deployments/staging/ is never read: a staging
 * stack is configured through the backend/frontend env, never through the
 * committed defaults that production and local dev fall back to.
 *
 * Arc (`arc`, `arcTestnet`) is emitted only once its default record exists,
 * and `DEPLOYMENT_BLOCKS` (each emitted contract's `blocks` entry) only once a
 * record has one. Until then the generated modules are byte-identical to the
 * pre-Arc output. Record fields other than `contracts` and `blocks` are
 * ignored.
 */
import * as fs from "fs";
import * as path from "path";

// record key -> generated key
const KEYS: Record<string, string> = {
  BlindEscrow: "blindEscrow",
  TaskRegistry: "taskRegistry",
  BlindReputation: "blindReputation",
  INFT: "inft",
  ValidatorPool: "validatorPool",
  AgentFactory: "agentFactory",
  USDCPaymaster: "USDCPaymaster",
  BlindAccountFactory: "BlindAccountFactory",
  EntryPoint: "EntryPoint",
  // Not a deployment of ours, but the settlement token address belongs to the
  // same record so Base consumers resolve it the same way as everything else.
  USDC: "USDC",
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The default records only — see the header. Not _deployments.recordPath. */
const DEFAULT_RECORDS_DIR = path.resolve(import.meta.dirname, "../deployments");

interface RecordFile {
  /** `contracts` with zero placeholders stripped. */
  contracts: Record<string, string>;
  blocks: Record<string, number>;
}

/** A record's `contracts` map with placeholders stripped, plus its `blocks`.
 *  Dropping zeros HERE rather than after the merge matters: base-mainnet.json
 *  carries `AgentFactory: 0x000…0` as its not-deployed-yet placeholder, and a
 *  zero left in place would shadow a real address from the companion record
 *  and then be filtered out — losing the deployment entirely.
 *
 *  `optional` is for the companion record ONLY. A missing MAIN record must stay
 *  fatal: it used to throw ENOENT, and making it lenient would let a plain
 *  `sync-addresses` run exit 0 while emitting a module with `blindEscrow`
 *  silently absent. CHECK=1 catches that only until someone commits the
 *  truncated module — after which generated and committed agree and the drift
 *  guard goes quiet. */
function readRecordFile(dir: string, file: string, optional = false): RecordFile {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) {
    if (optional) return { contracts: {}, blocks: {} };
    throw new Error(`Deployment record not found: ${p}`);
  }
  const rec = JSON.parse(fs.readFileSync(p, "utf-8"));
  const raw: Record<string, string> = rec.contracts ?? {};
  const blocks: Record<string, unknown> = rec.blocks ?? {};
  for (const [k, b] of Object.entries(blocks)) {
    if (!Number.isSafeInteger(b) || (b as number) < 0) throw new Error(`${p}: blocks.${k} is not a block number (${JSON.stringify(b)}).`);
  }
  return {
    contracts: Object.fromEntries(Object.entries(raw).filter(([, v]) => v && v.toLowerCase() !== ZERO_ADDRESS)),
    blocks: blocks as Record<string, number>,
  };
}

interface Loaded {
  addresses: Record<string, string>;
  blocks: Record<string, number>;
}

function load(dir: string, file: string): Loaded {
  // deploy-agent-factory.ts writes its own record to `agent-factory-<net>.json`
  // and never touches `<net>.json`, but AgentFactory is read from `<net>.json`
  // here — so the address reached the generated modules only if a human
  // remembered to mirror it across (base-sepolia.json's note documents exactly
  // that manual step). Worse, deploy-base.ts rewrites `contracts` wholesale as
  // { BlindEscrow, USDC }, so re-running it silently DELETED a mirrored
  // AgentFactory. Reading the companion record makes the mirror unnecessary:
  // the main record still wins where both carry a key, so an existing mirrored
  // value keeps working.
  const records = [
    readRecordFile(dir, file),
    readRecordFile(dir, `aa-${file}`, true),
    readRecordFile(dir, `agent-factory-${file}`, true),
  ];
  const c = { ...records[2].contracts, ...records[1].contracts, ...records[0].contracts };
  const addresses: Record<string, string> = {};
  const blocks: Record<string, number> = {};
  for (const [recKey, genKey] of Object.entries(KEYS)) {
    // An all-zero address is the deliberate "not deployed yet" placeholder
    // (see contracts/deployments/base-mainnet.json and CLAUDE.md). Emitting it
    // makes consumers that test truthiness believe the contract is live.
    if (!c[recKey] || c[recKey].toLowerCase() === ZERO_ADDRESS) continue;
    addresses[genKey] = c[recKey];
    // The block comes from a record that holds this same address, so a
    // mirrored AgentFactory gets its companion record's block and a stale
    // block never lands next to a newer address.
    const source = records.find(
      (r) => r.contracts[recKey]?.toLowerCase() === c[recKey].toLowerCase() && r.blocks[recKey] !== undefined,
    );
    if (source) blocks[genKey] = source.blocks[recKey];
  }
  return { addresses, blocks };
}

/** Generated key -> main record, in output order. Arc is emitted only when
 *  its main record exists. */
const NETWORKS: ReadonlyArray<{ key: string; file: string; ifPresent?: true }> = [
  { key: "mainnet", file: "0g-mainnet.json" },
  { key: "testnet", file: "0g-testnet.json" },
  { key: "base", file: "base-mainnet.json" },
  { key: "baseTestnet", file: "base-sepolia.json" },
  { key: "arc", file: "arc-mainnet.json", ifPresent: true },
  { key: "arcTestnet", file: "arc-testnet.json", ifPresent: true },
];

/**
 * AA infrastructure per CCTP chain, keyed by the backend's CCTP chainKey
 * (cctpChains.ts) — the fund modal looks up the paymaster/factory for the
 * source chain here. Emitted as its own export so CONTRACT_ADDRESSES (and
 * every snapshot test over it) is untouched. A chain appears only once its
 * aa-<record>.json companion exists (deploy-aa.ts); chains without one
 * (Arc — native USDC gas) never appear.
 */
const AA_CHAINS: ReadonlyArray<{ key: string; file: string }> = [
  { key: "base", file: "aa-base-mainnet.json" },
  { key: "base-sepolia", file: "aa-base-sepolia.json" },
  { key: "ethereum", file: "aa-ethereum-mainnet.json" },
  { key: "ethereum-sepolia", file: "aa-ethereum-sepolia.json" },
  { key: "arbitrum", file: "aa-arbitrum-mainnet.json" },
  { key: "arbitrum-sepolia", file: "aa-arbitrum-sepolia.json" },
  { key: "optimism-sepolia", file: "aa-optimism-sepolia.json" },
  { key: "polygon", file: "aa-polygon-mainnet.json" },
  { key: "polygon-amoy", file: "aa-polygon-amoy.json" },
];

/** Record keys an AA companion contributes, verbatim (already proper nouns). */
const AA_KEYS: ReadonlyArray<string> = [
  "USDCPaymaster",
  "BlindAccountFactory",
  "BlindAccountImplementation",
  "EntryPoint",
  "USDC",
];

/** The AA address module for the records in `dir`. Empty object when no
 *  chain has AA yet — the export is still emitted so consumers can import
 *  it unconditionally. */
export function renderAA(dir: string = DEFAULT_RECORDS_DIR): string {
  const addresses: Record<string, Record<string, string>> = {};
  for (const n of AA_CHAINS) {
    const p = path.join(dir, n.file);
    if (!fs.existsSync(p)) continue;
    const rec = JSON.parse(fs.readFileSync(p, "utf-8"));
    const raw: Record<string, string> = rec.contracts ?? {};
    const picked: Record<string, string> = {};
    for (const k of AA_KEYS) {
      const v = raw[k];
      if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/i.test(v)) {
        picked[k] = v;
      }
    }
    if (Object.keys(picked).length > 0) addresses[n.key] = picked;
  }
  return `export const AA_ADDRESSES = ${JSON.stringify(addresses, null, 2)} as const;\n`;
}

/** The generated module for the records in `dir`. */
export function render(dir: string = DEFAULT_RECORDS_DIR): string {
  const addresses: Record<string, Record<string, string>> = {};
  const blocks: Record<string, Record<string, number>> = {};
  for (const n of NETWORKS) {
    if (n.ifPresent && !fs.existsSync(path.join(dir, n.file))) continue;
    const loaded = load(dir, n.file);
    addresses[n.key] = loaded.addresses;
    if (Object.keys(loaded.blocks).length > 0) blocks[n.key] = loaded.blocks;
  }
  let out =
    "// GENERATED FILE — do not edit by hand.\n" +
    "// Source of truth: contracts/deployments/*.json\n" +
    "// Regenerate: cd contracts && npx hardhat run scripts/sync-addresses.ts\n" +
    `export const CONTRACT_ADDRESSES = ${JSON.stringify(addresses, null, 2)} as const;\n`;
  if (Object.keys(blocks).length > 0) {
    out += `export const DEPLOYMENT_BLOCKS = ${JSON.stringify(blocks, null, 2)} as const;\n`;
  }
  return out;
}

const TARGETS = [
  path.resolve(import.meta.dirname, "../../backend/src/contractAddresses.ts"),
  path.resolve(import.meta.dirname, "../../frontend/src/config/contractAddresses.ts"),
];

/**
 * Single source of truth for chain metadata, RPC endpoints, and contract addresses.
 * Propagated to each consumer from config/networks.json. Backend and frontend Docker
 * images do not ship with /config/ so the file is mirrored into their build trees
 * here; contract addresses already follow the same pattern.
 */
const NETWORKS_SOURCE = path.resolve(import.meta.dirname, "../../config/networks.json");
const NETWORKS_TARGETS = [
  path.resolve(import.meta.dirname, "../../backend/src/config/networks.json"),
  path.resolve(import.meta.dirname, "../../frontend/src/config/networks.json"),
];

export async function main() {
  const check = process.env.CHECK === "1";
  if (process.env.DEPLOYMENT_SET) {
    console.warn(`note: DEPLOYMENT_SET=${process.env.DEPLOYMENT_SET} is ignored; generated modules come from the default records only.`);
  }
  const content = render() + renderAA();
  let stale = false;
  for (const target of TARGETS) {
    const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : null;
    if (check) {
      if (existing !== content) { console.error(`STALE: ${path.relative(process.cwd(), target)}`); stale = true; }
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      console.log("wrote", path.relative(process.cwd(), target));
    }
  }
  if (fs.existsSync(NETWORKS_SOURCE)) {
    const networksContent = fs.readFileSync(NETWORKS_SOURCE, "utf-8");
    for (const target of NETWORKS_TARGETS) {
      const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : null;
      if (check) {
        if (existing !== networksContent) { console.error(`STALE: ${path.relative(process.cwd(), target)}`); stale = true; }
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, networksContent);
        console.log("wrote", path.relative(process.cwd(), target));
      }
    }
  }
  if (check) {
    if (stale) { console.error("\nAddress modules are stale vs deployments/*.json — run: npx hardhat run scripts/sync-addresses.ts"); process.exit(1); }
    console.log("✓ address modules in sync with deployments/*.json");
  }
}
