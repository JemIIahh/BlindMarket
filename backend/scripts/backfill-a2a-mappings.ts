/**
 * One-shot backfill of A2A taskHash ↔ taskId mappings into Redis.
 *
 * Scans every TaskCreated event from BlindEscrow's deployment block to head
 * and writes the bidirectional mapping to Redis. Designed to run from a
 * developer machine where the multi-minute RPC scan can complete without
 * hitting serverless function timeouts.
 *
 * After running, the backend's getTaskIdByHash() returns from cache for
 * every existing task — both /submit and /accept paths heal end-to-end.
 * Idempotent: safe to re-run, existing mappings are overwritten with the
 * same values. Also advances the indexer checkpoint to the scan endpoint
 * so the forward-only tick loop doesn't redundantly re-process the range.
 *
 * Usage:
 *   # Defaults: testnet contract + testnet RPC + REDIS_URL from backend/.env
 *   cd backend
 *   npx tsx scripts/backfill-a2a-mappings.ts
 *
 *   # Mainnet override (when tasks actually exist there)
 *   OG_RPC_URL=https://evmrpc.0g.ai \
 *   ESCROW_ADDRESS=0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff \
 *   ESCROW_DEPLOYMENT_BLOCK=<find by binary search> \
 *   npx tsx scripts/backfill-a2a-mappings.ts
 *
 *   # Different Redis (e.g. staging vs prod)
 *   REDIS_URL=redis://... npx tsx scripts/backfill-a2a-mappings.ts
 */

import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { JsonRpcProvider, Contract, EventLog } from 'ethers';
import Redis from 'ioredis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../.env') });

const REDIS_URL = process.env.REDIS_URL;
const OG_RPC_URL = process.env.OG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai';
const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS ?? '0x7B420523E2b5d6C0f0e5deF75b1D9a901167f041';
const DEPLOYMENT_BLOCK = Number(process.env.ESCROW_DEPLOYMENT_BLOCK ?? 33_459_885);

if (!REDIS_URL) {
  console.error('REDIS_URL required (in env or backend/.env)');
  process.exit(1);
}

// Match the indexer's chunk cap — 0G RPC times out reliably on
// queryFilter ranges over a few thousand blocks.
const CHUNK_SIZE = 1000;

const ESCROW_ABI = [
  'event TaskCreated(uint256 indexed taskId, address indexed agent, address token, uint256 amount, bytes32 taskHash, string category, string locationZone, uint256 deadline)',
];

const KEY = {
  hash2id: (hash: string) => `a2a:hash2id:${hash.toLowerCase()}`,
  id2hash: (id: bigint | string) => `a2a:id2hash:${String(id)}`,
  checkpoint: 'a2a:events:checkpoint',
};

async function main(): Promise<void> {
  const provider = new JsonRpcProvider(OG_RPC_URL);
  const escrow = new Contract(ESCROW_ADDRESS, ESCROW_ABI, provider);
  const redis = new Redis(REDIS_URL!);

  const network = await provider.getNetwork();
  const latest = await provider.getBlockNumber();
  const totalBlocks = latest - DEPLOYMENT_BLOCK;
  const totalChunks = Math.ceil(totalBlocks / CHUNK_SIZE);

  console.log('A2A hash→id backfill');
  console.log(`  redis     ${REDIS_URL!.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`  rpc       ${OG_RPC_URL}`);
  console.log(`  chain     ${network.chainId}`);
  console.log(`  escrow    ${ESCROW_ADDRESS}`);
  console.log(`  from      ${DEPLOYMENT_BLOCK}`);
  console.log(`  to        ${latest}`);
  console.log(`  range     ${totalBlocks} blocks (${totalChunks} chunks of ${CHUNK_SIZE})`);
  console.log('');

  const filter = escrow.filters.TaskCreated();
  let from = DEPLOYMENT_BLOCK;
  let totalEvents = 0;
  let chunkIdx = 0;
  const startTime = Date.now();

  while (from <= latest) {
    const to = Math.min(latest, from + CHUNK_SIZE - 1);
    chunkIdx++;
    try {
      const events = await escrow.queryFilter(filter, from, to);
      if (events.length > 0) {
        const pipe = redis.pipeline();
        for (const ev of events) {
          const args = (ev as EventLog).args;
          if (!args) continue;
          const taskId = args.taskId as bigint;
          const taskHash = args.taskHash as string;
          pipe.set(KEY.hash2id(taskHash), String(taskId));
          pipe.set(KEY.id2hash(taskId), taskHash.toLowerCase());
        }
        await pipe.exec();
        totalEvents += events.length;
        console.log(`  [${chunkIdx}/${totalChunks}] blocks ${from}..${to}: +${events.length} (total ${totalEvents})`);
      } else if (chunkIdx % 50 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const pct = ((chunkIdx / totalChunks) * 100).toFixed(1);
        console.log(`  [${chunkIdx}/${totalChunks}] ${pct}% scanned (${elapsed}s elapsed, ${totalEvents} events so far)`);
      }
      from = to + 1;
    } catch (e) {
      console.error(`  chunk ${from}..${to} failed: ${(e as Error).message.slice(0, 120)} — retrying in 2s`);
      await new Promise((r) => setTimeout(r, 2_000));
      // Do not advance `from` — retry the same chunk.
    }
  }

  await redis.set(KEY.checkpoint, String(latest));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('');
  console.log('backfill complete');
  console.log(`  ${totalEvents} TaskCreated events written`);
  console.log(`  ${chunkIdx} chunks scanned`);
  console.log(`  ${elapsed}s elapsed`);
  console.log(`  checkpoint advanced to block ${latest}`);

  await redis.quit();
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
