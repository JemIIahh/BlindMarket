/**
 * Deploy BlindEscrow to Base (payment/settlement layer).
 *
 * A thin wrapper kept for existing runbooks: deploy-settlement.ts does the
 * work (and also covers Arc). This name only runs on Base mainnet (8453) and
 * Base Sepolia (84532).
 *
 * Only deploys BlindEscrow — TaskRegistry, BlindReputation, INFT, and
 * ValidatorPool stay on 0G where agents operate.
 *
 * Writes (merges into) the chain's record in the DEPLOYMENT_SET and refuses
 * to replace a live BlindEscrow unless ALLOW_ESCROW_REPLACE=true.
 *
 * Usage:
 *   DEPLOYMENT_SET=staging npx hardhat run scripts/deploy-base.ts --network base-sepolia
 *   I_HAVE_READ_MAINNET_CHECKLIST=yes npx hardhat run scripts/deploy-base.ts --network base
 */
import { runSettlementDeploy } from "./_settlement-deploy.js";

runSettlementDeploy({ only: [8453, 84532], script: "deploy-base.ts" }).catch((err) => {
  console.error(err);
  process.exit(1);
});
