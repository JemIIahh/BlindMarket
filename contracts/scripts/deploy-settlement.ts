/**
 * Deploy BlindEscrow as a USDC settlement escrow on Base or Arc.
 * Everything it does is in _settlement-deploy.ts (runSettlementDeploy), which
 * tests and deploy-base.ts import; this file only runs it.
 *
 * Usage:
 *   DEPLOYMENT_SET=staging npx hardhat run scripts/deploy-settlement.ts --network arc-testnet
 *   DEPLOYMENT_SET=staging npx hardhat run scripts/deploy-settlement.ts --network base-sepolia
 *   I_HAVE_READ_MAINNET_CHECKLIST=yes ARC_MAINNET_RPC_URL=https://... \
 *     npx hardhat run scripts/deploy-settlement.ts --network arc-mainnet
 */
import { runSettlementDeploy } from "./_settlement-deploy.js";

runSettlementDeploy().catch((err) => {
  console.error(err);
  process.exit(1);
});
