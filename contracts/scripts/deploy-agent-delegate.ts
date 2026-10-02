/**
 * Deploy BlindAgentDelegate (the EIP-7702 delegate for sponsored agent gas)
 * on Arc, bound to the escrow in the chain's deployment record. Everything it
 * does is in _agent-delegate-deploy.ts (runAgentDelegateDeploy), which tests
 * import; this file only runs it.
 *
 * Usage:
 *   EXPECTED_ESCROW=0x... npx hardhat run scripts/deploy-agent-delegate.ts --network arc-testnet
 *   DEPLOYMENT_SET=staging EXPECTED_ESCROW=0x... \
 *     npx hardhat run scripts/deploy-agent-delegate.ts --network arc-testnet
 *   I_HAVE_READ_MAINNET_CHECKLIST=yes ARC_MAINNET_RPC_URL=https://... \
 *     npx hardhat run scripts/deploy-agent-delegate.ts --network arc-mainnet
 */
import { runAgentDelegateDeploy } from "./_agent-delegate-deploy.js";

runAgentDelegateDeploy().catch((err) => {
  console.error(err);
  process.exit(1);
});
