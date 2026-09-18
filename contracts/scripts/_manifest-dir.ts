/**
 * Loaded as the FIRST import of hardhat.config.ts, before any plugin or
 * dotenv.
 *
 * 1. OpenZeppelin manifest directory per deployment set. upgrades-core reads
 *    MANIFEST_DEFAULT_DIR once, when its module loads
 *    (node_modules/@openzeppelin/upgrades-core/dist/manifest.js), and
 *    @openzeppelin/hardhat-upgrades loads it eagerly. So a staging run must set
 *    it before that import, or staging proxies land in the production
 *    manifests (.openzeppelin/base-sepolia.json, unknown-16602.json).
 *    _deployments.ts refuses a run whose manifest directory does not match its
 *    set.
 *
 * 2. Snapshot of the guard variables as the shell gave them. These must come
 *    from the command line of a single run. contracts/.env is loaded into
 *    every run, so a value there would silently select a set or satisfy a
 *    guard for all of them. hardhat.config.ts calls
 *    assertGuardVarsNotFromDotenv() after dotenv has loaded.
 */

export const STAGING_MANIFEST_DIR = ".openzeppelin/staging";

// I_HAVE_READ_MAINNET_CHECKLIST is here too: it gates real money (_guard.ts),
// and a `yes` left in contracts/.env would satisfy it for every later run.
export const GUARD_VARS = [
  "DEPLOYMENT_SET",
  "EXPECTED_ESCROW",
  "ALLOW_ESCROW_REPLACE",
  "MANIFEST_DEFAULT_DIR",
  "I_HAVE_READ_MAINNET_CHECKLIST",
] as const;

if ((process.env.DEPLOYMENT_SET ?? "").trim() === "staging" && process.env.MANIFEST_DEFAULT_DIR === undefined) {
  process.env.MANIFEST_DEFAULT_DIR = STAGING_MANIFEST_DIR;
}

// Taken after the line above, so the directory set here is not mistaken for
// one that came from contracts/.env.
const beforeDotenv: Record<string, string | undefined> = Object.fromEntries(
  GUARD_VARS.map((k) => [k, process.env[k]]),
);

/** Throws if dotenv added or changed a guard variable after the snapshot. */
export function assertGuardVarsNotFromDotenv(env: Record<string, string | undefined> = process.env): void {
  const fromDotenv = GUARD_VARS.filter((k) => env[k] !== beforeDotenv[k]);
  if (fromDotenv.length > 0) {
    throw new Error(
      `${fromDotenv.join(", ")} came from contracts/.env. These must be passed on the command line ` +
        `for a single run. Remove them from contracts/.env.`,
    );
  }
}
