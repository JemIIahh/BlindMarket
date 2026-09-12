#!/usr/bin/env node
/**
 * scripts/migrate-smart-accounts.ts
 *
 * One-off migration that deploys a BlindAccount for every agent that does not
 * yet have one. Safe to re-run — the factory is idempotent and the script
 * skips agents that already have a smartAccountAddress in the DB.
 */
import 'dotenv/config';
import { deploySmartAccount } from '../src/services/aa.js';
import { baseMarketplaceSigner } from '../src/services/chain.js';
import { config } from '../src/config.js';
import { loadAllAgents, saveAgent } from '../src/services/deployedAgentStore.js';
import { redis, redisSub } from '../src/services/redis.js';

async function main() {
  console.log('Smart account migration');
  console.log('=======================');
  // --force redeploys even when the DB already has an address. Needed when
  // the factory itself was redeployed: CREATE2 addresses derive from the
  // factory address, so every stored address belongs to the old factory.
  const force = process.argv.includes('--force');
  if (force) console.log('FORCE mode: redeploying under the current factory\n');

  if (!config.blindAccountFactoryAddress) {
    console.error('BLIND_ACCOUNT_FACTORY_ADDRESS is not configured.');
    process.exit(1);
  }
  if (!baseMarketplaceSigner) {
    console.error('BASE_MARKETPLACE_SIGNER_PRIVATE_KEY is not configured (needed to pay deploy gas).');
    process.exit(1);
  }
  console.log(`Factory:  ${config.blindAccountFactoryAddress}`);
  console.log(`Deployer: ${baseMarketplaceSigner.address}`);
  console.log(`RPC:      ${config.baseRpcUrl}\n`);

  console.log('Loading agents...');
  const agents = await loadAllAgents();
  console.log(`Loaded ${agents.length} agents from DB\n`);

  let skipped = 0;
  let deployed = 0;
  let failed = 0;

  for (const agent of agents) {
    if (agent.smartAccountAddress && !force) {
      console.log(`${agent.id} ${agent.name} — already has ${agent.smartAccountAddress}`);
      skipped++;
      continue;
    }

    console.log(`${agent.id} ${agent.name} — deploying for wallet ${agent.walletAddress}...`);
    try {
      const smartAddr = await deploySmartAccount(agent, (msg) => console.log(`  ${msg}`), { force });
      if (!smartAddr) {
        console.warn(`  ${agent.id} deploySmartAccount returned empty — skipped`);
        failed++;
        continue;
      }
      agent.smartAccountAddress = smartAddr;
      console.log(`  ${agent.id} saving to DB...`);
      await saveAgent(agent);
      console.log(`  saved ${smartAddr}`);
      deployed++;
    } catch (e) {
      console.error(`  ${agent.id} FAILED: ${(e as Error).message}`);
      failed++;
    }
  }

  console.log('');
  console.log('Done');
  console.log('----');
  console.log(`Deployed: ${deployed}`);
  console.log(`Skipped:  ${skipped}`);
  console.log(`Failed:   ${failed}`);

  // Close Redis sockets so the process exits cleanly.
  redis.disconnect();
  redisSub.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
