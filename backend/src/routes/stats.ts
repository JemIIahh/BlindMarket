import { Router } from 'express';
import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { provider } from '../services/chain.js';
import { redis } from '../services/redis.js';
import { loadAllAgents } from '../services/deployedAgentStore.js';
import * as registryService from '../services/registry.js';
import * as accountingService from '../services/accountingService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadAbi(name: string) {
  try {
    return JSON.parse(readFileSync(join(__dirname, `../abi/${name}.json`), 'utf-8')).abi;
  } catch { return null; }
}

/**
 * Count unique HUMAN addresses that have used the platform — i.e., posted
 * a task or deployed an agent. Explicitly does NOT include the registered
 * executor set (`agent:executor:all`), because that's filled with
 * platform-generated agent wallets, not people. Including it produced the
 * cosmetic bug where "Registered Users" equalled "Active Agents" exactly
 * — every deployed agent self-registered an executor wallet, so each agent
 * inflated the user count by one.
 *
 * Both sources here are keyed on the deployer/poster's own wallet, so the
 * Set actually counts distinct humans (modulo Privy multi-wallet quirks).
 */
async function countRegisteredUsers(): Promise<number> {
  const addrs = new Set<string>();

  // Posters — one `a2a:poster:<addr>` key per address that posted a task.
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', 'a2a:poster:*', 'COUNT', 500);
    cursor = next;
    for (const k of batch) {
      // Key format `a2a:poster:0xabc…`; strip the prefix to get the address.
      const a = k.replace(/^a2a:poster:/, '');
      if (a.startsWith('0x')) addrs.add(a);
    }
  } while (cursor !== '0');

  // Deployed-agent owners — these are the humans who clicked "deploy agent".
  // Distinct from the agent's own wallet (which lives in agent:executor:all
  // and is NOT a human).
  try {
    const agents = await loadAllAgents();
    for (const a of agents) if (a.ownerAddress) addrs.add(a.ownerAddress.toLowerCase());
  } catch { /* ignore — count from posters alone still works */ }

  return addrs.size;
}

/**
 * Count tasks that reached a terminal verified state (status=='verified' in
 * a2a state — corresponds to on-chain status=Completed=4 once the bridge
 * fires completeVerification). SCANs every `a2a:state:<hash>` key. For
 * hackathon-scale (<10k tasks) this is fast; if the set grows past 100k,
 * fold the count into a maintained counter at state-transition time
 * instead of recomputing every request.
 */
async function countCompletedTasks(): Promise<number> {
  let cursor = '0';
  let completed = 0;
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', 'a2a:state:*', 'COUNT', 500);
    cursor = next;
    if (batch.length === 0) continue;
    // Pipeline GETs so we don't pay a round-trip per key on cloud Redis.
    const pipe = redis.pipeline();
    for (const k of batch) pipe.get(k);
    const results = await pipe.exec();
    if (!results) continue;
    for (const [, raw] of results) {
      if (typeof raw !== 'string') continue;
      try {
        const state = JSON.parse(raw);
        if (state.status === 'verified') completed++;
      } catch { /* malformed entry — skip */ }
    }
  } while (cursor !== '0');
  return completed;
}

export const statsRouter = Router();

/** GET /api/v1/stats — live platform counts, used by the sidebar (existing
 *  fields) and the landing-page stats block (the new totals fields). */
statsRouter.get('/', async (_req, res) => {
  const results = await Promise.allSettled([
    // Open tasks from chain
    registryService.openTaskCount(),
    // Active agents (running) from Redis
    loadAllAgents().then(a => a.filter(x => x.status === 'running').length),
    // Validator count from ValidatorPool if deployed
    (async () => {
      const addr = process.env.VALIDATOR_POOL_ADDRESS;
      if (!addr || /^0x0{40}$/i.test(addr)) return 0;
      const abi = loadAbi('ValidatorPool');
      if (!abi) return 0;
      const contract = new ethers.Contract(addr, abi, provider);
      return Number(await contract.activeValidatorCount());
    })(),
    // Total agents deployed (all statuses)
    loadAllAgents().then(a => a.length),
    // Distinct addresses that have posted a task or owned an agent
    countRegisteredUsers(),
    // Verified-state task count
    countCompletedTasks(),
    // Total escrow + payment volume from the durable ledger, in the pricing
    // unit (accountingService.getGlobalStats): a payment's amount is already
    // gross, and rows in other units (legacy 0G) are never added to it.
    accountingService.getGlobalStats().then((g) => ({
      processedVolume: g.totalVolume,
      totalFees: g.totalFees,
      processedTxCount: g.taskCount,
    })),
  ]);

  res.json({
    success: true,
    data: {
      // Existing fields (preserved for the sidebar consumer)
      openTasks:        results[0].status === 'fulfilled' ? results[0].value : 0,
      activeAgents:     results[1].status === 'fulfilled' ? results[1].value : 0,
      activeValidators: results[2].status === 'fulfilled' ? results[2].value : 0,
      // New fields for the landing-page totals block. `activeWorkers` is an
      // alias of activeAgents for clarity on the landing surface ("workers"
      // reads better than "agents" to non-technical visitors).
      totalAgents:      results[3].status === 'fulfilled' ? results[3].value : 0,
      registeredUsers:  results[4].status === 'fulfilled' ? results[4].value : 0,
      completedTasks:   results[5].status === 'fulfilled' ? results[5].value : 0,
      activeWorkers:    results[1].status === 'fulfilled' ? results[1].value : 0,
      // Volume / processing metrics
      processedVolume:  results[6].status === 'fulfilled' ? results[6].value.processedVolume : 0,
      totalFees:        results[6].status === 'fulfilled' ? results[6].value.totalFees : 0,
      processedTxCount: results[6].status === 'fulfilled' ? results[6].value.processedTxCount : 0,
    },
  });
});
