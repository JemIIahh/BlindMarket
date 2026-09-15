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

/** A record's `contracts` map with placeholders stripped. Dropping zeros HERE
 *  rather than after the merge matters: base-mainnet.json carries
 *  `AgentFactory: 0x000…0` as its not-deployed-yet placeholder, and a zero left
 *  in place would shadow a real address from the companion record and then be
 *  filtered out — losing the deployment entirely.
 *
 *  `optional` is for the companion record ONLY. A missing MAIN record must stay
 *  fatal: it used to throw ENOENT, and making it lenient would let a plain
 *  `sync-addresses` run exit 0 while emitting a module with `blindEscrow`
 *  silently absent. CHECK=1 catches that only until someone commits the
 *  truncated module — after which generated and committed agree and the drift
 *  guard goes quiet. */
function readContracts(file: string, optional = false): Record<string, string> {
  const p = path.resolve(__dirname, `../deployments/${file}`);
  if (!fs.existsSync(p)) {
    if (optional) return {};
    throw new Error(`Deployment record not found: ${p}`);
  }
  const raw: Record<string, string> = JSON.parse(fs.readFileSync(p, "utf-8")).contracts ?? {};
  return Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v && v.toLowerCase() !== ZERO_ADDRESS),
  );
}

function load(file: string): Record<string, string> {
  // deploy-agent-factory.ts writes its own record to `agent-factory-<net>.json`
  // and never touches `<net>.json`, but AgentFactory is read from `<net>.json`
  // here — so the address reached the generated modules only if a human
  // remembered to mirror it across (base-sepolia.json's note documents exactly
  // that manual step). Worse, deploy-base.ts rewrites `contracts` wholesale as
  // { BlindEscrow, USDC }, so re-running it silently DELETED a mirrored
  // AgentFactory. Reading the companion record makes the mirror unnecessary:
  // the main record still wins where both carry a key, so an existing mirrored
  // value keeps working.
  const c = {
    ...readContracts(`agent-factory-${file}`, true),
    ...readContracts(`aa-${file}`, true),
    ...readContracts(file),
  };
  const out: Record<string, string> = {};
  for (const [recKey, genKey] of Object.entries(KEYS)) {
    // An all-zero address is the deliberate "not deployed yet" placeholder
    // (see contracts/deployments/base-mainnet.json and CLAUDE.md). Emitting it
    // makes consumers that test truthiness believe the contract is live.
    if (c[recKey] && c[recKey].toLowerCase() !== ZERO_ADDRESS) out[genKey] = c[recKey];
  }
  return out;
}

function render(): string {
  const body = JSON.stringify({
    mainnet: load("0g-mainnet.json"),
    testnet: load("0g-testnet.json"),
    base: load("base-mainnet.json"),
    baseTestnet: load("base-sepolia.json"),
  }, null, 2);
  return (
    "// GENERATED FILE — do not edit by hand.\n" +
    "// Source of truth: contracts/deployments/*.json\n" +
    "// Regenerate: cd contracts && npx hardhat run scripts/sync-addresses.ts\n" +
    `export const CONTRACT_ADDRESSES = ${body} as const;\n`
  );
}

const TARGETS = [
  path.resolve(__dirname, "../../backend/src/contractAddresses.ts"),
  path.resolve(__dirname, "../../frontend/src/config/contractAddresses.ts"),
];

async function main() {
  const check = process.env.CHECK === "1";
  const content = render();
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
  if (check) {
    if (stale) { console.error("\nAddress modules are stale vs deployments/*.json — run: npx hardhat run scripts/sync-addresses.ts"); process.exit(1); }
    console.log("✓ address modules in sync with deployments/*.json");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
