#!/usr/bin/env node
/**
 * scripts/check-aa-status.ts
 *
 * Diagnostic for ERC-4337 Account Abstraction rollout.
 *
 * Lists every deployed agent and shows, for each:
 *   - wallet address (the EOA / owner)
 *   - smart account address stored in the DB
 *   - smart account address registered in BlindAccountFactory
 *
 * A mismatch between DB and chain means the agent needs re-registration.
 * A missing chain address means the migration script should deploy it.
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import { loadAllAgents } from '../src/services/deployedAgentStore.js';
import { baseProvider } from '../src/services/chain.js';
import { config } from '../src/config.js';
import { redis, redisSub } from '../src/services/redis.js';

const FactoryAbi = ['function accounts(address owner) view returns (address)'];

async function main() {
  console.log('AA diagnostic');
  console.log('=============');

  if (!config.blindAccountFactoryAddress) {
    console.error('BLIND_ACCOUNT_FACTORY_ADDRESS is not configured.');
    process.exit(1);
  }
  console.log(`Factory:      ${config.blindAccountFactoryAddress}`);
  console.log(`Base RPC:     ${config.baseRpcUrl}`);
  console.log(`EntryPoint:   ${config.entryPointAddress || '(unset)'}`);
  console.log(`Paymaster:    ${config.usdcPaymasterAddress || '(unset)'}`);
  console.log('');

  const factory = new ethers.Contract(config.blindAccountFactoryAddress, FactoryAbi, baseProvider);
  const agents = await loadAllAgents();
  console.log(`Total agents loaded from DB: ${agents.length}\n`);

  if (agents.length === 0) {
    console.log('No agents found.');
    return;
  }

  let ok = 0;
  let missingDb = 0;
  let missingChain = 0;
  let mismatch = 0;

  for (const agent of agents) {
    const dbAddr = agent.smartAccountAddress || '';
    let chainAddr = '';
    try {
      chainAddr = (await factory.accounts(agent.walletAddress)) as string;
      if (chainAddr === ethers.ZeroAddress) chainAddr = '';
    } catch (e) {
      console.warn(`  RPC lookup failed for ${agent.walletAddress}: ${(e as Error).message}`);
    }

    const dbOk = dbAddr.length > 0;
    const chainOk = chainAddr.length > 0;

    if (dbOk && chainOk && dbAddr.toLowerCase() === chainAddr.toLowerCase()) {
      ok++;
    } else if (!dbOk && !chainOk) {
      missingDb++;
      missingChain++;
    } else if (!dbOk) {
      missingDb++;
    } else if (!chainOk) {
      missingChain++;
    } else {
      mismatch++;
    }

    const status =
      !dbOk && !chainOk
        ? 'NEEDS_DEPLOY'
        : !dbOk
          ? 'DB_MISSING'
          : !chainOk
            ? 'CHAIN_MISSING'
            : dbAddr.toLowerCase() !== chainAddr.toLowerCase()
              ? 'MISMATCH'
              : 'OK';

    console.log(
      `${agent.id.slice(0, 8)} | ${status.padEnd(13)} | wallet ${agent.walletAddress} | db ${dbAddr || '—'} | chain ${chainAddr || '—'}`,
    );
  }

  console.log('');
  console.log('Summary');
  console.log('-------');
  console.log(`OK:            ${ok}`);
  console.log(`Needs deploy:  ${missingDb + missingChain - Math.min(missingDb, missingChain)}`); // both missing
  console.log(`DB missing:    ${missingDb}`);
  console.log(`Chain missing: ${missingChain}`);
  console.log(`Mismatch:      ${mismatch}`);

  redis.disconnect();
  redisSub.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
