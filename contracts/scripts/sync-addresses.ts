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
  // Not a deployment of ours, but the settlement token address belongs to the
  // same record so Base consumers resolve it the same way as everything else.
  USDC: "USDC",
};

function load(file: string): Record<string, string> {
  const rec = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../deployments/${file}`), "utf-8"));
  const c = rec.contracts ?? {};
  const out: Record<string, string> = {};
  for (const [recKey, genKey] of Object.entries(KEYS)) if (c[recKey]) out[genKey] = c[recKey];
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
