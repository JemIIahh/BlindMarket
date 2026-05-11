/**
 * Generate a fresh random EOA to use as the marketplace signer (verifier role
 * on BlindEscrow). Writes MARKETPLACE_SIGNER_PRIVATE_KEY to backend/.env so
 * the backend can sign marketplaceAssign / completeVerification calls.
 *
 * Refuses to overwrite an existing key — run with FORCE_REGENERATE=1 to bypass
 * (only do this if you're sure the old key has no on-chain role assigned to it).
 *
 * Usage:
 *   npx hardhat run scripts/generate-marketplace-signer.ts
 *
 * Output: prints the new address (public). The private key is appended to
 * backend/.env, never to stdout, so it doesn't leak into the terminal scrollback.
 */

import { Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";

const BACKEND_ENV_PATH = path.resolve(__dirname, "../../backend/.env");
const KEY_NAME = "MARKETPLACE_SIGNER_PRIVATE_KEY";

function readEnv(p: string): string {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
}

function hasKey(env: string, name: string): boolean {
  return new RegExp(`^${name}=`, "m").test(env);
}

async function main() {
  const env = readEnv(BACKEND_ENV_PATH);
  if (hasKey(env, KEY_NAME) && !process.env.FORCE_REGENERATE) {
    console.error(
      `[abort] ${KEY_NAME} is already set in ${BACKEND_ENV_PATH}.\n` +
        `If you really want to replace it, run with FORCE_REGENERATE=1.\n` +
        `Make sure the old key has no active on-chain role first — rotate the\n` +
        `verifier off it before discarding.`,
    );
    process.exit(1);
  }

  const wallet = Wallet.createRandom();
  const addr = wallet.address;
  const pk = wallet.privateKey; // 0x-prefixed

  // Append to backend/.env (creating it if absent). We append rather than
  // rewrite so any existing config is preserved verbatim.
  const sep = env.length > 0 && !env.endsWith("\n") ? "\n" : "";
  const block =
    `\n# Marketplace signer — calls marketplaceAssign + completeVerification on BlindEscrow.\n` +
    `# Address: ${addr}\n` +
    `${KEY_NAME}=${pk}\n`;

  // If the key was set and FORCE_REGENERATE was specified, replace the existing
  // line + the comment block above it (best-effort — leaves trailing comments
  // alone if they were placed differently).
  let next: string;
  if (hasKey(env, KEY_NAME)) {
    next = env.replace(new RegExp(`^${KEY_NAME}=.*$`, "m"), `${KEY_NAME}=${pk}`);
    // Also try to update the address comment if present immediately above.
    next = next.replace(/^# Address: 0x[0-9a-fA-F]{40}$/m, `# Address: ${addr}`);
  } else {
    next = env + sep + block;
  }
  fs.writeFileSync(BACKEND_ENV_PATH, next, { mode: 0o600 });

  console.log("Generated marketplace signer:");
  console.log("  address:", addr);
  console.log(`  private key written to: ${BACKEND_ENV_PATH} (${KEY_NAME})`);
  console.log("");
  console.log("Next steps:");
  console.log(`  1. Fund this address with 0G for gas:  ${addr}`);
  console.log("     (faucet: https://faucet.0g.ai)");
  console.log("  2. Rotate the on-chain verifier role to it:");
  console.log(
    `       MARKETPLACE_SIGNER_ADDRESS=${addr} npx hardhat run scripts/rotate-verifier.ts --network 0g-testnet`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
