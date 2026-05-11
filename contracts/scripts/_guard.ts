/**
 * Mainnet deploy guard.
 *
 * Refuses to run a script if the connected chain is not on the testnet
 * allowlist AND the operator hasn't acknowledged docs/MAINNET-CHECKLIST.md
 * by setting I_HAVE_READ_MAINNET_CHECKLIST=yes in the environment.
 *
 * This is a forcing function, not a permission system: the env var is
 * trivially settable by anyone. The protection comes from making the
 * person have to read the checklist file (which is what the env var name
 * points at) before they can flip the switch — i.e., they cannot deploy
 * to mainnet by accident.
 *
 * Allowed testnet chainIds:
 *   - 16602   (0G Galileo testnet)
 *   - 31337   (Hardhat local)
 *   - 1337    (Ganache local)
 *   - 11155111 (Sepolia, in case used for staging)
 *
 * Anything else is treated as mainnet and gated.
 */

import { ethers } from "hardhat";

const ALLOWED_TESTNETS = new Set<number>([16602, 31337, 1337, 11155111]);
const ACK_ENV = "I_HAVE_READ_MAINNET_CHECKLIST";
const CHECKLIST_PATH = "docs/MAINNET-CHECKLIST.md";

export async function assertSafeNetwork(): Promise<void> {
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  if (ALLOWED_TESTNETS.has(chainId)) {
    return;
  }

  const ack = process.env[ACK_ENV];
  if (ack === "yes") {
    console.warn(
      `[guard] running on chainId ${chainId} with ${ACK_ENV}=yes — proceeding. ` +
        `Ensure every box in ${CHECKLIST_PATH} is actually checked.`,
    );
    return;
  }

  console.error(
    [
      "",
      "═".repeat(70),
      `  REFUSING TO DEPLOY TO chainId=${chainId}`,
      "═".repeat(70),
      "",
      "  This chain is not on the testnet allowlist, which means it is",
      "  presumed to be mainnet (or a chain where real money is at stake).",
      "",
      `  Before proceeding, read ${CHECKLIST_PATH} end-to-end and verify`,
      "  every checkbox is green. The checklist covers:",
      "    - Independent contract review / audit",
      "    - Storage-layout dry run",
      "    - Multisig admin (Gnosis Safe) — REQUIRED",
      "    - Fresh isolated marketplace signer",
      "    - On-chain role rotation (proposeAdmin, acceptAdmin, setVerifier)",
      "    - Backend secret store config (not plain .env files)",
      "    - Monitoring + pause readiness + rotation runbook",
      "    - Post-deployment verification",
      "",
      "  When (and only when) every box is actually checked, set:",
      `    export ${ACK_ENV}=yes`,
      "  and rerun the script. Setting this without reading the checklist",
      "  is on you.",
      "",
      "═".repeat(70),
      "",
    ].join("\n"),
  );
  process.exit(1);
}
